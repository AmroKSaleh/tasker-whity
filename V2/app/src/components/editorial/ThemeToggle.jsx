import { useId } from 'react'
import clsx from 'clsx'

// Sun -> crescent-moon morph switch. Rays retract, color shifts, and the
// mask "eraser" bites the disc into a crescent all in sync with the knob's
// horizontal slide (one shared duration/easing, zero delay) — the icon
// arrives fully morphed exactly when it reaches the other side, rather than
// morphing in place first and sliding as a bare disc.
export default function ThemeToggle({ dark, onChange, className, title }) {
  const maskId = useId()
  return (
    <button
      type="button"
      role="switch"
      aria-checked={dark}
      title={title ?? (dark ? 'Switch to light mode' : 'Switch to dark mode')}
      onClick={() => onChange(!dark)}
      data-state={dark ? 'dark' : 'light'}
      className={clsx('theme-toggle', className)}
    >
      <svg viewBox="0 0 60 32" width="52" height="28" aria-hidden="true">
        <rect className="tt-track" x="2" y="2" width="56" height="28" rx="14" />
        <g className="tt-knob">
          {/* Rays: rotation lives on a static wrapper <g> so the CSS scale
              animation on the <line> can't clobber it (a CSS transform on the
              line would otherwise override the SVG rotate attribute). */}
          <g className="tt-rays">
            {Array.from({ length: 8 }).map((_, i) => (
              <g key={i} transform={`rotate(${i * 45} 16 16)`}>
                <line className="tt-ray" x1="16" y1="5.5" x2="16" y2="8.5" />
              </g>
            ))}
          </g>
          <mask id={maskId}>
            <rect x="0" y="0" width="32" height="32" fill="#fff" />
            <circle className="tt-eraser" cx="16" cy="16" r="9" />
          </mask>
          <circle className="tt-core" cx="16" cy="16" r="11" mask={`url(#${maskId})`} />
        </g>
      </svg>
    </button>
  )
}
