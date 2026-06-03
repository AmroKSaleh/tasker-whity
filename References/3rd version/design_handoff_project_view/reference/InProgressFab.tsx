// InProgressFab.tsx — mobile floating action button.
import { useState } from 'react';
import { Play } from 'lucide-react';
import { InProgressSheet } from './InProgressSheet';

type Props = {
  count?: number;
};

export function InProgressFab({ count = 0 }: Props) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="
          fixed z-30 flex items-center gap-1.5 rounded-full
          bg-ink text-paper px-3.5 py-2.5
          font-mono text-[11px] uppercase tracking-[0.06em]
          shadow-fab
        "
        style={{
          right: '14px',
          bottom: 'max(16px, env(safe-area-inset-bottom))',
        }}
      >
        <Play className="h-3 w-3" />
        In progress
        <span className="rounded-full bg-accent px-1.5 py-px text-[10px] font-semibold text-white">
          {count}
        </span>
      </button>

      {open && <InProgressSheet onClose={() => setOpen(false)} />}
    </>
  );
}
