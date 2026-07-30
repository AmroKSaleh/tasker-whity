import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../../lib/supabase'

const EVENTS = [
  { id: 'task.updated', label: 'Task updated', hint: 'status, hand-to-agent, confirm — any change' },
  { id: 'task.completed', label: 'Task completed', hint: 'a task is marked done' },
  { id: 'review.submitted', label: 'Review submitted', hint: 'a task passes or fails its gate' },
]

const STATUS_STYLE = {
  delivered: 'text-green-600 border-green-600/30 bg-green-600/[0.06]',
  pending: 'text-amber-500 border-amber-500/30 bg-amber-500/[0.06]',
  dead: 'text-red-500 border-red-500/30 bg-red-500/[0.06]',
}

function randomSecret() {
  return Array.from(crypto.getRandomValues(new Uint8Array(24))).map(b => b.toString(16).padStart(2, '0')).join('')
}

export default function WebhooksSection() {
  const [userId, setUserId] = useState(null)
  const [hooks, setHooks] = useState([])
  const [deliveries, setDeliveries] = useState([])
  const [url, setUrl] = useState('')
  const [events, setEvents] = useState(EVENTS.map(e => e.id))
  const [newSecret, setNewSecret] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const load = useCallback(async (uid) => {
    const [{ data: h }, { data: d }] = await Promise.all([
      supabase.from('webhooks').select('id, url, events, active, failure_count, created_at').eq('user_id', uid).order('created_at', { ascending: false }),
      supabase.from('webhook_deliveries').select('id, event, status, response_status, created_at, last_error').eq('user_id', uid).order('created_at', { ascending: false }).limit(8),
    ])
    setHooks(h ?? [])
    setDeliveries(d ?? [])
  }, [])

  useEffect(() => {
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (!user) return
      setUserId(user.id)
      load(user.id)
    })
  }, [load])

  function toggleEvent(id) {
    setEvents(ev => ev.includes(id) ? ev.filter(x => x !== id) : [...ev, id])
  }

  async function addWebhook() {
    setError(null)
    const clean = url.trim()
    if (!/^https?:\/\/.+/.test(clean)) { setError('Enter a valid http(s) URL.'); return }
    if (!events.length) { setError('Pick at least one event.'); return }
    setBusy(true)
    const secret = randomSecret()
    const { error: e } = await supabase.from('webhooks').insert({ user_id: userId, url: clean, secret, events })
    setBusy(false)
    if (e) { setError(e.message); return }
    setNewSecret(secret)
    setUrl('')
    setEvents(EVENTS.map(x => x.id))
    load(userId)
  }

  async function setActive(id, active) {
    await supabase.from('webhooks').update({ active, failure_count: active ? 0 : undefined }).eq('id', id)
    load(userId)
  }

  async function remove(id) {
    await supabase.from('webhooks').delete().eq('id', id)
    load(userId)
  }

  async function testFire(hook) {
    await supabase.from('webhook_deliveries').insert({
      webhook_id: hook.id, user_id: userId, event: 'test.ping',
      payload: { event: 'test.ping', action: 'create', type: 'Test', actor: 'user', data: { message: 'Tasker webhook test' }, updatedFrom: null, webhookTimestamp: Date.now() },
    })
    load(userId)
  }

  return (
    <section className="mb-7">
      <label className="block font-mono text-[9px] font-bold tracking-widest text-mute-2 uppercase mb-3">
        Outbound Webhooks
      </label>
      <p className="text-[11px] text-mute-2 mb-4 leading-relaxed">
        Fire a signed POST to your own URL when a task changes — so an event can trigger an agent run instead of it polling. Each request carries an <span className="font-mono">X-Tasker-Signature</span> (HMAC-SHA256 of the body, keyed with the endpoint secret). Delivery retries at 1&nbsp;min / 1&nbsp;hr / 6&nbsp;hr, then the endpoint auto-disables.
      </p>

      {/* Existing endpoints */}
      {hooks.length > 0 && (
        <div className="flex flex-col gap-2 mb-5">
          {hooks.map(h => (
            <div key={h.id} className="rounded-xl border border-line bg-surf-2 px-4 py-3">
              <div className="flex items-center gap-2">
                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${h.active ? 'bg-green-500' : 'bg-mute-2'}`} />
                <span className="font-mono text-[12px] text-ink truncate flex-1">{h.url}</span>
              </div>
              <div className="flex flex-wrap gap-1.5 mt-2">
                {(h.events ?? []).map(ev => (
                  <span key={ev} className="font-mono text-[9.5px] text-mute px-1.5 py-0.5 rounded border border-line-2">{ev}</span>
                ))}
              </div>
              {!h.active && (
                <p className="text-[10.5px] text-red-500 mt-2">Disabled after {h.failure_count} failed deliveries. Re-enable to resume.</p>
              )}
              <div className="flex items-center gap-3 mt-2.5">
                <button onClick={() => testFire(h)} className="text-[11px] text-accent hover:underline">Send test</button>
                <button onClick={() => setActive(h.id, !h.active)} className="text-[11px] text-mute hover:text-ink transition-colors">{h.active ? 'Disable' : 'Enable'}</button>
                <button onClick={() => remove(h.id)} className="ml-auto text-[11px] text-mute hover:text-red-500 transition-colors">Remove</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* One-time secret reveal */}
      {newSecret && (
        <div className="rounded-xl border border-accent/40 bg-accent/[0.05] px-4 py-3 mb-5">
          <p className="text-[11px] font-semibold text-ink mb-1.5">Signing secret — copy it now, it won't be shown again:</p>
          <div className="flex items-center gap-2">
            <code className="flex-1 font-mono text-[11px] text-ink break-all">{newSecret}</code>
            <button onClick={() => { navigator.clipboard.writeText(newSecret); }} className="text-[11px] text-accent hover:underline shrink-0">Copy</button>
          </div>
          <button onClick={() => setNewSecret(null)} className="text-[10.5px] text-mute hover:text-ink mt-2 transition-colors">Dismiss</button>
        </div>
      )}

      {/* Add form */}
      <div className="rounded-xl border border-line bg-surf-2 px-4 py-3.5">
        <input
          type="url"
          value={url}
          onChange={e => setUrl(e.target.value)}
          placeholder="https://your-runner.example.com/tasker-webhook"
          className="w-full bg-paper border border-line rounded-lg px-3 py-2.5 text-[13px] text-ink outline-none focus:border-ink transition-colors placeholder:text-mute-2 font-mono"
        />
        <div className="flex flex-col gap-1.5 mt-3">
          {EVENTS.map(ev => (
            <label key={ev.id} className="flex items-start gap-2.5 cursor-pointer">
              <input type="checkbox" checked={events.includes(ev.id)} onChange={() => toggleEvent(ev.id)} className="mt-0.5 accent-ink" />
              <span className="text-[12.5px] text-ink leading-tight">{ev.label} <span className="text-mute-2">— {ev.hint}</span></span>
            </label>
          ))}
        </div>
        {error && <p className="text-[11px] text-red-500 mt-2.5">{error}</p>}
        <button
          onClick={addWebhook}
          disabled={busy}
          className="mt-3 px-4 py-2 rounded-lg bg-ink text-paper text-[13px] font-medium disabled:opacity-40 transition-colors"
        >
          {busy ? 'Adding…' : 'Add endpoint'}
        </button>
      </div>

      {/* Delivery log */}
      {deliveries.length > 0 && (
        <div className="mt-5">
          <p className="font-mono text-[9px] font-bold tracking-widest text-mute-2 uppercase mb-2">Recent deliveries</p>
          <div className="flex flex-col gap-1">
            {deliveries.map(d => (
              <div key={d.id} className="flex items-center gap-2.5 text-[11.5px] py-1 border-b border-line/60 last:border-0">
                <span className={`font-mono text-[9px] px-1.5 py-0.5 rounded border ${STATUS_STYLE[d.status] ?? 'text-mute border-line-2'}`}>
                  {d.status}{d.response_status ? ` ${d.response_status}` : ''}
                </span>
                <span className="font-mono text-mute truncate">{d.event}</span>
                <span className="ml-auto text-mute-2 shrink-0">{new Date(d.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  )
}
