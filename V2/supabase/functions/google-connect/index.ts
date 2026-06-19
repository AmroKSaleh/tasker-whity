// google-connect — builds a Google OAuth *authorization-code* consent URL for the
// authenticated caller and the requested scope(s). Part of the shared Google
// connect + refresh-token foundation (TDE).
//
// Deploy WITH JWT verification (default — do NOT pass --no-verify-jwt) so we trust
// the caller's identity from their Supabase session. The returned `state` is an
// HMAC-signed (userId | expiry | returnPath) blob; google-callback verifies it.
//
// Required edge-function secrets: GOOGLE_CLIENT_ID, GOOGLE_REDIRECT_URI.
// Optional: GOOGLE_OAUTH_STATE_SECRET (falls back to SUPABASE_SERVICE_ROLE_KEY).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const enc = new TextEncoder()

function b64url(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function hmac(key: string, msg: string): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(msg)))
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } } },
    )
    const { data: { user }, error } = await supabase.auth.getUser()
    if (error || !user) return json({ error: 'Unauthorized' }, 401)

    const { scopes = [], returnPath = '/settings' } = await req.json().catch(() => ({}))
    if (!Array.isArray(scopes) || scopes.length === 0) return json({ error: 'scopes (non-empty array) required' }, 400)

    const clientId = Deno.env.get('GOOGLE_CLIENT_ID')
    const redirectUri = Deno.env.get('GOOGLE_REDIRECT_URI')
    const stateKey = Deno.env.get('GOOGLE_OAUTH_STATE_SECRET') ?? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    if (!clientId || !redirectUri) return json({ error: 'Google OAuth not configured (GOOGLE_CLIENT_ID / GOOGLE_REDIRECT_URI missing)' }, 500)

    // Signed, single-use-ish state: userId | expiry(epoch s) | returnPath | requested-scopes
    // (the requested scopes are echoed back so the callback knows which services the
    // user explicitly connected — for per-service connection tracking).
    const exp = Math.floor(Date.now() / 1000) + 600 // 10 minutes
    const payload = `${user.id}|${exp}|${returnPath}|${scopes.join(' ')}`
    const state = `${b64url(enc.encode(payload))}.${b64url(await hmac(stateKey, payload))}`

    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth')
    url.searchParams.set('client_id', clientId)
    url.searchParams.set('redirect_uri', redirectUri)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('scope', scopes.join(' '))
    url.searchParams.set('access_type', 'offline')        // ask for a refresh token
    url.searchParams.set('prompt', 'consent')             // ensure refresh token is returned
    url.searchParams.set('include_granted_scopes', 'true') // incremental auth — keep prior scopes
    url.searchParams.set('state', state)

    return json({ url: url.toString() })
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500)
  }
})
