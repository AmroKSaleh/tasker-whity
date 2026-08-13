// ── Flow exceptions — the human review surface for a flow (TDE-382 → TDE-816) ──
// Pure functions, no Supabase/Deno deps. Extracted from index.ts so the MCP tool and
// the web Flows page derive exceptions from ONE implementation instead of a mirror.
// Every other client-side mirror in this repo (flowGraph.js, projectTransfer.js,
// SectionContextSidebar.jsx) carries a "keep in sync" comment and the standing risk
// that it does not. That risk is unacceptable here specifically: this is the surface
// that tells a human whether a flow is clean, so a drifted copy means the web says
// "nothing needs you" while the agent is being told a gate failed.
//
// THE DESIGN (Q7 / TDE-799): human attention DEGRADES with volume — 29 step outputs
// means rubber-stamping by the sixth, and a rubber-stamped output is worse than an
// ungated one because it then carries confidence it never earned. So a human is shown
// EXCEPTIONS, never outputs, and review load scales with problems found rather than
// with flow length. What this module deliberately omits — passing checks, artifacts,
// progress — is omission on purpose. get_flow_audit is the everything view.

import { inputEdges, outputContract } from './contract_gate.ts'

export type FlowExceptionKind = 'failed_check' | 'judgment_residue' | 'terminal'

export type TaskRef = { id: string, ref: string, text: string }

export type FlowException = {
  kind: FlowExceptionKind
  task: TaskRef & { status: string | null, executor: string | null }
  // How many steps transitively build on this one. Q7's placement rule: gate early
  // seams in long flows first, because a bad output early contaminates everything
  // downstream while the last step contaminates only itself.
  blast: number
  failure?: {
    ruleId: string
    label: string
    ruleKind: 'check' | 'judgment'
    severity: string
    observedValue: string | null
    note: string | null
    gateInto: TaskRef | null
    gateIntoKey: string
    retryCount: number
  }
  residue?: { ruleId: string, label: string, rule: string }
}

export function taskRef(task: any, prefix?: string | null): string {
  const p = prefix ?? task?.project?.prefix
  if (p && task?.short_id != null) return `${p}-${task.short_id}`
  return `#${task?.short_id ?? String(task?.id ?? '').slice(0, 8)}`
}

const KIND_RANK: Record<FlowExceptionKind, number> = { failed_check: 0, judgment_residue: 1, terminal: 2 }

// Which steps end the operation — nothing downstream can catch a problem in their
// output, which is what makes this Q7's one unconditional gate.
//
// Childless-in-the-DAG is the right test only when the flow HAS a DAG. Contracts are
// optional (TDE-792), so a legitimately ungated flow has no edges at all and every
// step is childless — under the naive rule a 12-step ungated flow reports 12 terminal
// exceptions, which is exactly the volume-driven rubber-stamping Q7 exists to prevent.
// With no wiring, the operation's terminus is simply its last step.
export function terminalTaskIds(tasks: any[], childrenOf: Map<string, string[]>, hasEdges: boolean): Set<string> {
  const childless = tasks.filter(t => !(childrenOf.get(t.id)?.length))
  if (hasEdges) return new Set(childless.map(t => t.id))
  const last = [...tasks].sort((a, b) =>
    ((a.flow_step ?? Number.MAX_SAFE_INTEGER) - (b.flow_step ?? Number.MAX_SAFE_INTEGER)) ||
    ((a.sort_order ?? 0) - (b.sort_order ?? 0))
  ).at(-1)
  return new Set(last ? [last.id] : [])
}

// The in-flow I/O graph: who consumes whom, and how many edges exist at all.
function buildGraph(tasks: any[]) {
  const byId = new Map(tasks.map(t => [t.id, t]))
  const childrenOf = new Map<string, string[]>()
  let edgeCount = 0
  for (const t of tasks) {
    for (const e of inputEdges(t.input)) {
      if (!byId.has(e.source_task_id)) continue
      edgeCount++
      if (!childrenOf.has(e.source_task_id)) childrenOf.set(e.source_task_id, [])
      childrenOf.get(e.source_task_id)!.push(t.id)
    }
  }
  return { byId, childrenOf, edgeCount }
}

