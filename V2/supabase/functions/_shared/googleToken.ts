// Shared: return a VALID Google access token for a user, refreshing it server-side
// if expired (the browser can't refresh — the refresh token lives here). Returns
// null if the user has no Google connection. Requires GOOGLE_CLIENT_ID/SECRET secrets.
export async function loadGoogleAccessToken(sb: any, userId: string): Promise<string | null> {
  const { data } = await sb.from('user_settings')
    .select('google_access_token, google_refresh_token, google_token_expiry')
    .eq('user_id', userId).maybeSingle()
  if (!data?.google_access_token) return null

  const expiry = data.google_token_expiry ? new Date(data.google_token_expiry).getTime() : 0
  if (Date.now() < expiry - 60_000) return data.google_access_token        // still valid (60s skew)
  if (!data.google_refresh_token) return data.google_access_token          // can't refresh; try as-is

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: Deno.env.get('GOOGLE_CLIENT_ID')!,
      client_secret: Deno.env.get('GOOGLE_CLIENT_SECRET')!,
      refresh_token: data.google_refresh_token,
      grant_type: 'refresh_token',
    }),
  })
  const tok = await res.json()
  if (!res.ok || !tok.access_token) return data.google_access_token        // refresh failed; fall back
  const newExpiry = new Date(Date.now() + Number(tok.expires_in ?? 3600) * 1000).toISOString()
  await sb.from('user_settings')
    .update({ google_access_token: tok.access_token, google_token_expiry: newExpiry })
    .eq('user_id', userId)
  return tok.access_token
}
