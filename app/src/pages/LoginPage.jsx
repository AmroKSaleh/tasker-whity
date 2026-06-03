import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import Button from '../components/ui/Button'
import Card from '../components/ui/Card'
import Input from '../components/ui/Input'

export default function LoginPage() {
  const navigate = useNavigate()
  const [mode, setMode] = useState('signin') // 'signin' | 'signup' | 'magic'
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')

  async function handleEmailAuth(e) {
    e.preventDefault()
    setError('')
    setMessage('')
    setLoading(true)
    try {
      if (mode === 'signup') {
        const { error } = await supabase.auth.signUp({ email, password })
        if (error) throw error
        setMessage('Check your email to confirm your account.')
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password })
        if (error) throw error
        navigate('/dashboard', { replace: true })
      }
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  async function handleMagicLink(e) {
    e.preventDefault()
    setError('')
    setMessage('')
    setLoading(true)
    try {
      const { error } = await supabase.auth.signInWithOtp({
        email,
        options: { emailRedirectTo: `${window.location.origin}/dashboard` },
      })
      if (error) throw error
      setMessage('Magic link sent — check your inbox.')
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-surface flex flex-col items-center justify-center p-6">
      {/* Wordmark */}
      <div className="mb-8 text-center">
        <h1 className="text-headline-medium font-medium text-on-surface tracking-tight">Tasker v0.2.2</h1>
        <p className="text-body-medium text-on-surface-variant mt-1">Your focus, decided.</p>
      </div>

      <Card elevation="low" className="w-full max-w-sm p-6 border border-outline-variant">
        {/* Mode tabs */}
        <div className="flex gap-0 border-b border-outline-variant mb-6">
          {[
            { id: 'signin',  label: 'Sign in' },
            { id: 'signup',  label: 'Sign up' },
            { id: 'magic',   label: 'Magic link' },
          ].map(tab => (
            <button
              key={tab.id}
              onClick={() => { setMode(tab.id); setError(''); setMessage('') }}
              className={`
                flex-1 pb-3 text-label-large font-medium border-b-2 -mb-px transition-colors duration-150
                ${mode === tab.id
                  ? 'text-primary border-primary'
                  : 'text-on-surface-variant border-transparent hover:text-on-surface'
                }
              `}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <form onSubmit={mode === 'magic' ? handleMagicLink : handleEmailAuth} className="flex flex-col gap-4">
          <Input
            label="Email"
            type="email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            required
            autoComplete="email"
            autoFocus
          />

          {mode !== 'magic' && (
            <Input
              label="Password"
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              required
              autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
            />
          )}

          {error && (
            <p className="text-body-small text-error px-1">{error}</p>
          )}
          {message && (
            <p className="text-body-small text-primary px-1">{message}</p>
          )}

          <Button
            type="submit"
            variant="filled"
            disabled={loading}
            className="w-full mt-2"
          >
            {loading ? 'Please wait…' : mode === 'signup' ? 'Create account' : mode === 'magic' ? 'Send magic link' : 'Sign in'}
          </Button>
        </form>
      </Card>
    </div>
  )
}
