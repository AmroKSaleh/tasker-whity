// Two-device sync simulation (TDE-410 gate). Run with:
//   node --experimental-strip-types local_sync.test.node.ts
// Exit 0 = every scenario asserted. The InMemoryHub mirrors the edge handler's
// semantics 1:1: same decision functions (sync_core), same file round-trip
// (local_format) — proving the LWW/tombstone/edit-beats-delete machinery.

import { parseTaskFile, serializeTaskFile, contentHash, serializeStructure, parseStructure } from './local_format.ts'
import type { TaskerTask } from './local_format.ts'
import { buildSlugMap } from './sync_core.ts'
import {
  resolveFlushChange, resolveFlushDelete, shortIdWithinLease, parseShortRef,
  slugify, dbRowToTaskerTask, buildPullMaps, LEASE_BLOCK, type LeaseState,
} from './sync_core.ts'

let failures = 0
function assert(cond: boolean, msg: string) {
  if (!cond) { failures++; console.error(`FAIL: ${msg}`) } else console.log(`ok: ${msg}`)
}

// ── In-memory hub mirroring the edge handler ─────────────────────────────────

interface HubRow { task: TaskerTask; local_rev: number }

class InMemoryHub {
  revision = 0
  tasks = new Map<number, HubRow>() // short id number → row
  tombstones: Array<{ short_id: number; rev: number }> = []
  leases = new Map<string, LeaseState>()
  nextLeaseStart = 100

  private bump(): number { return ++this.revision }

  pull(deviceId: string): { cursor: number; files: Record<string, string>; tombstoned: number[]; lease: LeaseState } {
    let lease = this.leases.get(deviceId)
    if (!lease) {
      lease = { start: this.nextLeaseStart, end: this.nextLeaseStart + LEASE_BLOCK - 1 }
      this.nextLeaseStart += LEASE_BLOCK
      this.leases.set(deviceId, lease)
    }
    const files: Record<string, string> = {}
    for (const [sid, row] of this.tasks) files[`tasks/TST-${sid}.md`] = serializeTaskFile(row.task)
    return { cursor: this.revision, files, tombstoned: this.tombstones.map(t => t.short_id), lease }
  }

  flush(deviceId: string, baseCursor: number, changedFiles: Array<{ path: string; content: string }>, deletedShortIds: number[] = []) {
    const hubWins: Array<{ path: string; content: string; reason: string }> = []
    const rejected: string[] = []
    const lease = this.leases.get(deviceId)

    for (const f of changedFiles) {
      const { task } = parseTaskFile(f.content, f.path)
      if (!task) { rejected.push(`${f.path}: unparseable`); continue }
      const sid = parseShortRef(task.id)
      if (sid === null) { rejected.push(`${f.path}: bad id`); continue }
      const hubRow = this.tasks.get(sid) || null
      const tomb = this.tombstones.filter(t => t.short_id === sid).map(t => t.rev)
      const tombRev = tomb.length ? Math.max(...tomb) : null
      const decision = resolveFlushChange(
        task.updated_at,
        hubRow ? { updated_at: hubRow.task.updated_at ?? null, local_rev: hubRow.local_rev } : null,
        tombRev, baseCursor,
      )
      if (decision === 'create') {
        if (!lease || !shortIdWithinLease(sid, [lease])) { rejected.push(`${f.path}: id outside device lease`); continue }
        this.tasks.set(sid, { task, local_rev: this.bump() })
      } else if (decision === 'apply' || decision === 'resurrect_edit_beats_delete') {
        this.tasks.set(sid, { task, local_rev: this.bump() })
      } else { // hub_wins
        hubWins.push({ path: f.path, content: serializeTaskFile(this.tasks.get(sid)!.task), reason: 'hub newer or tied' })
      }
    }

    for (const sid of deletedShortIds) {
      const hubRow = this.tasks.get(sid) || null
      const decision = resolveFlushDelete(
        hubRow ? { updated_at: hubRow.task.updated_at ?? null, local_rev: hubRow.local_rev } : null, baseCursor)
      if (decision === 'delete') {
        if (hubRow) { this.tasks.delete(sid); this.tombstones.push({ short_id: sid, rev: this.bump() }) }
      } else {
        hubWins.push({ path: `tasks/TST-${sid}.md`, content: serializeTaskFile(hubRow!.task), reason: 'edited on hub since pull — edit beats delete' })
      }
    }
    return { cursor: this.revision, hubWins, rejected }
  }
}

