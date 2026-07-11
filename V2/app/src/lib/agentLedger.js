import { supabase } from './supabase'

// Client-side mirror of the MCP get_task_activity derivation (TDE-374). Lifecycle state is
// DERIVED at read time from the last activity — never stored — so the web app and the MCP
// agree without a shared column.
const STALE_MS = 24 * 60 * 60 * 1000

export function deriveSessionState(session, activities, taskDone) {
  if (taskDone || session.closed_at) return 'complete'
  const last = activities.length ? activities[activities.length - 1] : null
  if (!last) return 'active'
  if (last.type === 'question') return 'awaiting_input'
  if (last.type === 'error') return 'error'
  return Date.now() - new Date(last.created_at).getTime() < STALE_MS ? 'active' : 'stale'
}

// All sessions for one task, newest first, each with its ordered activities + derived state.
export async function fetchTaskSessions(taskId, taskDone) {
  const { data: sessions } = await supabase
    .from('agent_sessions')
    .select('id, actor, opened_at, last_activity_at, closed_at')
    .eq('task_id', taskId)
    .order('opened_at', { ascending: false })
  if (!sessions?.length) return []
  const { data: acts } = await supabase
    .from('agent_activities')
    .select('session_id, type, body, created_at')
    .eq('task_id', taskId)
    .order('created_at', { ascending: true })
  const bySession = new Map()
  for (const a of acts ?? []) {
    if (!bySession.has(a.session_id)) bySession.set(a.session_id, [])
    bySession.get(a.session_id).push(a)
  }
  return sessions.map(s => {
    const activities = bySession.get(s.id) ?? []
    return { ...s, activities, state: deriveSessionState(s, activities, taskDone) }
  })
}

// From a set of task ids, those with an OPEN session whose last entry is a question
// (i.e. an agent is waiting on the human). Powers the Front Page attention strip (TDE-374 m4).
export async function fetchAwaitingInputTaskIds(taskIds) {
  if (!taskIds?.length) return new Set()
  const { data: sessions } = await supabase
    .from('agent_sessions')
    .select('id, task_id')
    .in('task_id', taskIds)
    .is('closed_at', null)
  if (!sessions?.length) return new Set()
  const sessionIds = sessions.map(s => s.id)
  const { data: acts } = await supabase
    .from('agent_activities')
    .select('session_id, type, created_at')
    .in('session_id', sessionIds)
    .order('created_at', { ascending: true })
  const lastType = new Map()
  for (const a of acts ?? []) lastType.set(a.session_id, a.type) // ascending order → last write wins
  const awaiting = new Set()
  for (const s of sessions) if (lastType.get(s.id) === 'question') awaiting.add(s.task_id)
  return awaiting
}
