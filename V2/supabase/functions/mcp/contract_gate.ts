// ── Contract logic for Tasker Flows (extracted for testability — TDE-287) ────
// Pure functions, no Supabase/IO deps: the I/O-edge model, the rule-quality linter,
// the derive-from-input governance, and the verifiable contract gate. Unit-tested in
// contract_gate.test.ts; imported by index.ts.

// Each input edge carries the CONSUMER's acceptance criteria for that one incoming
// artifact (fan-in = multiple edges). `output` holds the producer's single
// definition-of-done contract plus the validation ledger.
export function inputEdges(input: any): Array<{ source_task_id: string, expected_type?: string, contract: { rules: any[] } }> {
  if (!input) return []
  if (Array.isArray(input.edges)) {
    return input.edges.filter((e: any) => e && e.source_task_id)
  }
  if (input.source_task_id) {
    // Legacy single-source shape → one edge; fold validation_rules into a judgment rule.
    const rules = input.validation_rules
      ? [{ id: 'legacy', label: 'Validation rules', rule: input.validation_rules, kind: 'judgment', severity: 'blocker' }]
      : []
    return [{ source_task_id: input.source_task_id, expected_type: input.expected_type, contract: { rules } }]
  }
  return []
}

// All upstream source task IDs this task consumes from (the tasks that block it).
export function inputSourceIds(input: any): string[] {
  return inputEdges(input).map(e => e.source_task_id)
}

// The producer's output contract ({ rules: [], confirmed: false } if none set).
export function outputContract(output: any): { rules: any[], confirmed: boolean } {
  if (output?.contract?.rules) return { ...output.contract, confirmed: output.contract.confirmed === true }
  return { rules: [], confirmed: false }
}

// Detect vague rules that are hard to enforce or trivially self-pass.
const VAGUE_RULE_WORDS = /\b(readable|clarity|clear|good|nice|appropriate|reasonable|relevant|professional|adequate|sufficient|proper|well.written|high.quality|comprehensive|thorough|engaging|interesting|helpful|useful)\b/i
export function lintRule(r: any): string | null {
  const text = (r.rule || '').trim()
  if (text.length < 15) return 'rule is too short to be checkable — add a specific, measurable criterion'
  const match = text.match(VAGUE_RULE_WORDS)
  if (match) return `vague language "${match[0]}" — replace with a concrete, verifiable criterion (e.g. instead of "readable" → "each sentence under 25 words, no unexplained jargon"; instead of "comprehensive" → "covers all N sections listed in the outline")`
  return null
}

// ── TDE-287: derive-from-input governance ────────────────────────────────────
// The original intent of the I/O system was that a producer's output contract is
// GOVERNED by what its downstream consumers demand — the consumer's input-edge rules
// ARE the acceptance criteria the output must satisfy. This derives a DRAFT output
// contract from those consumer rules, plus the assumptions made while deriving (the
// surfacing half of the authoring loop). `consumerTasks` = every task that lists
// `producerId` as an input source.
export function deriveOutputFromConsumers(producerId: string, consumerTasks: any[]): { rules: any[], assumptions: string[], sources: Array<{ id: string, text: string }> } {
  const assumptions: string[] = []
  const sources: Array<{ id: string, text: string }> = []
  const draft: any[] = []
  const seen = new Set<string>()
  for (const c of consumerTasks) {
    const edge = inputEdges(c.input).find((e: any) => e.source_task_id === producerId)
    if (!edge) continue
    sources.push({ id: c.id, text: c.text })
    const rules = edge.contract?.rules || []
    if (!rules.length) {
      assumptions.push(`Consumer "${c.text}" declares no input rules on this edge — there is nothing to derive from it, so the output bar for that handoff would be a guess, not a requirement.`)
      continue
    }
    for (const r of rules) {
      const key = (r.rule || '').trim().toLowerCase()
      if (!key) continue
      if (seen.has(key)) {
        assumptions.push(`Rule "${r.label}" is demanded by more than one consumer — merged into a single output rule; verify they mean the same thing.`)
        continue
      }
      seen.add(key)
      const lint = lintRule(r)
      if (lint) assumptions.push(`Derived rule "${r.label}" inherits vague language from the consumer's input criterion — ${lint}`)
      draft.push({
        label: r.label,
        rule: r.rule,
        description: r.description || `Derived from the input requirement of "${c.text}".`,
        kind: r.kind === 'check' ? 'check' : 'judgment',
        severity: r.severity === 'warning' ? 'warning' : 'blocker',
      })
    }
  }
  if (!draft.length && !assumptions.length) {
    assumptions.push('No downstream consumer lists this task as an input source — there is nothing to derive an output contract from. Wire the consumer edge first (set_task_input), or author the def-of-done directly.')
  }
  return { rules: draft, assumptions, sources }
}

// ── TDE-287 / finishes TDE-203: the verifiable contract gate ─────────────────
// A flow may only be finalized (name_flow) when every INTERNAL handoff carries a
// non-trivial, human-blessed contract — on BOTH sides: the producer's output
// definition-of-done and the consumer's input acceptance criteria. Returns a list
// of human-readable violations; an empty list means the gate passes.
export function contractGateViolations(flowTasks: any[]): string[] {
  const inFlow = new Set(flowTasks.map((t: any) => t.id))
  const ref = (t: any) => `${t.short_id != null ? `#${t.short_id}` : t.id.slice(0, 8)} "${t.text}"`
  const refId = (id: string) => {
    const t = flowTasks.find((x: any) => x.id === id)
    return t ? (t.short_id != null ? `#${t.short_id}` : id.slice(0, 8)) : id.slice(0, 8)
  }
  // A contract's rules must exist and none may trip the vagueness linter.
  const ruleIssue = (rules: any[]): string | null => {
    if (!rules || !rules.length) return 'no rules (empty contract)'
    const flagged = rules.map((r: any) => (lintRule(r) ? `"${r.label}"` : null)).filter(Boolean)
    if (flagged.length) return `vague/uncheckable rule(s): ${flagged.join(', ')}`
    return null
  }
  const violations: string[] = []
  for (const t of flowTasks) {
    const edges = inputEdges(t.input).filter((e: any) => inFlow.has(e.source_task_id))
    for (const e of edges) {
      const c: any = e.contract || {}
      const issue = ruleIssue(c.rules)
      if (issue) violations.push(`${ref(t)} ← input from ${refId(e.source_task_id)}: ${issue}`)
      else if (c.confirmed !== true) violations.push(`${ref(t)} ← input from ${refId(e.source_task_id)}: contract not human-blessed (run confirm_contract)`)
    }
    const feedsInFlow = flowTasks.some((o: any) => inputEdges(o.input).some((e: any) => e.source_task_id === t.id))
    if (feedsInFlow) {
      const oc = outputContract(t.output)
      const issue = ruleIssue(oc.rules)
      if (issue) violations.push(`${ref(t)} → output def-of-done: ${issue}`)
      else if (oc.confirmed !== true) violations.push(`${ref(t)} → output def-of-done: contract not human-blessed (run confirm_contract)`)
    }
  }
  return violations
}
