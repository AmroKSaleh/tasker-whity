import { Navigate, useLocation } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import NavigationRail from '../components/layout/NavigationRail'
import ProjectPanel from '../components/projects/ProjectPanel'
import { useProjects } from '../hooks/useProjects'

export default function DashboardPage() {
  const location = useLocation()
  const projects = useProjects()

  const tabName = location.pathname.split('/').filter(Boolean).pop()

  // Root dashboard: redirect to first project or show empty state
  if (!tabName || tabName === 'dashboard') {
    if (projects.length > 0) {
      return <Navigate to={`/dashboard/${projects[0].name}`} replace />
    }
    return (
      <div className="flex min-h-screen bg-surface">
        <NavigationRail />
        <main className="flex-1 flex flex-col min-h-screen pb-16 md:pb-0">
          <header className="md:hidden flex items-center justify-between px-4 h-14 bg-surface-container-low border-b border-outline-variant shrink-0">
            <span className="text-title-large font-medium text-on-surface">Tasker v0.2.2</span>
            <button onClick={() => supabase.auth.signOut()} className="text-label-medium text-on-surface-variant hover:text-on-surface transition-colors px-2 py-1">
              Sign out
            </button>
          </header>
          <div className="flex-1 flex items-center justify-center p-8 text-center">
            <div>
              <p className="text-[15px] font-semibold text-ink mb-1">No projects yet</p>
              <p className="text-[13px] text-mute">Use the + button in the sidebar to create your first project.</p>
            </div>
          </div>
        </main>
      </div>
    )
  }

  const project = projects.find(p => p.name === tabName)

  return (
    <div className="flex min-h-screen bg-surface">
      <NavigationRail />

      <main className="flex-1 flex flex-col min-h-screen overflow-y-auto pb-16 md:pb-0">
        {/* Mobile header */}
        <header className="md:hidden flex items-center justify-between px-4 h-14 bg-surface-container-low border-b border-outline-variant shrink-0">
          <span className="text-title-large font-medium text-on-surface">Tasker v0.2.2</span>
          <button
            onClick={() => supabase.auth.signOut()}
            className="text-label-medium text-on-surface-variant hover:text-on-surface transition-colors px-2 py-1"
          >
            Sign out
          </button>
        </header>

        {project
          ? <ProjectPanel project={project} />
          : (
            <div className="flex-1 flex flex-col items-center justify-center p-8 text-center">
              <div className="max-w-sm">
                <p className="text-display-small mb-3">◎</p>
                <p className="text-headline-small font-medium text-on-surface mb-2 capitalize">{tabName}</p>
                <p className="text-body-medium text-on-surface-variant">Project not found.</p>
              </div>
            </div>
          )
        }
      </main>
    </div>
  )
}
