// ── Full-fidelity project export / import (web client) ────────────────────────
// Serialize an ENTIRE project to a portable JSON bundle and recreate it under the
// current account with fresh IDs. Runs client-side against the RLS-scoped Supabase
// client (the user can only touch their own rows). This is the BROWSER twin of the
// MCP tools exportProjectBundle / importProjectBundle in
// V2/supabase/functions/mcp/index.ts — keep the two in sync. Bundles are
// interchangeable: a bundle from either side imports through either side.
import { supabase } from './supabase'
import { useProjectStore } from '../store/useProjectStore'

const EXPORT_BUNDLE_VERSION = 1

// Tasks whose progress is cleared come in as a fresh template: status → pending,
// completion wiped. (Matches the MCP reset_progress behavior — base status only.)
function applyReset(bundle) {
  return {
    ...bundle,
    tasks: (bundle.tasks || []).map(t => ({ ...t, status: 'pending', completed_at: null })),
  }
}

export async function exportProjectBundle(projectId, { resetProgress = false } = {}) {
  const { data: project } = await supabase
    .from('projects').select('*').eq('id', projectId).single()
  if (!project) throw new Error('Project not found.')

  const [sections, groups, tasks, flows, statuses, knowledge, instructions] = (await Promise.all([
    supabase.from('sections').select('*').eq('project_id', projectId).order('sort_order'),
    supabase.from('groups').select('*').eq('project_id', projectId).order('sort_order'),
    supabase.from('tasks').select('*').eq('project_id', projectId).order('sort_order'),
    supabase.from('flows').select('*').eq('project_id', projectId),
    supabase.from('project_statuses').select('*').eq('project_id', projectId),
    supabase.from('project_knowledge').select('*').eq('project_id', projectId),
    supabase.from('project_instructions').select('*').eq('project_id', projectId),
  ])).map(r => r.data || [])

  const taskIds = tasks.map(t => t.id)
  const flowIds = flows.map(f => f.id)
  const [discussions, taskStatuses, flowIs, flowKb] = (await Promise.all([
    taskIds.length ? supabase.from('task_discussions').select('*').in('task_id', taskIds) : { data: [] },
    taskIds.length ? supabase.from('task_statuses').select('*').in('task_id', taskIds) : { data: [] },
    flowIds.length ? supabase.from('flow_instructions').select('*').in('flow_id', flowIds) : { data: [] },
    flowIds.length ? supabase.from('flow_knowledge').select('*').in('flow_id', flowIds) : { data: [] },
  ])).map(r => r.data || [])

  const bundle = {
    tasker_export: {
      version: EXPORT_BUNDLE_VERSION,
      source: { name: project.name, prefix: project.prefix || null, project_id: projectId },
    },
    project: { name: project.name, context: project.context ?? {} },
    sections, groups, tasks, flows,
    statuses, task_statuses: taskStatuses,
    flow_instructions: flowIs, flow_knowledge: flowKb,
    knowledge, instructions,
    task_discussions: discussions,
  }
  return resetProgress ? applyReset(bundle) : bundle
}

