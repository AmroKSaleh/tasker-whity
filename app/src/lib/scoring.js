const PRIORITY_SCORES = { rush: 100, high: 60, medium: 30, low: 10 }

export function scoreTask(task, now = new Date()) {
  if (task.status === 'done') return -1
  if (task.status === 'in_progress') return -1
  if (task.tags?.includes('reference')) return -1

  if (task.pinned) return 9999

  let score = PRIORITY_SCORES[task.priority] ?? 0

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

  return score
}

export function rankTasks(tasks) {
  return tasks
    .map(task => ({ task, score: scoreTask(task) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || new Date(a.task.created_at) - new Date(b.task.created_at))
    .map(({ task }) => task)
}
