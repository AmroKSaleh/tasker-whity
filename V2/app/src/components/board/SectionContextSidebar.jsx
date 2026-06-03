export default function SectionContextSidebar({ section, groups, tasks, project, onClose }) {

  // Compute section context
  const sectionTasks = tasks.filter(t => t.section_id === section.id)
  const doneTasks = sectionTasks.filter(t => t.status === 'done').length
  const inProgressTasks = sectionTasks.filter(t => t.status === 'in_progress').length
  const pendingTasks = sectionTasks.filter(t => t.status !== 'done' && t.status !== 'in_progress').length

  const contextText = `
Section: ${section.name}
Project: ${project.name} (${project.prefix})

Task Summary:
- Total: ${sectionTasks.length} tasks
- Done: ${doneTasks}
- In Progress: ${inProgressTasks}
- Pending: ${pendingTasks}

Groups (${groups.length}):
${groups.map(g => {
  const groupTasks = sectionTasks.filter(t => t.group_id === g.id)
  return `- ${g.name}: ${groupTasks.length} tasks`
}).join('\n')}

Recent Tasks:
${sectionTasks.slice(0, 5).map(t => `- [${t.status}] ${t.text}`).join('\n')}
  `.trim()


  return (
    <aside className="w-96 shrink-0 border-l border-line bg-paper flex flex-col overflow-hidden">
      {/* Header */}
      <div className="px-5 py-4 border-b border-line bg-surf shrink-0">
        <div className="flex items-center justify-between mb-2">
          <h2 className="font-semibold text-ink text-[14px]">{section.name}</h2>
          <button onClick={onClose} className="text-mute hover:text-ink text-lg leading-none">×</button>
        </div>
        <p className="text-[11px] text-mute font-mono tracking-wide">{project.prefix}</p>
      </div>

      {/* Context display */}
      <div className="px-5 py-4 border-b border-line bg-surf-2 shrink-0">
        <p className="text-[10px] font-mono text-mute-2 uppercase tracking-widest mb-2.5 font-bold">Context</p>
        <div className="bg-paper rounded border border-line p-3">
          <pre className="text-[11px] text-ink-2 whitespace-pre-wrap break-words overflow-auto max-h-40 font-mono">
            {contextText}
          </pre>
        </div>
      </div>

    </aside>
  )
}
