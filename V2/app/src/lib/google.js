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

// Start the connect flow for the given scope(s) in a POPUP (keeps the user on the
// Tasker page, like the Calendar connect). The popup is opened synchronously (within
// the click gesture) so it isn't blocked, then pointed at the consent URL. Resolves
// when google-callback posts back { source:'tasker-google', status }. Falls back to a
// full-page redirect if the popup is blocked.
export async function connectGoogle(scopes, returnPath = '/settings') {
  const list = Array.isArray(scopes) ? scopes : [scopes]
  const popup = window.open('about:blank', 'tasker-google', 'width=520,height=640,menubar=no,toolbar=no')

  const { data: { session } } = await supabase.auth.getSession()
  if (!session) { popup?.close(); throw new Error('Not signed in') }

  const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/google-connect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
    body: JSON.stringify({ scopes: list, returnPath }),
  })
  const json = await res.json()
  if (!res.ok || !json.url) { popup?.close(); throw new Error(json.error || 'Could not start Google connect') }

  // Popup blocked → fall back to a full-page redirect (the callback handles both).
  if (!popup) { window.location.href = json.url; return new Promise(() => {}) }
  popup.location.href = json.url

  // The popup ends on /google-connected.html (this app's origin), which posts back.
  return new Promise((resolve, reject) => {
    let done = false
    function cleanup() { window.removeEventListener('message', onMsg); clearInterval(poll) }
    function onMsg(e) {
      if (e.origin !== window.location.origin || !e.data || e.data.source !== 'tasker-google') return
      done = true; cleanup(); try { popup.close() } catch (_) { /* ignore */ }
      if (e.data.status === 'connected') resolve()
      else reject(new Error(e.data.status === 'denied' ? 'You declined the permission.' : `Connection failed (${e.data.status}).`))
    }
    const poll = setInterval(() => {
      if (popup.closed && !done) { cleanup(); reject(new Error('Connection cancelled.')) }
    }, 500)
    window.addEventListener('message', onMsg)
  })
}

// Read the current Google connection (null if not connected). `scopes` is the
// list of granted scopes — use hasGoogleScope() to check a specific service.
export async function loadGoogleConnection(userId) {
  const { data } = await supabase
    .from('user_settings')
    .select('google_access_token, google_connected_scopes, google_token_expiry')
    .eq('user_id', userId)
    .maybeSingle()
  if (!data?.google_access_token) return null
  return {
    connected: true,
    // The UI reflects only the services the user explicitly connected, so each
    // Google service connects/disconnects independently (google_connected_scopes),
    // not the raw accumulated grant.
    scopes: (data.google_connected_scopes ?? '').split(' ').filter(Boolean),
    expiry: data.google_token_expiry,
  }
}

export function hasGoogleScope(connection, scope) {
  return !!connection && connection.scopes.includes(scope)
}

// Fully disconnect Google (clears the shared grant + all per-service tracking).
export async function disconnectGoogle(userId) {
  await supabase
    .from('user_settings')
    .update({
      google_access_token: null,
      google_refresh_token: null,
      google_token_expiry: null,
      google_scopes: null,
      google_connected_scopes: null,
    })
    .eq('user_id', userId)
}

// Disconnect ONE service: drop its scope from the explicitly-connected set. If it
// was the last connected service, fully clear the shared grant; otherwise keep the
// token (the remaining services still need it).
export async function disconnectGoogleScope(userId, scope) {
  const { data } = await supabase
    .from('user_settings')
    .select('google_connected_scopes')
    .eq('user_id', userId)
    .maybeSingle()
  const remaining = (data?.google_connected_scopes ?? '').split(' ').filter(Boolean).filter(s => s !== scope)
  if (remaining.length === 0) return disconnectGoogle(userId)
  await supabase
    .from('user_settings')
    .update({ google_connected_scopes: remaining.join(' ') })
    .eq('user_id', userId)
}
