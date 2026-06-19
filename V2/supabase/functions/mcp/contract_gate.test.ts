// TDE-287 — unit tests for the contract logic (run: deno test contract_gate.test.ts)
import { lintRule, deriveOutputFromConsumers, contractGateViolations } from './contract_gate.ts'

function assert(cond: any, msg: string) {
  if (!cond) throw new Error('FAIL: ' + msg)
}
function eq(a: any, b: any, msg: string) {
  if (a !== b) throw new Error(`FAIL: ${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`)
}

const goodRule = (label: string) => ({ id: label, label, rule: 'output must contain a passing test command with exit code 0', kind: 'check', severity: 'blocker' })
const vagueRule = (label: string) => ({ id: label, label, rule: 'the result should be readable and comprehensive', kind: 'judgment', severity: 'blocker' })
const blessed = (rules: any[]) => ({ rules, confirmed: true })
const unblessed = (rules: any[]) => ({ rules, confirmed: false })

// ── lintRule ────────────────────────────────────────────────────────────────
Deno.test('lintRule passes a concrete rule', () => {
  eq(lintRule(goodRule('a')), null, 'concrete rule should not be flagged')
})
Deno.test('lintRule flags vague language', () => {
  assert(lintRule(vagueRule('a'))?.includes('vague language'), 'vague rule should be flagged')
})
Deno.test('lintRule flags too-short rules', () => {
  assert(lintRule({ rule: 'short' })?.includes('too short'), 'short rule should be flagged')
})

// ── deriveOutputFromConsumers ─────────────────────────────────────────────────
Deno.test('derive: produces rules from a consumer input edge', () => {
  const consumer = { id: 'b', text: 'Consumer', input: { edges: [{ source_task_id: 'a', contract: { rules: [goodRule('needs-test')] } }] } }
  const d = deriveOutputFromConsumers('a', [consumer])
  eq(d.rules.length, 1, 'one derived rule')
  eq(d.rules[0].label, 'needs-test', 'rule label carried over')
  eq(d.sources.length, 1, 'one source consumer')
})
Deno.test('derive: dedupes a rule demanded by two consumers and surfaces the merge', () => {
  const r = goodRule('shared')
  const c1 = { id: 'b', text: 'B', input: { edges: [{ source_task_id: 'a', contract: { rules: [r] } }] } }
  const c2 = { id: 'c', text: 'C', input: { edges: [{ source_task_id: 'a', contract: { rules: [r] } }] } }
  const d = deriveOutputFromConsumers('a', [c1, c2])
  eq(d.rules.length, 1, 'merged to a single rule')
  assert(d.assumptions.some(a => a.includes('more than one consumer')), 'merge assumption surfaced')
})
Deno.test('derive: surfaces an assumption when a consumer has no input rules', () => {
  const consumer = { id: 'b', text: 'Bare', input: { edges: [{ source_task_id: 'a', contract: { rules: [] } }] } }
  const d = deriveOutputFromConsumers('a', [consumer])
  eq(d.rules.length, 0, 'nothing to derive')
  assert(d.assumptions.some(a => a.includes('no input rules')), 'no-rules assumption surfaced')
})
Deno.test('derive: surfaces an assumption when there are no consumers at all', () => {
  const d = deriveOutputFromConsumers('a', [])
  assert(d.assumptions.some(a => a.includes('No downstream consumer')), 'no-consumer assumption surfaced')
})
Deno.test('derive: flags vague language inherited from the consumer', () => {
  const consumer = { id: 'b', text: 'B', input: { edges: [{ source_task_id: 'a', contract: { rules: [vagueRule('soft')] } }] } }
  const d = deriveOutputFromConsumers('a', [consumer])
  assert(d.assumptions.some(a => a.includes('vague language')), 'vague-inheritance assumption surfaced')
})

// ── contractGateViolations ────────────────────────────────────────────────────
// Flow A → B: A produces, B consumes. A's output + B's input edge must both be blessed.
const flowAB = (aOut: any, bIn: any) => ([
  { id: 'a', short_id: 1, text: 'Producer', input: { edges: [] }, output: { contract: aOut } },
  { id: 'b', short_id: 2, text: 'Consumer', input: { edges: [{ source_task_id: 'a', contract: bIn }] }, output: {} },
])

Deno.test('gate: passes when both sides are non-trivial and blessed', () => {
  const v = contractGateViolations(flowAB(blessed([goodRule('o')]), blessed([goodRule('i')])))
  eq(v.length, 0, 'no violations on a fully-blessed flow')
})
Deno.test('gate: blocks an unblessed input edge', () => {
  const v = contractGateViolations(flowAB(blessed([goodRule('o')]), unblessed([goodRule('i')])))
  assert(v.some(x => x.includes('input') && x.includes('not human-blessed')), 'unblessed input flagged')
})
Deno.test('gate: blocks an unblessed output def-of-done', () => {
  const v = contractGateViolations(flowAB(unblessed([goodRule('o')]), blessed([goodRule('i')])))
  assert(v.some(x => x.includes('output') && x.includes('not human-blessed')), 'unblessed output flagged')
})
Deno.test('gate: blocks an empty contract', () => {
  const v = contractGateViolations(flowAB(blessed([]), blessed([goodRule('i')])))
  assert(v.some(x => x.includes('no rules')), 'empty output contract flagged')
})
Deno.test('gate: blocks a vague rule even when blessed', () => {
  const v = contractGateViolations(flowAB(blessed([vagueRule('o')]), blessed([goodRule('i')])))
  assert(v.some(x => x.includes('vague/uncheckable')), 'vague rule flagged despite blessing')
})
Deno.test('gate: ignores edges to tasks outside the flow', () => {
  // B consumes 'external' which is NOT in the flow → that edge is not gated.
  const tasks = [
    { id: 'b', short_id: 2, text: 'Consumer', input: { edges: [{ source_task_id: 'external', contract: unblessed([goodRule('i')]) }] }, output: {} },
  ]
  eq(contractGateViolations(tasks).length, 0, 'external edge not gated')
})
