import { useEffect, useState } from 'react'
import { getSsoProviders, startSsoUrl } from '../../api/auth'

/**
 * One sign-in link per configured identity provider.
 *
 * Renders nothing when no providers exist or the lookup fails: SSO is optional
 * configuration, so its absence must never block password login.
 */
export default function SsoButtons() {
  const [providers, setProviders] = useState([])

  useEffect(() => {
    let cancelled = false
    getSsoProviders()
      .then((list) => { if (!cancelled) setProviders(list) })
      .catch(() => { if (!cancelled) setProviders([]) })
    return () => { cancelled = true }
  }, [])

  if (providers.length === 0) {
    return null
  }

  return (
    <div>
      {providers.map((p) => (
        <a key={p.id} href={startSsoUrl(p.id)}>
          Continue with {p.name}
        </a>
      ))}
    </div>
  )
}
