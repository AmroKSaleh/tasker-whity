import { Link } from 'react-router-dom'
import clsx from 'clsx'

// Items are ordered root → current. Every segment except the last is a link; the last is the
// page you are already on, so it renders as plain text.
// Styling rides the shared .kicker class so a trail reads as native masthead furniture.
export default function Breadcrumbs({ items = [], className = '' }) {
  const trail = items.filter(Boolean)
  if (!trail.length) return null

  return (
    <nav aria-label="Breadcrumb" className={clsx('min-w-0', className)}>
      <ol className="flex items-center gap-2 min-w-0">
        {trail.map((item, i) => {
          const isLast = i === trail.length - 1
          return (
            <li key={`${item.label}-${i}`} className="flex items-center gap-2 min-w-0">
              {isLast || !item.to ? (
                <span
                  className={clsx('kicker truncate max-w-[22ch]', isLast && 'text-ink')}
                  aria-current={isLast ? 'page' : undefined}
                  title={item.label}
                >
                  {item.label}
                </span>
              ) : (
                <Link
                  to={item.to}
                  className="kicker truncate max-w-[22ch] hover:text-ink transition-colors"
                  title={item.label}
                >
                  {item.label}
                </Link>
              )}
              {!isLast && <span aria-hidden="true" className="text-mute-2 shrink-0">›</span>}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}
