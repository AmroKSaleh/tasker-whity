// TDE-287 — unit tests for the contract logic (run: deno test contract_gate.test.ts)
import { lintRule, deriveOutputFromConsumers, contractAdvisories, renderContractAdvisory } from './contract_gate.ts'

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

// ── contractAdvisories (TDE-820) ──────────────────────────────────────────────
// Replaces contractGateViolations. Nothing here blocks — the three states a handoff can be
// in are now DISTINGUISHED rather than collapsed into one "violation":
//   ungated   = no contract (legitimate; gates belong only at seams)
//   vague     = a contract exists but trips the linter
//   unblessed = sharp rules, not yet human-confirmed
// Flow A → B: A produces, B consumes.
const flowAB = (aOut: any, bIn: any) => ([
  { id: 'a', short_id: 1, text: 'Producer', input: { edges: [] }, output: { contract: aOut } },
  { id: 'b', short_id: 2, text: 'Consumer', input: { edges: [{ source_task_id: 'a', contract: bIn }] }, output: {} },
])
const kinds = (as: any[]) => as.map(a => a.kind).sort()

Deno.test('advisory: silent when both sides are non-trivial and blessed', () => {
  const a = contractAdvisories(flowAB(blessed([goodRule('o')]), blessed([goodRule('i')])))
  eq(a.length, 0, 'a fully-blessed flow produces no advisories')
  eq(renderContractAdvisory(a), '', 'nothing rendered when there is nothing to say')
})
Deno.test('advisory: an unblessed input edge is unblessed, not a violation', () => {
  const a = contractAdvisories(flowAB(blessed([goodRule('o')]), unblessed([goodRule('i')])))
  eq(kinds(a).join(','), 'unblessed', 'only the input edge is flagged, as unblessed')
  assert(a[0].where.includes('input'), 'points at the input edge')
})
Deno.test('advisory: an unblessed output def-of-done is unblessed', () => {
  const a = contractAdvisories(flowAB(unblessed([goodRule('o')]), blessed([goodRule('i')])))
  eq(kinds(a).join(','), 'unblessed', 'only the output side is flagged')
  assert(a[0].where.includes('output'), 'points at the output def-of-done')
})
// THE REGRESSION THIS TASK EXISTS TO PREVENT: an absent contract used to be reported as
// "no rules (empty contract)" and hard-blocked name_flow, forcing bypass on a valid flow.
Deno.test('advisory: an ABSENT contract is ungated — never an error', () => {
  const a = contractAdvisories(flowAB(blessed([]), blessed([goodRule('i')])))
  eq(kinds(a).join(','), 'ungated', 'empty output contract is ungated, not a violation')
  assert(!/violation|issue|blocked/i.test(renderContractAdvisory(a)), 'wording does not imply failure')
})
Deno.test('advisory: a fully ungated flow yields only ungated advisories', () => {
  const a = contractAdvisories(flowAB(blessed([]), blessed([])))
  eq(kinds(a).join(','), 'ungated,ungated', 'both sides ungated, nothing else')
})
Deno.test('advisory: a vague rule is vague even when blessed', () => {
  const a = contractAdvisories(flowAB(blessed([vagueRule('o')]), blessed([goodRule('i')])))
  eq(kinds(a).join(','), 'vague', 'vague rule surfaced despite blessing')
  assert(a[0].detail.includes('vague/uncheckable'), 'names the flagged rule')
})
Deno.test('advisory: the three kinds are reported independently, not collapsed', () => {
  const tasks = [
    { id: 'a', short_id: 1, text: 'A', input: { edges: [] }, output: { contract: blessed([]) } },                 // ungated output
    { id: 'b', short_id: 2, text: 'B', input: { edges: [{ source_task_id: 'a', contract: blessed([vagueRule('i')]) }] }, output: { contract: unblessed([goodRule('o')]) } },
    { id: 'c', short_id: 3, text: 'C', input: { edges: [{ source_task_id: 'b', contract: blessed([goodRule('i')]) }] }, output: {} },
  ]
  // kinds() sorts alphabetically: unblessed < ungated < vague.
  eq(kinds(contractAdvisories(tasks)).join(','), 'unblessed,ungated,vague', 'one of each, distinguishable')
})
Deno.test('advisory: ignores edges to tasks outside the flow', () => {
  const tasks = [
    { id: 'b', short_id: 2, text: 'Consumer', input: { edges: [{ source_task_id: 'external', contract: unblessed([goodRule('i')]) }] }, output: {} },
  ]
  eq(contractAdvisories(tasks).length, 0, 'external edge not advised on')
})
