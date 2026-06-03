export default function FAB({ onClick, icon = '+', label, className = '' }) {
  return (
    <button
      onClick={onClick}
      aria-label={label || 'Add'}
      className={`
        fixed bottom-6 right-6
        flex items-center justify-center gap-2
        bg-primary-container text-on-primary-container
        rounded-lg shadow-md
        transition-all duration-200
        hover:brightness-95 active:brightness-90
        focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2
        ${label ? 'px-4 h-14 text-label-large font-medium' : 'w-14 h-14 text-2xl'}
        ${className}
      `}
    >
      <span className={label ? 'text-xl' : ''}>{icon}</span>
      {label && <span>{label}</span>}
    </button>
  )
}
