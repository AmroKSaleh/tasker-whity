import { useState } from 'react'

export const STALE_DAYS = 60

export function isStale(entry) {
  if (entry.archived_at) return false
  const last = new Date(entry.reviewed_at ?? entry.updated_at).getTime()
  return Date.now() - last > STALE_DAYS * 86400000
}

export function countStale(entries) {
  return entries.filter(isStale).length
}

export default function KbHealthPanel({ entries, archiveEntry, reviewEntry }) {
  const [busy, setBusy] = useState(false)
  const stale = entries.filter(isStale)
  const agentStale = stale.filter(e => (e.source ?? 'user') === 'agent')
  const userStale = stale.filter(e => (e.source ?? 'user') !== 'agent')

  async function archiveAllAgent() {
    setBusy(true)
    for (const e of agentStale) await archiveEntry(e.id)
    setBusy(false)
  }

  if (stale.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 px-6 text-center gap-3">
        <div className="w-10 h-10 rounded-xl border border-dashed border-line flex items-center justify-center text-green-500 text-lg">✓</div>
        <p className="text-[13px] text-mute leading-relaxed">
          Knowledge base is healthy.<br />Nothing has gone stale ({STALE_DAYS}+ days untouched).
        </p>
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-y-auto p-5 flex flex-col gap-6">
      {agentStale.length > 0 && (
        <section className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <h3 className="font-mono text-[11px] tracking-widest uppercase text-mute">
              AI entries · {agentStale.length} stale
            </h3>
            <button onClick={archiveAllAgent} disabled={busy} className="btn btn-sm disabled:opacity-40">
              {busy ? 'Archiving…' : `Archive all ${agentStale.length}`}
            </button>
          </div>
          <ul className="divide-y divide-line-2 border border-line-2 rounded-lg overflow-hidden">
            {agentStale.map(e => (
              <li key={e.id} className="flex items-center justify-between px-3.5 py-2.5 gap-3">
                <span className="text-[13px] text-ink truncate">{e.title}</span>
                <button onClick={() => archiveEntry(e.id)} className="btn btn-sm shrink-0">Archive</button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {userStale.length > 0 && (
        <section className="flex flex-col gap-2">
          <h3 className="font-mono text-[11px] tracking-widest uppercase text-mute">
            Your entries · {userStale.length} stale
          </h3>
          <p className="text-[12px] text-mute-2 leading-relaxed">
            These are yours — nothing happens automatically. Keep to reset the clock, or archive (recoverable).
          </p>
          <ul className="divide-y divide-line-2 border border-line-2 rounded-lg overflow-hidden">
            {userStale.map(e => (
              <li key={e.id} className="flex items-center justify-between px-3.5 py-2.5 gap-3">
                <span className="text-[13px] text-ink truncate">{e.title}</span>
                <div className="flex items-center gap-2 shrink-0">
                  <button onClick={() => reviewEntry(e.id)} className="btn btn-sm">Keep</button>
                  <button onClick={() => archiveEntry(e.id)} className="btn btn-sm">Archive</button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
