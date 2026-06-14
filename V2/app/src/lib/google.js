import { supabase } from './supabase'

// Shared Google connection (auth-code flow + refresh tokens). One Google grant
// per user; each service connects by requesting its scope — scopes accumulate
// via incremental consent. See edge functions: google-connect / google-callback,
// and loadGoogleAccessToken() in the MCP for server-side use.

// Per-service OAuth scopes.
export const GOOGLE_SCOPES = {
  drive: 'https://www.googleapis.com/auth/drive.file',
  gmail: 'https://www.googleapis.com/auth/gmail.readonly',
  tasks: 'https://www.googleapis.com/auth/tasks.readonly',
}

// Start the connect flow for the given scope(s): ask the google-connect function
// (authenticated) for a consent URL, then redirect the browser to Google. After
// consent, google-callback stores the tokens and redirects back to
// `${returnPath}?google=connected` (or =denied / =expired / =error).
export async function connectGoogle(scopes, returnPath = '/settings') {
  const list = Array.isArray(scopes) ? scopes : [scopes]
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) throw new Error('Not signed in')

  const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/google-connect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
    body: JSON.stringify({ scopes: list, returnPath }),
  })
  const json = await res.json()
  if (!res.ok || !json.url) throw new Error(json.error || 'Could not start Google connect')
  window.location.href = json.url
}

// Read the current Google connection (null if not connected). `scopes` is the
// list of granted scopes — use hasGoogleScope() to check a specific service.
export async function loadGoogleConnection(userId) {
  const { data } = await supabase
    .from('user_settings')
    .select('google_access_token, google_scopes, google_token_expiry')
    .eq('user_id', userId)
    .maybeSingle()
  if (!data?.google_access_token) return null
  return {
    connected: true,
    scopes: (data.google_scopes ?? '').split(' ').filter(Boolean),
    expiry: data.google_token_expiry,
  }
}

export function hasGoogleScope(connection, scope) {
  return !!connection && connection.scopes.includes(scope)
}

export async function disconnectGoogle(userId) {
  await supabase
    .from('user_settings')
    .update({
      google_access_token: null,
      google_refresh_token: null,
      google_token_expiry: null,
      google_scopes: null,
    })
    .eq('user_id', userId)
}
