/**
 * Spec Kit parser tests — run with: node src/specKit.test.js
 * Validates against the fixture in V2/examples/spec-kit-sample/tasks.md
 */

import { parseSpecKitContent, parseSpecKitFile, findSpecKitTasksFile } from './specKit.js'
import { fileURLToPath } from 'url'
import { join, dirname } from 'path'

const __dir      = dirname(fileURLToPath(import.meta.url))
const SAMPLE_DIR = join(__dir, '..', '..', 'examples', 'spec-kit-sample')
const SAMPLE     = join(SAMPLE_DIR, 'tasks.md')

let passed = 0
let failed = 0

function assert(label, cond, detail = '') {
  if (cond) { console.log(`  ✅  ${label}`); passed++ }
  else      { console.error(`  ❌  ${label}${detail ? ' — ' + detail : ''}`); failed++ }
}
function assertEqual(label, a, b) {
  assert(label, a === b, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`)
}

// ─── Spec Kit tasks.md fixture ────────────────────────────────────────────────

console.log('\n── Spec Kit: tasks.md fixture ──────────────────')
const sk = await parseSpecKitFile(SAMPLE)

assertEqual('project name Link Shortener API', sk.project.name, 'Link Shortener API')
assertEqual('prefix LSA',  sk.project.prefix,  'LSA')
assertEqual('8 tasks',     sk.tasks.length,    8)
assertEqual('3 sections',  sk.sections.length, 3)
assertEqual('0 groups',    sk.groups.length,   0)
assert('no warnings', sk.warnings.length === 0, sk.warnings.join(', '))

const byId = id => sk.tasks.find(t => t.id === id)
assertEqual('T001 done',       byId('T001').status,   'done')
assertEqual('T002 done',       byId('T002').status,   'done')
assertEqual('T003 pending',    byId('T003').status,   'pending')
assertEqual('T001 short_id 1', byId('T001').short_id, 1)
assertEqual('T008 short_id 8', byId('T008').short_id, 8)

assert('[P] stripped from T003', !byId('T003').text.includes('[P]'), byId('T003').text)
assert('[P] stripped from T004', !byId('T004').text.includes('[P]'), byId('T004').text)
assertEqual('T003 text clean', byId('T003').text, 'Configure ESLint and Prettier')

const names = sk.sections.map(s => s.name)
assert('section names in order',
  JSON.stringify(names) === JSON.stringify(['Setup', 'Tests First (TDD)', 'Core Implementation']),
  names.join(' | '))
assertEqual('T001 → setup',              byId('T001').section_id, 'setup')
assertEqual('T006 → core-implementation', byId('T006').section_id, 'core-implementation')

assert('only valid statuses',
  sk.tasks.every(t => ['pending', 'in_progress', 'done'].includes(t.status)))
assert('all tasks have a section', sk.tasks.every(t => !!t.section_id))

// ─── Plain markdown checklist (no headings) ───────────────────────────────────

console.log('\n── Plain markdown checklist (no headings) ──────')
const plain = parseSpecKitContent('- [ ] Do the thing\n- [x] Did the other thing\n')

assertEqual('2 tasks',              plain.tasks.length,       2)
assertEqual('1 default section',    plain.sections.length,    1)
assertEqual('default section name', plain.sections[0].name,  'Tasks')
assertEqual('first task pending',   plain.tasks[0].status,   'pending')
assertEqual('second task done',     plain.tasks[1].status,   'done')
assert('orphan tasks linked to default section',
  plain.tasks.every(t => t.section_id === 'tasks'))

// ─── Detection ─────────────────────────────────────────────────────────────────

console.log('\n── Detection: findSpecKitTasksFile ─────────────')
const found = await findSpecKitTasksFile(SAMPLE_DIR)
assert('finds tasks.md in sample dir', !!found && found.endsWith('tasks.md'), String(found))

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n── Result ──────────────────────────────────────`)
console.log(`   ${passed} passed  |  ${failed} failed`)
if (failed > 0) process.exit(1)
