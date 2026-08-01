import { useState, useEffect } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { getOrCreateBacklogSectionId } from '../hooks/useTasks'

const PRIORITIES = [
  { value: null,     label: 'None' },
  { value: 'low',    label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high',   label: 'High' },
  { value: 'rush',   label: 'Rush' },
]

// Mirrors the MCP's resolveProject: slug exact, then id exact, then prefix (case-insensitive).
async function resolveProject(userId, ref) {
  if (!ref) return null
  let { data } = await supabase.from('projects').select('id, name, slug, prefix').eq('slug', ref).eq('user_id', userId).maybeSingle()
  if (!data) ({ data } = await supabase.from('projects').select('id, name, slug, prefix').eq('id', ref).eq('user_id', userId).maybeSingle())
  if (!data) ({ data } = await supabase.from('projects').select('id, name, slug, prefix').ilike('prefix', ref).eq('user_id', userId).maybeSingle())
  return data
}

// Public "linear.new"-style prefilled task composer (TDE-394): any surface without MCP
// access (email, Slack, another AI product) can hand off work with a plain URL —
// /new?title=...&detail=...&project=...&priority=... — instead of an API call.
export default function NewTaskPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const params = new URLSearchParams(location.search)

  const [checkingAuth, setCheckingAuth] = useState(true)
  const [projects, setProjects] = useState([])
  const [text, setText] = useState(params.get('title') || '')
  const [detail, setDetail] = useState(params.get('detail') || '')
  const [priority, setPriority] = useState(
    PRIORITIES.some(p => p.value === params.get('priority')) ? params.get('priority') : null
  )
  const [projectId, setProjectId] = useState('')
  const [projectNotFound, setProjectNotFound] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    async function load() {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) {
        navigate(`/login?next=${encodeURIComponent(location.pathname + location.search)}`, { replace: true })
        return
      }
      const { data: projectList } = await supabase.from('projects').select('id, name, slug, prefix').order('created_at')
      setProjects(projectList || [])

      const projectRef = params.get('project')
      if (projectRef) {
        const match = await resolveProject(session.user.id, projectRef)
        if (match) setProjectId(match.id)
        else { setProjectNotFound(true); setProjectId(projectList?.[0]?.id ?? '') }
      } else {
        setProjectId(projectList?.[0]?.id ?? '')
      }
      setCheckingAuth(false)
    }
    load()
  }, [])

  async function handleSave(e) {
    e.preventDefault()
    if (!text.trim() || !projectId || saving) return
    setSaving(true)
    setError('')
    try {
      const { data: { user } } = await supabase.auth.getUser()
      const sectionId = await getOrCreateBacklogSectionId(projectId)
      const { count } = await supabase
        .from('tasks')
        .select('id', { count: 'exact', head: true })
        .eq('project_id', projectId)
        .eq('section_id', sectionId)
      const { data: newTask, error: insertError } = await supabase.from('tasks').insert({
        project_id: projectId,
        section_id: sectionId,
        user_id: user.id,
        text: text.trim(),
        detail: detail.trim() || null,
        priority: priority || null,
        status: 'pending',
        sort_order: count ?? 0,
      }).select().single()
      if (insertError) throw insertError

      const project = projects.find(p => p.id === projectId)
      navigate(`/dashboard/${project?.slug ?? projectId}?task=${newTask.id}`, { replace: true })
    } catch (err) {
      setError(err.message)
      setSaving(false)
    }
  }

  if (checkingAuth) {
    return (
      <div className="min-h-screen bg-paper flex items-center justify-center">
        <p className="text-[13px] text-mute">Loading…</p>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-paper flex flex-col items-center justify-center p-6">
      <div className="mb-6 text-center">
        <div className="inline-flex items-center gap-2 mb-2">
          <span style={{ color: '#D97757', fontSize: 18, fontWeight: 700 }}>✦</span>
          <h1 className="text-[24px] font-extrabold text-ink tracking-tight">Tasker</h1>
        </div>
        <p className="text-[13px] text-mute">New task</p>
      </div>

      <div className="w-full max-w-[440px] bg-paper border border-line rounded-xl shadow-card p-6">
        <form onSubmit={handleSave} className="flex flex-col gap-4">
          <div>
            <label className="text-[11px] font-semibold text-mute uppercase tracking-wide mb-1 block">Task</label>
            <input
              value={text}
              onChange={e => setText(e.target.value)}
              autoFocus
              placeholder="What needs doing?"
              className="w-full bg-surf-2 rounded-lg px-3 py-2.5 text-[13px] text-ink outline-none border border-line focus:border-ink transition-colors placeholder:text-mute-2"
            />
          </div>

          <div>
            <label className="text-[11px] font-semibold text-mute uppercase tracking-wide mb-1 block">Project</label>
            <select
              value={projectId}
              onChange={e => { setProjectId(e.target.value); setProjectNotFound(false) }}
              className="w-full bg-surf-2 rounded-lg px-3 py-2.5 text-[13px] text-ink outline-none border border-line focus:border-ink transition-colors"
            >
              {projects.length === 0 && <option value="">No projects yet</option>}
              {projects.map(p => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
            {projectNotFound && (
              <p className="text-[11px] text-mute mt-1">
                Couldn't find project "{params.get('project')}" — pick one instead.
              </p>
            )}
          </div>

          <div>
            <label className="text-[11px] font-semibold text-mute uppercase tracking-wide mb-1 block">Notes</label>
            <textarea
              value={detail}
              onChange={e => setDetail(e.target.value)}
              rows={3}
              placeholder="Additional context…"
              className="w-full bg-surf-2 rounded-lg px-3 py-2.5 text-[13px] text-ink outline-none border border-line focus:border-ink transition-colors resize-none placeholder:text-mute-2"
            />
          </div>

          <div>
            <label className="text-[11px] font-semibold text-mute uppercase tracking-wide mb-1 block">Priority</label>
            <div className="flex gap-1 flex-wrap">
              {PRIORITIES.map(p => (
                <button
                  key={String(p.value)}
                  type="button"
                  onClick={() => setPriority(p.value)}
                  className={`px-3 py-1 rounded-pill text-[12px] border transition-all ${
                    priority === p.value
                      ? 'bg-ink text-paper border-transparent'
                      : 'border-line text-mute hover:bg-surf-2'
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          {error && <p className="text-[12px] text-red-500 -mt-1">{error}</p>}

          <button
            type="submit"
            disabled={!text.trim() || !projectId || saving}
            className="w-full mt-1 h-10 bg-ink text-paper rounded-md text-[13px] font-semibold tracking-tight transition-all duration-150 hover:bg-ink-2 disabled:opacity-40 disabled:pointer-events-none"
          >
            {saving ? 'Creating…' : 'Create task'}
          </button>
        </form>
      </div>
    </div>
  )
}