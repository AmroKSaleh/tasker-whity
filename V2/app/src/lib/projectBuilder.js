import { supabase } from './supabase'
import { useProjectStore } from '../store/useProjectStore'

async function seedTaskDiscussion(taskId, userId, focus) {
  await supabase.from('task_discussions').insert({
    task_id: taskId,
    user_id: userId,
    messages: [],
    steps: focus.steps,
    checked_steps: new Array(focus.steps.length).fill(false),
    reason: focus.reason,
  })
}

export async function createProjectWithStructure(structure) {
  const { data: { user } } = await supabase.auth.getUser()
  const { projects, addProject } = useProjectStore.getState()

  const displayName = structure.description || structure.name || 'Project'
  const slug = displayName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '') || 'project'

  const { data: proj } = await supabase.from('projects').insert({
    name: displayName,
    slug,
    description: displayName,
    user_id: user.id,
    context: structure.context ?? null,
  }).select().single()

  if (!proj) throw new Error('Failed to create project')

  for (let si = 0; si < (structure.sections ?? []).length; si++) {
    const sec = structure.sections[si]

    const { data: section } = await supabase.from('sections').insert({
      project_id: proj.id,
      name: sec.name || sec.title,
      sort_order: si,
    }).select().single()

    if (!section) continue

    for (let gi = 0; gi < (sec.groups ?? []).length; gi++) {
      const grp = sec.groups[gi]

      const { data: group } = await supabase.from('groups').insert({
        project_id: proj.id,
        section_id: section.id,
        name: grp.name,
        sort_order: gi,
      }).select().single()

      for (let ti = 0; ti < (grp.tasks ?? []).length; ti++) {
        const t = grp.tasks[ti]
        const { data: taskData } = await supabase.from('tasks').insert({
          project_id: proj.id,
          section_id: section.id,
          group_id: group?.id ?? null,
          text: typeof t === 'string' ? t : t.text,
          priority: typeof t === 'object' ? (t.priority || null) : null,
          sort_order: ti,
          user_id: user.id,
        }).select('id').single()
        if (taskData && typeof t === 'object' && t.focus) {
          await seedTaskDiscussion(taskData.id, user.id, t.focus)
        }
      }
    }

    for (let ti = 0; ti < (sec.tasks ?? []).length; ti++) {
      const t = sec.tasks[ti]
      const { data: taskData } = await supabase.from('tasks').insert({
        project_id: proj.id,
        section_id: section.id,
        group_id: null,
        text: typeof t === 'string' ? t : t.text,
        priority: typeof t === 'object' ? (t.priority || null) : null,
        sort_order: ti,
        user_id: user.id,
      }).select('id').single()
      if (taskData && typeof t === 'object' && t.focus) {
        await seedTaskDiscussion(taskData.id, user.id, t.focus)
      }
    }
  }

  addProject(proj)
  return proj
}
