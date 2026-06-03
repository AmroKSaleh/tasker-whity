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

  const slug = structure.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')

  const { data: proj } = await supabase.from('projects').insert({
    name: slug,
    description: structure.description || structure.name,
    context: structure.context ?? null,
    position: projects.length,
    user_id: user.id,
  }).select().single()

  if (!proj) throw new Error('Failed to create project')

  for (let si = 0; si < (structure.sections ?? []).length; si++) {
    const sec = structure.sections[si]

    const { data: section } = await supabase.from('sections').insert({
      project_id: proj.id,
      title: sec.title,
      position: si,
    }).select().single()

    if (!section) continue

    // Grouped tasks
    for (let gi = 0; gi < (sec.groups ?? []).length; gi++) {
      const grp = sec.groups[gi]

      const { data: group } = await supabase.from('groups').insert({
        section_id: section.id,
        name: grp.name,
        position: gi,
        user_id: user.id,
      }).select().single()

      for (let ti = 0; ti < (grp.tasks ?? []).length; ti++) {
        const t = grp.tasks[ti]
        const { data: taskData } = await supabase.from('tasks').insert({
          project_id: proj.id,
          section_id: section.id,
          group_id: group?.id ?? null,
          text: typeof t === 'string' ? t : t.text,
          priority: typeof t === 'object' ? (t.priority || null) : null,
          position: ti,
          user_id: user.id,
          updated_at: new Date().toISOString(),
        }).select('id').single()
        if (taskData && typeof t === 'object' && t.focus) {
          await seedTaskDiscussion(taskData.id, user.id, t.focus)
        }
      }
    }

    // Ungrouped tasks
    for (let ti = 0; ti < (sec.tasks ?? []).length; ti++) {
      const t = sec.tasks[ti]
      const { data: taskData } = await supabase.from('tasks').insert({
        project_id: proj.id,
        section_id: section.id,
        group_id: null,
        text: typeof t === 'string' ? t : t.text,
        priority: typeof t === 'object' ? (t.priority || null) : null,
        position: ti,
        user_id: user.id,
        updated_at: new Date().toISOString(),
      }).select('id').single()
      if (taskData && typeof t === 'object' && t.focus) {
        await seedTaskDiscussion(taskData.id, user.id, t.focus)
      }
    }
  }

  addProject(proj)
  return proj
}