export function downloadBundle(bundle, projectName) {
  const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${(projectName || 'project').replace(/[^a-z0-9]/gi, '_')}_tasker.json`
  a.click()
  URL.revokeObjectURL(url)
}

// Derive a 2–5 uppercase prefix unique within the user's projects (mirrors the
// server's deriveProjectPrefix). RLS scopes the prefix query to this user.
async function deriveUniquePrefix(name) {
  const words = String(name || '').toUpperCase().split(/[^A-Z]+/).filter(Boolean)
  let base = words.length >= 2 ? words.slice(0, 4).map(w => w[0]).join('') : (words[0] || '').slice(0, 4)
  if (base.length < 2) base = (base + 'PRJ').slice(0, 3)
  base = base.slice(0, 5)
  const { data } = await supabase.from('projects').select('prefix')
  const taken = new Set((data || []).map(r => (r.prefix || '').toUpperCase()).filter(Boolean))
  for (const suf of ['', 'X', 'Y', 'Z', 'A', 'B', 'C', 'D', 'E', 'F']) {
    const cand = base.slice(0, 5 - suf.length) + suf
    if (cand.length >= 2 && cand.length <= 5 && !taken.has(cand)) return cand
  }
  return base
}

function stripManaged(row, extra = []) {
  const out = { ...row }
  for (const k of ['id', 'created_at', 'updated_at', 'user_id', 'project_id', ...extra]) delete out[k]
  return out
}

// Remap the task→task references inside a task's input edges (+ legacy output.target_task_id).
function remapTaskRefs(input, output, taskMap) {
  const m = id => taskMap.get(id) || id
  let newInput = input
  if (input && typeof input === 'object') {
    newInput = JSON.parse(JSON.stringify(input))
    if (Array.isArray(newInput.edges)) {
      newInput.edges = newInput.edges.map(e => (e && e.source_task_id) ? { ...e, source_task_id: m(e.source_task_id) } : e)
    } else if (newInput.source_task_id) {
      newInput.source_task_id = m(newInput.source_task_id)
    }
  }
  let newOutput = output
  if (output && typeof output === 'object' && output.target_task_id) {
    newOutput = { ...output, target_task_id: m(output.target_task_id) }
  }
  return { input: newInput, output: newOutput }
}

async function insertRows(table, rows, counts) {
  if (!rows.length) return
  const { error } = await supabase.from(table).insert(rows)
  if (error) throw new Error(`Importing ${table.replace(/_/g, ' ')} failed: ${error.message}`)
  counts[table] = (counts[table] || 0) + rows.length
}

// Recreate the whole project from a bundle. Always a NEW project. Returns the new row.
export async function importProjectBundle(bundle, { name, resetProgress = false } = {}) {
  if (!bundle || typeof bundle !== 'object' || !bundle.project) {
    throw new Error('Not a valid Tasker export file.')
  }
  if (resetProgress) bundle = applyReset(bundle)

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('You must be signed in to import.')
  const userId = user.id

  // 1. New project (fresh slug + prefix), carrying the Foundation context verbatim.
  const projName = (name && name.trim()) || bundle.project.name || 'Imported Project'
  const slug = projName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '-' + Date.now().toString(36)
  const prefix = await deriveUniquePrefix(projName)
  const { data: proj, error: pe } = await supabase.from('projects').insert({
    name: projName, slug, description: projName, user_id: userId, context: bundle.project.context ?? {}, prefix,
  }).select().single()
  if (pe || !proj) throw new Error(`Failed to create project: ${pe?.message || 'unknown error'}`)
  const newProjectId = proj.id

  // The projects AFTER-INSERT trigger auto-seeds a baseline Instruction Set; the bundle
  // already carries the source IS (baseline included), so clear it to keep an exact copy.
  await supabase.from('project_instructions').delete().eq('project_id', newProjectId)

  // 2. Pre-mint new IDs for every FK-referenced entity so references remap in one pass.
  const sectionMap = new Map(), groupMap = new Map(), flowMap = new Map(),
        statusMap = new Map(), taskMap = new Map()
  for (const s of bundle.sections || []) sectionMap.set(s.id, crypto.randomUUID())
  for (const g of bundle.groups || []) groupMap.set(g.id, crypto.randomUUID())
  for (const f of bundle.flows || []) flowMap.set(f.id, crypto.randomUUID())
  for (const s of bundle.statuses || []) statusMap.set(s.id, crypto.randomUUID())
  for (const t of bundle.tasks || []) taskMap.set(t.id, crypto.randomUUID())

  const counts = {}

  // 3. Sections → groups → custom statuses → flows.
  await insertRows('sections', (bundle.sections || []).map(s => ({
    ...stripManaged(s), id: sectionMap.get(s.id), project_id: newProjectId,
  })), counts)
  await insertRows('groups', (bundle.groups || []).map(g => ({
    ...stripManaged(g), id: groupMap.get(g.id), project_id: newProjectId,
    section_id: g.section_id ? (sectionMap.get(g.section_id) ?? null) : null,
  })), counts)
  await insertRows('project_statuses', (bundle.statuses || []).map(s => ({
    ...stripManaged(s), id: statusMap.get(s.id), project_id: newProjectId, user_id: userId,
  })), counts)
  // Flow short_id is unique per ACCOUNT — cannot be preserved; regenerate below.
  await insertRows('flows', (bundle.flows || []).map(f => ({
    ...stripManaged(f, ['short_id']), id: flowMap.get(f.id), project_id: newProjectId, user_id: userId, short_id: null,
  })), counts)
  if ((bundle.flows || []).length) {
    let n = 1
    if (proj.prefix) {
      const { data: ex } = await supabase.from('flows').select('short_id').like('short_id', `${proj.prefix}-F%`)
      const used = (ex || []).map(r => { const mm = r.short_id?.match(/^.+-F(\d+)$/); return mm ? parseInt(mm[1], 10) : 0 })
      n = used.length ? Math.max(...used) + 1 : 1
    }
    for (const f of bundle.flows) {
      const sid = proj.prefix ? `${proj.prefix}-F${n++}` : `${projName} - F${n++}`
      await supabase.from('flows').update({ short_id: sid }).eq('id', flowMap.get(f.id))
    }
  }

  // 4. Tasks. Preserve short_id (new project is empty → originals stay unique and the
  //    per-project trigger leaves explicit values alone). Remap FKs + I/O refs; defer
  //    the task→task seed link to a 2nd pass.
  await insertRows('tasks', (bundle.tasks || []).map(t => {
    const { input, output } = remapTaskRefs(t.input, t.output, taskMap)
    return {
      ...stripManaged(t, ['intake_job_id', 'spawned_from_seed_id', 'completed_at']),
      id: taskMap.get(t.id), project_id: newProjectId, user_id: userId,
      status: t.status,
      completed_at: t.status === 'done' ? (t.completed_at ?? null) : null,
      section_id: t.section_id ? (sectionMap.get(t.section_id) ?? null) : null,
      group_id: t.group_id ? (groupMap.get(t.group_id) ?? null) : null,
      flow_id: t.flow_id ? (flowMap.get(t.flow_id) ?? null) : null,
      custom_status_id: t.custom_status_id ? (statusMap.get(t.custom_status_id) ?? null) : null,
      intake_job_id: null, spawned_from_seed_id: null,
      input, output,
    }
  }), counts)
  // 5. Backfill task→task seed provenance now that every task exists.
  for (const t of (bundle.tasks || [])) {
    if (t.spawned_from_seed_id && taskMap.has(t.spawned_from_seed_id)) {
      await supabase.from('tasks').update({ spawned_from_seed_id: taskMap.get(t.spawned_from_seed_id) }).eq('id', taskMap.get(t.id))
    }
  }

  // 6. Leaf rows: milestones, task↔status junction, flow IS/KB, project KB/IS.
  await insertRows('task_discussions', (bundle.task_discussions || [])
    .filter(d => taskMap.has(d.task_id))
    .map(d => ({ ...stripManaged(d, ['task_id']), task_id: taskMap.get(d.task_id), user_id: userId })), counts)
  await insertRows('task_statuses', (bundle.task_statuses || [])
    .filter(ts => taskMap.has(ts.task_id) && statusMap.has(ts.status_id))
    .map(ts => ({ ...stripManaged(ts, ['task_id', 'status_id']), task_id: taskMap.get(ts.task_id), status_id: statusMap.get(ts.status_id) })), counts)
  await insertRows('flow_instructions', (bundle.flow_instructions || [])
    .filter(r => flowMap.has(r.flow_id))
    .map(r => ({ ...stripManaged(r, ['flow_id']), flow_id: flowMap.get(r.flow_id), user_id: userId })), counts)
  await insertRows('flow_knowledge', (bundle.flow_knowledge || [])
    .filter(r => flowMap.has(r.flow_id))
    .map(r => ({ ...stripManaged(r, ['flow_id']), flow_id: flowMap.get(r.flow_id), user_id: userId })), counts)
  await insertRows('project_knowledge', (bundle.knowledge || [])
    .map(r => ({ ...stripManaged(r), project_id: newProjectId, user_id: userId })), counts)
  await insertRows('project_instructions', (bundle.instructions || [])
    .map(r => ({ ...stripManaged(r), project_id: newProjectId, user_id: userId })), counts)

  // Surface the new project immediately (the realtime subscription also refetches).
  useProjectStore.getState().addProject(proj)
  return { project: proj, counts }
}
