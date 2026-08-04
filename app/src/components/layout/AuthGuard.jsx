import { Navigate } from 'react-router-dom'
import { useSession } from '../../auth/SessionProvider'

/**
 * Renders children only for an authenticated session. The server enforces
 * access on every request; this prevents rendering a shell that cannot load.
 */
export default function AuthGuard({ children }) {
  const { status } = useSession()

  if (status === 'loading') {
    return null
  }

  if (status === 'anonymous') {
    return <Navigate to="/login" replace />
  }

  return children
}
