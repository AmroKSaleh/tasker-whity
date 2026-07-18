// ── Local Mode: sync core (TDE-410) ──────────────────────────────────────────
// Pure decision + mapping logic for pull/flush. No I/O, no Supabase — the edge
// function feeds it DB rows; the two-device simulation feeds it an in-memory hub.
// Design: docs/local-first-design.md D3 (cursor sync), D4 (per-task LWW by
// updated_at, hub arbitrates, tombstones, edit-beats-delete), D8 (ID leases).

import type { TaskerTask, TaskerProjectMeta, TaskerSection, TaskerGroup, TaskerMilestone } from './local_format.ts'

// ── DB row shapes (subset the sync engine reads) ─────────────────────────────

export interface DbSectionRow { id: string; name: string; sort_order?: number | null }
export interface DbGroupRow { id: string; name: string; section_id: string; sort_order?: number | null }

export interface DbTaskRow {
  id: string
  short_id: number
  text: string
  detail?: string | null
  status: string
  priority?: string | null
  due_date?: string | null
  section_id?: string | null
  group_id?: string | null
  sort_order?: number | null
  input?: unknown
  output?: unknown
  review_enabled?: boolean | null
  review_bar?: unknown
  updated_at?: string | null
  local_rev?: number | null
}

// ── slugs ─────────────────────────────────────────────────────────────────────

