// ── XLSX Export ──────────────────────────────────────────────

export async function exportProjectAsXLSX(project, sections, groups, tasks) {
  const XLSX = await import('xlsx')
  const wb = XLSX.utils.book_new()

  const sheetName = project.name.slice(0, 31).replace(/[:\\/?*[\]]/g, '')
  const rows = buildProjectRows(sections, groups, tasks)
  const ws = XLSX.utils.aoa_to_sheet(rows)

  // Column widths
  ws['!cols'] = [
    { wch: 52 }, // Task
    { wch: 10 }, // Priority
    { wch: 12 }, // Status
    { wch: 12 }, // Due Date
    { wch: 40 }, // Notes
  ]

  XLSX.utils.book_append_sheet(wb, ws, sheetName)

  // Context sheet if project has context
  if (project.context && typeof project.context === 'object') {
    const ctxRows = buildContextRows(project)
    const ctxWs = XLSX.utils.aoa_to_sheet(ctxRows)
    ctxWs['!cols'] = [{ wch: 24 }, { wch: 80 }]
    XLSX.utils.book_append_sheet(wb, ctxWs, 'Project Context')
  }

  const filename = `${project.name.replace(/[^a-z0-9]/gi, '_')}_tasks.xlsx`
  XLSX.writeFile(wb, filename)
}

function buildProjectRows(sections, groups, tasks) {
  const rows = []

  sections.forEach(section => {
    // Section header
    rows.push([`◆ ${section.name.toUpperCase()}`, '', '', '', ''])
    rows.push(['', '', '', '', ''])

    const sectionTasks = tasks.filter(t => t.section_id === section.id)
    const sectionGroups = groups.filter(g => g.section_id === section.id)
    const ungrouped = sectionTasks.filter(t => !t.group_id)

    // Ungrouped tasks
    if (ungrouped.length > 0) {
      rows.push(['Task', 'Priority', 'Status', 'Due Date', 'Notes'])
      ungrouped.forEach(t => rows.push([
        t.text,
        t.priority ? t.priority.charAt(0).toUpperCase() + t.priority.slice(1) : '—',
        formatStatus(t.status),
        t.due_date || '—',
        t.detail || '',
      ]))
      rows.push(['', '', '', '', ''])
    }

    // Groups
    sectionGroups.forEach(group => {
      const groupTasks = sectionTasks.filter(t => t.group_id === group.id)
      rows.push([`  ▸ ${group.name}`, '', '', '', ''])
      rows.push(['Task', 'Priority', 'Status', 'Due Date', 'Notes'])
      groupTasks.forEach(t => rows.push([
        t.text,
        t.priority ? t.priority.charAt(0).toUpperCase() + t.priority.slice(1) : '—',
        formatStatus(t.status),
        t.due_date || '—',
        t.detail || '',
      ]))
      rows.push(['', '', '', '', ''])
    })
  })

  return rows
}

function buildContextRows(project) {
  const ctx = project.context
  const rows = [
    ['Project Context & AI Summary', ''],
    ['', ''],
    ['Project', project.name],
    ['Exported', new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })],
    ['', ''],
  ]

  const fields = [
    ['Goal', ctx.goal],
    ['Why it matters', ctx.why],
    ['Scope', ctx.scope],
    ['Constraints', ctx.constraints],
    ['Definition of done', ctx.definition_of_done],
    ['Known risks', ctx.risks],
  ]

  fields.forEach(([label, value]) => {
    if (value) rows.push([label, value])
  })

  return rows
}

function formatStatus(status) {
  if (status === 'done') return 'Done'
  if (status === 'in_progress') return 'In Progress'
  return 'Pending'
}


// ── Markdown Export ──────────────────────────────────────────

