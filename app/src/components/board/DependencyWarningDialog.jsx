export default function FlowBlockedDialog({ dependency, onProceed, onCancel }) {
  if (!dependency) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-40"
      onClick={e => { if (e.target === e.currentTarget) onCancel() }}
    >
      <div className="bg-paper rounded-2xl w-full max-w-md mx-4 shadow-xl flex flex-col">
        <div className="flex items-center justify-between px-6 pt-6 pb-0">
          <p className="text-[15px] font-semibold text-ink">Flow blocked</p>
          <button onClick={onCancel} className="text-mute hover:text-ink text-lg leading-none transition-colors">×</button>
        </div>

        <div className="flex flex-col gap-4 px-6 pt-4 pb-6">
          <div>
            <p className="text-[13px] text-ink-2 mb-2">
              This task is part of a flow that requires <span className="font-semibold">"{dependency.sourceTaskName}"</span> to be complete first.
            </p>
            <p className="text-[13px] text-mute">
              Complete it first to keep the flow intact.
            </p>
          </div>

          <div className="flex gap-2 justify-end">
            <button
              onClick={onCancel}
              className="px-4 py-2 text-[13px] text-mute hover:text-ink transition-colors font-medium"
            >
              Complete flow step first
            </button>
            <button
              onClick={onProceed}
              className="px-4 py-2 rounded-lg bg-ink text-paper text-[13px] font-medium hover:bg-ink-2 transition-colors"
            >
              Proceed anyway
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
