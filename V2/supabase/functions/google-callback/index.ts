// google-callback — OAuth authorization-code redirect target. Google sends the
// user here with ?code & ?state after consent. We verify the signed state to
// recover the userId, exchange the code for access + refresh tokens (server-side,
// using the client secret), persist them on user_settings, then redirect back to
// the app. Part of the shared Google connect + refresh-token foundation (TDE).
//
// Deploy WITH --no-verify-jwt: Google's redirect carries no Supabase JWT; trust
// comes entirely from the HMAC-signed state minted by google-connect.
//
// Required secrets: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI, APP_URL.
// Optional: GOOGLE_OAUTH_STATE_SECRET (must match google-connect; falls back to
// SUPABASE_SERVICE_ROLE_KEY).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const enc = new TextEncoder()

function b64urlToBytes(s: string): Uint8Array {
  s = s.replace(/-/g, '+').replace(/_/g, '/')
  while (s.length % 4) s += '='
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

async function hmac(key: string, msg: string): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(msg)))
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let r = 0
  for (let i = 0; i < a.length; i++) r |= a[i] ^ b[i]
  return r === 0
}

Deno.serve(async (req) => {
  const url = new URL(req.url)
  const target = (Deno.env.get('APP_URL') ?? '').replace(/\/$/, '')
  // 302 to a STATIC handler page on the app (Netlify serves it as real text/html;
  // Supabase forces text/plain on function bodies, which can't run a popup-close
  // script). That page signals the opener + closes, or falls back to /settings.
  const back = (status: string) =>
    target
      ? Response.redirect(`${target}/google-connected.html?status=${status}`, 302)
      : new Response(`Google connection: ${status}. You can close this tab.`, { status: 200 })

  try {
    const code = url.searchParams.get('code')
    const state = url.searchParams.get('state')
    if (url.searchParams.get('error')) return back('denied')
    if (!code || !state) return back('error')

    // Verify the signed state and recover userId.
    const [payloadB64, sigB64] = state.split('.')
    if (!payloadB64 || !sigB64) return back('error')
    const stateKey = Deno.env.get('GOOGLE_OAUTH_STATE_SECRET') ?? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const payload = new TextDecoder().decode(b64urlToBytes(payloadB64))
    const expectedSig = await hmac(stateKey, payload)
    if (!timingSafeEqual(expectedSig, b64urlToBytes(sigB64))) return back('error')
    const [userId, expStr] = payload.split('|')
    if (!userId || Number(expStr) < Math.floor(Date.now() / 1000)) return back('expired')

    // Exchange the authorization code for tokens.
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: Deno.env.get('GOOGLE_CLIENT_ID')!,
        client_secret: Deno.env.get('GOOGLE_CLIENT_SECRET')!,
        redirect_uri: Deno.env.get('GOOGLE_REDIRECT_URI')!,
        grant_type: 'authorization_code',
      }),
    })
    const tok = await tokenRes.json()
    if (!tokenRes.ok || !tok.access_token) {
      console.error('[google-callback] token exchange failed:', tok)
      return back('error')
    }

    const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

    // Accumulate newly-granted scopes with any previously granted (incremental auth).
    const { data: existing } = await sb.from('user_settings')
      .select('google_scopes').eq('user_id', userId).maybeSingle()
    const prev = (existing?.google_scopes ?? '').split(' ').filter(Boolean)
    const fresh = String(tok.scope ?? '').split(' ').filter(Boolean)
    const scopes = Array.from(new Set([...prev, ...fresh])).join(' ')
    const expiry = new Date(Date.now() + Number(tok.expires_in ?? 3600) * 1000).toISOString()

    const patch: Record<string, unknown> = {
      user_id: userId,
      google_access_token: tok.access_token,
      google_token_expiry: expiry,
      google_scopes: scopes,
    }
    // Google returns refresh_token only on first consent (or with prompt=consent).
    // Never overwrite a stored refresh token with null.
    if (tok.refresh_token) patch.google_refresh_token = tok.refresh_token

    await sb.from('user_settings').upsert(patch, { onConflict: 'user_id' })
    return back('connected')
  } catch (e) {
    console.error('[google-callback]', e)
    return back('error')
  }
})
