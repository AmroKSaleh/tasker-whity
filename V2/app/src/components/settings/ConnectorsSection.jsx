import { useState } from 'react'
import clsx from 'clsx'
import { useGitHub } from '../../hooks/useGitHub'
import { useGoogleCalendar } from '../../hooks/useGoogleCalendar'
import { CONNECTORS, STATUS_NOTE } from '../../lib/connectors'

// Unified Settings → Connectors section (provider registry-driven). Live providers
// (GitHub, Google Calendar) are hook-backed; 'setup'/'soon' providers show as
// informational cards until their backend lands.
export default function ConnectorsSection() {
  const gh = useGitHub()
  const cal = useGoogleCalendar()

  const [ghPat, setGhPat] = useState('')
  const [ghShow, setGhShow] = useState(false)
  const [ghBusy, setGhBusy] = useState(false)
  const [ghErr, setGhErr] = useState(null)
  const [calBusy, setCalBusy] = useState(false)
  const [calErr, setCalErr] = useState(null)

  async function connectGitHub() {
    if (!ghPat.trim()) return
    setGhBusy(true); setGhErr(null)
    try { await gh.connect(ghPat.trim()); setGhPat('') }
    catch (e) { setGhErr(e.message ?? 'Invalid token. Check your PAT and try again.') }
    finally { setGhBusy(false) }
  }

  async function connectCal() {
    setCalBusy(true); setCalErr(null)
    try { await cal.connect() }
    catch (e) { setCalErr(e.message ?? 'Could not connect. Try again.') }
    finally { setCalBusy(false) }
  }

  // Live, hook-backed providers keyed by registry id.
  const live = {
    github: {
      loading: gh.loading,
      connected: gh.isConnected,
      statusLabel: gh.isOAuthUser ? 'Connected via GitHub login' : 'Connected',
      onDisconnect: gh.disconnect,
      error: ghErr,
      connectNode: gh.isOAuthUser
        ? <p className="text-[12px] text-mute">Sign out and back in with GitHub to connect automatically.</p>
        : (
          <div className="flex flex-col gap-2">
            <div className="flex gap-2">
              <input
                type={ghShow ? 'text' : 'password'}
                value={ghPat}
                onChange={e => { setGhPat(e.target.value); setGhErr(null) }}
                placeholder="github_pat_..."
                className="flex-1 bg-paper border border-line rounded-lg px-3 py-2 text-[12px] text-ink outline-none focus:border-ink transition-colors placeholder:text-mute-2 font-mono"
              />
              <button onClick={() => setGhShow(v => !v)} className="px-3 rounded-lg border border-line bg-paper text-[11px] text-mute hover:text-ink transition-colors shrink-0">
                {ghShow ? 'Hide' : 'Show'}
              </button>
            </div>
            <button
              onClick={connectGitHub}
              disabled={ghBusy || !ghPat.trim()}
              className="w-full px-4 py-2 rounded-lg border border-line bg-paper text-[12px] text-ink hover:bg-surf-2 transition-colors disabled:opacity-40"
            >
              {ghBusy ? 'Connecting…' : 'Connect with PAT'}
            </button>
            <p className="text-[11px] text-mute-2 leading-relaxed">
              Personal Access Token with <span className="font-mono">repo</span> scope.{' '}
              <a href="https://github.com/settings/tokens" target="_blank" rel="noopener noreferrer" className="text-accent hover:opacity-70 underline underline-offset-2">Get one</a>
            </p>
          </div>
        ),
    },
    google_calendar: {
      loading: cal.loading,
      connected: cal.isConnected,
      statusLabel: cal.isExpired ? 'Session expired' : 'Connected',
      onDisconnect: cal.disconnect,
      error: calErr,
      connectNode: (
        <button
          onClick={connectCal}
          disabled={calBusy}
          className="w-full px-4 py-2 rounded-lg border border-line bg-paper text-[12px] text-ink hover:bg-surf-2 transition-colors disabled:opacity-40"
        >
          {calBusy ? 'Connecting…' : cal.isExpired ? 'Reconnect' : 'Connect'}
        </button>
      ),
    },
  }

  return (
    <section className="mb-7">
      <label className="block font-mono text-[9px] font-bold tracking-widest text-mute-2 uppercase mb-1">
        Connectors
      </label>
      <p className="text-[11px] text-mute-2 mb-4 leading-relaxed">
        Connect 3rd-party apps. Tasker surfaces only the slice relevant to your work — never a full client. Connected apps also become available to your AI agents over MCP.
      </p>
      <div className="flex flex-col gap-2.5">
        {CONNECTORS.map(c => {
          const L = live[c.id]
          const Icon = c.icon
          const connected = !!L?.connected
          return (
            <div key={c.id} className="rounded-xl border border-line bg-surf-2 px-4 py-3">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2.5 min-w-0">
                  <Icon size={16} className="text-ink-2 shrink-0" />
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-[13px] font-medium text-ink">{c.label}</span>
                      {connected && <span className="text-[10px] text-green-600">●</span>}
                      {!L && (
                        <span className="text-[9px] font-mono text-mute-2 uppercase tracking-wide">{c.status}</span>
                      )}
                    </div>
                    <p className="text-[11px] text-mute-2 truncate">{c.slice}</p>
                  </div>
                </div>
                {connected && (
                  <button onClick={L.onDisconnect} className="text-[12px] text-mute hover:text-ink transition-colors shrink-0">
                    Disconnect
                  </button>
                )}
              </div>
              {L && L.loading && <p className="mt-2 text-[12px] text-mute">Checking connection…</p>}
              {L && !L.loading && !connected && <div className="mt-2.5">{L.connectNode}</div>}
              {L && L.error && <p className="mt-2 text-[11px] text-red-500">{L.error}</p>}
              {!L && <p className="mt-1.5 text-[11px] text-mute-2 italic">{STATUS_NOTE[c.status]}</p>}
            </div>
          )
        })}
      </div>
    </section>
  )
}
