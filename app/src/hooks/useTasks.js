import { useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { useTaskStore } from '../store/useTaskStore'

export async function updateTaskFields(taskId, updates) {
  const payload = { ...updates, updated_at: new Date().toISOString() }
  useTaskStore.getState().updateTask(taskId, payload)
  await supabase.from('tasks').update(payload).eq('id', taskId)
}

export async function updateGroupName(groupId, name) {
  useTaskStore.getState().updateGroup(groupId, { name })
  await supabase.from('groups').update({ name }).eq('id', groupId)
}

export function useTasks(projectId) {
  const {
    tasks, sections, groups,
    setTasks, setSections, setGroups,
    setActiveProjectId, updateTask, addTask, addSection, addGroup,
    removeTask, removeGroup, removeSection,
  } = useTaskStore()

  useEffect(() => {
    if (!projectId) return
    setActiveProjectId(projectId)

    async function fetchAll() {
      const [{ data: secs }, { data: tsks }] = await Promise.all([
        supabase.from('sections').select('*').eq('project_id', projectId).order('position'),
        supabase.from('tasks').select('*').eq('project_id', projectId).order('position'),
      ])
      if (secs) setSections(secs)
      if (tsks) setTasks(tsks)

      if (secs?.length) {
        const { data: grps } = await supabase
          .from('groups')
          .select('*')
          .in('section_id', secs.map(s => s.id))
          .order('position')
        setGroups(grps || [])
      } else {
        setGroups([])
      }
    }

    fetchAll()

    const sub = supabase
      .channel(`tasks-${projectId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'tasks', filter: `project_id=eq.${projectId}` },
        payload => {
          if (payload.eventType === 'INSERT') addTask(payload.new)
          else if (payload.eventType === 'UPDATE') updateTask(payload.new.id, payload.new)
          else fetchAll()
        }
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'sections', filter: `project_id=eq.${projectId}` },
        fetchAll
      )
      .subscribe()

    return () => sub.unsubscribe()
  }, [projectId])

  async function toggleDone(task) {
    const nowDone = !task.done
    updateTask(task.id, {
      done: nowDone,
      in_progress: nowDone ? false : task.in_progress,
      completed_at: nowDone ? new Date().toISOString() : null,
    })
    await supabase.from('tasks').update({
      done: nowDone,
      in_progress: nowDone ? false : task.in_progress,
      completed_at: nowDone ? new Date().toISOString() : null,
      updated_at: new Date().toISOString(),
    }).eq('id', task.id)
  }

  async function toggleInProgress(task) {
    const nowIP = !task.in_progress
    updateTask(task.id, { in_progress: nowIP })
    await supabase.from('tasks').update({
      in_progress: nowIP,
      updated_at: new Date().toISOString(),
    }).eq('id', task.id)
  }

  async function createTask(sectionId, text, groupId = null, extras = {}) {
    const position = tasks.filter(t => t.section_id === sectionId && t.group_id === (groupId ?? null)).length
    const { data: { user } } = await supabase.auth.getUser()
    const { data: newTask } = await supabase.from('tasks').insert({
      project_id: projectId,
      section_id: sectionId,
      group_id: groupId ?? null,
      text,
      position,
      user_id: user.id,
      updated_at: new Date().toISOString(),
      ...extras,
    }).select().single()
    if (newTask) addTask(newTask)
  }

  async function createSection(title) {
    const position = sections.length
    const { data: newSection } = await supabase.from('sections').insert({
      project_id: projectId,
      title,
      position,
    }).select().single()
    if (newSection) addSection(newSection)
  }

  async function createGroup(sectionId, name) {
    const position = groups.filter(g => g.section_id === sectionId).length
    const { data: { user } } = await supabase.auth.getUser()
    const { data: newGroup } = await supabase.from('groups').insert({
      section_id: sectionId,
      name,
      position,
      user_id: user.id,
    }).select().single()
    if (newGroup) addGroup(newGroup)
  }

  async function createGroupWithTasks(sectionId, groupName, taskList) {
    const position = groups.filter(g => g.section_id === sectionId).length
    const { data: { user } } = await supabase.auth.getUser()
    const { data: newGroup } = await supabase.from('groups').insert({
      section_id: sectionId,
      name: groupName,
      position,
      user_id: user.id,
    }).select().single()
    if (!newGroup) return
    addGroup(newGroup)

    for (let i = 0; i < taskList.length; i++) {
      const t = taskList[i]
      const { data: newTask } = await supabase.from('tasks').insert({
        project_id: projectId,
        section_id: sectionId,
        group_id: newGroup.id,
        text: typeof t === 'string' ? t : t.text,
        priority: typeof t === 'object' ? (t.priority || null) : null,
        position: i,
        user_id: user.id,
        updated_at: new Date().toISOString(),
      }).select().single()
      if (newTask) addTask(newTask)
    }
  }

  async function deleteTask(taskId) {
    removeTask(taskId)
    await supabase.from('tasks').delete().eq('id', taskId)
  }

  async function deleteGroup(groupId) {
    removeGroup(groupId)
    await supabase.from('tasks').delete().eq('group_id', groupId)
    await supabase.from('groups').delete().eq('id', groupId)
  }

  async function deleteSection(sectionId) {
    removeSection(sectionId)
    await supabase.from('tasks').delete().eq('section_id', sectionId)
    await supabase.from('groups').delete().eq('section_id', sectionId)
    await supabase.from('sections').delete().eq('id', sectionId)
  }

  return { tasks, sections, groups, toggleDone, toggleInProgress, createTask, createSection, createGroup, createGroupWithTasks, deleteTask, deleteGroup, deleteSection }
}
