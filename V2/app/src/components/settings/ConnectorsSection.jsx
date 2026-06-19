import { useState, useEffect } from 'react'
import { supabase } from '../../lib/supabase'
import { useGitHub } from '../../hooks/useGitHub'
import { useGoogleCalendar } from '../../hooks/useGoogleCalendar'
import { connectGoogle, loadGoogleConnection, disconnectGoogleScope, hasGoogleScope } from '../../lib/google'
import { CONNECTORS } from '../../lib/connectors'

const BTN = 'w-full px-4 py-2 rounded-lg border border-line bg-paper text-[12px] text-ink hover:bg-surf-2 transition-colors disabled:opacity-40'

// Shared card chrome. `action` renders on the right of the header; `children` below it.
function Row({ icon: Icon, label, slice, connected, badge, action, children }) {
  return (
    <div className="rounded-xl border border-line bg-surf-2 px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <Icon size={16} className="text-ink-2 shrink-0" />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-[13px] font-medium text-ink">{label}</span>
              {connected && <span className="text-[10px] text-green-600">●</span>}
              {badge && <span className="text-[9px] font-mono text-mute-2 uppercase tracking-wide">{badge}</span>}
            </div>
            <p className="text-[11px] text-mute-2 truncate">{slice}</p>
          </div>
        </div>
        {action}
      </div>
      {children}
    </div>
  )
}

const DisconnectBtn = ({ onClick, title }) => (
  <button onClick={onClick} title={title} className="text-[12px] text-mute hover:text-ink transition-colors shrink-0">Disconnect</button>
)

export default function ConnectorsSection() {
  const gh = useGitHub()
  const cal = useGoogleCalendar()

  const [userId, setUserId] = useState(null)
  const [googleConn, setGoogleConn] = useState(null)   // { connected, scopes[] } | null
  const [googleLoading, setGoogleLoading] = useState(true)

  const [ghPat, setGhPat] = useState('')
  const [ghShow, setGhShow] = useState(false)
  const [ghBusy, setGhBusy] = useState(false)
  const [ghErr, setGhErr] = useState(null)
  const [calBusy, setCalBusy] = useState(false)
  const [calErr, setCalErr] = useState(null)
  const [gScope, setGScope] = useState(null)           // scope mid-connect
  const [gErr, setGErr] = useState(null)

  useEffect(() => {
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (!user) { setGoogleLoading(false); return }
      setUserId(user.id)
      loadGoogleConnection(user.id).then(c => { setGoogleConn(c); setGoogleLoading(false) })
    })
  }, [])

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
  async function connectGoogleScope(scope) {
    setGScope(scope); setGErr(null)
    try {
      await connectGoogle([scope])                          // popup; resolves when the callback posts back
      if (userId) setGoogleConn(await loadGoogleConnection(userId))
    } catch (e) {
      setGErr(e.message ?? 'Could not connect.')
    } finally {
      setGScope(null)
    }
  }
  async function disconnectGoogleService(scope) {
    if (!userId) return
    await disconnectGoogleScope(userId, scope)
    setGoogleConn(await loadGoogleConnection(userId))
  }

  function renderCard(c) {
    const common = { icon: c.icon, label: c.label, slice: c.slice }

    if (c.kind === 'github') {
      const connected = gh.isConnected
      return (
        <Row {...common} connected={connected}
          action={connected && <DisconnectBtn onClick={gh.disconnect} />}>
          {gh.loading && <p className="mt-2 text-[12px] text-mute">Checking connection…</p>}
          {!gh.loading && !connected && (gh.isOAuthUser ? (
            <p className="mt-2 text-[12px] text-mute">Sign out and back in with GitHub to connect automatically.</p>
          ) : (
            <div className="mt-2.5 flex flex-col gap-2">
              <div className="flex gap-2">
                <input type={ghShow ? 'text' : 'password'} value={ghPat}
                  onChange={e => { setGhPat(e.target.value); setGhErr(null) }}
                  placeholder="github_pat_..."
                  className="flex-1 bg-paper border border-line rounded-lg px-3 py-2 text-[12px] text-ink outline-none focus:border-ink transition-colors placeholder:text-mute-2 font-mono" />
                <button onClick={() => setGhShow(v => !v)} className="px-3 rounded-lg border border-line bg-paper text-[11px] text-mute hover:text-ink transition-colors shrink-0">{ghShow ? 'Hide' : 'Show'}</button>
              </div>
              <button onClick={connectGitHub} disabled={ghBusy || !ghPat.trim()} className={BTN}>
                {ghBusy ? 'Connecting…' : 'Connect with PAT'}
              </button>
              <p className="text-[11px] text-mute-2 leading-relaxed">
                Personal Access Token with <span className="font-mono">repo</span> scope.{' '}
                <a href="https://github.com/settings/tokens" target="_blank" rel="noopener noreferrer" className="text-accent hover:opacity-70 underline underline-offset-2">Get one</a>
              </p>
            </div>
          ))}
          {ghErr && <p className="mt-2 text-[11px] text-red-500">{ghErr}</p>}
        </Row>
      )
    }

    if (c.kind === 'gcal') {
      const connected = cal.isConnected
      return (
        <Row {...common} connected={connected} badge={cal.isExpired ? 'expired' : null}
          action={connected && <DisconnectBtn onClick={cal.disconnect} />}>
          {cal.loading && <p className="mt-2 text-[12px] text-mute">Checking connection…</p>}
          {!cal.loading && !connected && (
            <button onClick={connectCal} disabled={calBusy} className={`mt-2.5 ${BTN}`}>
              {calBusy ? 'Connecting…' : cal.isExpired ? 'Reconnect' : 'Connect'}
            </button>
          )}
          {calErr && <p className="mt-2 text-[11px] text-red-500">{calErr}</p>}
        </Row>
      )
    }

    if (c.kind === 'google') {
      const connected = !!googleConn && hasGoogleScope(googleConn, c.scope)
      return (
        <Row {...common} connected={connected}
          action={connected && <DisconnectBtn onClick={() => disconnectGoogleService(c.scope)} />}>
          {googleLoading && <p className="mt-2 text-[12px] text-mute">Checking connection…</p>}
          {!googleLoading && !connected && (
            <button onClick={() => connectGoogleScope(c.scope)} disabled={gScope === c.scope} className={`mt-2.5 ${BTN}`}>
              {gScope === c.scope ? 'Connecting…' : 'Connect'}
            </button>
          )}
          {gErr && <p className="mt-2 text-[11px] text-red-500">{gErr}</p>}
        </Row>
      )
    }

    // 'soon'
    return (
      <Row {...common} badge="soon">
        <p className="mt-1.5 text-[11px] text-mute-2 italic">Coming soon.</p>
      </Row>
    )
  }

  return (
    <section className="mb-7">
      <label className="block font-mono text-[9px] font-bold tracking-widest text-mute-2 uppercase mb-1">
        Connectors
      </label>
      <p className="text-[11px] text-mute-2 mb-4 leading-relaxed">
        Connect 3rd-party apps. Tasker surfaces only the slice relevant to your work — never a full client. Each service connects independently, and connected apps also become available to your AI agents over MCP.
      </p>
      <div className="flex flex-col gap-2.5">
        {CONNECTORS.map(c => <div key={c.id}>{renderCard(c)}</div>)}
      </div>
    </section>
  )
}
