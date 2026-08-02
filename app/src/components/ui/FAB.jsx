export default function FAB({ onClick, icon = '+', label, className = '' }) {
  return (
    <button
      onClick={onClick}
      aria-label={label || 'Add'}
      className={`
        fixed bottom-6 right-6 z-30
        flex items-center justify-center gap-2
        bg-accent text-paper
        rounded-2xl shadow-hero
        transition-all duration-150
        hover:bg-accent-dark active:scale-95
        focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2
        ${label ? 'px-5 h-14 text-[13px] font-semibold' : 'w-14 h-14 text-2xl'}
        ${className}
      `}
    >
      <span>{icon}</span>
      {label && <span>{label}</span>}
    </button>
  )
}
