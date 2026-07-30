const PRIORITY_CONFIG = {
  rush:   { bg: 'var(--color-ink)',   color: 'var(--color-paper)', border: 'none',                                       label: 'RUSH' },
  high:   { bg: 'var(--color-ink-2)', color: 'var(--color-paper)', border: 'none',                                       label: 'HIGH' },
  medium: { bg: 'transparent',        color: 'var(--color-ink)',   border: '1px solid var(--color-ink)',                 label: 'MED'  },
  low:    { bg: 'transparent',        color: 'var(--color-mute-2)', border: '1px dashed var(--color-mute-2)',            label: 'LOW'  },
}

export default function Chip({ priority, children, className = '', light = false, ...props }) {
  if (priority) {
    const c = PRIORITY_CONFIG[priority]
    return (
      <span
        style={{
          background: light ? 'rgba(251,250,246,0.15)' : c.bg,
          color: light ? 'var(--color-paper)' : c.color,
          border: light ? '1px solid rgba(251,250,246,0.3)' : c.border,
          fontFamily: '"JetBrains Mono", ui-monospace, monospace',
          fontSize: '9px',
          fontWeight: 600,
          letterSpacing: '0.6px',
          padding: '2px 6px',
          borderRadius: '3px',
          display: 'inline-flex',
          alignItems: 'center',
          textTransform: 'uppercase',
          whiteSpace: 'nowrap',
        }}
        className={className}
        {...props}
      >
        {c.label}
      </span>
    )
  }

  return (
    <span
      className={`inline-flex items-center px-2 h-6 rounded-sm border border-line text-[11px] font-medium text-mute cursor-pointer select-none hover:border-ink hover:text-ink transition-colors duration-150 ${className}`}
      {...props}
    >
      {children}
    </span>
  )
}
