const variants = {
  filled:   'bg-ink text-paper hover:bg-ink-2 active:opacity-80',
  outlined: 'border border-line text-ink hover:bg-surf active:bg-surf-2',
  ghost:    'text-mute hover:text-ink hover:bg-surf active:bg-surf-2',
  accent:   'bg-accent text-paper hover:bg-accent-dark active:opacity-80',
}

export default function Button({ variant = 'filled', children, className = '', disabled, ...props }) {
  return (
    <button
      className={`
        inline-flex items-center justify-center gap-1.5
        px-4 h-9 rounded-md
        text-[13px] font-semibold tracking-tight
        transition-all duration-150
        disabled:opacity-40 disabled:pointer-events-none
        focus-visible:outline-2 focus-visible:outline-ink focus-visible:outline-offset-2
        ${variants[variant]}
        ${className}
      `}
      disabled={disabled}
      {...props}
    >
      {children}
    </button>
  )
}
