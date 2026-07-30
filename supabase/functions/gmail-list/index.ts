// gmail-list — scoped Gmail reader for the Tasker connector panel. Returns recent
// INBOX messages (metadata + snippet), or one message's body when { id } is given.
// Uses the shared Google connection with server-side token refresh. Authed (needs
// the caller's Supabase JWT to identify the user). Scope: gmail.readonly.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { loadGoogleAccessToken } from '../_shared/googleToken.ts'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } })

const G = 'https://gmail.googleapis.com/gmail/v1/users/me'

function header(headers: any[], name: string): string {
  const h = (headers || []).find((x) => x.name?.toLowerCase() === name.toLowerCase())
  return h?.value ?? ''
}
function b64urlDecode(s: string): string {
  s = s.replace(/-/g, '+').replace(/_/g, '/')
  while (s.length % 4) s += '='
  try { return decodeURIComponent(escape(atob(s))) } catch { try { return atob(s) } catch { return '' } }
}
function extractBody(payload: any): string {
  function walk(p: any): string {
    if (!p) return ''
    if (p.mimeType === 'text/plain' && p.body?.data) return b64urlDecode(p.body.data)
    if (Array.isArray(p.parts)) { for (const part of p.parts) { const r = walk(part); if (r) return r } }
    return ''
  }
  return walk(payload)
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  try {
    const authClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } } },
    )
    const { data: { user } } = await authClient.auth.getUser()
    if (!user) return json({ error: 'Unauthorized' }, 401)

    const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    const token = await loadGoogleAccessToken(sb, user.id)
    if (!token) return json({ error: 'Gmail not connected' }, 400)
    const auth = { Authorization: `Bearer ${token}` }

    const body = await req.json().catch(() => ({}))

    // Single message → return its body.
    if (body?.id) {
      const r = await fetch(`${G}/messages/${body.id}?format=full`, { headers: auth })
      const m = await r.json()
      if (!r.ok) return json({ error: m.error?.message ?? 'Gmail fetch failed' }, 502)
      return json({
        id: m.id,
        from: header(m.payload?.headers, 'From'),
        subject: header(m.payload?.headers, 'Subject'),
        date: header(m.payload?.headers, 'Date'),
        body: extractBody(m.payload) || m.snippet || '',
      })
    }

    // List recent inbox messages (metadata only).
    const listRes = await fetch(`${G}/messages?maxResults=20&labelIds=INBOX`, { headers: auth })
    const list = await listRes.json()
    if (!listRes.ok) return json({ error: list.error?.message ?? 'Gmail list failed' }, 502)
    const ids: string[] = (list.messages ?? []).map((x: any) => x.id)
    const messages = await Promise.all(ids.map(async (id) => {
      const r = await fetch(`${G}/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`, { headers: auth })
      const m = await r.json()
      return {
        id,
        from: header(m.payload?.headers, 'From'),
        subject: header(m.payload?.headers, 'Subject'),
        date: header(m.payload?.headers, 'Date'),
        snippet: m.snippet ?? '',
        unread: Array.isArray(m.labelIds) && m.labelIds.includes('UNREAD'),
      }
    }))
    return json({ messages })
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500)
  }
})
