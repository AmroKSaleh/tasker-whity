import { useState, useEffect } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { supabase } from '../lib/supabase'

const TABS = [
  { id: 'signin', label: 'Sign in' },
  { id: 'signup', label: 'Sign up' },
  { id: 'magic',  label: 'Magic link' },
]

export default function LoginPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const nextUrl = new URLSearchParams(location.search).get('next') || '/home'
  const [tab, setTab] = useState('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [showPasswordReset, setShowPasswordReset] = useState(false)
  const [isSettingPasswordAfterReset, setIsSettingPasswordAfterReset] = useState(false)
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')

  useEffect(() => {
    checkForResetSession()
  }, [])

  async function checkForResetSession() {
    const { data: { session } } = await supabase.auth.getSession()
    if (session) {
      setIsSettingPasswordAfterReset(true)
    }
  }

  function switchTab(id) {
    setTab(id)
    setError('')
    setMessage('')
    setShowPasswordReset(false)
  }

  async function handlePasswordReset() {
    if (!email) {
      setError('Please enter your email address first.')
      return
    }
    setError('')
    setLoading(true)
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${window.location.origin}/login`,
      })
      if (error) throw error
      setMessage('Password reset link sent to your email. Click the link to set a new password.')
      setShowPasswordReset(false)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  async function handleSetPasswordAfterReset(e) {
    e.preventDefault()
    setError('')
    setLoading(true)

    if (newPassword !== confirmPassword) {
      setError('Passwords do not match.')
      setLoading(false)
      return
    }

    if (newPassword.length < 6) {
      setError('Password must be at least 6 characters.')
      setLoading(false)
      return
    }

    try {
      const { error } = await supabase.auth.updateUser({ password: newPassword })
      if (error) throw error
      setMessage('Password set successfully! Redirecting...')
      setTimeout(() => navigate(nextUrl, { replace: true }), 1500)
    } catch (err) {
      setError(err.message)
      setLoading(false)
    }
  }

  async function handleGoogleSignIn() {
    setError('')
    setLoading(true)
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: `${window.location.origin}/dashboard`, queryParams: { prompt: 'select_account' } },
    })
    if (error) {
      setError(error.message)
      setLoading(false)
    }
  }

  async function handleGitHubSignIn() {
    setError('')
    setLoading(true)
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'github',
      options: { redirectTo: `${window.location.origin}/dashboard`, scopes: 'repo' },
    })
    if (error) {
      setError(error.message)
      setLoading(false)
    }
  }

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    setMessage('')
    setLoading(true)
    try {
      if (tab === 'magic') {
        const { error } = await supabase.auth.signInWithOtp({
          email,
          options: { emailRedirectTo: `${window.location.origin}/dashboard` },
        })
        if (error) throw error
        setMessage('Magic link sent — check your inbox.')
      } else if (tab === 'signup') {
        const { error } = await supabase.auth.signUp({ email, password })
        if (error) {
          if (error.message?.includes('already registered') || error.message?.includes('User already exists')) {
            setError('This email is already registered. Sign in with your original method, or use password reset to set a new password and enable email login.')
            setShowPasswordReset(true)
            setLoading(false)
            return
          }
          throw error
        }
        setMessage('Check your email to confirm your account.')
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password })
        if (error) {
          if (error.message?.includes('Invalid login credentials')) {
            setError('Invalid email or password. If you signed up with Google or GitHub, you can set a password to enable email login.')
            setShowPasswordReset(true)
          } else {
            throw error
          }
          setLoading(false)
          return
        }
        navigate(nextUrl, { replace: true })
      }
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
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
        <p className="text-[13px] text-mute">Durable, human-shared, quality-gated state.</p>
      </div>

      {/* Google */}
      <div className="w-full max-w-sm mb-2">
        <button
          onClick={handleGoogleSignIn}
          disabled={loading}
          className="w-full h-10 flex items-center justify-center gap-2.5 bg-paper border border-line rounded-xl text-[13px] font-semibold text-ink hover:bg-surf-2 transition-colors disabled:opacity-40"
        >
          <svg width="16" height="16" viewBox="0 0 24 24">
            <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
            <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
            <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"/>
            <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
          </svg>
          Continue with Google
        </button>
      </div>

      {/* GitHub */}
      <div className="w-full max-w-sm mb-3">
        <button
          onClick={handleGitHubSignIn}
          disabled={loading}
          className="w-full h-10 flex items-center justify-center gap-2.5 bg-paper border border-line rounded-xl text-[13px] font-semibold text-ink hover:bg-surf-2 transition-colors disabled:opacity-40"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.111.82-.261.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/>
          </svg>
          Continue with GitHub
        </button>
      </div>

      <div className="w-full max-w-sm flex items-center gap-3 mb-3">
        <div className="flex-1 h-px bg-line-2" />
        <span className="text-[11px] text-mute-2">or</span>
        <div className="flex-1 h-px bg-line-2" />
      </div>

      {/* Card */}
      <div className="w-full max-w-sm bg-paper border border-line rounded-xl shadow-card overflow-hidden">

        {isSettingPasswordAfterReset ? (
          // Password update form
          <div className="p-6">
            <h2 className="text-[16px] font-semibold text-ink mb-4">Set Your Password</h2>
            <form onSubmit={handleSetPasswordAfterReset} className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <label className="text-[11px] font-semibold text-mute uppercase tracking-wider">New Password</label>
                <input
                  type="password"
                  value={newPassword}
                  onChange={e => setNewPassword(e.target.value)}
                  required
                  autoFocus
                  autoComplete="new-password"
                  placeholder="········"
                  className="w-full bg-surf-2 border border-line rounded-md px-3 py-2.5 text-[13px] text-ink outline-none focus:border-ink transition-colors placeholder:text-mute-2"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-[11px] font-semibold text-mute uppercase tracking-wider">Confirm Password</label>
                <input
                  type="password"
                  value={confirmPassword}
                  onChange={e => setConfirmPassword(e.target.value)}
                  required
                  autoComplete="new-password"
                  placeholder="········"
                  className="w-full bg-surf-2 border border-line rounded-md px-3 py-2.5 text-[13px] text-ink outline-none focus:border-ink transition-colors placeholder:text-mute-2"
                />
              </div>

              {error && <p className="text-[12px] text-red-500 -mt-1">{error}</p>}
              {message && <p className="text-[12px] font-medium -mt-1" style={{ color: '#D97757' }}>{message}</p>}

              <button
                type="submit"
                disabled={loading}
                className="w-full mt-1 h-10 bg-ink text-paper rounded-md text-[13px] font-semibold tracking-tight transition-all duration-150 hover:bg-ink-2 disabled:opacity-40 disabled:pointer-events-none"
              >
                {loading ? 'Setting password…' : 'Set Password'}
              </button>
            </form>
          </div>
        ) : (
          <>
            {/* Tabs */}
            <div className="flex border-b border-line-2">
              {TABS.map(t => (
                <button
                  key={t.id}
                  onClick={() => switchTab(t.id)}
                  className={`
                    flex-1 py-3 text-[12px] font-semibold tracking-tight transition-colors duration-150
                    ${tab === t.id
                      ? 'text-ink border-b-2 border-ink -mb-px bg-paper'
                      : 'text-mute hover:text-ink-2 bg-surf-2'
                    }
                  `}
                >
                  {t.label}
                </button>
              ))}
            </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="flex flex-col gap-4 p-6">
          <div className="flex flex-col gap-1.5">
            <label className="text-[11px] font-semibold text-mute uppercase tracking-wider">Email</label>
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              required
              autoFocus
              autoComplete="email"
              placeholder="you@example.com"
              className="w-full bg-surf-2 border border-line rounded-md px-3 py-2.5 text-[13px] text-ink outline-none focus:border-ink transition-colors placeholder:text-mute-2"
            />
          </div>

          {tab !== 'magic' && (
            <div className="flex flex-col gap-1.5">
              <label className="text-[11px] font-semibold text-mute uppercase tracking-wider">Password</label>
              <input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                required
                autoComplete={tab === 'signup' ? 'new-password' : 'current-password'}
                placeholder="········"
                className="w-full bg-surf-2 border border-line rounded-md px-3 py-2.5 text-[13px] text-ink outline-none focus:border-ink transition-colors placeholder:text-mute-2"
              />
            </div>
          )}

          {error && (
            <div className="flex flex-col gap-2">
              <p className="text-[12px] text-red-500 -mt-1">{error}</p>
              {showPasswordReset && (tab === 'signin' || tab === 'signup') && (
                <button
                  type="button"
                  onClick={handlePasswordReset}
                  disabled={loading}
                  className="w-full h-9 bg-surf-2 border border-line rounded-md text-[12px] font-semibold text-ink hover:bg-line transition-colors disabled:opacity-40"
                >
                  Send password reset link
                </button>
              )}
            </div>
          )}
          {message && <p className="text-[12px] font-medium -mt-1" style={{ color: '#D97757' }}>{message}</p>}

          <button
            type="submit"
            disabled={loading}
            className="w-full mt-1 h-10 bg-ink text-paper rounded-md text-[13px] font-semibold tracking-tight transition-all duration-150 hover:bg-ink-2 disabled:opacity-40 disabled:pointer-events-none"
          >
            {loading
              ? 'Please wait…'
              : tab === 'signup' ? 'Create account'
              : tab === 'magic'  ? 'Send magic link'
              : 'Sign in'
            }
          </button>
        </form>
          </>
        )}
      </div>
    </div>
  )
}
