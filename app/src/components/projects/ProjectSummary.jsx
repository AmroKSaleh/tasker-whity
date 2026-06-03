const PRIORITIES = [
  { key: 'rush',   label: 'Rush',   color: '#B3261E' },
  { key: 'high',   label: 'High',   color: '#7D5700' },
  { key: 'medium', label: 'Medium', color: '#005AC1' },
  { key: 'low',    label: 'Low',    color: '#49454F' },
]

export default function ProjectSummary({ tasks }) {
  const checkable = tasks.filter(t => !t.tags?.includes('reference'))
  const done = checkable.filter(t => t.done).length
  const pending = checkable.filter(t => !t.done).length

  const cards = [
    { label: 'Pending', value: pending, color: 'var(--md-on-surface)' },
    { label: 'Done',    value: done,    color: '#386A20' },
    ...PRIORITIES.map(p => ({
      label: p.label,
      value: checkable.filter(t => !t.done && t.priority === p.key).length,
      color: p.color,
    })),
  ]

  return (
    <div className="grid grid-cols-3 sm:grid-cols-6 gap-2 mb-4">
      {cards.map(card => (
        <div key={card.label} className="bg-surface-container rounded-md p-3 text-center">
          <div className="text-title-large font-bold" style={{ color: card.color }}>
            {card.value}
          </div>
          <div className="text-label-small text-on-surface-variant uppercase tracking-wide mt-0.5">
            {card.label}
          </div>
        </div>
      ))}
    </div>
  )
}
