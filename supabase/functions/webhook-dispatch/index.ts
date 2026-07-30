// TDE-377 (Path B): the outbound-webhook drain. pg_cron pings this every minute; it also runs on
// demand. It reads due pending deliveries, signs each with the endpoint's HMAC secret, POSTs (5s
// timeout), and advances the retry ladder (1min / 1hr / 6hr, 4 attempts) — marking dead deliveries
// and auto-disabling an endpoint after persistent failure. All signing/retry logic lives HERE so
// the MCP write path only ever ENQUEUES.
import { createClient } from 'npm:@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

const BATCH = 100
const MAX_ATTEMPTS = 4                                   // 1 initial + 3 retries
const LADDER_MS = [60_000, 3_600_000, 21_600_000]        // wait after failures 1, 2, 3
const DISABLE_AFTER = 20                                 // consecutive dead deliveries → auto-disable
const POST_TIMEOUT_MS = 5_000

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type, x-dispatch-secret' }

async function hmacHex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body))
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('')
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })

  // Auth: the shared secret is generated in-DB and stored in Vault; cron reads it via SQL, this
  // function reads it via a service-role-only RPC. Neither the secret nor the repo ever hold it.
  const provided = req.headers.get('x-dispatch-secret') || ''
  const { data: expected } = await sb.rpc('get_webhook_dispatch_secret')
  if (!expected || provided !== expected) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { ...cors, 'Content-Type': 'application/json' } })
  }

  const nowIso = new Date().toISOString()
  const { data: due, error } = await sb.from('webhook_deliveries')
    .select('id, webhook_id, event, payload, attempts, webhooks(url, secret, active, failure_count)')
    .eq('status', 'pending')
    .lte('next_attempt_at', nowIso)
    .order('next_attempt_at', { ascending: true })
    .limit(BATCH)
  if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } })

  let delivered = 0, failed = 0, dead = 0, skipped = 0
  for (const d of (due ?? [])) {
    const hook: any = (d as any).webhooks
    if (!hook) { await sb.from('webhook_deliveries').update({ status: 'dead', last_error: 'webhook deleted' }).eq('id', (d as any).id); dead++; continue }
    if (!hook.active) { await sb.from('webhook_deliveries').update({ status: 'dead', last_error: 'endpoint disabled' }).eq('id', (d as any).id); skipped++; continue }

    const body = JSON.stringify((d as any).payload)
    const signature = await hmacHex(hook.secret, body)
    const ts = String((d as any).payload?.webhookTimestamp ?? Date.now())

    let ok = false, respStatus: number | null = null, errMsg: string | null = null
    try {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), POST_TIMEOUT_MS)
      const resp = await fetch(hook.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Tasker-Signature': signature,
          'X-Tasker-Timestamp': ts,
          'X-Tasker-Event': (d as any).event,
          'User-Agent': 'Tasker-Webhooks/1',
        },
        body,
        signal: ctrl.signal,
      })
      clearTimeout(timer)
      respStatus = resp.status
      ok = resp.status >= 200 && resp.status < 300
      if (!ok) errMsg = `HTTP ${resp.status}`
    } catch (e) {
      errMsg = (e as Error)?.name === 'AbortError' ? 'timeout after 5s' : String((e as Error)?.message || e)
    }

    if (ok) {
      await sb.from('webhook_deliveries').update({ status: 'delivered', delivered_at: new Date().toISOString(), response_status: respStatus, attempts: (d as any).attempts + 1, last_error: null }).eq('id', (d as any).id)
      if (hook.failure_count > 0) await sb.from('webhooks').update({ failure_count: 0 }).eq('id', (d as any).webhook_id)
      delivered++
    } else {
      const attempts = (d as any).attempts + 1
      if (attempts >= MAX_ATTEMPTS) {
        await sb.from('webhook_deliveries').update({ status: 'dead', attempts, response_status: respStatus, last_error: errMsg }).eq('id', (d as any).id)
        const fc = (hook.failure_count ?? 0) + 1
        const patch: any = { failure_count: fc }
        if (fc >= DISABLE_AFTER) patch.active = false
        await sb.from('webhooks').update(patch).eq('id', (d as any).webhook_id)
        dead++
      } else {
        const next = new Date(Date.now() + LADDER_MS[attempts - 1]).toISOString()
        await sb.from('webhook_deliveries').update({ attempts, response_status: respStatus, last_error: errMsg, next_attempt_at: next }).eq('id', (d as any).id)
        failed++
      }
    }
  }

  return new Response(JSON.stringify({ processed: (due ?? []).length, delivered, retry: failed, dead, skipped }), { headers: { ...cors, 'Content-Type': 'application/json' } })
})
