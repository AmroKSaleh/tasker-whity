import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import clsx from 'clsx'
import { supabase } from '../lib/supabase'
import AppShell from '../components/editorial/AppShell'
import { Kicker } from '../components/editorial/atoms'

// Strip the bare email address out of a "Name <email>" From header for display.
function fromName(from) {
  const m = from?.match(/^\s*"?([^"<]+?)"?\s*</)
  return (m ? m[1] : from || '').trim() || from || 'Unknown'
}

export default function GmailPanelPage() {
  const navigate = useNavigate()
  const [messages, setMessages] = useState(null)   // null = loading
  const [error, setError] = useState(null)
  const [openId, setOpenId] = useState(null)
  const [body, setBody] = useState({})             // id -> body | 'loading'

  useEffect(() => {
    let cancelled = false
    supabase.functions.invoke('gmail-list', { body: {} }).then(({ data, error }) => {
      if (cancelled) return
      if (error || data?.error) { setError(data?.error || 'Couldn’t load Gmail. Make sure it’s connected in Settings → Connectors.'); setMessages([]) }
      else setMessages(data.messages ?? [])
    })
    return () => { cancelled = true }
  }, [])

  async function toggle(id) {
    if (openId === id) { setOpenId(null); return }
    setOpenId(id)
    if (body[id] === undefined) {
      setBody(b => ({ ...b, [id]: 'loading' }))
      const { data, error } = await supabase.functions.invoke('gmail-list', { body: { id } })
      setBody(b => ({ ...b, [id]: (error || data?.error) ? '(couldn’t load this message)' : (data.body || '(no text content)') }))
    }
  }

  return (
    <AppShell active="gmail">
      <div className="px-7 py-8 md:px-10" style={{ maxWidth: 820 }}>
        <Kicker className="mb-2">CONNECTORS · GMAIL</Kicker>
        <h1 className="text-h1 m-0">Gmail.</h1>
        <p className="text-[12px] text-mute-2 mt-1.5 mb-6">Recent inbox — read-only for now. (Turning an email into a task comes next.)</p>

        {messages === null ? (
          <p className="text-[13px] text-mute">Loading inbox…</p>
        ) : error ? (
          <div className="rounded-xl border border-line bg-surf-2 px-4 py-3">
            <p className="text-[13px] text-ink">{error}</p>
            <button onClick={() => navigate('/settings')} className="mt-2 text-[12px] text-accent hover:opacity-70">Open Settings</button>
          </div>
        ) : messages.length === 0 ? (
          <p className="text-[13px] text-mute">No messages in the inbox.</p>
        ) : (
          <div className="flex flex-col rounded-xl border border-line-2 overflow-hidden">
            {messages.map(m => {
              const isOpen = openId === m.id
              return (
                <div key={m.id} className="border-b border-line-2 last:border-b-0">
                  <button
                    onClick={() => toggle(m.id)}
                    className={clsx('w-full text-left px-4 py-3 hover:bg-surf-2 transition-colors', m.unread && 'bg-surf-2/40')}
                  >
                    <div className="flex items-center gap-2">
                      {m.unread && <span className="w-1.5 h-1.5 rounded-full bg-accent shrink-0" />}
                      <span className={clsx('flex-1 text-[13px] truncate', m.unread ? 'font-semibold text-ink' : 'text-ink-2')}>{m.subject || '(no subject)'}</span>
                      <span className="text-[11px] text-mute-2 shrink-0">{fromName(m.from)}</span>
                    </div>
                    <p className="text-[11.5px] text-mute-2 truncate mt-0.5">{m.snippet}</p>
                  </button>
                  {isOpen && (
                    <div className="px-4 pb-4 pt-1">
                      <div className="text-[11px] text-mute-2 mb-2">{m.from} · {m.date}</div>
                      <pre className="text-[12.5px] text-ink-2 whitespace-pre-wrap font-sans leading-relaxed">
                        {body[m.id] === 'loading' ? 'Loading…' : body[m.id]}
                      </pre>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </AppShell>
  )
}
