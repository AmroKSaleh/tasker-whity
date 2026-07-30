import { useState, useEffect } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'

const CLIENT_NAMES = {
  'claude.ai': 'Claude.ai',
}

function clientLabel(id) {
  if (!id) return 'An external app'
  for (const [key, name] of Object.entries(CLIENT_NAMES)) {
    if (id.includes(key)) return name
  }
  return id
}

export default function OAuthAuthorizePage() {
  const location = useLocation()
  const navigate = useNavigate()
  const params = new URLSearchParams(location.search)

  const clientId = params.get('client_id') ?? ''
  const redirectUri = params.get('redirect_uri') ?? ''
  const state = params.get('state') ?? ''
  const codeChallenge = params.get('code_challenge') ?? ''
  const codeChallengeMethod = params.get('code_challenge_method') ?? 'S256'

  const [session, setSession] = useState(null)
  const [loading, setLoading] = useState(true)
  const [working, setWorking] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session)
      setLoading(false)
      if (!session) {
        navigate(`/login?next=${encodeURIComponent(location.pathname + location.search)}`, { replace: true })
      }
    })
  }, [])

  async function handleApprove() {
    if (!redirectUri) { setError('Missing redirect_uri'); return }
    setWorking(true)
    try {
      const bytes = new Uint8Array(32)
      crypto.getRandomValues(bytes)
      const code = btoa(String.fromCharCode(...bytes))
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')

      const { error: dbErr } = await supabase.from('oauth_codes').insert({
        user_id: session.user.id,
        code,
        client_id: clientId || 'unknown',
        redirect_uri: redirectUri,
        code_challenge: codeChallenge || null,
        code_challenge_method: codeChallenge ? codeChallengeMethod : null,
        expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      })
      if (dbErr) throw new Error(dbErr.message)

      const url = new URL(redirectUri)
      url.searchParams.set('code', code)
      if (state) url.searchParams.set('state', state)
      window.location.href = url.toString()
    } catch (err) {
      setError(err.message)
      setWorking(false)
    }
  }

  function handleDeny() {
    if (!redirectUri) { navigate('/home'); return }
    const url = new URL(redirectUri)
    url.searchParams.set('error', 'access_denied')
    if (state) url.searchParams.set('state', state)
    window.location.href = url.toString()
  }

  if (loading) return null
  if (!session) return null

  const appName = clientLabel(clientId)

  return (
    <div className="min-h-screen bg-paper flex flex-col items-center justify-center p-6">
      <div className="w-full max-w-sm">

        {/* Wordmark */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center gap-2 mb-1">
            <span style={{ color: '#D97757', fontSize: 18, fontWeight: 700 }}>✦</span>
            <span className="text-[22px] font-extrabold text-ink tracking-tight">Tasker</span>
          </div>
        </div>

        {/* Card */}
        <div className="bg-paper border border-line rounded-xl shadow-panel overflow-hidden">
          {/* Header */}
          <div className="px-6 pt-6 pb-4 border-b border-line-2">
            <p className="text-[13px] font-semibold text-ink mb-0.5">{appName} wants to connect</p>
            <p className="text-[12px] text-mute">Signed in as {session.user.email}</p>
          </div>

          {/* Permissions */}
          <div className="px-6 py-4 border-b border-line-2">
            <p className="text-[11px] font-semibold text-mute uppercase tracking-wider mb-3">This will allow {appName} to</p>
            <ul className="flex flex-col gap-2">
              {[
                'Read your projects and tasks',
                'Create and update tasks',
                'Mark tasks as done',
                'Add and complete milestones',
              ].map(p => (
                <li key={p} className="flex items-center gap-2.5 text-[12px] text-ink-2">
                  <span className="text-[#5C7A5F] font-bold">✓</span>
                  {p}
                </li>
              ))}
            </ul>
          </div>

          {/* Actions */}
          <div className="px-6 py-4 flex gap-3">
            <button
              onClick={handleDeny}
              disabled={working}
              className="flex-1 h-9 border border-line rounded-lg text-[13px] font-semibold text-mute hover:text-ink hover:border-ink-2 transition-colors disabled:opacity-40"
            >
              Deny
            </button>
            <button
              onClick={handleApprove}
              disabled={working}
              className="flex-1 h-9 bg-ink text-paper rounded-lg text-[13px] font-semibold hover:bg-ink-2 transition-colors disabled:opacity-40"
            >
              {working ? 'Connecting…' : 'Allow'}
            </button>
          </div>

          {error && (
            <p className="px-6 pb-4 text-[12px] text-red-500">{error}</p>
          )}
        </div>

        <p className="text-center text-[11px] text-mute-2 mt-4">
          You can revoke this access anytime from Settings.
        </p>
      </div>
    </div>
  )
}