export function exportProjectAsMarkdown(project, sections, groups, tasks) {
  const lines = []
  const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })

  // Header
  lines.push(`# ${project.name}`)
  lines.push('')
  lines.push(`> Exported from Tasker on ${today}`)
  lines.push('')

  // Context block
  if (project.context && typeof project.context === 'object') {
    const ctx = project.context
    lines.push('## Project Context')
    lines.push('')
    if (ctx.goal)              lines.push(`**Goal:** ${ctx.goal}`)
    if (ctx.why)               lines.push(`**Why it matters:** ${ctx.why}`)
    if (ctx.scope)             lines.push(`**Scope:** ${ctx.scope}`)
    if (ctx.constraints)       lines.push(`**Constraints:** ${ctx.constraints}`)
    if (ctx.definition_of_done) lines.push(`**Definition of done:** ${ctx.definition_of_done}`)
    if (ctx.risks)             lines.push(`**Known risks:** ${ctx.risks}`)
    lines.push('')
    lines.push('---')
    lines.push('')
  }

  // Stats
  const checkable = tasks.filter(t => !t.tags?.includes('reference'))
  const done = checkable.filter(t => t.status === 'done').length
  const inProgress = checkable.filter(t => t.status === 'in_progress').length
  const pending = checkable.filter(t => t.status === 'pending').length
  const total = checkable.length
  const pct = total ? Math.round((done / total) * 100) : 0

  lines.push('## Progress')
  lines.push('')
  lines.push(`| | |`)
  lines.push(`|---|---|`)
  lines.push(`| Total tasks | ${total} |`)
  lines.push(`| Completed | ${done} (${pct}%) |`)
  lines.push(`| In progress | ${inProgress} |`)
  lines.push(`| Pending | ${pending} |`)
  lines.push('')
  lines.push('---')
  lines.push('')

  // Tasks
  lines.push('## Tasks')
  lines.push('')

  sections.forEach(section => {
    lines.push(`### ${section.name}`)
    lines.push('')

    const sectionTasks = tasks.filter(t => t.section_id === section.id)
    const sectionGroups = groups.filter(g => g.section_id === section.id)
    const ungrouped = sectionTasks.filter(t => !t.group_id)

    if (ungrouped.length > 0) {
      lines.push('| Task | Priority | Status | Due Date |')
      lines.push('|------|----------|--------|----------|')
      ungrouped.forEach(t => {
        lines.push(`| ${escapeMd(t.text)} | ${t.priority || '—'} | ${formatStatus(t.status)} | ${t.due_date || '—'} |`)
        if (t.detail) lines.push(`| ↳ *${escapeMd(t.detail)}* | | | |`)
      })
      lines.push('')
    }

    sectionGroups.forEach(group => {
      lines.push(`**${group.name}**`)
      lines.push('')
      const groupTasks = sectionTasks.filter(t => t.group_id === group.id)
      if (groupTasks.length > 0) {
        lines.push('| Task | Priority | Status | Due Date |')
        lines.push('|------|----------|--------|----------|')
        groupTasks.forEach(t => {
          lines.push(`| ${escapeMd(t.text)} | ${t.priority || '—'} | ${formatStatus(t.status)} | ${t.due_date || '—'} |`)
          if (t.detail) lines.push(`| ↳ *${escapeMd(t.detail)}* | | | |`)
        })
      }
      lines.push('')
    })

    lines.push('---')
    lines.push('')
  })

  // Claude prompt suggestions
  lines.push('## Using This With Claude')
  lines.push('')
  lines.push('Paste this document into a conversation and try:')
  lines.push('')
  lines.push('- *"What are the highest priority tasks I should focus on today?"*')
  lines.push('- *"Are there any risks or blockers based on the current task statuses?"*')
  lines.push('- *"Help me plan my week based on these tasks and due dates."*')
  lines.push('- *"What tasks are overdue or at risk of being overdue?"*')
  lines.push('- *"Summarise the current state of this project in 3 bullet points."*')
  lines.push('')
  lines.push('---')
  lines.push('')
  lines.push(`*Generated by Tasker v0.2.3*`)

  const content = lines.join('\n')
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${project.name.replace(/[^a-z0-9]/gi, '_')}_tasks.md`
  a.click()
  URL.revokeObjectURL(url)
}

function escapeMd(str) {
  return (str || '').replace(/\|/g, '\\|').replace(/\n/g, ' ')
}
