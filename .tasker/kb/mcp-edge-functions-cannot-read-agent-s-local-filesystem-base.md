# MCP: Edge functions cannot read agent's local filesystem (Base64 required for binary)

_KB entry · source: agent · READ-ONLY mirror (edit via create_kb_entry/update_kb_entry over MCP)._

When designing MCP tools that operate on files (like uploading or parsing), remember that the Tasker MCP server runs REMOTELY on Supabase Edge Functions. It does NOT have access to the agent's local filesystem (e.g. your laptop).

To pass binary files (like .zip or images) from the agent to the MCP tool, the agent must read the file locally, encode it as Base64, and pass the string to the tool. The Edge Function can then decode it using `atob()` and `Uint8Array`.
