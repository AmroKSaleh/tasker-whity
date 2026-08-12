// Mirrors the scoring block in supabase/functions/mcp/index.ts. The two MUST stay in step —
// the web board and the MCP ranking a task differently is a bug the user sees, not a nuance.
const PRIORITY_SCORES = { rush: 100, high: 60, medium: 30, low: 10 }
// An unset priority used to score 0 and then be dropped by the `score > 0` filter, so a task nobody
// had triaged became UNRANKABLE rather than last. Zero was doing double duty as "no priority set"
// and as the exclusion threshold. It now ranks just below `low`.
const UNSET_PRIORITY_SCORE = 5
// The pin used to `return 9999` BEFORE priority, due date or skip count were read, so every pinned
// task tied and fell back to the creation-date tiebreak. Additive keeps pins on top AND ordered
// sensibly among themselves.
const PIN_BONUS = 1000

export function scoreTask(task, now = new Date()) {
  if (task.status === 'done') return -1
  if (task.tags?.includes('reference')) return -1

  let score = PRIORITY_SCORES[task.priority] ?? UNSET_PRIORITY_SCORE

  if (task.due_date) {
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    const due = new Date(task.due_date)
    const dueDay = new Date(due.getFullYear(), due.getMonth(), due.getDate())
    const diffDays = Math.round((dueDay - today) / 86400000)
    if (diffDays < 0)        score += 80
    else if (diffDays === 0) score += 50
    else if (diffDays <= 3)  score += 20
  }

  if (task.skip_count > 0) {
    score = Math.max(1, Math.round(score / (1 + task.skip_count * 0.3)))
  }

  if (task.pinned) score += PIN_BONUS

  return score
}

// in_progress tasks used to score -1 and vanish from every ranked view. Started work IS work and
// must stay visible, but it is not a candidate for "what should I START next" — so it is split out,
// never dropped.
export function partitionRanked(tasks) {
  const live = tasks
    .map(task => ({ task, score: scoreTask(task) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || new Date(a.task.created_at) - new Date(b.task.created_at))
    .map(({ task }) => task)
  return {
    inFlight: live.filter(t => t.status === 'in_progress'),
    next: live.filter(t => t.status !== 'in_progress'),
  }
}

// Next-up only. The three consumers (Front Page "Next Up", ProjectCard, Today) keep their exact
// prior shape through this — in_progress is still absent from them, now by the caller's choice
// rather than by a sentinel buried in the scorer.
export function rankTasks(tasks) {
  return partitionRanked(tasks).next
}
