import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../lib/supabase'

const PHASE_FIELDS = 'id, project_id, name, sort_order, exit_condition, due_date, slug'

// TDE-804. A phase is a stage bounded by an EXIT CONDITION, not a date — due_date is
// optional decoration, which is what separates a phase from a sprint. The active phase
// lives on projects.active_phase_id (one column, so "two phases active" is unrepresentable).
export function usePhases(projectId) {
  const [phases, setPhases] = useState([])
  const [activePhaseId, setActivePhaseId] = useState(null)
  const [loading, setLoading] = useState(true)

  const refetch = useCallback(async () => {
    if (!projectId) { setPhases([]); setActivePhaseId(null); setLoading(false); return }
    const [{ data: rows }, { data: proj }] = await Promise.all([
      supabase.from('phases').select(PHASE_FIELDS).eq('project_id', projectId).order('sort_order'),
      supabase.from('projects').select('active_phase_id').eq('id', projectId).maybeSingle(),
    ])
    setPhases(rows ?? [])
    setActivePhaseId(proj?.active_phase_id ?? null)
    setLoading(false)
  }, [projectId])

  useEffect(() => { refetch() }, [refetch])

  const createPhase = useCallback(async ({ name, exit_condition = null, due_date = null }) => {
    const next = phases.length ? Math.max(...phases.map(p => p.sort_order ?? 0)) + 1 : 0
    const { data } = await supabase.from('phases')
      .insert({ project_id: projectId, name, sort_order: next, exit_condition, due_date: due_date || null })
      .select(PHASE_FIELDS).single()
    // First phase becomes active, mirroring create_phase in the MCP — otherwise phases exist
    // but nothing is "current" and the agent's queue has nothing to scope to.
    if (data && !activePhaseId) {
      await supabase.from('projects').update({ active_phase_id: data.id }).eq('id', projectId)
    }
    await refetch()
    return data
  }, [projectId, phases, activePhaseId, refetch])

  const updatePhase = useCallback(async (id, patch) => {
    await supabase.from('phases').update(patch).eq('id', id)
    await refetch()
  }, [refetch])

  // Tasks are NOT deleted — the FK is ON DELETE SET NULL, so they become unphased, which is
  // a legitimate resting state rather than a loss.
  const deletePhase = useCallback(async (id) => {
    await supabase.from('phases').delete().eq('id', id)
    await refetch()
  }, [refetch])

  const setActivePhase = useCallback(async (id) => {
    await supabase.from('projects').update({ active_phase_id: id }).eq('id', projectId)
    setActivePhaseId(id)
  }, [projectId])

  const reorderPhases = useCallback(async (ordered) => {
    setPhases(ordered)
    await Promise.all(ordered.map((p, i) => supabase.from('phases').update({ sort_order: i }).eq('id', p.id)))
    await refetch()
  }, [refetch])

  return { phases, activePhaseId, loading, refetch, createPhase, updatePhase, deletePhase, setActivePhase, reorderPhases }
}

// Tint index is positional, capped at the 5 defined washes (index.css). Past that phases
// share tints and the badge does the identifying — five near-paper washes is already the
// limit of what stays distinguishable.
export function phaseTint(sortIndex) {
  return `var(--phase-tint-${(sortIndex % 5) + 1})`
}