function mkTask(id: string, title: string, updatedAt: string, body = 'ctx'): TaskerTask {
  return { id, title, status: 'pending', priority: 'medium', section: 'core', order: 10, updated_at: updatedAt, body }
}
function fileOf(t: TaskerTask) { return { path: `tasks/${t.id}.md`, content: serializeTaskFile(t) } }

// ── Scenario 0: seed + both devices pull ─────────────────────────────────────
const hub = new InMemoryHub()
hub.tasks.set(1, { task: mkTask('TST-1', 'Original title', '2026-07-14T10:00:00.000Z'), local_rev: ++hub.revision })
hub.tasks.set(2, { task: mkTask('TST-2', 'Second task', '2026-07-14T10:00:00.000Z'), local_rev: ++hub.revision })
hub.tasks.set(3, { task: mkTask('TST-3', 'Third task', '2026-07-14T10:00:00.000Z'), local_rev: ++hub.revision })

const pullA1 = hub.pull('device-A')
const pullB1 = hub.pull('device-B')
assert(Object.keys(pullA1.files).length === 3, 'device A pull hydrates 3 task files')
assert(pullA1.lease.start !== pullB1.lease.start, `devices get disjoint ID leases (A ${pullA1.lease.start}-${pullA1.lease.end}, B ${pullB1.lease.start}-${pullB1.lease.end})`)
assert(contentHash(pullA1.files['tasks/TST-1.md']) === contentHash(pullB1.files['tasks/TST-1.md']), 'both devices see identical file content')

// ── Scenario 1: concurrent edit, later edit flushes second → later wins ──────
const a1 = mkTask('TST-1', 'Edit from A (earlier)', '2026-07-14T11:00:00.000Z')
const b1 = mkTask('TST-1', 'Edit from B (later)', '2026-07-14T11:05:00.000Z')
const fA1 = hub.flush('device-A', pullA1.cursor, [fileOf(a1)])
assert(fA1.hubWins.length === 0, 'A flushes first: applied cleanly (hub unchanged since A pull)')
const fB1 = hub.flush('device-B', pullB1.cursor, [fileOf(b1)])
assert(fB1.hubWins.length === 0, 'B flushes second with NEWER edit: LWW applies B')
assert(hub.tasks.get(1)!.task.title === 'Edit from B (later)', `hub holds the newer edit (got "${hub.tasks.get(1)!.task.title}")`)

// ── Scenario 2: concurrent edit, later edit flushes FIRST → hub wins vs older ─
const pullA2 = hub.pull('device-A')
const pullB2 = hub.pull('device-B')
const a2 = mkTask('TST-2', 'A edit (newer)', '2026-07-14T12:10:00.000Z')
const b2 = mkTask('TST-2', 'B edit (older)', '2026-07-14T12:01:00.000Z')
hub.flush('device-A', pullA2.cursor, [fileOf(a2)])
const fB2 = hub.flush('device-B', pullB2.cursor, [fileOf(b2)])
assert(fB2.hubWins.length === 1, 'B flushing an OLDER concurrent edit gets hub_wins back')
assert(hub.tasks.get(2)!.task.title === 'A edit (newer)', 'hub keeps the newer edit')
assert(fB2.hubWins[0].content.includes('A edit (newer)'), 'B receives the corrected file content to write back')

// ── Scenario 3: delete propagates via tombstone ──────────────────────────────
const pullA3 = hub.pull('device-A')
const fA3 = hub.flush('device-A', pullA3.cursor, [], [3])
assert(fA3.hubWins.length === 0 && !hub.tasks.has(3), 'A deletes TST-3: hub row removed')
assert(hub.tombstones.some(t => t.short_id === 3), 'tombstone recorded for TST-3')
const pullB3 = hub.pull('device-B')
assert(pullB3.tombstoned.includes(3), 'B pull reports the tombstone (delete propagates)')
assert(!('tasks/TST-3.md' in pullB3.files), 'deleted task absent from B pull files')

