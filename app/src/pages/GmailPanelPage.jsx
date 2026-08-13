import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import clsx from 'clsx'
import { supabase } from '../lib/supabase'
import AppShell from '../components/editorial/AppShell'
import Breadcrumbs from '../components/layout/Breadcrumbs'
import Conductor from '../components/connectors/Conductor'

function fromName(from) {
  const m = from?.match(/^\s*"?([^"<]+?)"?\s*</)
  return (m ? m[1] : from || '').trim() || from || 'Unknown'
}

export default function GmailPanelPage() {
  const navigate = useNavigate()
  const [messages, setMessages] = useState(null)
  const [error, setError] = useState(null)
  const [openId, setOpenId] = useState(null)
  const [body, setBody] = useState({})             // id -> text | 'loading'
  const [projects, setProjects] = useState([])
  const [projectId, setProjectId] = useState('')
  const [sending, setSending] = useState({})       // id -> bool (creating intake job)

  useEffect(() => {
    let cancelled = false
    supabase.functions.invoke('gmail-list', { body: {} }).then(({ data, error }) => {
      if (cancelled) return
      if (error || data?.error) { setError(data?.error || 'Couldn’t load Gmail. Make sure it’s connected in Settings → Connectors.'); setMessages([]) }
      else setMessages(data.messages ?? [])
    })
    supabase.from('projects').select('id, name, prefix').order('created_at').then(({ data }) => {
      if (cancelled || !data) return
      setProjects(data)
      setProjectId(prev => prev || data[0]?.id || '')
    })
    return () => { cancelled = true }
  }, [])

  async function fetchBody(id) {
    setBody(b => (b[id] === undefined ? { ...b, [id]: 'loading' } : b))
    const { data, error } = await supabase.functions.invoke('gmail-list', { body: { id } })
    const text = (error || data?.error) ? '' : (data.body || '')
    setBody(b => ({ ...b, [id]: text || '(no text content)' }))
    return text
  }

  function toggle(id) {
    if (openId === id) { setOpenId(null); return }
    setOpenId(id)
    if (body[id] === undefined) fetchBody(id)
  }

  // +Task → capture the email as a pending intake job. It surfaces in the docked
  // Conductor's In-flight tab (realtime); the agent structures it ("process intake"
  // in CC) and it moves to Parked for review + import.
  async function createIntakeJob(m) {
    setSending(s => ({ ...s, [m.id]: true }))
    try {
      const { data: { user } } = await supabase.auth.getUser()
      const text = body[m.id] && body[m.id] !== 'loading' ? body[m.id] : await fetchBody(m.id)
      await supabase.from('intake_jobs').insert({
        user_id: user.id,
        source: 'gmail',
        payload: { from: m.from, subject: m.subject, date: m.date, body: text || m.snippet || '' },
        status: 'pending',
      })
    } finally {
      setSending(s => ({ ...s, [m.id]: false }))
    }
  }

  return (
    <AppShell active="gmail">
      <div className="px-7 py-8 md:px-10 flex items-start gap-8 lg:gap-12">
        <div className="w-full max-w-[760px] shrink-0">
        <Breadcrumbs items={[{ label: 'Settings', to: '/settings' }, { label: 'Connectors', to: '/settings' }, { label: 'Gmail' }]} />
        <h1 className="text-h1 m-0">Gmail.</h1>
        <p className="text-[12px] text-mute-2 mt-1.5 mb-6">Recent inbox. <span className="font-medium text-ink-2">+ Task</span> hands the email to your agent (say <span className="font-mono">process intake</span> in CC) — it structures tasks you review &amp; import.</p>

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
          <div className="flex flex-col rounded-xl border border-line bg-surf-2 overflow-hidden shadow-sm">
            {messages.map(m => {
              const isOpen = openId === m.id
              return (
                <div key={m.id} className="border-b border-line-2 last:border-b-0">
                  <div className={clsx('flex items-start gap-2 px-4 py-3 hover:bg-surf transition-colors', m.unread && 'bg-surf/50')}>
                    <button onClick={() => toggle(m.id)} className="flex-1 min-w-0 text-left">
                      <div className="flex items-center gap-2">
                        {m.unread && <span className="w-1.5 h-1.5 rounded-full bg-accent shrink-0" />}
                        <span className={clsx('flex-1 text-[13px] truncate', m.unread ? 'font-semibold text-ink' : 'text-ink-2')}>{m.subject || '(no subject)'}</span>
                        <span className="text-[11px] text-mute-2 shrink-0">{fromName(m.from)}</span>
                      </div>
                      <p className="text-[11.5px] text-mute-2 truncate mt-0.5">{m.snippet}</p>
                    </button>
                    <button
                      onClick={() => createIntakeJob(m)}
                      disabled={sending[m.id]}
                      title="Send this email to your agent to structure into tasks"
                      className="shrink-0 rounded-md border border-line px-2 py-1 text-[11px] font-semibold text-mute hover:text-ink disabled:opacity-50"
                    >
                      {sending[m.id] ? '…' : '+ Task'}
                    </button>
                  </div>
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
        <Conductor source="gmail" projects={projects} defaultProjectId={projectId} />
      </div>
    </AppShell>
  )
}
