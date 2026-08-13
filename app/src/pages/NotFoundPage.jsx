import { Link, useLocation } from 'react-router-dom'

export default function NotFoundPage() {
  const location = useLocation()

  return (
    <div className="min-h-screen bg-paper flex flex-col items-center justify-center p-6">
      <div className="mb-6 text-center">
        <div className="inline-flex items-center gap-2 mb-2">
          <span style={{ color: '#D97757', fontSize: 18, fontWeight: 700 }}>✦</span>
          <h1 className="text-[24px] font-extrabold text-ink tracking-tight">Tasker</h1>
        </div>
        <p className="text-[13px] text-mute">Page not found</p>
      </div>

      <div className="w-full max-w-[440px] bg-paper border border-line rounded-xl shadow-card p-6 text-center">
        <p className="text-[13px] text-ink mb-1">
          There is nothing at <span className="font-mono text-[12px] text-mute">{location.pathname}</span>.
        </p>
        <p className="text-[12px] text-mute mb-5">
          The link may be stale, or the page may have been renamed.
        </p>
        <div className="flex gap-2 justify-center">
          <Link
            to="/home"
            className="px-4 h-9 inline-flex items-center bg-ink text-paper rounded-md text-[13px] font-semibold tracking-tight transition-all duration-150 hover:bg-ink-2"
          >
            Go to Tasker
          </Link>
          <Link
            to="/docs"
            className="px-4 h-9 inline-flex items-center border border-line text-mute rounded-md text-[13px] font-semibold tracking-tight transition-colors hover:bg-surf-2"
          >
            Docs
          </Link>
        </div>
      </div>
    </div>
  )
}
