import "https://deno.land/std@0.224.0/dotenv/load.ts";

const SUPABASE_URL = Deno.env.get("VITE_SUPABASE_URL") || "https://rzjhmipbamyvpwlkfvxx.supabase.co";
const TEST_API_KEY = Deno.env.get("TEST_API_KEY");

const ENDPOINT = `${SUPABASE_URL}/functions/v1/mcp`;

async function testNoAuthHeader() {
  console.log("Test 1: No Auth Header (Checking for --no-verify-jwt)...");
  
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_my_attention" } })
    });

    const bodyText = await res.text();
    let isGateway401 = false;
    
    if (res.status === 401) {
      try {
        const json = JSON.parse(bodyText);
        // If it has jsonrpc: '2.0', it's our Edge Function rejecting it (which is good!)
        if (json.jsonrpc === "2.0") {
          isGateway401 = false;
        } else {
          isGateway401 = true;
        }
      } catch (e) {
        // Not JSON = definitely gateway
        isGateway401 = true;
      }
    }

    if (isGateway401) {
      console.error(`❌ FAILED: Received HTTP 401 from the API Gateway.`);
      console.error(`   The Edge Function was likely deployed WITHOUT the --no-verify-jwt flag.`);
      console.error(`   Response body:`, bodyText);
      Deno.exit(1);
    }

    console.log(`✅ PASSED: Gateway did not block the request with a JWT failure.`);
  } catch (error) {
    console.error(`❌ FAILED: Network error:`, error);
    Deno.exit(1);
  }
}

async function testValidApiKey() {
  if (!TEST_API_KEY) {
    console.warn("⚠️  Skipping Test 2: TEST_API_KEY environment variable is not set.");
    console.warn("   To run this test, provide a valid API key (e.g. TEST_API_KEY=tsk_... deno run -A scripts/smoke-test-mcp.ts)");
    return;
  }

  console.log("\nTest 2: Valid API Key (Checking for scoped-client secret)...");
  
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { 
        "Content-Type": "application/json",
        "Authorization": `Bearer ${TEST_API_KEY}`
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_my_attention", arguments: {} } })
    });

    const bodyText = await res.text();

    if (bodyText.includes("AUTH_JWT_SECRET") || bodyText.includes("SUPABASE_AUTH_JWT_SECRET")) {
      console.error(`❌ FAILED: Found JWT secret configuration error in response!`);
      console.error(`   The AUTH_JWT_SECRET may be missing or incorrectly configured in the Edge Function.`);
      console.error(`   Response body:`, bodyText);
      Deno.exit(1);
    }

    try {
      const json = JSON.parse(bodyText);
      if (json.error) {
        // We might get an error if the tool call fails for other reasons, but as long as it's not a JWT error, it's fine for this smoke test.
        console.warn(`⚠️  Warning: Tool call returned a JSON-RPC error, but NO JWT secret issues were found.`);
        console.warn(`   Error message:`, json.error.message);
      } else {
        console.log(`✅ PASSED: Tool call succeeded. AUTH_JWT_SECRET is correctly configured.`);
      }
    } catch (e) {
      console.error(`❌ FAILED: Could not parse response as JSON. Response body:`, bodyText);
      Deno.exit(1);
    }
  } catch (error) {
    console.error(`❌ FAILED: Network error:`, error);
    Deno.exit(1);
  }
}

async function run() {
  console.log(`Running Post-Deploy MCP Smoke Tests against: ${ENDPOINT}\n`);
  await testNoAuthHeader();
  await testValidApiKey();
  console.log("\n🎉 All executed smoke tests passed!");
}

run();
