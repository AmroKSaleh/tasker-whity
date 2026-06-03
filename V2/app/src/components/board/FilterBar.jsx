import { Search } from 'lucide-react'
import clsx from 'clsx'

const FILTERS = [
  { id: 'all',     label: 'All',    dot: null },
  { id: 'pending', label: 'Pending', dot: null },
  { id: 'done',    label: 'Complete', dot: null },
  null,
  { id: 'rush',   label: 'Rush',   dot: 'rush' },
  { id: 'high',   label: 'High',   dot: 'high' },
  { id: 'medium', label: 'Medium', dot: 'med' },
  { id: 'low',    label: 'Low',    dot: 'low' },
]

export default function FilterBar({ active = 'all', onChange, counts = {} }) {
  return (
    <div className="flex items-center gap-3 border-b border-line-2 bg-paper px-5 py-2.5 shrink-0 overflow-x-auto scrollbar-hide">
      <div className="flex gap-1.5 overflow-hidden">
        {FILTERS.map((f, i) =>
          f === null ? (
            <span key={i} className="mx-0.5 h-4 w-px self-center bg-line shrink-0" />
          ) : (
            <button
              key={f.id}
              onClick={() => onChange?.(active === f.id ? 'all' : f.id)}
              className={clsx('pill shrink-0', active === f.id && 'pill-active')}
            >
              {f.dot && (
                <span className={clsx(
                  'h-1.5 w-1.5 rounded-full shrink-0',
                  f.dot === 'rush' && 'bg-priority-rush',
                  f.dot === 'high' && 'bg-priority-high',
                  f.dot === 'med'  && 'bg-priority-med',
                  f.dot === 'low'  && 'bg-priority-low',
                )} />
              )}
              {f.label}
              {counts[f.id] != null && (
                <span className={clsx('text-[10px]', active === f.id ? 'text-paper/60' : 'text-mute')}>
                  {counts[f.id]}
                </span>
              )}
            </button>
          )
        )}
      </div>

      <div className="ml-auto flex items-center gap-1.5 shrink-0">
        <button className="icon-btn" title="Search">
          <Search className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  )
}
