// Flow graph helpers — client-side mirror of the MCP contract layer (TDE-137).
// A flow is a connected component of a project's I/O graph. These read BOTH the
// new edge-list input shape ({ edges: [{ source_task_id, contract }] }) and the
// legacy single-source shape ({ source_task_id, validation_rules }).

export function inputEdges(input) {
  if (!input) return []
  if (Array.isArray(input.edges)) return input.edges.filter(e => e && e.source_task_id)
  if (input.source_task_id) {
    const rules = input.validation_rules
      ? [{ id: 'legacy', label: 'Validation rules', rule: input.validation_rules, kind: 'judgment', severity: 'blocker' }]
      : []
    return [{ source_task_id: input.source_task_id, contract: { rules } }]
  }
  return []
}

export function inputSourceIds(input) {
  return inputEdges(input).map(e => e.source_task_id)
}

export function outputRules(output) {
  return output?.contract?.rules ?? []
}

export function isConfirmed(contract) {
  return contract?.confirmed === true
}

// Client-side mirror of the server lintRule (contract_gate.ts / TDE-287): flags vague
// or too-short rules that the contract gate would reject. Returns a message or null.
const VAGUE_RULE_WORDS = /\b(readable|clarity|clear|good|nice|appropriate|reasonable|relevant|professional|adequate|sufficient|proper|well.written|high.quality|comprehensive|thorough|engaging|interesting|helpful|useful)\b/i
export function lintRule(rule) {
  const text = (rule?.rule || '').trim()
  if (text.length < 15) return 'too short to be checkable — add a specific, measurable criterion'
  const m = text.match(VAGUE_RULE_WORDS)
  if (m) return `vague language "${m[0]}" — replace with a concrete, verifiable criterion`
  return null
}

// Client-side mirror of contractGateViolations (TDE-287): a DECLARED handoff must
// carry a non-trivial, human-blessed contract on both sides (producer output
// def-of-done + consumer input acceptance). `steps` = [{ task }].
//
// Both this and the server gate iterate DECLARED edges only, so a flow with none
// scores zero violations. That is correct — gates belong only at seams, and a flow
// may have none — but "no violations" and "nothing to violate" are different states
// and must not render alike. edgeCount distinguishes them.
export function flowGateStatus(steps) {
  const tasks = steps.map(s => s.task)
  const inFlow = new Set(tasks.map(t => t.id))
  const ruleIssue = rules => {
    if (!rules || !rules.length) return true
    return rules.some(r => lintRule(r))
  }
  let weak = 0, unblessed = 0, edgeCount = 0
  for (const t of tasks) {
    const edges = inputEdges(t.input).filter(e => inFlow.has(e.source_task_id))
    for (const e of edges) {
      edgeCount++
      if (ruleIssue(e.contract?.rules)) weak++
      else if (!isConfirmed(e.contract)) unblessed++
    }
    const feedsInFlow = tasks.some(o => inputEdges(o.input).some(e => e.source_task_id === t.id))
    if (feedsInFlow) {
      if (ruleIssue(outputRules(t.output))) weak++
      else if (!isConfirmed(t.output?.contract)) unblessed++
    }
  }
  const total = weak + unblessed
  return { ok: total === 0, weak, unblessed, total, edgeCount }
}

// Connected components within one set of tasks (caller passes a single project's
// tasks). Two things hold a component together: I/O edges, and a shared flow_id.
//
// The flow_id half is load-bearing, not a convenience. Gates are OPTIONAL under the
// current definition (TDE-792) — a flow can legitimately carry no contracts and
// therefore no edges at all. Detecting on edges alone made such a flow invisible
// here, while flow_id kept its tasks off the board (TDE-320), so the work vanished
// from every surface at once.
export function detectFlows(tasks) {
  const taskById = new Map(tasks.map(t => [t.id, t]))
  const adj = new Map(tasks.map(t => [t.id, new Set()]))
  tasks.forEach(t => {
    for (const src of inputSourceIds(t.input)) {
      if (adj.has(src)) { adj.get(t.id).add(src); adj.get(src).add(t.id) }
    }
  })
  const byFlowId = new Map()
  tasks.forEach(t => {
    if (!t.flow_id) return
    if (!byFlowId.has(t.flow_id)) byFlowId.set(t.flow_id, [])
    byFlowId.get(t.flow_id).push(t.id)
  })
  for (const ids of byFlowId.values()) {
    for (let i = 1; i < ids.length; i++) {
      adj.get(ids[0]).add(ids[i])
      adj.get(ids[i]).add(ids[0])
    }
  }
  const visited = new Set()
  const flows = []
  tasks.forEach(t => {
    if (visited.has(t.id) || (adj.get(t.id).size === 0 && !t.flow_id)) return
    const taskIds = new Set()
    const queue = [t.id]
    visited.add(t.id)
    while (queue.length) {
      const curr = queue.shift()
      taskIds.add(curr)
      for (const nb of adj.get(curr)) if (!visited.has(nb)) { visited.add(nb); queue.push(nb) }
    }
    // Roots = tasks in this component with no in-component source.
    const idArr = [...taskIds]
    const roots = idArr.filter(id => {
      const srcs = inputSourceIds(taskById.get(id)?.input)
      return !srcs.some(s => taskIds.has(s))
    })
    const rootTask = taskById.get(roots[0])
    const words = rootTask?.text?.split(' ').slice(0, 4).join(' ') ?? 'Flow'
    const truncated = rootTask && rootTask.text.split(' ').length > 4
    flows.push({
      id: `flow-${flows.length}`,
      rootTaskId: roots[0] ?? idArr[0],
      autoName: words + (truncated ? '…' : ''),
      taskIds,
    })
  })
  return flows
}

// Topological depth, multi-parent aware: depth = max(parent depth) + 1, else 0.
export function topoDepths(tasks) {
  const taskById = new Map(tasks.map(t => [t.id, t]))
  const depths = new Map()
  function depth(id, stack = new Set()) {
    if (depths.has(id)) return depths.get(id)
    if (stack.has(id)) return 0
    stack.add(id)
    const srcs = inputSourceIds(taskById.get(id)?.input).filter(s => taskById.has(s))
    const d = srcs.length ? Math.max(...srcs.map(s => depth(s, stack) + 1)) : 0
    depths.set(id, d)
    return d
  }
  tasks.forEach(t => depth(t.id))
  return depths
}

// A flow's tasks in execution order, each with a 1-based step number + depth.
// With no I/O edges every task sits at depth 0, so flow_step (assigned by name_flow)
// carries the intended order — without it an ungated flow would list in sort_order,
// which is board ordering and says nothing about sequence.
export function flowSteps(flowTaskIds, allTaskById) {
  const tasks = [...flowTaskIds].map(id => allTaskById.get(id)).filter(Boolean)
  const depths = topoDepths(tasks)
  const sorted = tasks.slice().sort((a, b) => {
    const da = depths.get(a.id) ?? 0
    const db = depths.get(b.id) ?? 0
    if (da !== db) return da - db
    const fa = a.flow_step, fb = b.flow_step
    if (fa != null && fb != null && fa !== fb) return fa - fb
    return (a.sort_order ?? 0) - (b.sort_order ?? 0)
  })
  return sorted.map((t, i) => ({ task: t, step: i + 1, depth: depths.get(t.id) ?? 0 }))
}