// Which steps end the operation. Exported for the step list, which marks them — the one
// gate Q7 makes unconditional should be visible where the steps are, not only in the
// exception list.
export function flowTerminalIds(tasks: any[]): Set<string> {
  const { childrenOf, edgeCount } = buildGraph(tasks)
  return terminalTaskIds(tasks, childrenOf, edgeCount > 0)
}

// `tasks` = every task in one flow, each carrying id, text, status, short_id,
// flow_step, input, output, executor. `prefix` = the project prefix for display refs.
export function deriveFlowExceptions(tasks: any[], prefix?: string | null): FlowException[] {
  const refOf = (t: any): TaskRef => ({ id: t.id, ref: taskRef(t, prefix), text: t.text })
  const { byId, childrenOf, edgeCount } = buildGraph(tasks)

  const blastOf = (id: string): number => {
    const seen = new Set<string>()
    const queue = [...(childrenOf.get(id) || [])]
    while (queue.length) {
      const c = queue.shift()!
      if (seen.has(c)) continue
      seen.add(c)
      for (const g of (childrenOf.get(c) || [])) if (!seen.has(g)) queue.push(g)
    }
    return seen.size
  }

  const terminalIds = terminalTaskIds(tasks, childrenOf, edgeCount > 0)
  const excs: FlowException[] = []

  for (const t of tasks) {
    const out = (t.output && typeof t.output === 'object') ? t.output : {}
    const ledgers = (out.validation_ledgers && typeof out.validation_ledgers === 'object') ? out.validation_ledgers : {}
    const blast = blastOf(t.id)
    const task = { ...refOf(t), status: t.status ?? null, executor: t.executor ?? null }

    // (1) FAILED CHECKS — carried WITH the observed value, which is the point. A claim
    // that something failed is not reviewable; what was actually seen is.
    const seenFail = new Set<string>()
    for (const [edgeKey, entry] of Object.entries<any>(ledgers)) {
      for (const l of (entry?.ledger || [])) {
        if (l.status !== 'fail') continue
        const key = `${edgeKey}:${l.rule_id}`
        if (seenFail.has(key)) continue
        seenFail.add(key)
        const consumer = byId.get(edgeKey)
        excs.push({
          kind: 'failed_check', task, blast,
          failure: {
            ruleId: l.rule_id,
            label: l.label || l.rule_id,
            ruleKind: l.kind === 'check' ? 'check' : 'judgment',
            severity: l.severity || 'blocker',
            observedValue: l.observed_value ?? null,
            note: l.note ?? null,
            gateInto: consumer ? refOf(consumer) : null,
            gateIntoKey: edgeKey,
            retryCount: entry.retry_count ?? 0,
          },
        })
      }
    }

    // (2) JUDGMENT RESIDUE — criteria no deterministic check could cover. Q7: "what
    // cannot be reduced to a check IS the human's review list." These belong here even
    // when nothing has failed, because nothing has actually VERIFIED them either.
    const oc = outputContract(out)
    for (const r of (oc.rules || []).filter((r: any) => r.kind === 'judgment')) {
      // Skip if a human or independent validator already ruled on this rule.
      const ruled = Object.values<any>(ledgers).some((entry: any) =>
        (entry?.ledger || []).some((l: any) => l.rule_id === r.id && l.status === 'pass' &&
          l.validator && l.validator !== 'self' && l.validator !== 'unverified'))
      if (ruled) continue
      excs.push({ kind: 'judgment_residue', task, blast, residue: { ruleId: r.id, label: r.label || r.id, rule: r.rule } })
    }

    // (3) TERMINAL OUTPUT — unconditional, regardless of what the checks said.
    if (terminalIds.has(t.id)) excs.push({ kind: 'terminal', task, blast })
  }

  return excs.sort((a, b) => (b.blast - a.blast) || (KIND_RANK[a.kind] - KIND_RANK[b.kind]))
}

