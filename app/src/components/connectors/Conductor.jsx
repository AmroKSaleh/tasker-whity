import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import clsx from 'clsx'
import { supabase } from '../../lib/supabase'
import { Kicker } from '../editorial/atoms'

const PRIORITIES = ['rush', 'high', 'medium', 'low']
const PRIORITY_DOT = { rush: '#C0432D', high: '#D9822B', medium: '#3a7bd5', low: '#8a8f98' }

// Resolve a section by name within a project, creating it if missing. null if no name.
async function resolveOrCreateSection(projectId, name) {
  if (!name) return null
  const { data: existing } = await supabase.from('sections').select('id').eq('project_id', projectId).eq('name', name).maybeSingle()
  if (existing) return existing.id
  const { data: last } = await supabase.from('sections').select('sort_order').eq('project_id', projectId).order('sort_order', { ascending: false }).limit(1).maybeSingle()
  const sortOrder = ((last?.sort_order) ?? -1) + 1
  const { data } = await supabase.from('sections').insert({ project_id: projectId, name, sort_order: sortOrder }).select('id').single()
  return data?.id ?? null
}

const fromResult = t => ({
  title: t.title || '', context: t.context || '', section: t.section || '',
  priority: PRIORITIES.includes(t.priority) ? t.priority : 'medium',
  milestones: Array.isArray(t.milestones) ? t.milestones : [],
})

