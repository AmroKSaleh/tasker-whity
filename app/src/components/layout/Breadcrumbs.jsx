import { Link } from 'react-router-dom'

// Items are ordered root → current. Every segment except the last is a link; the last is the
// page you are already on, so it renders as plain text.
export default function Breadcrumbs({ items = [] }) {
  const trail = items.filter(Boolean)
  if (!trail.length) return null

  return (
    <nav aria-label="Breadcrumb">
      <ol className="flex items-center gap-1.5 font-mono text-[10px] tracking-widest uppercase text-mute-2">
        {trail.map((item, i) => {
          const isLast = i === trail.length - 1
          return (
            <li key={`${item.label}-${i}`} className="flex items-center gap-1.5 min-w-0">
              {isLast || !item.to ? (
                <span
                  className="max-w-[22ch] truncate"
                  aria-current={isLast ? 'page' : undefined}
                  title={item.label}
                >
                  {item.label}
                </span>
              ) : (
                <Link
                  to={item.to}
                  className="max-w-[22ch] truncate hover:text-mute transition-colors"
                  title={item.label}
                >
                  {item.label}
                </Link>
              )}
              {!isLast && <span aria-hidden="true" className="text-line">›</span>}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}
