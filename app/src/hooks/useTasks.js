import { useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { useTaskStore } from '../store/useTaskStore'

async function checkInputDependency(task, updates) {
  if (!task.input || !['in_progress', 'done'].includes(updates.status)) {
    return null
  }
  const sourceTaskId = task.input.source_task_id
  if (!sourceTaskId) return null

  if (window.__TASKER_LOCAL__) {
    const sourceTask = useTaskStore.getState().tasks.find(t => t.id === sourceTaskId)
    if (sourceTask && sourceTask.status !== 'done') {
      return {
        sourceTaskName: sourceTask.text,
        message: `This task depends on "${sourceTask.text}" being complete. Complete it first for proper workflow.`
      }
    }
    return null
  }

  const { data: sourceTask } = await supabase.from('tasks').select('text, status').eq('id', sourceTaskId).maybeSingle()
  if (sourceTask && sourceTask.status !== 'done') {
    return {
      sourceTaskName: sourceTask.text,
      message: `This task depends on "${sourceTask.text}" being complete. Complete it first for proper workflow.`
    }
  }
  return null
}

export async function updateTaskFields(taskId, updates, onDependencyWarning = null) {
  const task = useTaskStore.getState().tasks.find(t => t.id === taskId)
  if (!task) return

  if (updates.status && ['in_progress', 'done'].includes(updates.status)) {
    const dependency = await checkInputDependency(task, updates)
    if (dependency && onDependencyWarning) {
      onDependencyWarning(dependency)
      return
    }
  }

  useTaskStore.getState().updateTask(taskId, updates)
  if (window.__TASKER_LOCAL__) {
    await fetch(`/api/tasks/${taskId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    })
  } else {
    await supabase.from('tasks').update(updates).eq('id', taskId)
  }
}

export async function updateSectionFields(sectionId, updates) {
  useTaskStore.getState().updateSection(sectionId, updates)
  await supabase.from('sections').update(updates).eq('id', sectionId)
}

export async function updateGroupName(groupId, name) {
  useTaskStore.getState().updateGroup(groupId, { name })
  await supabase.from('groups').update({ name }).eq('id', groupId)
}

// Resolves a project's "Backlog" section, creating it if the project predates that convention
// (or it was renamed/deleted) — never returns null, so callers always have a real section to
// target instead of writing section_id: null (which the board can't render — see TDE-369).
export async function getOrCreateBacklogSectionId(projectId) {
  const { data: existing } = await supabase
    .from('sections').select('id').eq('project_id', projectId).eq('name', 'Backlog')
    .order('sort_order').limit(1).maybeSingle()
  if (existing) return existing.id

  const { count } = await supabase.from('sections')
    .select('id', { count: 'exact', head: true }).eq('project_id', projectId)
  const { data: created } = await supabase.from('sections')
    .insert({ project_id: projectId, name: 'Backlog', sort_order: count ?? 0 })
    .select().single()
  return created?.id ?? null
}

export function useTasks(projectId) {
  const {
    tasks, sections, groups,
    setTasks, setSections, setGroups,
    setActiveProjectId, updateTask, addTask, addSection, addGroup,
    removeTask, removeGroup, removeSection,
    moveTask: moveTaskInStore,
    pinTaskInStore,
  } = useTaskStore()

  useEffect(() => {
    // In local mode the store is already populated by useLocalProject — skip Supabase.
    if (window.__TASKER_LOCAL__) return
    if (!projectId) return
    setActiveProjectId(projectId)

    const cacheKey = `tasker-board-${projectId}`
    try {
      const cached = JSON.parse(localStorage.getItem(cacheKey) || 'null')
      if (cached) {
        setSections(cached.sections || [])
        setTasks(cached.tasks || [])
        setGroups(cached.groups || [])
      }
    } catch {}

    async function fetchAll() {
      const [{ data: secs }, { data: tsks }] = await Promise.all([
        supabase.from('sections').select('*').eq('project_id', projectId).order('sort_order'),
        supabase.from('tasks').select('*, task_statuses(status_id, status:project_statuses(id, name, color, base_status))').eq('project_id', projectId).is('is_deleted', false).order('sort_order'),
      ])
      if (secs) setSections(secs)
      if (tsks) setTasks(tsks)

      let grps = []
      if (secs?.length) {
        const { data } = await supabase
          .from('groups')
          .select('*')
          .in('section_id', secs.map(s => s.id))
          .order('sort_order')
        grps = data || []
      }
      setGroups(grps)

      try {
        localStorage.setItem(cacheKey, JSON.stringify({ sections: secs || [], tasks: tsks || [], groups: grps }))
      } catch {}
    }

    fetchAll()

    const sub = supabase
      .channel(`tasks-${projectId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tasks', filter: `project_id=eq.${projectId}` }, payload => {
        if (payload.eventType === 'INSERT') addTask(payload.new)
        else if (payload.eventType === 'UPDATE') updateTask(payload.new.id, payload.new)
        else fetchAll()
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'sections', filter: `project_id=eq.${projectId}` }, fetchAll)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'groups', filter: `project_id=eq.${projectId}` }, fetchAll)
      // Supabase drops server-side-FILTERED DELETE events, so the filtered listeners above
      // miss deletions (creates/updates come through fine). Subscribe to DELETEs WITHOUT a
      // filter — RLS still scopes them — and narrow to this project client-side via the old row.
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'tasks' }, payload => { if (payload.old?.id) removeTask(payload.old.id) })
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'sections' }, payload => { if (payload.old?.project_id === projectId) fetchAll() })
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'groups' }, payload => { if (payload.old?.project_id === projectId) fetchAll() })
      .subscribe()

    return () => sub.unsubscribe()
  }, [projectId])

  async function toggleDone(task) {
    const nowDone = task.status !== 'done'
    const updates = {
      status: nowDone ? 'done' : 'pending',
      completed_at: nowDone ? new Date().toISOString() : null,
      ...(nowDone && task.pinned ? { pinned: false } : {}),
    }
    updateTask(task.id, updates)
    if (window.__TASKER_LOCAL__) {
      await fetch(`/api/tasks/${task.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: updates.status }),
      })
    } else {
      await supabase.from('tasks').update(updates).eq('id', task.id)
    }
  }

  async function toggleInProgress(task, onDependencyWarning = null) {
    const nowIP = task.status !== 'in_progress'
    const updates = { status: nowIP ? 'in_progress' : 'pending' }

    // Check for input dependency when starting work
    if (nowIP && task.input) {
      const sourceTaskId = task.input.source_task_id
      if (sourceTaskId) {
        if (window.__TASKER_LOCAL__) {
          const sourceTask = useTaskStore.getState().tasks.find(t => t.id === sourceTaskId)
          if (sourceTask && sourceTask.status !== 'done') {
            if (onDependencyWarning) { onDependencyWarning({ sourceTaskName: sourceTask.text }); return }
          }
        } else {
          const { data: sourceTask } = await supabase.from('tasks').select('text, status').eq('id', sourceTaskId).maybeSingle()
          if (sourceTask && sourceTask.status !== 'done') {
            if (onDependencyWarning) { onDependencyWarning({ sourceTaskName: sourceTask.text }); return }
          }
        }
      }
    }

    updateTask(task.id, updates)
    if (window.__TASKER_LOCAL__) {
      await fetch(`/api/tasks/${task.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      })
    } else {
      await supabase.from('tasks').update(updates).eq('id', task.id)
    }
  }

  async function createTask(sectionId, text, groupId = null, extras = {}) {
    const sortOrder = tasks.filter(t => t.section_id === sectionId && t.group_id === (groupId ?? null)).length
    const { data: { user } } = await supabase.auth.getUser()
    const { data: newTask } = await supabase.from('tasks').insert({
      project_id: projectId,
      section_id: sectionId,
      group_id: groupId ?? null,
      text,
      sort_order: sortOrder,
      user_id: user.id,
      ...extras,
    }).select().single()
    if (newTask) addTask(newTask)
    return newTask
  }

  async function createSection(name) {
    const sortOrder = sections.length
    const { data: newSection } = await supabase.from('sections').insert({
      project_id: projectId,
      name,
      sort_order: sortOrder,
    }).select().single()
    if (newSection) addSection(newSection)
    return newSection
  }

  async function createGroup(sectionId, name) {
    const sortOrder = groups.filter(g => g.section_id === sectionId).length
    const { data: newGroup } = await supabase.from('groups').insert({
      project_id: projectId,
      section_id: sectionId,
      name,
      sort_order: sortOrder,
    }).select().single()
    if (newGroup) addGroup(newGroup)
  }

  async function createGroupWithTasks(sectionId, groupName, taskList) {
    const sortOrder = groups.filter(g => g.section_id === sectionId).length
    const { data: { user } } = await supabase.auth.getUser()
    const { data: newGroup } = await supabase.from('groups').insert({
      project_id: projectId,
      section_id: sectionId,
      name: groupName,
      sort_order: sortOrder,
    }).select().single()
    if (!newGroup) return
    addGroup(newGroup)

    const rows = taskList.map((t, i) => ({
      project_id: projectId,
      section_id: sectionId,
      group_id: newGroup.id,
      text: typeof t === 'string' ? t : t.text,
      priority: typeof t === 'object' ? (t.priority || null) : null,
      sort_order: i,
      user_id: user.id,
    }))
    const { data: newTasks } = await supabase.from('tasks').insert(rows).select()
    if (newTasks) newTasks.forEach(t => addTask(t))
  }

  async function deleteTask(taskId) {
    removeTask(taskId)
    await supabase.from('tasks').update({ is_deleted: true, deleted_at: new Date().toISOString() }).eq('id', taskId)
  }

  async function hardDeleteTask(taskId) {
    await Promise.all([
      supabase.from('task_discussions').delete().eq('task_id', taskId),
      supabase.from('tasks').delete().eq('id', taskId),
    ])
  }

  async function restoreTask(taskId) {
    await supabase.from('tasks').update({ is_deleted: false, deleted_at: null }).eq('id', taskId)
  }

  async function deleteGroup(groupId) {
    removeGroup(groupId)
    await supabase.from('tasks').delete().eq('group_id', groupId)
    await supabase.from('groups').delete().eq('id', groupId)
  }

  async function deleteSection(sectionId) {
    removeSection(sectionId)
    await Promise.all([
      supabase.from('tasks').delete().eq('section_id', sectionId),
      supabase.from('groups').delete().eq('section_id', sectionId),
      supabase.from('sections').delete().eq('id', sectionId),
    ])
  }

  // TDE-886: critical is a multi-select marker. This used to clear every pin in the project
  // before setting one, so marking a second task silently unmarked the first.
  async function pinTask(taskId) {
    const currentTask = tasks.find(t => t.id === taskId)
    const nowPinned = !currentTask?.pinned
    const now = new Date().toISOString()
    pinTaskInStore(taskId, nowPinned ? now : null)
    await supabase.from('tasks').update({
      pinned: nowPinned,
      pinned_at: nowPinned ? now : null,
      pin_snoozed: false,
    }).eq('id', taskId)
  }

  async function reorderTasks(orderedTasks) {
    // Optimistically write the new sort_order onto each task in the store.
    // The board renders lists sorted by sort_order, so updating the field
    // (not just array position) makes the reorder show immediately.
    const store = useTaskStore.getState()
    orderedTasks.forEach((t, i) => store.updateTask(t.id, { sort_order: i }))
    await Promise.all(orderedTasks.map((t, i) =>
      supabase.from('tasks').update({ sort_order: i }).eq('id', t.id)
    ))
  }

  async function moveTask(taskId, toSectionId, toGroupId) {
    moveTaskInStore(taskId, toSectionId, toGroupId ?? null)
    await supabase.from('tasks').update({
      section_id: toSectionId,
      group_id: toGroupId ?? null,
    }).eq('id', taskId)
  }

  async function reorderSections(orderedSections) {
    setSections(orderedSections.map((s, i) => ({ ...s, sort_order: i })))
    await Promise.all(orderedSections.map((s, i) =>
      supabase.from('sections').update({ sort_order: i }).eq('id', s.id)
    ))
  }

  return { tasks, sections, groups, toggleDone, toggleInProgress, pinTask, createTask, createSection, createGroup, createGroupWithTasks, deleteTask, hardDeleteTask, restoreTask, deleteGroup, deleteSection, reorderTasks, reorderSections, moveTask }
}
