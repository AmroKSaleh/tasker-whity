import { useState } from 'react'
import { listPings, createPing, login } from '../api/pings'

/**
 * Temporary end-to-end check: log in with the seeded admin, create a ping,
 * and list them back — proving migration → route → cookie auth → SPA.
 * Removed once the real board lands.
 */
export default function PingCheck() {
  const [pings, setPings] = useState([])
  const [status, setStatus] = useState('idle')
  const [error, setError] = useState(null)

  async function runCheck() {
    setStatus('running')
    setError(null)
    try {
      await login('admin@example.com', 'admin123')
      await createPing(`from the SPA at ${new Date().toISOString()}`)
      setPings(await listPings())
      setStatus('ok')
    } catch (e) {
      setError(`${e.name} ${e.status ?? ''}: ${e.message}`)
      setStatus('failed')
    }
  }

  return (
    <div style={{ padding: 24, fontFamily: 'monospace' }}>
      <h1>Tasker host check</h1>
      <button onClick={runCheck}>Run end-to-end check</button>
      <p>Status: {status}</p>
      {error && <pre style={{ color: '#C0432D' }}>{error}</pre>}
      <ul>
        {pings.map((p) => (
          <li key={p.id}>
            #{p.id} tenant {p.tenantId} — {p.label}
          </li>
        ))}
      </ul>
    </div>
  )
}