export function slugify(name: string): string {
  const s = (name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return s || 'section'
}

// Stable, collision-free slug per row (dedup by appending -2, -3 … in list order).
export function buildSlugMap(rows: Array<{ id: string; name: string }>): Map<string, string> {
  const used = new Set<string>()
  const map = new Map<string, string>()
  for (const r of rows) {
    let slug = slugify(r.name)
    let n = 2
    while (used.has(slug)) { slug = `${slugify(r.name)}-${n}`; n++ }
    used.add(slug)
    map.set(r.id, slug)
  }
  return map
}

export const UNFILED_SLUG = 'unfiled'

// ── DB → file model ───────────────────────────────────────────────────────────

export interface PullMaps {
  sectionSlugById: Map<string, string>
  groupSlugById: Map<string, string>
  shortRefByUuid: Map<string, string> // task uuid → "TDE-52"
  sectionIdBySlug: Map<string, string>
  groupIdBySlug: Map<string, { id: string; section_id: string }>
}

export function buildPullMaps(prefix: string, sections: DbSectionRow[], groups: DbGroupRow[], tasks: DbTaskRow[]): PullMaps {
  const sectionSlugById = buildSlugMap(sections)
  const groupSlugById = buildSlugMap(groups)
  const shortRefByUuid = new Map<string, string>()
  for (const t of tasks) shortRefByUuid.set(t.id, `${prefix}-${t.short_id}`)
  const sectionIdBySlug = new Map<string, string>()
  for (const [id, slug] of sectionSlugById) sectionIdBySlug.set(slug, id)
  const groupIdBySlug = new Map<string, { id: string; section_id: string }>()
  for (const g of groups) {
    const slug = groupSlugById.get(g.id)
    if (slug) groupIdBySlug.set(slug, { id: g.id, section_id: g.section_id })
  }
  return { sectionSlugById, groupSlugById, shortRefByUuid, sectionIdBySlug, groupIdBySlug }
}

export function buildProjectMeta(name: string, prefix: string, nextShortId: number, sections: DbSectionRow[], groups: DbGroupRow[], maps: PullMaps, needUnfiled: boolean): TaskerProjectMeta {
  const secs: TaskerSection[] = sections.map((s, i) => ({
    id: maps.sectionSlugById.get(s.id) || slugify(s.name),
    name: s.name,
    order: s.sort_order ?? (i + 1) * 10,
  }))
  if (needUnfiled) secs.push({ id: UNFILED_SLUG, name: 'Unfiled', order: 9990 })
  const grps: TaskerGroup[] = groups.map((g, i) => ({
    id: maps.groupSlugById.get(g.id) || slugify(g.name),
    name: g.name,
    section: maps.sectionSlugById.get(g.section_id) || UNFILED_SLUG,
    order: g.sort_order ?? (i + 1) * 10,
  }))
  return { version: 1, name, prefix, next_short_id: nextShortId, sections: secs, groups: grps, flows: {} }
}

// Translate a task's input edges to short refs for file portability. Read-only in
// files (flush ignores these fields — contracts are hub ceremonies per D5).
function translateInput(input: unknown, maps: PullMaps): TaskerTask['input'] | undefined {
  if (!input || typeof input !== 'object') return undefined
  const inp = input as Record<string, unknown>
  const toRef = (uuid: unknown) => (typeof uuid === 'string' && maps.shortRefByUuid.get(uuid)) || String(uuid ?? '')
  if (Array.isArray(inp.edges) && inp.edges.length) {
    const edges = (inp.edges as Array<Record<string, unknown>>).filter(e => e && e.source_task_id)
    if (!edges.length) return undefined
    const hasRules = edges.some(e => {
      const c = e.contract as Record<string, unknown> | undefined
      return Array.isArray(c?.rules) && (c!.rules as unknown[]).length > 0
    })
    if (edges.length === 1 && !hasRules) return { from: toRef(edges[0].source_task_id) }
    return { edges: edges.map(e => ({ ...e, source_task_id: toRef(e.source_task_id) })) }
  }
  if (inp.source_task_id) return { from: toRef(inp.source_task_id) }
  return undefined
}

function translateOutput(output: unknown): TaskerTask['output'] | undefined {
  if (!output || typeof output !== 'object') return undefined
  const out = output as Record<string, unknown>
  const contract = out.contract as Record<string, unknown> | undefined
  const hasRules = Array.isArray(contract?.rules) && (contract!.rules as unknown[]).length > 0
  const desc = typeof out.description === 'string' ? out.description : undefined
  if (hasRules) return { ...(desc ? { description: desc } : {}), contract: { rules: contract!.rules, confirmed: contract!.confirmed === true } }
  if (desc) return desc
  return undefined
}

// Optional milestones come from task_discussions (a separate table), so they are
// passed in rather than read off the task row. ONLY plain milestones (kind absent)
// are surfaced — seed checklist items (kind = 'question' | 'prerequisite') are NOT
// milestones and are never emitted as such.
export function dbRowToTaskerTask(row: DbTaskRow, prefix: string, maps: PullMaps, milestones?: TaskerMilestone[]): TaskerTask {
  const task: TaskerTask = {
    id: `${prefix}-${row.short_id}`,
    title: row.text,
    status: (['pending', 'in_progress', 'done'].includes(row.status) ? row.status : 'pending') as TaskerTask['status'],
    priority: (['rush', 'high', 'medium', 'low'].includes(row.priority || '') ? row.priority : 'medium') as TaskerTask['priority'],
    section: (row.section_id && maps.sectionSlugById.get(row.section_id)) || UNFILED_SLUG,
    order: row.sort_order ?? 0,
    body: (row.detail || '').replace(/\s+$/, ''),
  }
  if (milestones && milestones.length) task.milestones = milestones
  if (row.group_id) {
    const g = maps.groupSlugById.get(row.group_id)
    if (g) task.group = g
  }
  if (row.due_date) task.due = String(row.due_date).slice(0, 10)
  if (row.updated_at) task.updated_at = new Date(row.updated_at).toISOString()
  const input = translateInput(row.input, maps)
  if (input) task.input = input
  const output = translateOutput(row.output)
  if (output !== undefined) task.output = output
  if (row.review_enabled && row.review_bar && typeof row.review_bar === 'object') {
    const bar = row.review_bar as Record<string, unknown>
    if (Array.isArray(bar.rules) && bar.rules.length) task.review = { bar: row.review_bar as Record<string, unknown> }
  }
  return task
}

// ── flush decisions (the LWW heart — D4) ─────────────────────────────────────

export type FlushDecision =
  | 'create'                      // no hub row, no live tombstone conflict → insert
  | 'apply'                       // hub row unchanged since pull, or file is newer → update
  | 'hub_wins'                    // hub changed since pull and is newer-or-tied → return corrected file
  | 'resurrect_edit_beats_delete' // hub deleted it since pull, local edited it → reinsert

export interface HubTaskState { updated_at: string | null; local_rev: number }

function ts(v: string | null | undefined): number {
  if (!v) return 0
  const n = Date.parse(v)
  return Number.isFinite(n) ? n : 0
}

export function resolveFlushChange(
  fileUpdatedAt: string | undefined,
  hub: HubTaskState | null,
  tombstoneRev: number | null,
  baseCursor: number,
): FlushDecision {
  if (!hub) {
    if (tombstoneRev !== null && tombstoneRev > baseCursor) return 'resurrect_edit_beats_delete'
    return 'create' // brand new, or knowingly recreated after an acknowledged tombstone
  }
  if ((hub.local_rev ?? 0) <= baseCursor) return 'apply' // unchanged since our pull
  // Concurrent change on the hub → last write wins; ties go to the hub (D4).
  return ts(fileUpdatedAt) > ts(hub.updated_at) ? 'apply' : 'hub_wins'
}

export type DeleteDecision = 'delete' | 'edit_beats_delete_keep'

export function resolveFlushDelete(hub: HubTaskState | null, baseCursor: number): DeleteDecision {
  if (!hub) return 'delete' // already gone — idempotent
  if ((hub.local_rev ?? 0) > baseCursor) return 'edit_beats_delete_keep' // hub edited since pull → edit wins
  return 'delete'
}

// ── ID lease math (D8) ────────────────────────────────────────────────────────

export const LEASE_BLOCK = 20
export const LEASE_MIN_FREE = 5

export interface LeaseState { start: number; end: number }

// A lease still serves if enough of its block is unused by existing tasks.
export function leaseFreeIds(lease: LeaseState, usedShortIds: Set<number>): number[] {
  const free: number[] = []
  for (let i = lease.start; i <= lease.end; i++) if (!usedShortIds.has(i)) free.push(i)
  return free
}

export function shortIdWithinLease(shortId: number, leases: LeaseState[]): boolean {
  return leases.some(l => shortId >= l.start && shortId <= l.end)
}

export function parseShortRef(ref: string): number | null {
  const m = /^[A-Za-z]+-(\d+)$/.exec(ref || '')
  return m ? Number(m[1]) : null
}
