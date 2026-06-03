// AddTaskInline.tsx — "+ Add task" at the bottom of each lane.
import { useState, useRef, useEffect } from 'react';

type Props = {
  label?: string;
  sectionId: string;
  stageId: string | null;
  onAdd?: (title: string, sectionId: string, stageId: string | null) => void;
};

export function AddTaskInline({ label = 'Add task', sectionId, stageId, onAdd }: Props) {
  const [active, setActive] = useState(false);
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (active) inputRef.current?.focus(); }, [active]);

  function commit() {
    const v = value.trim();
    if (v && onAdd) onAdd(v, sectionId, stageId);
    setValue('');
    setActive(false);
  }

  if (!active) {
    return (
      <button
        type="button"
        onClick={() => setActive(true)}
        className="
          mx-0.5 my-1 flex items-center gap-2 rounded-md border border-dashed border-line
          bg-transparent px-2.5 py-2 text-left font-sans text-xs text-mute
          transition-colors hover:border-mute-2 hover:bg-surf-2 hover:text-ink-2
        "
      >
        <span className="font-mono text-[13px] text-mute-2">+</span>
        {label}
      </button>
    );
  }

  return (
    <input
      ref={inputRef}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
        if (e.key === 'Escape') { setValue(''); setActive(false); }
      }}
      onBlur={commit}
      placeholder="Task title…"
      className="
        mx-0.5 my-1 rounded-md border border-accent bg-paper px-2.5 py-2
        font-sans text-xs text-ink outline-none placeholder:text-mute-2
      "
    />
  );
}
