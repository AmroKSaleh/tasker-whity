// Swimlane.tsx — stage divider inside a column.
import type { Stage } from './types';

export function Swimlane({ stage }: { stage: Stage }) {
  const remaining = stage.tasks.filter(t => t.status !== 'done').length;
  return (
    <div className="flex select-none items-center gap-2 px-1.5 pb-1.5 pt-3.5 font-mono text-[10px] font-medium uppercase tracking-[0.12em] text-mute">
      <span>{stage.name}</span>
      <span className="font-normal text-mute-2">{remaining}/{stage.tasks.length}</span>
      <span className="h-px flex-1 bg-line-2" />
    </div>
  );
}
