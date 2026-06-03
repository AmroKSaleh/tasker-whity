const PRIORITY_SCORES = { rush: 100, high: 75, medium: 50, low: 25 }

export function scoreTask(task, now = new Date()) {
  if (task.done) return -1
  if (task.in_progress) return -1
  if (task.tags?.includes('reference')) return -1

  let score = PRIORITY_SCORES[task.priority] ?? 0

  if (task.due_date) {
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    const due   = new Date(task.due_date)
    const dueDay = new Date(due.getFullYear(), due.getMonth(), due.getDate())
    if (dueDay < today) score += 80       // overdue
    else if (dueDay.getTime() === today.getTime()) score += 50  // due today
  }

  return score
}

export function rankTasks(tasks) {
  return tasks
    .map(task => ({ task, score: scoreTask(task) }))
    .filter(({ score }) => score > 0)
    .filter(({ task }) => !task.in_progress)
    .sort((a, b) => b.score - a.score)
    .map(({ task }) => task)
}
