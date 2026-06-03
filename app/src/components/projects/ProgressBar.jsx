export default function ProgressBar({ tasks }) {
  const checkable = tasks.filter(t => !t.tags?.includes('reference'))
  const done = checkable.filter(t => t.done).length
  const total = checkable.length
  const pct = total ? Math.round((done / total) * 100) : 0

  return (
    <div className="py-4">
      <div className="flex justify-between items-center mb-2">
        <span className="text-body-small text-on-surface-variant">
          <span className="text-primary font-medium">{done}</span> / {total} complete
        </span>
        <span className="text-body-small text-on-surface-variant">{pct}%</span>
      </div>
      <div className="w-full h-2 bg-outline-variant rounded-pill overflow-hidden">
        <div
          className="h-full bg-primary rounded-pill transition-[width] duration-500"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  )
}
