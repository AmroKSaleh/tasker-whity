import { useState } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { login, completeTwoFactor, selectTenant } from '../api/auth'
import { useSession } from '../auth/SessionProvider'
import SsoButtons from '../components/layout/SsoButtons'

export default function LoginPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const nextUrl = new URLSearchParams(location.search).get('next') || '/home'

  const [step, setStep] = useState('credentials')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [memberships, setMemberships] = useState([])
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)

  const { refresh } = useSession()

  /** Route a login-family outcome to the next step. */
  async function applyOutcome(outcome) {
    if (outcome.status === 'requires_2fa') {
      setStep('two_factor')
      return
    }
    if (outcome.status === 'requires_2fa_enrollment') {
      // An admin-mandated 2FA policy the caller hasn't enrolled in yet.
      // There is no session to refresh into and no enrollment UI in this
      // SPA (whity's admin owns that) — without this branch, falling
      // through to the refresh()/navigate below would silently bounce the
      // user back to /login with no explanation, since getMe() 401s and
      // flips the session to anonymous.
      setStep('2fa_enrollment_required')
      return
    }
    if (outcome.status === 'requires_tenant_selection') {
      setMemberships(outcome.memberships)
      setStep('tenant')
      return
    }
    await refresh()
    navigate(nextUrl, { replace: true })
  }

  /** Run an auth call, surfacing its message and never leaving the form busy. */
  async function attempt(fn) {
    setBusy(true)
    setError(null)
    try {
      await applyOutcome(await fn())
    } catch (e) {
      setError(e.message ?? 'Something went wrong')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="min-h-screen bg-paper flex flex-col items-center justify-center p-6">

      {/* Wordmark */}
      <div className="mb-10 text-center">
        <div className="inline-flex items-center gap-2 mb-2">
          <span style={{ color: '#D97757', fontSize: 18, fontWeight: 700 }}>✦</span>
          <h1 className="text-[24px] font-extrabold text-ink tracking-tight">Tasker</h1>
        </div>
        <p className="text-[13px] text-mute">Your focus, decided.</p>
      </div>

      {/* Card */}
      <div className="w-full max-w-sm bg-paper border border-line rounded-xl shadow-card overflow-hidden">

        {step === 'credentials' && (
          <div className="p-6">
            <h2 className="text-[16px] font-semibold text-ink mb-4">Sign in</h2>
            <form
              onSubmit={(e) => { e.preventDefault(); attempt(() => login(email, password)) }}
              className="flex flex-col gap-4"
            >
              <div className="flex flex-col gap-1.5">
                <label htmlFor="email" className="text-[11px] font-semibold text-mute uppercase tracking-wider">
                  Email
                </label>
                <input
                  id="email"
                  type="email"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  required
                  autoFocus
                  autoComplete="username"
                  placeholder="you@example.com"
                  className="w-full bg-surf-2 border border-line rounded-md px-3 py-2.5 text-[13px] text-ink outline-none focus:border-ink transition-colors placeholder:text-mute-2"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <label htmlFor="password" className="text-[11px] font-semibold text-mute uppercase tracking-wider">
                  Password
                </label>
                <input
                  id="password"
                  type="password"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  required
                  autoComplete="current-password"
                  placeholder="········"
                  className="w-full bg-surf-2 border border-line rounded-md px-3 py-2.5 text-[13px] text-ink outline-none focus:border-ink transition-colors placeholder:text-mute-2"
                />
              </div>

              {error && <p role="alert" className="text-[12px] text-red-500 -mt-1">{error}</p>}

              <button
                type="submit"
                disabled={busy}
                className="w-full mt-1 h-10 bg-ink text-paper rounded-md text-[13px] font-semibold tracking-tight transition-all duration-150 hover:bg-ink-2 disabled:opacity-40 disabled:pointer-events-none"
              >
                {busy ? 'Please wait…' : 'Sign in'}
              </button>
            </form>

            <div className="flex items-center gap-3 mt-4">
              <div className="flex-1 h-px bg-line-2" />
              <span className="text-[11px] text-mute-2">or</span>
              <div className="flex-1 h-px bg-line-2" />
            </div>

            <div className="mt-3">
              <SsoButtons />
            </div>
          </div>
        )}

        {step === 'two_factor' && (
          <div className="p-6">
            <h2 className="text-[16px] font-semibold text-ink mb-4">Two-factor authentication</h2>
            <form
              onSubmit={(e) => { e.preventDefault(); attempt(() => completeTwoFactor(code)) }}
              className="flex flex-col gap-4"
            >
              <div className="flex flex-col gap-1.5">
                <label htmlFor="code" className="text-[11px] font-semibold text-mute uppercase tracking-wider">
                  Authentication code
                </label>
                <input
                  id="code"
                  value={code}
                  onChange={e => setCode(e.target.value)}
                  required
                  autoFocus
                  autoComplete="one-time-code"
                  placeholder="123456"
                  className="w-full bg-surf-2 border border-line rounded-md px-3 py-2.5 text-[13px] text-ink outline-none focus:border-ink transition-colors placeholder:text-mute-2"
                />
              </div>

              {error && <p role="alert" className="text-[12px] text-red-500 -mt-1">{error}</p>}

              <button
                type="submit"
                disabled={busy}
                className="w-full mt-1 h-10 bg-ink text-paper rounded-md text-[13px] font-semibold tracking-tight transition-all duration-150 hover:bg-ink-2 disabled:opacity-40 disabled:pointer-events-none"
              >
                {busy ? 'Verifying…' : 'Verify'}
              </button>
            </form>
          </div>
        )}

        {step === 'tenant' && (
          <div className="p-6">
            <h2 className="text-[16px] font-semibold text-ink mb-4">Choose a workspace</h2>

            {error && <p role="alert" className="text-[12px] text-red-500 mb-3">{error}</p>}

            <div className="flex flex-col gap-2">
              {memberships.map(m => (
                <button
                  key={m.tenant_id}
                  type="button"
                  disabled={busy}
                  onClick={() => attempt(() => selectTenant(m.tenant_id))}
                  className="w-full flex items-center justify-between gap-2 h-11 px-3 bg-surf-2 border border-line rounded-md text-[13px] font-semibold text-ink hover:bg-line transition-colors disabled:opacity-40"
                >
                  <span>{m.tenant_name}</span>
                  <span className="text-[11px] font-medium text-mute uppercase tracking-wider">{m.role}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {step === '2fa_enrollment_required' && (
          <div className="p-6">
            <h2 className="text-[16px] font-semibold text-ink mb-4">Two-factor authentication required</h2>
            <p className="text-[13px] text-ink-2 leading-relaxed">
              Your organization requires two-factor authentication. Please set
              it up at the admin portal before signing in.
            </p>
            <a
              href="http://localhost:3010/login"
              className="mt-4 inline-block w-full text-center h-10 leading-10 bg-ink text-paper rounded-md text-[13px] font-semibold tracking-tight transition-all duration-150 hover:bg-ink-2"
            >
              Go to admin portal
            </a>
          </div>
        )}

      </div>
    </div>
  )
}
