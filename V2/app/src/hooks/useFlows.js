import { useState, useEffect, useMemo, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import { detectFlows, flowSteps, flowGateStatus } from '../lib/flowGraph'

// Dedicated fetch for the Flows page: needs input/output (the contract data),
// which the shared useAllTasks hook deliberately omits to keep the Today query lean.
const TASK_FIELDS = 'id, project_id, section_id, text, detail, status, priority, sort_order, short_id, input, output, flow_id'
const PROJECT_FIELDS = 'id, name, slug, prefix'

const STATUS_RANK = { in_progress: 0, pending: 1, done: 2 }

export function useFlows() {
  const [tasks, setTasks] = useState([])
  const [projects, setProjects] = useState([])
  const [loading, setLoading] = useState(true)

  const [flowRecs, setFlowRecs] = useState([])

  const refetch = useCallback(async () => {
    const [{ data: projs }, { data: tsks }, { data: frecs }] = await Promise.all([
      supabase.from('projects').select(PROJECT_FIELDS).order('created_at'),
      supabase.from('tasks').select(TASK_FIELDS).order('sort_order'),
      supabase.from('flows').select('id, short_id, gate_bypassed, gate_bypass_reason'),
    ])
    if (projs) setProjects(projs)
    if (tsks) setTasks(tsks)
    if (frecs) setFlowRecs(frecs)
    setLoading(false)
  }, [])

  useEffect(() => { refetch() }, [refetch])

  const projectMap = useMemo(() => Object.fromEntries(projects.map(p => [p.id, p])), [projects])
  const taskById = useMemo(() => new Map(tasks.map(t => [t.id, t])), [tasks])
  const flowRecMap = useMemo(() => new Map(flowRecs.map(f => [f.id, f])), [flowRecs])

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
        const flowRecordId = steps.map(s => s.task.flow_id).find(Boolean) || null
        const flowRec = flowRecordId ? flowRecMap.get(flowRecordId) : null
        result.push({
          id: `${projectId}:${f.id}`,
          name: f.autoName,
          // The named-flow record id (flows table), if this detected flow has been
          // named via name_flow. null when the flow was never named → no flow IS/KB.
          flowRecordId,
          shortId: flowRec?.short_id ?? null,
          // Contract gate (TDE-287): client-side mirror of the server gate, plus the
          // recorded bypass state. Lets the cockpit show trust at a glance.
          gate: flowGateStatus(steps),
          gateBypassed: flowRec?.gate_bypassed === true,
          gateBypassReason: flowRec?.gate_bypass_reason ?? null,
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
  }, [tasks, projectMap, taskById, flowRecMap])

  return { flows, projects, taskById, loading, refetch }
}
