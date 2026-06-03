// InProgressSidebar.tsx — desktop right rail.
// NOTE: the existing app already has an in-progress sidebar visual; this redesign
// only repositions it. If you have a working <InProgressSidebar>, KEEP IT and
// just mount it in this slot. The reference below is for new builds.

import clsx from 'clsx';

type IpTask = {
  id: string;
  sectionName: string;
  title: string;
  dueLabel: string;          // e.g. "Today", "Fri"
  startedAgo?: string;       // e.g. "Started 32m ago"
};

type Props = {
  featured?: IpTask | null;
  others?: IpTask[];
};

export function InProgressSidebar({ featured, others = [] }: Props) {
  const count = (featured ? 1 : 0) + others.length;

  return (
    <aside className="hidden md:flex h-full w-72 shrink-0 flex-col gap-3 overflow-y-auto border-l border-line-2 bg-paper px-4 py-4">
      <h3 className="m-0 flex items-center justify-between font-mono text-[11px] uppercase tracking-[0.1em] text-mute">
        In progress
        <span className="rounded-sm bg-line-2 px-1.5 py-0.5 text-[10px] text-ink-2">{count}</span>
      </h3>

      {featured && <IpCard task={featured} featured />}
      {others.map(t => <IpCard key={t.id} task={t} />)}

      <button className="btn-ghost mt-auto justify-center">View all in-progress →</button>
    </aside>
  );
}

function IpCard({ task, featured }: { task: IpTask; featured?: boolean }) {
  return (
    <div className={clsx(
      'flex flex-col gap-2 rounded-lg border p-3.5',
      featured
        ? 'border-ink bg-ink text-paper'
        : 'border-line bg-paper'
    )}>
      <span className={clsx(
        'font-mono text-[9.5px] uppercase tracking-[0.1em]',
        featured ? 'text-paper/55' : 'text-mute'
      )}>
        {task.sectionName}
      </span>
      <p className={clsx('font-medium leading-snug', featured ? 'text-[15px]' : 'text-sm')}>
        {task.title}
      </p>
      <div className={clsx(
        'flex items-center gap-2 font-mono text-[10px] tracking-[0.04em]',
        featured ? 'text-paper/60' : 'text-mute'
      )}>
        <span className="text-accent">● {task.dueLabel}</span>
        {task.startedAgo && (<><span>·</span><span>{task.startedAgo}</span></>)}
      </div>
      {featured && (
        <div className="mt-1 flex gap-1.5">
          <button className="rounded bg-accent px-2 py-1 text-[11px] font-medium text-white">Focus →</button>
          <button className="rounded bg-white/10 px-2 py-1 text-[11px] font-medium text-paper">Complete</button>
        </div>
      )}
    </div>
  );
}
