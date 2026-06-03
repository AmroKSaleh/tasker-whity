// TaskDetailPanel.tsx — desktop right slide-in.
import { useEffect, useRef } from 'react';
import { MoreHorizontal, X, Calendar } from 'lucide-react';
import clsx from 'clsx';
import type { Task, Status, Priority } from './types';

type Props = {
  taskId: string;
  onClose: () => void;
  // Wire to your store. In practice, useTask(taskId) returns the live task.
  task?: Task & { sectionName?: string; stageName?: string | null };
  onUpdate?: (patch: Partial<Task>) => void;
};

export function TaskDetailPanel({ taskId, onClose, task, onUpdate }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  // Esc-to-close
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Focus the title on open, restore previous focus on close
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('h2')?.focus();
    return () => previous?.focus?.();
  }, [taskId]);

  if (!task) return null;  // loading guard

  return (
    <>
      {/* Scrim — leaves the in-progress sidebar visible */}
      <div
        className="fixed inset-y-0 left-0 z-40 bg-ink/[0.12] animate-fade-in"
        style={{ right: 'calc(380px + 288px)' }}
        onClick={onClose}
      />
      <aside
        ref={ref}
        role="dialog"
        aria-label="Task detail"
        className="fixed inset-y-0 z-50 flex w-[380px] flex-col border-l border-line bg-paper shadow-panel animate-slide-in-right"
        style={{ right: 288 /* sit beside the in-progress sidebar */ }}
      >
        <header className="flex items-center justify-between gap-3 border-b border-line-2 px-4.5 pb-3 pt-4">
          <div className="font-mono text-[10px] uppercase tracking-[0.08em] text-mute">
            <span className="font-medium text-ink-2">{task.sectionName}</span>
            {' · '}
            {task.stageName ?? 'Ungrouped'}
          </div>
          <div className="flex items-center gap-1.5">
            <button className="icon-btn"><MoreHorizontal className="h-3.5 w-3.5" /></button>
            <button className="icon-btn" onClick={onClose} title="Close">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </header>

        <div className="flex flex-1 flex-col gap-5 overflow-y-auto p-4.5">
          {/* Title — contentEditable, autosaved on blur */}
          <h2
            tabIndex={-1}
            contentEditable
            suppressContentEditableWarning
            spellCheck={false}
            onBlur={(e) => onUpdate?.({ title: e.currentTarget.textContent || '' })}
            className="m-0 border-b border-dashed border-transparent text-[19px] font-semibold leading-tight tracking-[-0.01em] outline-none focus:border-accent"
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
            <DateButton iso={task.due_at} onClick={() => {/* open date picker */}} />
          </Field>

          <Field label="Notes">
            <textarea
              defaultValue={task.notes}
              onBlur={(e) => onUpdate?.({ notes: e.currentTarget.value })}
              className="w-full min-h-[96px] rounded-md border border-line-2 bg-surf-2 p-3 font-sans text-[13px] leading-[1.55] text-ink-2 resize-y focus:outline-none focus:border-accent focus:bg-paper"
            />
          </Field>

          <Field label="Tags">
            <div className="flex flex-wrap gap-1.5">
              {task.tags.map((tag) => <span key={tag} className="chip chip-tag">#{tag}</span>)}
              <button className="font-mono text-[10px] tracking-wide text-mute rounded-sm border border-dashed border-line px-1.5 py-0.5">
                + tag
              </button>
            </div>
          </Field>

          <Field label="Discussion">
            <div className="
              rounded-lg border-[1.5px] border-dashed border-line p-4 text-center text-xs text-mute
              bg-[repeating-linear-gradient(135deg,transparent,transparent_6px,rgba(26,25,22,0.015)_6px,rgba(26,25,22,0.015)_12px)]
            ">
              <span className="mb-1.5 inline-block rounded-sm border border-line bg-paper px-1.5 py-0.5 font-mono text-[9.5px] uppercase tracking-[0.1em] text-mute">
                Future
              </span>
              <div>Thread on this task — @mentions, AI suggestions, decisions captured here.</div>
            </div>
          </Field>
        </div>
      </aside>
    </>
  );
}

// ---- Small sub-components ----

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="font-mono text-[10px] uppercase tracking-[0.1em] text-mute">{label}</div>
      {children}
    </div>
  );
}

export function StatusSegmented({ value, onChange }: { value: Status; onChange: (s: Status) => void }) {
  const opts: { id: Status; label: string }[] = [
    { id: 'pending',     label: 'Pending' },
    { id: 'in_progress', label: 'In progress' },
    { id: 'done',        label: 'Done' },
  ];
  return (
    <div className="grid grid-cols-3 gap-1.5 rounded-lg bg-surf-2 p-1">
      {opts.map(o => {
        const active = value === o.id;
        return (
          <button
            key={o.id}
            onClick={() => onChange(o.id)}
            className={clsx(
              'flex flex-col items-center gap-1 rounded-md px-1 py-2 text-xs font-medium transition-colors',
              active
                ? 'bg-paper text-ink shadow-[0_1px_2px_rgba(26,25,22,0.05)]'
                : 'bg-transparent text-mute hover:text-ink-2',
            )}
          >
            <span className={clsx(
              'h-1.5 w-1.5 rounded-full',
              active && o.id === 'done' ? 'bg-priority-done'
                : active ? 'bg-accent' : 'bg-mute-2'
            )} />
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export function PrioritySegmented({ value, onChange }: { value: Priority; onChange: (p: Priority) => void }) {
  const opts: { id: Exclude<Priority, null>; label: string; activeCls: string }[] = [
    { id: 'rush', label: 'Rush', activeCls: 'bg-priority-rush border-priority-rush text-white' },
    { id: 'high', label: 'High', activeCls: 'bg-priority-high border-priority-high text-white' },
    { id: 'med',  label: 'Med',  activeCls: 'bg-priority-med  border-priority-med  text-white' },
    { id: 'low',  label: 'Low',  activeCls: 'bg-ink border-ink text-paper' },
  ];
  return (
    <div className="grid grid-cols-4 gap-1.5">
      {opts.map(o => {
        const active = value === o.id;
        return (
          <button
            key={o.id}
            onClick={() => onChange(o.id)}
            className={clsx(
              'rounded-md border px-1 py-2 font-mono text-[10px] uppercase tracking-[0.08em] transition-colors',
              active ? o.activeCls : 'border-line bg-paper text-mute hover:text-ink-2'
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

function DateButton({ iso, onClick }: { iso: string | null; onClick: () => void }) {
  // Format with whatever date lib you use. Placeholder formatting:
  const label = iso ? new Date(iso).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) : 'No due date';
  const relative = iso ? toRelative(iso) : '';
  return (
    <button
      onClick={onClick}
      className="flex w-full items-center gap-2.5 rounded-md border border-line-2 bg-surf-2 px-3 py-2.5 font-mono text-xs text-ink-2 hover:bg-paper"
    >
      <Calendar className="h-3.5 w-3.5 text-mute" />
      <span>{label}</span>
      {relative && <span className="ml-auto text-[11px] text-mute">{relative}</span>}
    </button>
  );
}

function toRelative(iso: string): string {
  const now = new Date();
  const d = new Date(iso);
  const diffDays = Math.round((d.getTime() - now.getTime()) / 86400000);
  if (diffDays === 0) return 'today';
  if (diffDays === 1) return 'tomorrow';
  if (diffDays === -1) return 'yesterday';
  if (diffDays > 0) return `in ${diffDays} days`;
  return `${-diffDays} days ago`;
}
