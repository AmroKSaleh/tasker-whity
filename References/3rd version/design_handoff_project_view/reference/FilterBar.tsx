// FilterBar.tsx — pill row above the columns.
import { Search } from 'lucide-react';
import clsx from 'clsx';
import type { FilterId } from './types';

type Filter =
  | null
  | { id: FilterId; label: string; count: number; dot?: 'rush' | 'high' | 'med' | 'low' };

const FILTERS: Filter[] = [
  { id: 'all',     label: 'All',     count: 47 },
  { id: 'pending', label: 'Pending', count: 32 },
  { id: 'done',    label: 'Done',    count: 15 },
  null,
  { id: 'rush', label: 'Rush',    count: 2,  dot: 'rush' },
  { id: 'high', label: 'High',    count: 8,  dot: 'high' },
  { id: 'med',  label: 'Medium',  count: 14, dot: 'med' },
  { id: 'low',  label: 'Low',     count: 23, dot: 'low' },
];

type Props = {
  active?: FilterId;
  onChange?: (id: FilterId) => void;
  onCollapseAll?: () => void;
  onExpandAll?: () => void;
};

export function FilterBar({ active = 'all', onChange, onCollapseAll, onExpandAll }: Props) {
  return (
    <div className="flex items-center gap-3.5 border-b border-line-2 bg-paper px-8 py-3.5">
      <div className="flex gap-1.5 overflow-hidden">
        {FILTERS.map((f, i) =>
          f === null ? (
            <span key={i} className="mx-0.5 h-4.5 w-px self-center bg-line" />
          ) : (
            <button
              key={f.id}
              onClick={() => onChange?.(f.id)}
              className={clsx('pill', active === f.id && 'pill-active')}
            >
              {f.dot && (
                <span
                  className={clsx(
                    'h-1.5 w-1.5 rounded-full',
                    f.dot === 'rush' && 'bg-priority-rush',
                    f.dot === 'high' && 'bg-priority-high',
                    f.dot === 'med'  && 'bg-priority-med',
                    f.dot === 'low'  && 'bg-priority-low',
                  )}
                />
              )}
              {f.label}
              <span className={clsx('text-[10px]', active === f.id ? 'text-paper/55' : 'text-mute')}>
                {f.count}
              </span>
            </button>
          )
        )}
      </div>
      <div className="ml-auto flex items-center gap-2">
        <button className="btn btn-sm" onClick={onCollapseAll}>Collapse all</button>
        <button className="btn btn-sm" onClick={onExpandAll}>Expand all</button>
        <span className="h-4.5 w-px bg-line" />
        <button className="icon-btn" title="Search"><Search className="h-3.5 w-3.5" /></button>
      </div>
    </div>
  );
}
