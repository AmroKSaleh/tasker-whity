// TaskItem.placeholder.tsx
//
// THIS IS A PLACEHOLDER. The brief says: "The existing TaskItem component
// renders a task row — its internal design should stay the same."
//
// Swap this file for an import of your real TaskItem component. The
// BoardColumn.tsx in this bundle imports from './TaskItem.placeholder' — point
// it at your real component:
//
//   import { TaskItem } from '@/components/tasks/TaskItem';
//
// The only props the new layout passes in:
//   - task:      Task
//   - selected:  boolean   (true when this task is open in the right panel/sheet)
//   - onClick:   () => void  (open the task panel/sheet)
//
// Your existing TaskItem likely already accepts `task`; add `selected` and
// `onClick` if missing. `selected` should render a 1.5px inset accent ring
// (`shadow-[inset_0_0_0_1.5px_#1A1916]` or similar). `onClick` opens the panel.
//
// Below is the minimal placeholder used by the design mockups, in case you
// want to reference what the row should look like at rest.

import clsx from 'clsx';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical, Play, Pause, Pencil, Trash2 } from 'lucide-react';
import type { Task } from './types';

type Props = {
  task: Task;
  selected?: boolean;
  onClick?: () => void;
};

export function TaskItem({ task, selected, onClick }: Props) {
  const sortable = useSortable({
    id: task.id,
    data: { type: 'task', sectionId: task.sectionId, stageId: task.stageId },
  });
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = sortable;

  const done = task.status === 'done';
  const inProgress = task.status === 'in_progress';

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition, opacity: isDragging ? 0.35 : 1 }}
      onClick={onClick}
      className={clsx(
        'group relative flex cursor-pointer items-start gap-2 rounded-md px-1.5 py-2 pl-1 pr-2 transition-colors',
        inProgress && 'bg-accent-soft',
        selected && 'bg-paper shadow-[inset_0_0_0_1.5px_#1A1916]',
        !inProgress && !selected && 'hover:bg-surf-2',
      )}
    >
      {inProgress && (
        <span className="absolute left-[-2px] top-1.5 bottom-1.5 w-0.5 rounded-r-sm bg-accent" />
      )}

      <button
        className="opacity-0 transition-opacity group-hover:opacity-100 cursor-grab text-mute-2"
        {...attributes}
        {...listeners}
      >
        <GripVertical className="h-3 w-3" />
      </button>

      <div className={clsx(
        'mt-0.5 h-4 w-4 shrink-0 rounded border-[1.5px] bg-paper',
        done ? 'border-ink bg-ink' : 'border-mute-2'
      )} />

      <div className={clsx('mt-0.5 shrink-0', inProgress ? 'text-accent' : 'text-mute-2')}>
        {inProgress ? <Pause className="h-3 w-3" /> : <Play className="h-3 w-3" />}
      </div>

      <div className="min-w-0 flex-1">
        <div className={clsx(
          'text-[13px] leading-snug',
          done && 'text-mute line-through decoration-[1px]',
          inProgress && 'font-medium'
        )}>
          {task.title}
        </div>

        {(task.priority || task.due_at || task.tags.length > 0) && (
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {task.priority && <span className={`chip chip-${task.priority}`}>{task.priority}</span>}
            {task.due_at && <span className="chip chip-due">{new Date(task.due_at).toLocaleDateString()}</span>}
            {task.tags.map(t => <span key={t} className="chip chip-tag">#{t}</span>)}
          </div>
        )}
      </div>

      <div className="absolute right-1.5 top-2 flex gap-0.5 rounded bg-surf-2 p-0.5 opacity-0 transition-opacity group-hover:opacity-100">
        <button className="icon-btn !h-5 !w-5"><Pencil className="h-3 w-3" /></button>
        <button className="icon-btn !h-5 !w-5"><Trash2 className="h-3 w-3" /></button>
      </div>
    </div>
  );
}