// One parked job: the agent's analysis + editable proposals. Import creates the tasks,
// links them back to this job (provenance), and moves the job to 'imported' (placed).
function ParkedJob({ job, projects, defaultProjectId, expanded, onToggle, onImported }) {
  const [tasks, setTasks] = useState(() => (job.result?.tasks || []).map(fromResult))
  const [projectId, setProjectId] = useState(defaultProjectId || projects[0]?.id || '')
  const [importing, setImporting] = useState(false)
  const subject = job.payload?.subject || 'Intake'
  const analysis = job.result?.analysis || ''

  const setTask = (i, patch) => setTasks(ts => ts.map((t, j) => j === i ? { ...t, ...patch } : t))
  const setMs = (ti, mi, v) => setTasks(ts => ts.map((t, j) => j === ti ? { ...t, milestones: t.milestones.map((m, k) => k === mi ? v : m) } : t))
  const addMs = ti => setTasks(ts => ts.map((t, j) => j === ti ? { ...t, milestones: [...t.milestones, ''] } : t))
  const delMs = (ti, mi) => setTasks(ts => ts.map((t, j) => j === ti ? { ...t, milestones: t.milestones.filter((_, k) => k !== mi) } : t))
  const delTask = i => setTasks(ts => ts.filter((_, j) => j !== i))

  async function importTasks() {
    if (!projectId || !tasks.length) return
    setImporting(true)
    try {
      const { data: { user } } = await supabase.auth.getUser()
      for (const t of tasks) {
        const section_id = await resolveOrCreateSection(projectId, t.section?.trim())
        const { data: newTask } = await supabase.from('tasks').insert({
          user_id: user.id, project_id: projectId, section_id,
          text: t.title?.trim() || '(untitled)', detail: t.context || null,
          priority: t.priority || 'medium', status: 'pending',
          intake_source: job.source, intake_job_id: job.id,
        }).select('id').single()
        if (newTask) {
          for (const m of (t.milestones || []).map(x => x.trim()).filter(Boolean)) {
            await supabase.rpc('append_milestone', { p_task_id: newTask.id, p_user_id: user.id, p_text: m })
          }
        }
      }
      await supabase.from('intake_jobs').update({ status: 'imported', updated_at: new Date().toISOString() }).eq('id', job.id)
      onImported?.()
    } finally {
      setImporting(false)
    }
  }

  return (
    <div className="rounded-xl border border-line-2 bg-paper overflow-hidden shadow-sm">
      <button onClick={onToggle} className="w-full flex items-center gap-2 px-3 py-2.5 text-left hover:bg-surf-2">
        <span className={clsx('text-[13px] font-medium text-ink flex-1 min-w-0', !expanded && 'truncate')}>{subject}</span>
        <span className="text-[10px] font-mono text-mute-2 shrink-0">{tasks.length} task{tasks.length !== 1 ? 's' : ''}</span>
      </button>
      {expanded && (
        <div className="px-3 pb-3 flex flex-col gap-3 border-t border-line-2 pt-3">
          {analysis && <p className="text-[12px] text-ink-2 leading-relaxed whitespace-pre-wrap">{analysis}</p>}
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-mute-2">Import into</span>
            <select value={projectId} onChange={e => setProjectId(e.target.value)} className="bg-surf-2 border border-line rounded-lg px-2.5 py-1.5 text-[12px] text-ink outline-none focus:border-ink">
              {projects.map(p => <option key={p.id} value={p.id}>{p.prefix ? `${p.prefix} · ` : ''}{p.name}</option>)}
            </select>
          </div>
          {tasks.map((t, i) => (
            <div key={i} className="rounded-lg border border-line-2 p-2.5 flex flex-col gap-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[10px] font-mono text-mute-2">TASK {i + 1}</span>
                <button onClick={() => delTask(i)} className="text-[11px] text-mute hover:text-[#C0432D]">Remove</button>
              </div>
              <input value={t.title} onChange={e => setTask(i, { title: e.target.value })} placeholder="Title" className="bg-paper border border-line rounded-lg px-2.5 py-1.5 text-[13px] font-medium text-ink outline-none focus:border-ink" />
              <textarea value={t.context} onChange={e => setTask(i, { context: e.target.value })} placeholder="Context" rows={2} className="bg-paper border border-line rounded-lg px-2.5 py-1.5 text-[12px] text-ink-2 outline-none focus:border-ink resize-y" />
              <div className="flex gap-2">
                <input value={t.section} onChange={e => setTask(i, { section: e.target.value })} placeholder="Section (optional)" className="flex-1 min-w-0 bg-paper border border-line rounded-lg px-2.5 py-1.5 text-[12px] text-ink outline-none focus:border-ink" />
                <select value={t.priority} onChange={e => setTask(i, { priority: e.target.value })} className="bg-paper border border-line rounded-lg px-2 py-1.5 text-[12px] text-ink outline-none focus:border-ink">
                  {PRIORITIES.map(p => <option key={p} value={p}>{p}</option>)}
                </select>
              </div>
              <div>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[10px] font-mono text-mute-2">MILESTONES</span>
                  <button onClick={() => addMs(i)} className="text-[11px] text-accent hover:opacity-70">+ Add</button>
                </div>
                <div className="flex flex-col gap-1.5">
                  {t.milestones.map((m, k) => (
                    <div key={k} className="flex gap-1.5">
                      <input value={m} onChange={e => setMs(i, k, e.target.value)} className="flex-1 min-w-0 bg-paper border border-line rounded-lg px-2.5 py-1 text-[12px] text-ink-2 outline-none focus:border-ink" />
                      <button onClick={() => delMs(i, k)} className="text-[12px] text-mute hover:text-[#C0432D] px-1">×</button>
                    </div>
                  ))}
                  {!t.milestones.length && <p className="text-[11px] text-mute-2">None.</p>}
                </div>
              </div>
            </div>
          ))}
          {!tasks.length && <p className="text-[12px] text-mute-2">No proposed tasks. Nothing to import.</p>}
          {tasks.length > 0 && (
            <button onClick={importTasks} disabled={importing || !projectId} className="self-end rounded-lg bg-ink text-paper px-3.5 py-1.5 text-[12px] font-semibold disabled:opacity-50">
              {importing ? 'Importing…' : `Import ${tasks.length} task${tasks.length !== 1 ? 's' : ''}`}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

// The Conductor: a docked, always-present column inside a connector page. Scoped to
// one `source` so captures never mix across connectors. Tabs follow the intake_job
// lifecycle: in-flight → parked → placed.
export default function Conductor({ source, projects, defaultProjectId }) {
  const navigate = useNavigate()
  const [tab, setTab] = useState('parked')
  const [jobs, setJobs] = useState([])
  const [placed, setPlaced] = useState([])
  const [openJobId, setOpenJobId] = useState(null)
  const [showDone, setShowDone] = useState(false)

  const loadJobs = useCallback(async () => {
    const { data } = await supabase.from('intake_jobs').select('*').eq('source', source).order('created_at', { ascending: false })
    setJobs(data || [])
  }, [source])

  const loadPlaced = useCallback(async () => {
    const { data } = await supabase.from('tasks')
      .select('id, text, status, priority, project_id, projects(slug, name)')
      .eq('intake_source', source).order('created_at', { ascending: false })
    setPlaced(data || [])
  }, [source])

  useEffect(() => {
    let cancelled = false
    loadJobs(); loadPlaced()
    const channel = supabase.channel(`conductor-${source}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'intake_jobs', filter: `source=eq.${source}` }, () => { if (!cancelled) { loadJobs(); loadPlaced() } })
      .subscribe()
    return () => { cancelled = true; supabase.removeChannel(channel) }
  }, [source, loadJobs, loadPlaced])

  const importing = jobs.filter(j => j.status === 'pending' || j.status === 'processing' || j.status === 'error')
  const parked = jobs.filter(j => j.status === 'ready' || j.status === 'done')   // 'done' = legacy parked
  const placedShown = showDone ? placed : placed.filter(t => t.status !== 'done')

  // "Importing" is a live, non-clickable status tab: it surfaces itself while a
  // capture is in the pipeline (pending/processing/error), then hands back to Parked
  // once the agent's proposals are ready.
  const surfacing = importing.length
  useEffect(() => {
    if (surfacing > 0) setTab('importing')
    else setTab(t => (t === 'importing' ? 'parked' : t))
  }, [surfacing])

  const TABS = [
    { key: 'live', label: 'In-flight', count: placed.length },                       // imported tasks now in projects
    { key: 'parked', label: 'Parked', count: parked.length },                        // structured, awaiting import
    { key: 'importing', label: 'Importing', count: importing.length, locked: true }, // live; auto-surfaces, not clickable
  ]

  return (
    <div className="hidden lg:flex flex-col flex-1 min-w-[360px] min-h-[420px] rounded-2xl border border-line bg-surf-2 shadow-sm overflow-hidden sticky top-8 self-start max-h-[calc(100vh-4rem)]">
      <div className="px-4 pt-5 pb-3 border-b border-line-2 shrink-0">
        <Kicker className="mb-1">CONDUCTOR</Kicker>
        <div className="flex gap-1">
          {TABS.map(t => {
            const isActive = tab === t.key
            return (
              <button key={t.key}
                onClick={t.locked ? undefined : () => setTab(t.key)}
                disabled={t.locked}
                title={t.locked ? 'Opens automatically while a capture is being processed' : undefined}
                className={clsx('flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[12px] font-medium transition-colors',
                  isActive ? 'bg-surf text-ink' : t.locked ? 'text-mute-2/60 cursor-default' : 'text-mute hover:text-ink hover:bg-surf-2')}>
                {t.locked && t.count > 0 && <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse shrink-0" />}
                {t.label}
                {t.count > 0 && <span className={clsx('rounded-full px-1.5 text-[10px] font-mono', isActive ? 'bg-ink text-paper' : 'bg-surf-2 text-mute-2')}>{t.count}</span>}
              </button>
            )
          })}
        </div>
      </div>

      <div className="flex-1 overflow-auto px-4 py-4 no-scrollbar flex flex-col gap-2.5">
        {tab === 'importing' && (
          importing.length === 0
            ? <p className="text-[12px] text-mute-2">Nothing being imported right now. This tab opens on its own when a capture is processing.</p>
            : importing.map(j => {
              const subject = j.payload?.subject || 'Intake'
              if (j.status === 'error') return (
                <div key={j.id} className="rounded-xl border border-[#C0432D]/40 bg-[#C0432D]/5 px-3 py-2.5">
                  <p className="text-[13px] text-ink font-medium truncate">{subject}</p>
                  <p className="text-[12px] text-ink-2 mt-0.5">{j.error || 'Your agent reported an error.'}</p>
                </div>
              )
              const processing = j.status === 'processing'
              return (
                <div key={j.id} className={clsx('rounded-xl border bg-paper px-3 py-2.5 shadow-sm', processing ? 'border-accent/40' : 'border-line-2')}>
                  <p className="text-[13px] text-ink font-medium truncate flex items-center gap-2">
                    {processing && <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse shrink-0" />}{subject}
                  </p>
                  <p className="text-[11.5px] text-mute-2 mt-0.5 leading-relaxed">
                    {processing ? 'Your agent is structuring this — appears in Parked when done.' : <>Waiting for your agent. Say <span className="font-mono text-ink-2">process intake</span> in CC.</>}
                  </p>
                </div>
              )
            })
        )}

        {tab === 'parked' && (
          parked.length === 0
            ? <p className="text-[12px] text-mute-2">Nothing parked. Structured intakes land here for you to review &amp; import.</p>
            : parked.map(j => (
              <ParkedJob key={j.id} job={j} projects={projects} defaultProjectId={defaultProjectId}
                expanded={openJobId === j.id} onToggle={() => setOpenJobId(id => id === j.id ? null : j.id)}
                onImported={() => { setOpenJobId(null); loadJobs(); loadPlaced(); setTab('live') }} />
            ))
        )}

        {tab === 'live' && (
          <>
            <label className="flex items-center gap-1.5 text-[11px] text-mute-2 cursor-pointer self-start">
              <input type="checkbox" checked={showDone} onChange={e => setShowDone(e.target.checked)} className="accent-ink" />
              Show done tasks
            </label>
            {placedShown.length === 0
              ? <p className="text-[12px] text-mute-2">{placed.length ? 'All imported tasks are done.' : 'No tasks imported from here yet.'}</p>
              : placedShown.map(t => (
                <button key={t.id} onClick={() => t.projects?.slug && navigate(`/dashboard/${t.projects.slug}?task=${t.id}`)}
                  className="rounded-xl border border-line-2 bg-paper px-3 py-2.5 text-left hover:bg-surf transition-colors shadow-sm">
                  <div className="flex items-center gap-2">
                    <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: PRIORITY_DOT[t.priority] || PRIORITY_DOT.low }} />
                    <span className={clsx('text-[13px] flex-1 min-w-0 truncate', t.status === 'done' ? 'text-mute-2 line-through' : 'text-ink')}>{t.text}</span>
                  </div>
                  <p className="text-[11px] text-mute-2 mt-0.5 ml-3.5">{t.projects?.name || '—'} · {t.status === 'in_progress' ? 'in progress' : t.status}</p>
                </button>
              ))}
          </>
        )}
      </div>
    </div>
  )
}
