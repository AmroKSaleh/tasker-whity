import { useState } from 'react'

export default function Swimlane({ group, children }) {
  const [collapsed, setCollapsed] = useState(false)
  const doneCount = group.tasks.filter(t => t.status === 'done').length

  return (
    <div>
      <div
        onClick={() => setCollapsed(c => !c)}
        className="flex select-none items-center gap-2 px-1.5 pb-1.5 pt-3.5 font-mono text-[10px] font-medium uppercase tracking-[0.12em] text-mute cursor-pointer hover:text-ink-2 transition-colors"
      >
        <span>{group.name}</span>
        <span className="font-normal text-mute-2">{doneCount}/{group.tasks.length}</span>
        <span className="h-px flex-1 bg-line-2" />
        <span className="text-mute-2 text-[8px]">{collapsed ? '▶' : '▼'}</span>
      </div>
      {!collapsed && children}
    </div>
  )
}
