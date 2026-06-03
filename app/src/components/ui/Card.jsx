const elevations = {
  low:     'bg-surface-container-low',
  default: 'bg-surface-container',
  high:    'bg-surface-container-high',
}

export default function Card({ elevation = 'default', children, className = '', onClick, ...props }) {
  return (
    <div
      className={`
        rounded-lg
        ${elevations[elevation]}
        ${onClick ? 'cursor-pointer hover:brightness-95 active:brightness-90 transition-[filter] duration-150' : ''}
        ${className}
      `}
      onClick={onClick}
      {...props}
    >
      {children}
    </div>
  )
}
