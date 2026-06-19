import { useState, useEffect } from 'react'
import { X } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { Kicker } from '../editorial/atoms'

const PRIORITIES = ['rush', 'high', 'medium', 'low']

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

// The "red box": shows the agent's analysis + proposed tasks (editable) for a job,
// updating live via realtime as the agent posts back. Import creates the tasks.
export default function IntakePanel({ jobId, projects, defaultProjectId, onClose, onImported }) {
  const [phase, setPhase] = useState('waiting')   // waiting | ready | error | done
  const [analysis, setAnalysis] = useState('')
  const [errorMsg, setErrorMsg] = useState('')
  const [tasks, setTasks] = useState([])
  const [projectId, setProjectId] = useState(defaultProjectId || projects[0]?.id || '')
  const [subject, setSubject] = useState('')
  const [importing, setImporting] = useState(false)

  function applyJob(row) {
    if (!row) return
    setSubject(row.payload?.subject || '')
    if (row.status === 'done' && row.result) {
      setAnalysis(row.result.analysis || '')
      setTasks((row.result.tasks || []).map(t => ({
        title: t.title || '', context: t.context || '', section: t.section || '',
        priority: PRIORITIES.includes(t.priority) ? t.priority : 'medium',
        milestones: Array.isArray(t.milestones) ? t.milestones : [],
      })))
      setPhase('ready')
    } else if (row.status === 'error') {
      setErrorMsg(row.error || 'Your agent reported an error.')
      setPhase('error')
    } else {
      setPhase('waiting')
    }
  }

  useEffect(() => {
    let cancelled = false
    supabase.from('intake_jobs').select('*').eq('id', jobId).maybeSingle().then(({ data }) => { if (!cancelled) applyJob(data) })
    const channel = supabase.channel(`intake-${jobId}`)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'intake_jobs', filter: `id=eq.${jobId}` }, p => applyJob(p.new))
      .subscribe()
    return () => { cancelled = true; supabase.removeChannel(channel) }
  }, [jobId])

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
        }).select('id').single()
        if (newTask) {
          for (const m of (t.milestones || []).map(x => x.trim()).filter(Boolean)) {
            await supabase.rpc('append_milestone', { p_task_id: newTask.id, p_user_id: user.id, p_text: m })
          }
        }
      }
      await supabase.from('intake_jobs').update({ status: 'done', updated_at: new Date().toISOString() }).eq('id', jobId)
      setPhase('done')
      onImported?.()
    } finally {
      setImporting(false)
    }
  }

  return (
    <>
      <div className="fixed inset-0 z-30 bg-black/20" onClick={onClose} />
      <div className="fixed right-0 top-0 bottom-0 z-40 w-full max-w-[560px] bg-paper border-l border-line-2 flex flex-col shadow-2xl">
        <div className="px-5 pt-5 pb-3 border-b border-line-2 flex items-start justify-between gap-3 shrink-0">
          <div className="min-w-0">
            <Kicker className="mb-1">EMAIL → TASKS</Kicker>
            <h3 className="text-[15px] font-semibold text-ink truncate">{subject || 'Intake'}</h3>
          </div>
          <button onClick={onClose} className="rounded-md p-1.5 text-mute hover:text-ink hover:bg-surf-2 shrink-0"><X size={16} /></button>
        </div>

        <div className="flex-1 overflow-auto px-5 py-4 no-scrollbar">
          {phase === 'waiting' && (
            <div className="rounded-xl border border-line bg-surf-2 px-4 py-4">
              <p className="text-[13px] text-ink font-medium mb-1">Waiting for your agent…</p>
              <p className="text-[12px] text-mute-2 leading-relaxed">In Claude Code (or Cursor), say <span className="font-mono text-ink">process intake</span>. Your agent reads this email, structures tasks, and they appear here to review and import.</p>
            </div>
          )}
          {phase === 'error' && <div className="rounded-xl border border-[#C0432D]/40 bg-[#C0432D]/5 px-4 py-3 text-[13px] text-ink">{errorMsg}</div>}
          {phase === 'done' && <div className="rounded-xl border border-[#4ade80]/40 bg-[#4ade80]/5 px-4 py-3 text-[13px] text-[#3a9d57]">✓ Imported. You can close this.</div>}
          {phase === 'ready' && (
            <div className="flex flex-col gap-4">
              {analysis && (<div><Kicker className="mb-1">ANALYSIS</Kicker><p className="text-[12.5px] text-ink-2 leading-relaxed whitespace-pre-wrap">{analysis}</p></div>)}
              <div className="flex items-center gap-2">
                <span className="text-[11px] text-mute-2">Import into</span>
                <select value={projectId} onChange={e => setProjectId(e.target.value)} className="bg-surf-2 border border-line rounded-lg px-2.5 py-1.5 text-[12px] text-ink outline-none focus:border-ink">
                  {projects.map(p => <option key={p.id} value={p.id}>{p.prefix ? `${p.prefix} · ` : ''}{p.name}</option>)}
                </select>
              </div>
              {tasks.map((t, i) => (
                <div key={i} className="rounded-xl border border-line-2 p-3 flex flex-col gap-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[10px] font-mono text-mute-2">TASK {i + 1}</span>
                    <button onClick={() => delTask(i)} className="text-[11px] text-mute hover:text-[#C0432D]">Remove</button>
                  </div>
                  <input value={t.title} onChange={e => setTask(i, { title: e.target.value })} placeholder="Title" className="bg-paper border border-line rounded-lg px-2.5 py-1.5 text-[13px] font-medium text-ink outline-none focus:border-ink" />
                  <textarea value={t.context} onChange={e => setTask(i, { context: e.target.value })} placeholder="Context" rows={3} className="bg-paper border border-line rounded-lg px-2.5 py-1.5 text-[12px] text-ink-2 outline-none focus:border-ink resize-y" />
                  <div className="flex gap-2">
                    <input value={t.section} onChange={e => setTask(i, { section: e.target.value })} placeholder="Section (optional)" className="flex-1 bg-paper border border-line rounded-lg px-2.5 py-1.5 text-[12px] text-ink outline-none focus:border-ink" />
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
                          <input value={m} onChange={e => setMs(i, k, e.target.value)} className="flex-1 bg-paper border border-line rounded-lg px-2.5 py-1 text-[12px] text-ink-2 outline-none focus:border-ink" />
                          <button onClick={() => delMs(i, k)} className="text-[12px] text-mute hover:text-[#C0432D] px-1">×</button>
                        </div>
                      ))}
                      {!t.milestones.length && <p className="text-[11px] text-mute-2">None.</p>}
                    </div>
                  </div>
                </div>
              ))}
              {!tasks.length && <p className="text-[12px] text-mute-2">Your agent proposed no tasks for this email.</p>}
            </div>
          )}
        </div>

        {phase === 'ready' && tasks.length > 0 && (
          <div className="px-5 py-3 border-t border-line-2 flex justify-end shrink-0">
            <button onClick={importTasks} disabled={importing || !projectId} className="rounded-lg bg-ink text-paper px-4 py-2 text-[13px] font-semibold disabled:opacity-50">
              {importing ? 'Importing…' : `Import ${tasks.length} task${tasks.length !== 1 ? 's' : ''}`}
            </button>
          </div>
        )}
      </div>
    </>
  )
}