// ── Text rendering (MCP surface only; the web renders the same objects as UI) ──

function failureLines(e: FlowException): string[] {
  const f = e.failure!
  const retry = f.retryCount ? ` · ${f.retryCount} retr${f.retryCount === 1 ? 'y' : 'ies'} so far` : ''
  const into = f.gateInto ? `${f.gateInto.ref} "${f.gateInto.text}"` : f.gateIntoKey
  return [
    `  ✗ ${e.task.ref} "${e.task.text}" — failed ${f.ruleKind === 'check' ? 'check' : 'judgment rule'} [${f.severity}]: ${f.label}`,
    f.observedValue ? `      observed: ${f.observedValue}` : `      observed: (none recorded — the check was asserted, not run)`,
    ...(f.note ? [`      note: ${f.note}`] : []),
    `      gate into: ${into}${retry}`,
  ]
}

function residueLines(e: FlowException): string[] {
  const r = e.residue!
  return [
    `  ? ${e.task.ref} "${e.task.text}" — judgment criterion with no deterministic check: ${r.label}`,
    `      rule: ${r.rule}`,
    `      why you: this could not be reduced to a check, so no check has verified it.`,
  ]
}

function terminalLines(e: FlowException): string[] {
  return [
    `  ◆ ${e.task.ref} "${e.task.text}" — TERMINAL output [${e.task.status}]${e.task.executor && e.task.executor !== 'agent' ? ` · executor: ${e.task.executor}` : ''}`,
    `      why you: nothing downstream consumes this, so no later step can catch a problem in it. Q7 makes this gate unconditional.`,
  ]
}

export function renderFlowExceptions(
  excs: FlowException[],
  opts: { flowName: string, shortId?: string | null, stepCount: number, stepListOpen?: boolean, historyLines?: string[] | null },
): string {
  const lines: string[] = [
    `# What needs you — "${opts.flowName}"${opts.shortId ? `  [${opts.shortId}]` : ''}`,
    `${opts.stepCount} step${opts.stepCount !== 1 ? 's' : ''}${opts.stepListOpen ? ' known so far (step list OPEN)' : ''} · ${excs.length} item${excs.length !== 1 ? 's need' : ' needs'} judgment`,
    `Ordered by blast radius — how much downstream work builds on the step. Passing checks and step outputs are deliberately NOT shown (Q7: showing everything is what causes rubber-stamping).`,
  ]
  if (!excs.length) {
    lines.push('', 'Nothing needs you. Every declared check passed, no judgment criteria are unverified, and there is no terminal step — which is itself unusual; check the flow actually has an endpoint.')
    return lines.join('\n')
  }
  const failed = excs.filter(e => e.kind === 'failed_check')
  const residue = excs.filter(e => e.kind === 'judgment_residue')
  const terminal = excs.filter(e => e.kind === 'terminal')
  if (failed.length) {
    lines.push('', `── FAILED CHECKS (${failed.length}) — a gate rejected something ──`)
    failed.forEach(e => lines.push(...failureLines(e)))
  }
  if (residue.length) {
    lines.push('', `── JUDGMENT RESIDUE (${residue.length}) — nothing could check these for you ──`)
    residue.forEach(e => lines.push(...residueLines(e)))
  }
  if (terminal.length) {
    lines.push('', `── TERMINAL OUTPUT (${terminal.length}) — unconditional gate ──`)
    terminal.forEach(e => lines.push(...terminalLines(e)))
  }
  if (opts.historyLines) {
    lines.push('', `── EARLIER FAILED ATTEMPTS (from durable gate history) ──`)
    lines.push(...(opts.historyLines.length ? opts.historyLines : ['  (none recorded)']))
  } else {
    lines.push('', `(Pass include_history:true to also see earlier failed attempts a step has since passed.)`)
  }
  return lines.join('\n')
}
