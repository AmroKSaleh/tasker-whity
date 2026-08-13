// TDE-816 — unit tests for the flow exception derivation (run: deno test flow_exceptions.test.ts)
// This module is imported by BOTH the MCP tool and the web Flows page, so a regression here
// desynchronises what a human is told needs them from what the agent is told.
import { deriveFlowExceptions, flowTerminalIds, renderFlowExceptions } from './flow_exceptions.ts'

function assert(cond: any, msg: string) {
  if (!cond) throw new Error('FAIL: ' + msg)
}
function eq(a: any, b: any, msg: string) {
  if (a !== b) throw new Error(`FAIL: ${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`)
}

const T = (id: string, text: string, over: any = {}) => ({
  id, text, status: 'done', short_id: id.replace('t', ''), flow_step: Number(id.replace('t', '')),
  sort_order: 0, input: null, output: null, executor: 'agent', ...over,
})
const edge = (src: string) => ({ edges: [{ source_task_id: src, contract: { rules: [] } }] })

// ── terminal steps ───────────────────────────────────────────────────────────
Deno.test('gateless flow: only the last step is terminal, not every step', () => {
  // Contracts are optional (TDE-792), so an ungated flow has no edges and every step is
  // childless. Marking all of them terminal is the exact volume that causes rubber-stamping.
  const tasks = [T('t1', 'One'), T('t2', 'Two'), T('t3', 'Three')]
  eq([...flowTerminalIds(tasks)].join(), 't3', 'last step by flow_step is the terminus')
  const excs = deriveFlowExceptions(tasks, 'TDE')
  eq(excs.length, 1, 'one exception for a clean gateless flow')
  eq(excs[0].kind, 'terminal', 'and it is the terminal output')
  eq(excs[0].task.ref, 'TDE-3', 'ref uses the project prefix')
})

Deno.test('DAG: terminals are the childless nodes', () => {
  const tasks = [
    T('t1', 'Root'), T('t2', 'Middle', { input: edge('t1') }),
    T('t3', 'End', { input: edge('t2') }), T('t4', 'Side', { input: edge('t1') }),
  ]
  eq([...flowTerminalIds(tasks)].sort().join(), 't3,t4', 'both leaves are terminal')
})

// ── failed checks ────────────────────────────────────────────────────────────
Deno.test('failed check carries the observed value and sorts by blast radius', () => {
  const tasks = [
    T('t1', 'Root', {
      output: { validation_ledgers: { t2: { retry_count: 2, ledger: [
        { rule_id: 'r1', label: 'Word count', kind: 'check', severity: 'blocker', status: 'fail', observed_value: '412 words', note: 'needs 1000+' },
      ] } } },
    }),
    T('t2', 'Middle', { input: edge('t1') }),
    T('t3', 'End', { input: edge('t2') }),
  ]
  const excs = deriveFlowExceptions(tasks, 'TDE')
  eq(excs[0].kind, 'failed_check', 'the failure outranks the terminal output')
  eq(excs[0].blast, 2, 'two steps transitively build on the failing one')
  eq(excs[0].failure!.observedValue, '412 words', 'what was seen, not the claim')
  eq(excs[0].failure!.gateInto!.ref, 'TDE-2', 'the gate names its consumer')
  eq(excs[0].failure!.retryCount, 2, 'retries carried through')
})

// ── judgment residue ─────────────────────────────────────────────────────────
Deno.test('judgment residue: only judgment rules, only until independently ruled on', () => {
  const base = () => [
    T('t1', 'Root', { output: { contract: { rules: [
      { id: 'j1', label: 'Tone', rule: 'Reads as editorial, not marketing', kind: 'judgment' },
      { id: 'c1', label: 'Has a link', rule: 'Contains at least one URL', kind: 'check' },
    ] } } }),
    T('t2', 'End', { input: edge('t1') }),
  ]
  const residue = (tasks: any[]) => deriveFlowExceptions(tasks, 'TDE').filter(e => e.kind === 'judgment_residue')
  eq(residue(base()).length, 1, 'the check is not residue — something can verify it')
  eq(residue(base())[0].residue!.label, 'Tone', 'the judgment rule is')

  const independent = base()
  independent[0].output.validation_ledgers = { t2: { ledger: [{ rule_id: 'j1', status: 'pass', validator: 'independent-subagent' }] } }
  eq(residue(independent).length, 0, 'an independent pass clears it')

  const self = base()
  self[0].output.validation_ledgers = { t2: { ledger: [{ rule_id: 'j1', status: 'pass', validator: 'self' }] } }
  eq(residue(self).length, 1, 'a self-pass does not — that is the correlated blind spot')
})

// ── rendering ────────────────────────────────────────────────────────────────
Deno.test('rendered text keeps the agent-facing shape', () => {
  const tasks = [
    T('t1', 'Root', { output: { validation_ledgers: { t2: { ledger: [
      { rule_id: 'r1', label: 'Word count', kind: 'check', severity: 'blocker', status: 'fail', observed_value: '412 words' },
    ] } } } }),
    T('t2', 'End', { input: edge('t1') }),
  ]
  const text = renderFlowExceptions(deriveFlowExceptions(tasks, 'TDE'), {
    flowName: 'Test Flow', shortId: 'TDE-F1', stepCount: 2, stepListOpen: true,
  })
  assert(text.startsWith('# What needs you — "Test Flow"  [TDE-F1]'), 'header')
  assert(text.includes('2 steps known so far (step list OPEN)'), 'open step list is stated, not hidden')
  assert(text.includes('── FAILED CHECKS (1) — a gate rejected something ──'), 'failure section')
  assert(text.includes('      observed: 412 words'), 'observed value is indented under the failure')
  assert(text.includes('── TERMINAL OUTPUT (1) — unconditional gate ──'), 'terminal section')
  assert(renderFlowExceptions([], { flowName: 'Empty', stepCount: 2 }).includes('Nothing needs you.'), 'empty state')
})

Deno.test('missing observed value is reported as asserted-not-run', () => {
  const tasks = [
    T('t1', 'Root', { output: { validation_ledgers: { t2: { ledger: [
      { rule_id: 'r1', label: 'Word count', kind: 'check', status: 'fail' },
    ] } } } }),
    T('t2', 'End', { input: edge('t1') }),
  ]
  const text = renderFlowExceptions(deriveFlowExceptions(tasks, 'TDE'), { flowName: 'F', stepCount: 2 })
  assert(text.includes('observed: (none recorded — the check was asserted, not run)'), 'no silent pass-off')
})
