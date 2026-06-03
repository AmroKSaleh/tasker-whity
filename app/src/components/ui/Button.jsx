const variants = {
  filled:   'bg-primary text-on-primary hover:opacity-90 active:opacity-80',
  tonal:    'bg-secondary-container text-on-secondary-container hover:opacity-90 active:opacity-80',
  outlined: 'border border-outline text-primary hover:bg-primary hover:bg-opacity-8 active:bg-opacity-12',
  text:     'text-primary hover:bg-primary hover:bg-opacity-8 active:bg-opacity-12',
}

export default function Button({ variant = 'filled', children, className = '', disabled, ...props }) {
  return (
    <button
      className={`
        inline-flex items-center justify-center gap-2
        px-6 h-10 rounded-pill
        text-label-large font-medium
        transition-all duration-200
        disabled:opacity-38 disabled:pointer-events-none
        focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2
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
