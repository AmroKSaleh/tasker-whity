import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { syncSettingsFromSupabase } from '../../lib/aiSettings'
import { syncBrowserTimezone } from '../../lib/timezone'
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
          syncBrowserTimezone().catch(() => {})
          // A pending org invite survives any login method (incl. OAuth, which lands on /dashboard).
          const pendingInvite = localStorage.getItem('tasker.pendingInvite')
          if (pendingInvite) {
            localStorage.removeItem('tasker.pendingInvite')
            navigate(`/invite/${pendingInvite}`, { replace: true })
            return
          }
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
