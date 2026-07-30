/**
 * Parser tests — run with: node src/parser.test.js
 * Validates against the real example fixtures in V2/examples/.
 */

import { parseTaskerDir, derivePrefix } from './parser.js'
import { fileURLToPath } from 'url'
import { join, dirname } from 'path'

const __dir = dirname(fileURLToPath(import.meta.url))
const EXAMPLES = join(__dir, '..', '..', 'examples')

let passed = 0
let failed = 0

function assert(label, cond, detail = '') {
  if (cond) {
    console.log(`  ✅  ${label}`)
    passed++
  } else {
    console.error(`  ❌  ${label}${detail ? ' — ' + detail : ''}`)
    failed++
  }
}

function assertEqual(label, a, b) {
  assert(label, a === b, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`)
}

// ─── derivePrefix ─────────────────────────────────────────────────────────────

console.log('\n── derivePrefix ───────────────────────────────')
assertEqual('Blog Post Workflow → BPW',       derivePrefix('Blog Post Workflow'),       'BPW')
assertEqual('Link Shortener Service → LSS',   derivePrefix('Link Shortener Service'),   'LSS')
assertEqual('Tasker → TSK',                   derivePrefix('Tasker'),                   'TSK')
assertEqual('API → API',                      derivePrefix('API'),                      'API')
assertEqual('My App → MA',                    derivePrefix('My App'),                   'MA')

// ─── Blog Post Workflow (30 tasks, 5 sections, 8 groups) ─────────────────────

console.log('\n── Blog Post Workflow ──────────────────────────')
const bpw = await parseTaskerDir(join(EXAMPLES, 'blog-post-workflow', '.tasker'))

assertEqual('30 tasks',    bpw.tasks.length,    30)
assertEqual('5 sections',  bpw.sections.length,  5)
assertEqual('8 groups',    bpw.groups.length,    8)
assertEqual('prefix BPW',  bpw.project.prefix,  'BPW')
assert('no warnings', bpw.warnings.length === 0, bpw.warnings.join(', '))

// Flow chain: BPW-4 → BPW-11 → BPW-18 → BPW-24
const byId = id => bpw.tasks.find(t => t.id === id)
assert('BPW-4 is flow root (no input)',    !byId('BPW-4').input)
assertEqual('BPW-11 depends on BPW-4',    byId('BPW-11').input?.source_task_id, 'BPW-4')
assertEqual('BPW-18 depends on BPW-11',   byId('BPW-18').input?.source_task_id, 'BPW-11')
assertEqual('BPW-24 depends on BPW-18',   byId('BPW-24').input?.source_task_id, 'BPW-18')

// Section refs resolve
const planningTasks = bpw.tasks.filter(t => t.section_id === 'planning')
assert('planning tasks > 0', planningTasks.length > 0)
const writingTasks = bpw.tasks.filter(t => t.section_id === 'writing')
assert('writing tasks > 0',  writingTasks.length > 0)

// BPW-4 has body text (output + notes)
assert('BPW-4 has output', !!byId('BPW-4').output)

// flow_names keyed by root task
assert('flow_names has BPW-4',
  Object.prototype.hasOwnProperty.call(bpw.project.context.flow_names, 'BPW-4'))
assertEqual('flow name is Publishing Pipeline',
  bpw.project.context.flow_names['BPW-4'], 'Publishing Pipeline')

// Statuses
const allStatuses = new Set(bpw.tasks.map(t => t.status))
assert('only valid statuses',
  [...allStatuses].every(s => ['pending','in_progress','done'].includes(s)))

// ─── Link Shortener Service (13 tasks) ───────────────────────────────────────

console.log('\n── Link Shortener Service (tasker-demo) ────────')
const lss = await parseTaskerDir(join('C:', 'Users', 'PC', 'tasker-demo', '.tasker'))

assertEqual('13 tasks',    lss.tasks.length,    13)
assertEqual('5 sections',  lss.sections.length,  5)
assertEqual('2 groups',    lss.groups.length,    2)
assertEqual('prefix LSS',  lss.project.prefix,  'LSS')
assert('no warnings', lss.warnings.length === 0, lss.warnings.join(', '))

// Pipeline flow: LSS-1 → LSS-2 → LSS-3 → LSS-4 → LSS-5 → LSS-6
const lById = id => lss.tasks.find(t => t.id === id)
assert('LSS-1 is root (no input)',         !lById('LSS-1').input)
assertEqual('LSS-2 depends on LSS-1',      lById('LSS-2').input?.source_task_id, 'LSS-1')
assertEqual('LSS-3 depends on LSS-2',      lById('LSS-3').input?.source_task_id, 'LSS-2')
assertEqual('LSS-4 depends on LSS-3',      lById('LSS-4').input?.source_task_id, 'LSS-3')
assertEqual('LSS-5 depends on LSS-4',      lById('LSS-5').input?.source_task_id, 'LSS-4')
assertEqual('LSS-6 depends on LSS-5',      lById('LSS-6').input?.source_task_id, 'LSS-5')

// Statuses after the PR (LSS-3 and LSS-4 are done on that branch; main still has original)
const lss1Status = lById('LSS-1').status
const lss2Status = lById('LSS-2').status
assert('LSS-1 done', lss1Status === 'done')
assert('LSS-2 done', lss2Status === 'done')

// Milestones on LSS-3
const lss3 = lById('LSS-3')
assert('LSS-3 has milestones', lss3.milestones.length > 0)
assert('LSS-3 milestones have text', lss3.milestones.every(m => typeof m.text === 'string'))
assert('LSS-3 milestones have done', lss3.milestones.every(m => typeof m.done === 'boolean'))

// Short IDs
assertEqual('LSS-3 short_id is 3', lById('LSS-3').short_id, 3)
assertEqual('LSS-6 short_id is 6', lById('LSS-6').short_id, 6)

// Groups
const endpointsTasks = lss.tasks.filter(t => t.group_id === 'endpoints')
assert('endpoints group has tasks', endpointsTasks.length > 0)
assertEqual('LSS-3 group is endpoints', lById('LSS-3').group_id, 'endpoints')

// flow_names
assertEqual('Core API Pipeline flow name',
  lss.project.context.flow_names['LSS-1'], 'Core API Pipeline')

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n── Result ──────────────────────────────────────`)
console.log(`   ${passed} passed  |  ${failed} failed`)
if (failed > 0) process.exit(1)
