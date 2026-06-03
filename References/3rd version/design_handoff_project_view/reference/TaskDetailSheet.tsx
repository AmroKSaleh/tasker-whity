// TaskDetailSheet.tsx — mobile bottom sheet variant of the task detail.
import { useEffect, useRef } from 'react';
import { X, Calendar } from 'lucide-react';
import { useSheetDrag } from './hooks/useSheetDrag';
import { StatusSegmented, PrioritySegmented } from './TaskDetailPanel';
import type { Task } from './types';

type Props = {
  taskId: string;
  onClose: () => void;
  task?: Task & { sectionName?: string; stageName?: string | null };
  onUpdate?: (patch: Partial<Task>) => void;
};

export function TaskDetailSheet({ taskId, onClose, task, onUpdate }: Props) {
  const { handlers, style } = useSheetDrag(onClose);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose(); }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!task) return null;

  return (
    <>
      <div className="fixed inset-0 z-40 bg-ink/30 animate-fade-in" onClick={onClose} />
      <div
        ref={ref}
        role="dialog"
        aria-label="Task detail"
        className="fixed inset-x-0 bottom-0 z-50 flex max-h-[85vh] flex-col rounded-t-sheet bg-paper shadow-sheet animate-sheet-up"
        style={{ height: '62vh', paddingBottom: 'max(22px, env(safe-area-inset-bottom))', ...style }}
      >
        {/* Drag handle area — consumes pointer events for drag-to-dismiss */}
        <div
          className="touch-none pt-2 pb-1 flex justify-center"
          {...handlers}
        >
          <div className="h-1 w-9 rounded-sm bg-line" />
        </div>

        <div className="flex flex-col gap-4 overflow-y-auto px-4 pb-6 pt-2">
          <div className="flex items-center justify-between gap-2">
            <div className="font-mono text-[10px] uppercase tracking-[0.08em] text-mute">
              <span className="font-medium text-ink-2">{task.sectionName}</span> · {task.stageName ?? 'Ungrouped'}
            </div>
            <button className="icon-btn" onClick={onClose}><X className="h-3.5 w-3.5" /></button>
          </div>

          <h2
            contentEditable
            suppressContentEditableWarning
            spellCheck={false}
            onBlur={(e) => onUpdate?.({ title: e.currentTarget.textContent || '' })}
            className="m-0 text-[18px] font-semibold leading-tight tracking-[-0.01em] outline-none"
          >
            {task.title}
          </h2>

          <Field label="Status">
            <StatusSegmented value={task.status} onChange={(v) => onUpdate?.({ status: v })} />
          </Field>

          <Field label="Priority">
            <PrioritySegmented value={task.priority} onChange={(v) => onUpdate?.({ priority: v })} />
          </Field>

          <Field label="Due">
            <button className="flex w-full items-center gap-2.5 rounded-md border border-line-2 bg-surf-2 px-3 py-2.5 font-mono text-xs text-ink-2">
              <Calendar className="h-3.5 w-3.5 text-mute" />
              <span>{task.due_at ? new Date(task.due_at).toLocaleDateString() : 'No due date'}</span>
            </button>
          </Field>

          <Field label="Notes">
            <textarea
              defaultValue={task.notes}
              onBlur={(e) => onUpdate?.({ notes: e.currentTarget.value })}
              className="w-full min-h-[96px] rounded-md border border-line-2 bg-surf-2 p-3 font-sans text-[13px] leading-[1.55] text-ink-2 resize-y focus:outline-none focus:border-accent focus:bg-paper"
            />
          </Field>
        </div>
      </div>
    </>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="font-mono text-[10px] uppercase tracking-[0.1em] text-mute">{label}</div>
      {children}
    </div>
  );
}
