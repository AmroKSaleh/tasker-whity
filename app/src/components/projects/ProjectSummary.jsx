const PRIORITIES = [
  { key: 'rush',   label: 'Rush' },
  { key: 'high',   label: 'High' },
  { key: 'medium', label: 'Medium' },
  { key: 'low',    label: 'Low' },
]

export default function ProjectSummary({ tasks }) {
  const checkable = tasks.filter(t => !t.tags?.includes('reference'))
  const done = checkable.filter(t => t.status === 'done').length
  const pending = checkable.filter(t => t.status !== 'done').length

  const cards = [
    { label: 'Pending', value: pending },
    { label: 'Done',    value: done    },
    ...PRIORITIES.map(p => ({
      label: p.label,
      value: checkable.filter(t => t.status !== 'done' && t.priority === p.key).length,
    })),
  ]

  return (
    <div className="grid grid-cols-3 sm:grid-cols-6 gap-2 mb-4">
      {cards.map(card => (
        <div key={card.label} className="bg-surf-2 rounded-md p-3 text-center">
          <div className="text-[22px] font-bold text-ink">
            {card.value}
          </div>
          <div className="font-mono text-[9px] font-bold text-mute uppercase tracking-widest mt-0.5">
            {card.label}
          </div>
        </div>
      ))}
    </div>
  )
}
