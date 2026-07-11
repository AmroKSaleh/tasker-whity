const PASS = '#4ade80'
const FAIL = '#ef4444'

export default function ReviewVerdictPanel({ verdict, bar }) {
  if (!verdict) return null
  const rules = bar?.rules || []
  const labelFor = (id) => rules.find((r) => r.id === id)?.label || id
  const overall = (verdict.overall || '').toLowerCase()
  const dot = overall === 'pass' ? PASS : overall === 'fail' ? FAIL : 'var(--color-line)'

  return (
    <div className="rounded-md border border-line-2 bg-surf-2 p-3">
      <div className="flex items-center gap-2 mb-2">
        <span className="inline-block h-2 w-2 rounded-full" style={{ background: dot }} />
        <span className="text-[12px] font-semibold text-ink">Review {(verdict.overall || '—').toUpperCase()}</span>
        {verdict.escalated && <span className="text-[10px] font-mono text-priority-rush">escalated</span>}
        {verdict.attempt ? <span className="ml-auto text-[10px] font-mono text-mute">attempt {verdict.attempt}/3</span> : null}
      </div>
      <ul className="flex flex-col gap-1">
        {(verdict.results || []).map((r, i) => (
          <li key={i} className="flex items-start gap-2 text-[12px] leading-snug">
            <span className="shrink-0" style={{ color: r.status === 'pass' ? PASS : FAIL }}>{r.status === 'pass' ? '✓' : '✗'}</span>
            <span className="text-ink-2">
              {labelFor(r.rule_id)}
              {r.observed_value ? <span className="text-mute"> — {r.observed_value}</span> : null}
              {r.status === 'fail' && r.note ? <span className="text-mute"> — {r.note}</span> : null}
            </span>
          </li>
        ))}
      </ul>
      {/* TDE-382: guided-review narrative (core → consequences → secondary), fallback to flat critique */}
      {verdict.narrative && (verdict.narrative.core || verdict.narrative.sections?.length || verdict.narrative.secondary) ? (
        <div className="mt-2 flex flex-col gap-1.5 border-t border-line-2 pt-2">
          {verdict.narrative.core && <p className="text-[12px] font-medium leading-snug text-ink">{verdict.narrative.core}</p>}
          {(verdict.narrative.sections || []).map((s, i) => (
            <p key={i} className="border-l-2 border-line pl-2 text-[11px] leading-snug text-ink-2">
              {s.point}{s.consequence ? <span className="text-mute"> — {s.consequence}</span> : null}
            </p>
          ))}
          {verdict.narrative.secondary && <p className="text-[10px] leading-snug text-mute-2">{verdict.narrative.secondary}</p>}
        </div>
      ) : verdict.critique ? (
        <p className="mt-2 whitespace-pre-wrap border-t border-line-2 pt-2 text-[11px] text-mute">{verdict.critique}</p>
      ) : null}
    </div>
  )
}
