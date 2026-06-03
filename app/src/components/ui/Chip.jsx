const PRIORITY_CONFIG = {
  rush:   { bg: '#111111', color: '#ffffff', border: '1px solid #111111',        label: 'RUSH' },
  high:   { bg: '#444444', color: '#ffffff', border: '1px solid #444444',        label: 'HIGH' },
  medium: { bg: '#ffffff', color: '#111111', border: '1px solid #111111',        label: 'MED'  },
  low:    { bg: '#ffffff', color: '#9a9a9a', border: '1px dashed #111111',       label: 'LOW'  },
}

export default function Chip({ priority, children, className = '', light = false, ...props }) {
  if (priority) {
    const c = PRIORITY_CONFIG[priority]
    return (
      <span
        style={{
          background: light ? 'rgba(255,255,255,0.15)' : c.bg,
          color: light ? '#ffffff' : c.color,
          border: light ? '1px solid rgba(255,255,255,0.3)' : c.border,
          fontFamily: 'inherit',
          fontSize: '9px',
          fontWeight: 600,
          letterSpacing: '0.6px',
          padding: '2px 6px',
          borderRadius: '3px',
          display: 'inline-flex',
          alignItems: 'center',
          textTransform: 'uppercase',
          whiteSpace: 'nowrap',
          fontVariantNumeric: 'tabular-nums',
        }}
        className={`font-mono ${className}`}
        {...props}
      >
        {c.label}
      </span>
    )
  }

  return (
    <span
      className={`inline-flex items-center px-2 h-6 rounded-sm border text-[11px] font-medium transition-all duration-150 cursor-pointer select-none ${className}`}
      {...props}
    >
      {children}
    </span>
  )
}
