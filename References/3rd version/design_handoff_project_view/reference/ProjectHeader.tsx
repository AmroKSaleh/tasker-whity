// ProjectHeader.tsx — top of the project view.
import { Zap } from 'lucide-react';
import type { Project } from './types';

type Props = {
  project: Project;
  onRename?: (name: string) => void;
  onExport?: () => void;
  onBriefing?: () => void;
  onFocus?: () => void;
};

export function ProjectHeader({ project, onRename, onExport, onBriefing, onFocus }: Props) {
  const pct = project.totalCount > 0
    ? Math.round((project.doneCount / project.totalCount) * 100)
    : 0;

  return (
    <header className="flex items-center justify-between gap-6 border-b border-line-2 bg-paper px-8 py-4">
      <div className="min-w-0">
        <div className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.06em] text-mute">
          <span>Workspace</span>
          <span className="text-mute-2">/</span>
          <span>Projects</span>
        </div>
        <h1
          contentEditable
          suppressContentEditableWarning
          spellCheck={false}
          onBlur={(e) => onRename?.(e.currentTarget.textContent || '')}
          className="mt-1.5 text-2xl font-semibold leading-tight tracking-[-0.015em] outline-none focus:underline focus:decoration-accent focus:decoration-1 focus:underline-offset-4"
        >
          {project.name}
        </h1>
        <div className="mt-2 flex items-center gap-3.5">
          <div className="h-1 w-[200px] overflow-hidden rounded-sm bg-line-2">
            <div className="h-full rounded-sm bg-ink" style={{ width: `${pct}%` }} />
          </div>
          <span className="font-mono text-[11px] tracking-[0.04em] text-mute">
            {project.doneCount} of {project.totalCount} · {pct}%
          </span>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        <button className="btn" onClick={onBriefing}>
          <Zap className="h-3.5 w-3.5" /> Briefing
        </button>
        <button className="btn" onClick={onExport}>Export</button>
        <button className="btn-primary" onClick={onFocus}>
          <Zap className="h-3.5 w-3.5" /> Focus
        </button>
      </div>
    </header>
  );
}