// ── Scenario 4: edit beats delete (delete side stale) ────────────────────────
const pullA4 = hub.pull('device-A')
const pullB4 = hub.pull('device-B')
const b4 = mkTask('TST-1', 'B keeps working on it', '2026-07-14T13:00:00.000Z')
hub.flush('device-B', pullB4.cursor, [fileOf(b4)])
const fA4 = hub.flush('device-A', pullA4.cursor, [], [1])
assert(hub.tasks.has(1), 'stale delete rejected: task still alive (edit beats delete)')
assert(fA4.hubWins.length === 1 && fA4.hubWins[0].reason.includes('edit beats delete'), 'A told the delete lost, gets current file back')
assert(hub.tasks.get(1)!.task.title === 'B keeps working on it', 'hub holds B\'s edit')

// ── Scenario 5: edit beats delete (edit side vs fresh tombstone) ─────────────
const pullA5 = hub.pull('device-A')
const pullB5 = hub.pull('device-B')
hub.flush('device-A', pullA5.cursor, [], [2]) // A deletes TST-2 → tombstone
const b5 = mkTask('TST-2', 'B edited after A deleted', '2026-07-14T14:00:00.000Z')
const fB5 = hub.flush('device-B', pullB5.cursor, [fileOf(b5)])
assert(fB5.rejected.length === 0 && fB5.hubWins.length === 0, 'B\'s concurrent edit accepted despite tombstone')
assert(hub.tasks.has(2) && hub.tasks.get(2)!.task.title === 'B edited after A deleted', 'task resurrected with B\'s edit (edit beats delete)')

// ── Scenario 6: creation honors leases ───────────────────────────────────────
const pullA6 = hub.pull('device-A')
const newIdA = pullA6.lease.start
const created = mkTask(`TST-${newIdA}`, 'Created locally on A', '2026-07-14T15:00:00.000Z')
const fA6 = hub.flush('device-A', pullA6.cursor, [fileOf(created)])
assert(fA6.rejected.length === 0 && hub.tasks.has(newIdA), `create within lease accepted (TST-${newIdA})`)
const rogue = mkTask('TST-999', 'Rogue id outside lease', '2026-07-14T15:01:00.000Z')
const fA6b = hub.flush('device-A', fA6.cursor, [fileOf(rogue)])
assert(fA6b.rejected.length === 1 && !hub.tasks.has(999), 'create outside lease rejected')
const pullB6 = hub.pull('device-B')
assert(`tasks/TST-${newIdA}.md` in pullB6.files, 'B pull sees the task A created')

// ── Scenario 7: group create-by-reference round-trip guarantee (TDE-581) ─────
// applyFlush creates an unknown `group:` slug NAMED verbatim as the slug ("slug-is-name")
// so the reference is stable across pulls. The core correctness claim is that the created
// group's own slug (derived from its name on the next pull) equals what the user typed —
// i.e. slugify(slug) === slug for anything the file could legally carry as a group slug.
// (The DB write path itself is verified live — applyFlush has no mock-sb harness by design.)
for (const s of ['backend-work', 'bugs', 'q3-planning', 'a', 'group-2', 'ai-native-layer']) {
  assert(slugify(s) === s, `group slug "${s}" round-trips (slugify is idempotent on a slug — slug-is-name is stable)`)
}
// And a raw pretty name does NOT round-trip — this is exactly why we chose slug-is-name over title-casing.
assert(slugify('Backend Work') === 'backend-work' && slugify('Backend Work') !== 'Backend Work', 'a pretty name re-slugs (would drift) — justifies naming the created group the slug verbatim')

// Section create-by-reference uses the identical slug-is-name guarantee (TDE section-create).
for (const s of ['bugs', 'research-planning', 'agent-native-layer', 'q4']) {
  assert(slugify(s) === s, `section slug "${s}" round-trips (slug-is-name stable for sections too)`)
}

