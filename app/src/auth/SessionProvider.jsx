import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { getMe, getCapabilities, logout as logoutRequest } from '../api/auth'
import { setUnauthorizedHandler } from '../api/client'

const SessionContext = createContext(null)

/**
 * Holds the signed-in profile and permission slugs for the whole app.
 *
 * Capabilities gate navigation FAIL-CLOSED: can() is false unless the slug is
 * present. Route-level RBAC on the server is the real enforcement; this only
 * decides what to show, so being wrong here must hide, never reveal.
 */
export function SessionProvider({ children }) {
  const [status, setStatus] = useState('loading')
  const [user, setUser] = useState(null)
  const [capabilities, setCapabilities] = useState([])

  const refresh = useCallback(async () => {
    try {
      const profile = await getMe()
      setUser(profile)
      setCapabilities(await getCapabilities())
      setStatus('authenticated')
    } catch {
      setUser(null)
      setCapabilities([])
      setStatus('anonymous')
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  // A 401 that survived apiFetch's refresh attempt means the session is gone.
  useEffect(() => {
    setUnauthorizedHandler(() => {
      setUser(null)
      setCapabilities([])
      setStatus('anonymous')
    })
    return () => setUnauthorizedHandler(null)
  }, [])

  const signOut = useCallback(async () => {
    try {
      await logoutRequest()
    } finally {
      setUser(null)
      setCapabilities([])
      setStatus('anonymous')
    }
  }, [])

  const value = useMemo(
    () => ({
      status,
      user,
      capabilities,
      can: (slug) => capabilities.includes(slug),
      refresh,
      signOut,
    }),
    [status, user, capabilities, refresh, signOut],
  )

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
}

/**
 * Access the session. Throws when used outside SessionProvider, which is a
 * developer error rather than a runtime condition.
 */
export function useSession() {
  const context = useContext(SessionContext)
  if (context === null) {
    throw new Error('useSession must be used inside a SessionProvider')
  }
  return context
}
