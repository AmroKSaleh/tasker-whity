const variants = {
  default: 'bg-paper border border-line-2',
  raised:  'bg-paper border border-line shadow-card',
  sunken:  'bg-surf-2 border border-line-2',
  hero:    'bg-ink text-paper shadow-hero',
}

export default function Card({ variant = 'default', children, className = '', onClick, ...props }) {
  return (
    <div
      className={`
        rounded-xl
        ${variants[variant]}
        ${onClick ? 'cursor-pointer hover:brightness-[0.97] active:brightness-95 transition-[filter] duration-150' : ''}
        ${className}
      `}
      onClick={onClick}
      {...props}
    >
      {children}
    </div>
  )
}