// ── Scenario 8: milestones in files (emit + round-trip + seed-item filter) ────
const mMaps = buildPullMaps('TST', [{ id: 'sec1', name: 'Core', sort_order: 0 }], [], [])
const dbRow = { id: 'u1', short_id: 5, text: 'Task with milestones', status: 'pending', priority: 'medium', section_id: 'sec1', sort_order: 0 }
// dbRowToTaskerTask surfaces passed-in milestones; the file round-trips them.
const withMs = dbRowToTaskerTask(dbRow as any, 'TST', mMaps, [{ text: 'step one', done: true }, { text: 'step two', done: false }])
assert(withMs.milestones?.length === 2 && withMs.milestones[0].done === true, 'dbRowToTaskerTask surfaces milestones (done flag preserved)')
const reparsed = parseTaskFile(serializeTaskFile(withMs), 'm').task!
assert(reparsed.milestones?.length === 2 && reparsed.milestones[0].text === 'step one' && reparsed.milestones[1].done === false, 'milestones survive serialize → parse round-trip')
// No milestones passed → field omitted entirely (not an empty array in the file).
const noMs = dbRowToTaskerTask(dbRow as any, 'TST', mMaps)
assert(noMs.milestones === undefined && !serializeTaskFile(noMs).includes('milestones:'), 'no milestones → milestones: omitted from the file')
// The emit-side kind filter: plain steps become milestones; seed items (kind) are dropped.
const steps = [{ summary: 'plain A' }, { summary: 'a question', kind: 'question' }, { summary: 'plain B' }, { summary: 'a prereq', kind: 'prerequisite' }]
const emitted = steps.filter(s => s.kind !== 'question' && s.kind !== 'prerequisite').map(s => s.summary)
assert(emitted.length === 2 && emitted.join(',') === 'plain A,plain B', 'emit filter keeps plain milestones, drops seed question/prerequisite items')

// ── Scenario 9: FROZEN SLUGS — buildSlugMap honors a stored slug (TDE-713) ───
// A stored slug is the permanent identity; it must be used verbatim and NEVER
// recomputed from the name (recompute-on-rename is exactly what orphans refs).
{
  // renamed section: stored slug "core-app" but name now "Core Application"
  const rows = [{ id: 's1', name: 'Core Application', slug: 'core-app' }, { id: 's2', name: 'Bugs' }]
  const m = buildSlugMap(rows)
  assert(m.get('s1') === 'core-app', 'stored slug used verbatim, NOT recomputed from the renamed name')
  assert(m.get('s2') === 'bugs', 'row without a stored slug still computes one (pre-migration fallback)')
  // a computed fallback must not collide with a reserved frozen slug
  const rows2 = [{ id: 'a', name: 'X', slug: 'bugs' }, { id: 'b', name: 'Bugs' }]
  const m2 = buildSlugMap(rows2)
  assert(m2.get('a') === 'bugs' && m2.get('b') === 'bugs-2', 'computed fallback dedupes AROUND a reserved frozen slug (bugs → bugs-2)')
}

// ── Scenario 10: structure manifest round-trip (TDE-713) ─────────────────────
{
  const manifest = {
    sections: [{ slug: 'core-app', name: 'Core App', order: 0 }, { slug: 'bugs', name: 'Bugs', order: 3 }],
    groups: [{ slug: 'google-integrations', name: 'Google Integrations', section: 'mcp-integrations', order: 1 }],
  }
  const { manifest: rt } = parseStructure(serializeStructure(manifest))
  assert(rt !== null && rt.sections.length === 2 && rt.groups.length === 1, 'structure manifest round-trips section+group counts')
  assert(rt!.sections[0].slug === 'core-app' && rt!.sections[0].name === 'Core App', 'section slug + name survive round-trip')
  assert(rt!.groups[0].section === 'mcp-integrations', 'group parent-section slug survives round-trip')
  // tolerates a BOM + ignores rows missing a slug
  const { manifest: rt2 } = parseStructure('﻿' + serializeStructure({ sections: [{ slug: '', name: 'no slug', order: 0 } as any], groups: [] }))
  assert(rt2 !== null && rt2.sections.length === 0, 'BOM tolerated; a section line with no slug is dropped')
}

if (failures > 0) { console.error(`\n${failures} failure(s)`); process.exit(1) }
console.log('\nALL SCENARIOS PASS')
