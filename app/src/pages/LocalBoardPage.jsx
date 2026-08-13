/**
 * Single-project board for local mode (npx tasker).
 *
 * No auth, no routing, no project picker — there is exactly one project
 * (the repo's .tasker/) and we go straight to the board.
 */

import { MemoryRouter }     from 'react-router-dom'
import { useLocalProject } from '../hooks/useLocalProject'
import ProjectBoard        from '../components/board/ProjectBoard'

export default function LocalBoardPage() {
  const { project, loading, error } = useLocalProject()

  if (loading) return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      height: '100vh', fontFamily: 'monospace', fontSize: 13,
      color: 'var(--color-mute, #6B6867)',
      background: 'var(--color-paper, #FBFAF6)',
    }}>
      Loading .tasker/…
    </div>
  )

  if (error) return (
    <div style={{
      padding: 32, fontFamily: 'monospace', fontSize: 13,
      color: '#C0432D', background: 'var(--color-paper, #FBFAF6)',
    }}>
      <strong>Tasker error:</strong> {error}
      <br /><br />
      Make sure the local server is running (<code>npx tasker</code>) and
      the .tasker/ directory is valid.
    </div>
  )

  if (!project) return null

  // MemoryRouter gives router context to ProjectBoard (useLocation, Link, etc.)
  // without touching the browser URL — local mode has no routing.
  return (
    <MemoryRouter>
      <ProjectBoard project={project} />
    </MemoryRouter>
  )
}
