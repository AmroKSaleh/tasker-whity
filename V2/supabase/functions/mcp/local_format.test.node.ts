// Round-trip test for local_format.ts (TDE-408). Run with:
//   node --experimental-strip-types local_format.test.node.ts
// Exit 0 = pass. Uses the reference example .tasker/ as the fixture.

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { parseTasker, serializeTasker, parseTaskFile, serializeTaskFile, contentHash } from './local_format.ts'

const EXAMPLE = join(import.meta.dirname ?? '.', '..', '..', '..', 'examples', 'blog-post-workflow', '.tasker')

let failures = 0
function assert(cond: boolean, msg: string) {
  if (!cond) { failures++; console.error(`FAIL: ${msg}`) }
  else console.log(`ok: ${msg}`)
}

function canon(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canon)
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(v as object).sort()) out[k] = canon((v as Record<string, unknown>)[k])
    return out
  }
  return v
}
function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(canon(a)) === JSON.stringify(canon(b))
}

// Load the fixture directory into a file map
const files: Record<string, string> = {}
files['project.json'] = readFileSync(join(EXAMPLE, 'project.json'), 'utf8')
for (const f of readdirSync(join(EXAMPLE, 'tasks'))) {
  files[`tasks/${f}`] = readFileSync(join(EXAMPLE, 'tasks', f), 'utf8')
}
assert(Object.keys(files).length === 31, `fixture loaded: ${Object.keys(files).length} files (expect 31: project.json + 30 tasks)`)

// Pass 1: parse the hand-written example
const p1 = parseTasker(files)
assert(p1.model !== null, 'example parses to a model')
assert(p1.warnings.length === 0, `no warnings parsing the reference example (got ${p1.warnings.length}: ${p1.warnings.map(w => `${w.path}: ${w.message}`).join('; ')})`)
if (!p1.model) process.exit(1)
assert(p1.model.tasks.length === 30, `30 tasks parsed (got ${p1.model.tasks.length})`)
assert(p1.model.meta.prefix === 'BPW', 'prefix BPW')
assert(p1.model.meta.sections.length === 5, '5 sections')
assert(p1.model.meta.groups.length === 8, '8 groups')

// Spot checks against known fixture facts
const bpw11 = p1.model.tasks.find(t => t.id === 'BPW-11')
assert(!!bpw11, 'BPW-11 present')
if (bpw11) {
  assert(bpw11.input?.from === 'BPW-4', `BPW-11 input.from is BPW-4 (got ${JSON.stringify(bpw11.input)})`)
  assert(bpw11.body.includes('## First Draft'), 'BPW-11 body preserved')
}
const bpw4 = p1.model.tasks.find(t => t.id === 'BPW-4')
assert(typeof bpw4?.output === 'string' && (bpw4!.output as string).length > 10, 'BPW-4 has a plain-string output')

// Round trip: serialize -> reparse -> models deep-equal
const gen1 = serializeTasker(p1.model)
const p2 = parseTasker(gen1)
assert(p2.model !== null, 'generated files parse back')
assert(p2.warnings.length === 0, `no warnings on generated files (got ${p2.warnings.map(w => w.message).join('; ')})`)
assert(deepEqual(p1.model, p2.model), 'model survives round-trip (parse → serialize → parse deep-equal)')

// Stability: second generation is byte-identical (serializer is a fixed point)
const gen2 = serializeTasker(p2.model!)
assert(deepEqual(Object.keys(gen1).sort(), Object.keys(gen2).sort()), 'same file set on regeneration')
let stable = true
for (const k of Object.keys(gen1)) if (gen1[k] !== gen2[k]) { stable = false; console.error(`  unstable: ${k}`) }
assert(stable, 'regenerated file set is byte-identical (fixed point)')

// D2 deltas: updated_at, JSON-form input edges, output-with-contract, review bar
const rich = {
  id: 'TST-1', title: 'A task with: everything "quoted"', status: 'in_progress' as const,
  priority: 'high' as const, section: 'core', group: 'g1', due: '2026-08-01', order: 20,
  updated_at: '2026-07-14T22:31:07.123Z',
  input: { edges: [{ source_task_id: 'TST-0', contract: { rules: [{ label: 'has data', rule: 'min_length: 10', kind: 'check', severity: 'blocker' }] } }] },
  output: { description: 'the artifact', contract: { rules: [{ label: 'exit 0', rule: 'command: test passes', kind: 'check', severity: 'blocker' }], confirmed: true } },
  review: { bar: { rules: [{ label: 'file exists', kind: 'check', rule: 'path present', severity: 'blocker' }] } },
  milestones: [{ text: 'step one: with colon', done: true }, { text: 'step two', done: false }],
  body: 'Multi-line body.\n\nWith a second paragraph and `code`.',
}
const richText = serializeTaskFile(rich)
const richBack = parseTaskFile(richText, 'rich').task
assert(richBack !== null, 'rich task parses back')
assert(deepEqual(rich, richBack), `rich task round-trips all D2 deltas${deepEqual(rich, richBack) ? '' : '\n  got: ' + JSON.stringify(richBack)}`)

// Hash determinism
assert(contentHash('hello') === contentHash('hello') && contentHash('hello') !== contentHash('hello!'), 'contentHash deterministic and discriminating')

if (failures > 0) { console.error(`\n${failures} failure(s)`); process.exit(1) }
console.log('\nALL PASS')
