export default function ProgressBar({ tasks }) {
  const checkable = tasks.filter(t => !t.tags?.includes('reference'))
  const done = checkable.filter(t => t.status === 'done').length
  const total = checkable.length
  const pct = total ? Math.round((done / total) * 100) : 0

  return (
    <div className="py-4">
      <div className="flex justify-between items-center mb-2">
        <span className="text-[12px] text-mute">
          <span className="text-ink font-semibold">{done}</span> / {total} complete
        </span>
        <span className="text-[12px] text-mute">{pct}%</span>
      </div>
      <div className="w-full h-1.5 bg-line rounded-pill overflow-hidden">
        <div
          className="h-full bg-ink rounded-pill transition-[width] duration-500"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  )
}
