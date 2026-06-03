// NewSectionColumn.tsx — trailing dashed column.
export function NewSectionColumn({ onClick }: { onClick?: () => void }) {
  return (
    <div className="flex h-full w-60 shrink-0 items-center justify-center rounded-xl border-[1.5px] border-dashed border-line bg-transparent">
      <button
        type="button"
        onClick={onClick}
        className="flex flex-col items-center gap-2 p-6 text-mute transition-colors hover:text-ink-2"
      >
        <span className="font-mono text-2xl text-mute-2">+</span>
        <span className="text-sm">New section</span>
      </button>
    </div>
  );
}
