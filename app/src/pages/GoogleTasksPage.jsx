import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import clsx from 'clsx'
import { ListChecks, RefreshCw, ArrowDownToLine, ChevronRight, X, Sparkles } from 'lucide-react'
import { supabase } from '../lib/supabase'
import AppShell from '../components/editorial/AppShell'
import Breadcrumbs from '../components/layout/Breadcrumbs'
import Conductor from '../components/connectors/Conductor'
import { loadGoogleConnection, hasGoogleScope } from '../lib/google'
import { GOOGLE_SCOPES } from '../lib/google'

async function callGoogleTasks(session, body) {
  const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/google-tasks`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await res.json()
  if (!res.ok || data.error) throw new Error(data.error ?? 'Request failed')
  return data
}

function formatDue(due) {
  if (!due) return null
  return due.slice(0, 10)
}

export default function GoogleTasksPage() {
  const navigate = useNavigate()
  const [connected, setConnected] = useState(null)
  const [lists, setLists] = useState([])
  const [selectedList, setSelectedList] = useState(null)
  const [tasks, setTasks] = useState([])
  const [loadingLists, setLoadingLists] = useState(false)
  const [loadingTasks, setLoadingTasks] = useState(false)
  const [error, setError] = useState(null)

  // Pull modal state
  const [pullTarget, setPullTarget] = useState(null)
  const [projects, setProjects] = useState([])
  const [sections, setSections] = useState([])
  const [selectedProject, setSelectedProject] = useState('')
  const [selectedSection, setSelectedSection] = useState('')
  const [loadingSections, setLoadingSections] = useState(false)
  const [pulling, setPulling] = useState(false)
  const [pulledIds, setPulledIds] = useState(new Set())
  const [sending, setSending] = useState({})          // google-task id -> bool (creating intake job)

  useEffect(() => {
    supabase.auth.getUser().then(async ({ data: { user } }) => {
      if (!user) return
      const conn = await loadGoogleConnection(user.id)
      const ok = hasGoogleScope(conn, GOOGLE_SCOPES.tasks)
      setConnected(ok)
    })
    // Load projects up front so the docked Conductor has them (also reused by the Pull modal).
    supabase.from('projects').select('id, name, prefix').order('created_at').then(({ data }) => {
      if (data) setProjects(data)
    })
  }, [])

  // + Task → capture the Google task as a pending intake job. It surfaces in the docked
  // Conductor (In-flight → Parked once the agent structures it → import into a project).
  async function createIntakeJob(task) {
    setSending(s => ({ ...s, [task.id]: true }))
    try {
      const { data: { user } } = await supabase.auth.getUser()
      await supabase.from('intake_jobs').insert({
        user_id: user.id,
        source: 'google_tasks',
        payload: {
          subject: task.title || '(untitled)',
          body: task.notes || '',
          due: task.due || null,
          list: selectedList?.title || null,
        },
        status: 'pending',
      })
    } finally {
      setSending(s => ({ ...s, [task.id]: false }))
    }
  }

  async function fetchLists() {
    setLoadingLists(true)
    setError(null)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const data = await callGoogleTasks(session, { action: 'lists' })
      setLists(data.lists)
      if (data.lists.length) {
        setSelectedList(data.lists[0])
        await fetchTasks(data.lists[0].id)
      }
    } catch (e) {
      setError(e.message)
    } finally {
      setLoadingLists(false)
    }
  }

  async function fetchTasks(listId) {
    setLoadingTasks(true)
    setTasks([])
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const data = await callGoogleTasks(session, { action: 'tasks', list_id: listId })
      setTasks(data.tasks)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoadingTasks(false)
    }
  }

  useEffect(() => {
    if (connected) fetchLists()
  }, [connected])

  async function openPull(task) {
    setPullTarget(task)
    const { data } = await supabase.from('projects').select('id, name, prefix').order('name')
    const list = data ?? []
    setProjects(list)
    setSelectedSection('')

    // Pick the first project that has at least one section
    let bestId = list[0]?.id ?? ''
    for (const p of list) {
      const { count } = await supabase.from('sections').select('id', { count: 'exact', head: true }).eq('project_id', p.id)
      if (count > 0) { bestId = p.id; break }
    }
    setSelectedProject(bestId)
    if (bestId) loadSections(bestId)
  }

  async function loadSections(projectId) {
    setSelectedSection('')
    setSections([])
    if (!projectId) return
    setLoadingSections(true)
    try {
      const { data, error } = await supabase.from('sections').select('id, name').eq('project_id', projectId).order('sort_order')
      if (error) throw error
      setSections(data ?? [])
      if (data?.length) setSelectedSection(data[0].id)
    } catch {
      setSections([])
    } finally {
      setLoadingSections(false)
    }
  }

  async function confirmPull() {
    if (!pullTarget || !selectedSection) return
    setPulling(true)
    try {
      const { data: { user } } = await supabase.auth.getUser()
      const { data: sectionRow } = await supabase.from('sections').select('project_id').eq('id', selectedSection).maybeSingle()
      const { data: lastTask } = await supabase
        .from('tasks')
        .select('sort_order')
        .eq('section_id', selectedSection)
        .order('sort_order', { ascending: false })
        .limit(1)
        .maybeSingle()

      const insert = {
        text: pullTarget.title || 'Untitled',
        section_id: selectedSection,
        project_id: sectionRow?.project_id,
        user_id: user.id,
        status: 'pending',
        sort_order: (lastTask?.sort_order ?? 0) + 1000,
        intake_source: 'google_tasks',
      }
      if (pullTarget.notes) insert.detail = pullTarget.notes
      if (pullTarget.due) insert.due_date = formatDue(pullTarget.due)

      const { error: insertErr } = await supabase.from('tasks').insert(insert)
      if (insertErr) throw new Error(insertErr.message)

      setPulledIds(prev => new Set([...prev, pullTarget.id]))
      setPullTarget(null)
    } catch (e) {
      alert(e.message)
    } finally {
      setPulling(false)
    }
  }

  return (
    <AppShell active="google-tasks">
      <div className="px-7 py-8 md:px-10 flex items-start gap-8 lg:gap-12">
        <div className="w-full max-w-[760px] shrink-0">
        <Breadcrumbs items={[{ label: 'Settings', to: '/settings' }, { label: 'Connectors', to: '/settings' }, { label: 'Google Tasks' }]} />
        <h1 className="text-h1 m-0">Google Tasks.</h1>
        <p className="text-[12px] text-mute-2 mt-1.5 mb-6">
          Your Google task lists, right here. Hit <span className="font-medium text-ink-2">Pull</span> to import a task into a Tasker project.
        </p>

        {connected === null && <p className="text-[13px] text-mute">Checking connection…</p>}

        {connected === false && (
          <div className="rounded-xl border border-line bg-surf-2 px-4 py-3">
            <p className="text-[13px] text-ink">Google Tasks isn't connected yet.</p>
            <button onClick={() => navigate('/settings')} className="mt-2 text-[12px] text-accent hover:opacity-70">
              Connect in Settings →
            </button>
          </div>
        )}

        {connected === true && (
          <div className="flex gap-5">
            {/* List sidebar */}
            <div className="w-44 shrink-0 flex flex-col gap-1">
              <div className="flex items-center justify-between mb-1">
                <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-mute">Lists</span>
                <button
                  onClick={fetchLists}
                  disabled={loadingLists}
                  className="p-1 rounded hover:bg-surf-2 text-mute hover:text-ink-2 transition-colors disabled:opacity-50"
                  title="Refresh"
                >
                  <RefreshCw className={clsx('h-3 w-3', loadingLists && 'animate-spin')} />
                </button>
              </div>
              {lists.length === 0 && !loadingLists && (
                <p className="text-[12px] text-mute">No lists found.</p>
              )}
              {lists.map(list => (
                <button
                  key={list.id}
                  onClick={() => { setSelectedList(list); fetchTasks(list.id) }}
                  className={clsx(
                    'flex items-center gap-1.5 w-full rounded-md px-2.5 py-2 text-left text-[12.5px] transition-colors',
                    selectedList?.id === list.id
                      ? 'bg-accent/10 text-accent font-medium'
                      : 'text-ink-2 hover:bg-surf-2',
                  )}
                >
                  <ListChecks className="h-3 w-3 shrink-0 opacity-60" />
                  <span className="truncate">{list.title}</span>
                </button>
              ))}
            </div>

            {/* Task list */}
            <div className="flex-1 min-w-0">
              {error && (
                <div className="rounded-xl border border-line bg-surf-2 px-4 py-3 mb-4">
                  <p className="text-[13px] text-ink">{error}</p>
                </div>
              )}

              {loadingTasks && <p className="text-[13px] text-mute">Loading tasks…</p>}

              {!loadingTasks && tasks.length === 0 && selectedList && (
                <p className="text-[13px] text-mute">No pending tasks in "{selectedList.title}".</p>
              )}

              {!loadingTasks && tasks.length > 0 && (
                <div className="flex flex-col rounded-xl border border-line bg-surf-2 overflow-hidden shadow-sm">
                  {tasks.map(task => {
                    const pulled = pulledIds.has(task.id)
                    return (
                      <div key={task.id} className="flex items-start gap-3 px-4 py-3 border-b border-line-2 last:border-b-0 hover:bg-surf transition-colors">
                        <div className="flex-1 min-w-0">
                          <p className={clsx('text-[13px] leading-snug', pulled ? 'text-mute line-through' : 'text-ink-2')}>
                            {task.title || '(untitled)'}
                          </p>
                          {task.notes && (
                            <p className="text-[11.5px] text-mute-2 mt-0.5 line-clamp-2">{task.notes}</p>
                          )}
                          {task.due && (
                            <p className="text-[11px] text-mute mt-0.5 font-mono">Due {formatDue(task.due)}</p>
                          )}
                        </div>
                        <div className="flex items-center gap-1.5 shrink-0">
                          <button
                            onClick={() => createIntakeJob(task)}
                            disabled={sending[task.id]}
                            title="Send to your agent to structure into tasks — appears in the Conductor"
                            className="rounded-md border border-line px-2 py-1 text-[11px] font-semibold text-mute hover:text-ink hover:border-ink-2 disabled:opacity-50 transition-colors flex items-center gap-1"
                          >
                            <Sparkles className="h-3 w-3" />
                            {sending[task.id] ? '…' : '+ Task'}
                          </button>
                          <button
                            onClick={() => openPull(task)}
                            disabled={pulled}
                            title="Import directly into a project/section"
                            className="rounded-md border border-line px-2 py-1 text-[11px] font-semibold text-mute hover:text-ink hover:border-ink-2 disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex items-center gap-1"
                          >
                            <ArrowDownToLine className="h-3 w-3" />
                            {pulled ? 'Pulled' : 'Pull'}
                          </button>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </div>
        )}
        </div>
        <Conductor source="google_tasks" projects={projects} defaultProjectId={projects[0]?.id || ''} />
      </div>

      {/* Pull modal */}
      {pullTarget && (
        <>
          <div className="fixed inset-0 z-40 bg-ink/30 animate-fade-in" onClick={() => setPullTarget(null)} />
          <div className="fixed z-50 left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[380px] rounded-xl border border-line bg-paper shadow-sheet p-5 flex flex-col gap-4">
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="font-mono text-[10px] uppercase tracking-[0.1em] text-mute mb-1">Pull to Tasker</p>
                <p className="text-[14px] font-semibold text-ink leading-snug">{pullTarget.title}</p>
              </div>
              <button onClick={() => setPullTarget(null)} className="icon-btn shrink-0">
                <X className="h-3.5 w-3.5" />
              </button>
            </div>

            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-1.5">
                <label className="font-mono text-[10px] uppercase tracking-[0.1em] text-mute">Project</label>
                <select
                  value={selectedProject}
                  onChange={e => { setSelectedProject(e.target.value); loadSections(e.target.value) }}
                  className="rounded-md border border-line-2 bg-surf-2 px-3 py-2 text-[13px] text-ink-2 outline-none focus:border-accent"
                >
                  {projects.map(p => (
                    <option key={p.id} value={p.id}>{p.prefix} · {p.name}</option>
                  ))}
                </select>
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="font-mono text-[10px] uppercase tracking-[0.1em] text-mute">Section</label>
                {loadingSections ? (
                  <p className="text-[12px] text-mute">Loading sections…</p>
                ) : sections.length === 0 ? (
                  <p className="text-[12px] text-mute">No sections in this project — add one first.</p>
                ) : (
                  <select
                    value={selectedSection}
                    onChange={e => setSelectedSection(e.target.value)}
                    className="rounded-md border border-line-2 bg-surf-2 px-3 py-2 text-[13px] text-ink-2 outline-none focus:border-accent"
                  >
                    {sections.map(s => (
                      <option key={s.id} value={s.id}>{s.name}</option>
                    ))}
                  </select>
                )}
              </div>
            </div>

            <button
              onClick={confirmPull}
              disabled={pulling || !selectedSection}
              className="w-full rounded-md border border-accent bg-accent/10 px-4 py-2.5 text-[13px] font-semibold text-accent hover:bg-accent/20 disabled:opacity-50 transition-colors"
            >
              {pulling ? 'Pulling…' : 'Pull task'}
            </button>
          </div>
        </>
      )}
    </AppShell>
  )
}
