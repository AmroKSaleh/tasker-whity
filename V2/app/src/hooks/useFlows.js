import { useState, useEffect, useMemo } from 'react'
import { supabase } from '../lib/supabase'
import { detectFlows, flowSteps } from '../lib/flowGraph'

// Dedicated fetch for the Flows page: needs input/output (the contract data),
// which the shared useAllTasks hook deliberately omits to keep the Today query lean.
const TASK_FIELDS = 'id, project_id, section_id, text, status, priority, sort_order, short_id, input, output'
const PROJECT_FIELDS = 'id, name, slug, prefix'

const STATUS_RANK = { in_progress: 0, pending: 1, done: 2 }

export function useFlows() {
  const [tasks, setTasks] = useState([])
  const [projects, setProjects] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    async function fetchAll() {
      const [{ data: projs }, { data: tsks }] = await Promise.all([
        supabase.from('projects').select(PROJECT_FIELDS).order('created_at'),
        supabase.from('tasks').select(TASK_FIELDS).order('sort_order'),
      ])
      if (cancelled) return
      if (projs) setProjects(projs)
      if (tsks) setTasks(tsks)
      setLoading(false)
    }
    fetchAll()
    return () => { cancelled = true }
  }, [])

  const projectMap = useMemo(() => Object.fromEntries(projects.map(p => [p.id, p])), [projects])
  const taskById = useMemo(() => new Map(tasks.map(t => [t.id, t])), [tasks])

  // Flows are detected per-project (a flow never crosses projects), then flattened.
  const flows = useMemo(() => {
    const byProject = {}
    tasks.forEach(t => { (byProject[t.project_id] ??= []).push(t) })
    const result = []
    for (const [projectId, projTasks] of Object.entries(byProject)) {
      const project = projectMap[projectId]
      detectFlows(projTasks).forEach(f => {
        const steps = flowSteps(f.taskIds, taskById)
        const doneCount = steps.filter(s => s.task.status === 'done').length
        const anyInProgress = steps.some(s => s.task.status === 'in_progress')
        const status = doneCount === steps.length ? 'done'
          : (anyInProgress || doneCount > 0) ? 'in_progress'
          : 'pending'
        result.push({
          id: `${projectId}:${f.id}`,
          name: f.autoName,
          projectId,
          projectName: project?.name ?? '—',
          projectPrefix: project?.prefix ?? null,
          steps,
          stepCount: steps.length,
          doneCount,
          status,
        })
      })
    }
    return result.sort((a, b) =>
      (STATUS_RANK[a.status] - STATUS_RANK[b.status]) || (b.stepCount - a.stepCount))
  }, [tasks, projectMap, taskById])

  return { flows, projects, taskById, loading }
}
