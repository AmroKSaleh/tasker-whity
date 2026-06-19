import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import clsx from 'clsx'
import { supabase } from '../lib/supabase'
import AppShell from '../components/editorial/AppShell'
import { Kicker } from '../components/editorial/atoms'

// Strip the bare address out of a "Name <email>" From header for compact display.
function fromName(from) {
  const m = from?.match(/^\s*"?([^"<]+?)"?\s*</)
  return (m ? m[1] : from || '').trim() || from || 'Unknown'
}

export default function GmailPanelPage() {
  const navigate = useNavigate()
  const [messages, setMessages] = useState(null)   // null = loading
  const [error, setError] = useState(null)
  const [openId, setOpenId] = useState(null)
  const [body, setBody] = useState({})             // id -> text | 'loading'
  const [projects, setProjects] = useState([])
  const [projectId, setProjectId] = useState('')
  const [created, setCreated] = useState({})       // id -> 'creating' | true | 'error'

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

  async function createFromEmail(m) {
    if (!projectId) return
    setCreated(c => ({ ...c, [m.id]: 'creating' }))
    try {
      const { data: { user } } = await supabase.auth.getUser()
      const text = body[m.id] && body[m.id] !== 'loading' ? body[m.id] : await fetchBody(m.id)
      // File into the project's Backlog if it has one; otherwise ungrouped.
      const { data: sec } = await supabase.from('sections').select('id').eq('project_id', projectId).eq('name', 'Backlog').maybeSingle()
      const detail = `From: ${m.from}\nDate: ${m.date}\n\n${text || m.snippet || ''}`.slice(0, 5000)
      const { error } = await supabase.from('tasks').insert({
        user_id: user.id, project_id: projectId, section_id: sec?.id ?? null,
        text: m.subject || '(no subject)', detail, status: 'pending',
      })
      setCreated(c => ({ ...c, [m.id]: error ? 'error' : true }))
    } catch {
      setCreated(c => ({ ...c, [m.id]: 'error' }))
    }
  }

  return (
    <AppShell active="gmail">
      <div className="px-7 py-8 md:px-10" style={{ maxWidth: 820 }}>
        <Kicker className="mb-2">CONNECTORS · GMAIL</Kicker>
        <h1 className="text-h1 m-0">Gmail.</h1>
        <p className="text-[12px] text-mute-2 mt-1.5 mb-5">Recent inbox. Turn an email into a task — it lands in the project below (your agent can structure it from there).</p>

        {projects.length > 0 && (
          <div className="flex items-center gap-2 mb-5">
            <span className="text-[11px] text-mute-2">Create tasks in</span>
            <select
              value={projectId}
              onChange={e => setProjectId(e.target.value)}
              className="bg-surf-2 border border-line rounded-lg px-2.5 py-1.5 text-[12px] text-ink outline-none focus:border-ink"
            >
              {projects.map(p => <option key={p.id} value={p.id}>{p.prefix ? `${p.prefix} · ` : ''}{p.name}</option>)}
            </select>
          </div>
        )}

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
              const c = created[m.id]
              return (
                <div key={m.id} className="border-b border-line-2 last:border-b-0">
                  <div className={clsx('flex items-start gap-2 px-4 py-3 hover:bg-surf-2 transition-colors', m.unread && 'bg-surf-2/40')}>
                    <button onClick={() => toggle(m.id)} className="flex-1 min-w-0 text-left">
                      <div className="flex items-center gap-2">
                        {m.unread && <span className="w-1.5 h-1.5 rounded-full bg-accent shrink-0" />}
                        <span className={clsx('flex-1 text-[13px] truncate', m.unread ? 'font-semibold text-ink' : 'text-ink-2')}>{m.subject || '(no subject)'}</span>
                        <span className="text-[11px] text-mute-2 shrink-0">{fromName(m.from)}</span>
                      </div>
                      <p className="text-[11.5px] text-mute-2 truncate mt-0.5">{m.snippet}</p>
                    </button>
                    <button
                      onClick={() => createFromEmail(m)}
                      disabled={!projectId || c === 'creating' || c === true}
                      title="Create a task from this email"
                      className="shrink-0 rounded-md border border-line px-2 py-1 text-[11px] font-semibold text-mute hover:text-ink disabled:opacity-50"
                    >
                      {c === true ? '✓ Task' : c === 'creating' ? '…' : c === 'error' ? 'Retry' : '+ Task'}
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
    </AppShell>
  )
}
