import { createClient } from 'npm:@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function json(body: any, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })
}

async function verifyPkce(verifier: string, challenge: string): Promise<boolean> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  const b64 = btoa(String.fromCharCode(...new Uint8Array(hash)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
  return b64 === challenge
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors })
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405)

  let body: Record<string, string>
  const ct = req.headers.get('content-type') ?? ''
  if (ct.includes('application/x-www-form-urlencoded')) {
    body = Object.fromEntries(new URLSearchParams(await req.text()))
  } else {
    try { body = await req.json() } catch { return json({ error: 'invalid_request' }, 400) }
  }

  const { grant_type, code, redirect_uri, code_verifier } = body
  if (grant_type !== 'authorization_code') return json({ error: 'unsupported_grant_type' }, 400)
  if (!code) return json({ error: 'invalid_request', error_description: 'code required' }, 400)

  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } })
  const { data: authCode } = await sb.from('oauth_codes').select('*').eq('code', code).maybeSingle()

  if (!authCode) return json({ error: 'invalid_grant', error_description: 'Code not found or already used' }, 400)
  if (new Date(authCode.expires_at) < new Date()) {
    await sb.from('oauth_codes').delete().eq('code', code)
    return json({ error: 'invalid_grant', error_description: 'Code expired' }, 400)
  }
  // Defence in depth. The authorize page also checks this, but that check runs in the browser and
  // is therefore advisory. The comparison below only tests the REQUEST against the CODE, so an
  // attacker who controlled the redirect_uri at authorize time matches it here trivially — which
  // is precisely the hijack case. Validate against what the client actually REGISTERED instead.
  if (authCode.redirect_uri) {
    const { data: client } = await sb.from('oauth_clients')
      .select('redirect_uris').eq('client_id', authCode.client_id).maybeSingle()
    const registered = Array.isArray(client?.redirect_uris) ? client.redirect_uris : []
    if (!registered.includes(authCode.redirect_uri)) {
      // Burn the code — it was minted for a destination this client never registered.
      await sb.from('oauth_codes').delete().eq('code', code)
      return json({ error: 'invalid_grant', error_description: 'redirect_uri is not registered for this client' }, 400)
    }
  }
  if (redirect_uri && authCode.redirect_uri !== redirect_uri) {
    return json({ error: 'invalid_grant', error_description: 'redirect_uri mismatch' }, 400)
  }
  if (authCode.code_challenge) {
    if (!code_verifier) return json({ error: 'invalid_grant', error_description: 'code_verifier required' }, 400)
    if (!(await verifyPkce(code_verifier, authCode.code_challenge))) {
      return json({ error: 'invalid_grant', error_description: 'PKCE verification failed' }, 400)
    }
  }

  await sb.from('oauth_codes').delete().eq('code', code)

  const tokenBytes = new Uint8Array(32)
  crypto.getRandomValues(tokenBytes)
  const accessToken = btoa(String.fromCharCode(...tokenBytes))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')

  await sb.from('oauth_tokens').insert({
    user_id: authCode.user_id,
    access_token: accessToken,
    client_id: authCode.client_id,
    expires_at: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
  })

  return json({ access_token: accessToken, token_type: 'bearer', expires_in: 31536000 })
})
