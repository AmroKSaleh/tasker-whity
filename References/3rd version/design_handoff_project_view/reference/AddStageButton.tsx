// AddStageButton.tsx — opens existing AddStageModal.
import { Plus } from 'lucide-react';

type Props = { sectionId: string; onClick?: () => void };

export function AddStageButton({ sectionId, onClick }: Props) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-section-id={sectionId}
      className="
        flex w-full items-center justify-center gap-1.5 rounded-md border border-line
        bg-transparent px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-[0.08em]
        text-mute transition-colors hover:border-mute-2 hover:bg-paper hover:text-ink-2
      "
    >
      <Plus className="h-3 w-3" />
      Add stage
    </button>
  );
}
