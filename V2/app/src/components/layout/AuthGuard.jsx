import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { syncSettingsFromSupabase } from '../../lib/aiSettings'
import { saveGitHubToken } from '../../lib/github'

export default function AuthGuard({ children }) {
  const navigate = useNavigate()
  const [checking, setChecking] = useState(true)

  async function captureGitHubToken(session) {
    if (session?.provider_token && session.user?.id) {
      await saveGitHubToken(session.user.id, session.provider_token).catch(() => {})
    }
  }

  useEffect(() => {
    supabase.auth.getSession()
      .then(({ data: { session } }) => {
        if (!session) navigate('/login', { replace: true })
        else {
          captureGitHubToken(session).catch(() => {})
          syncSettingsFromSupabase().catch(() => {})
          setChecking(false)
        }
      })
      .catch(() => navigate('/login', { replace: true }))

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (!session) { navigate('/login', { replace: true }); return }
      captureGitHubToken(session).catch(() => {})
    })

    return () => subscription.unsubscribe()
  }, [navigate])

  if (checking) return null

  return children
}
