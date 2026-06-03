import { useState } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { useProjectStore } from '../../store/useProjectStore'
import { deleteProject } from '../../hooks/useProjects'
import NewProjectModal from './NewProjectModal'

export default function NavigationRail() {
  const navigate = useNavigate()
  const location = useLocation()
  const { projects } = useProjectStore()
  const [showModal, setShowModal] = useState(false)

  const activeSlug = location.pathname.split('/dashboard/')[1] || ''

  async function handleSignOut() {
    await supabase.auth.signOut()
  }

  function handleCreated(proj) {
    setShowModal(false)
    if (proj) navigate(`/dashboard/${proj.name}`)
  }

  async function handleDeleteProject(e, proj) {
    e.stopPropagation()
    if (!window.confirm(`Delete "${proj.description || proj.name}" and all its tasks? This cannot be undone.`)) return
    if (activeSlug === proj.name) navigate('/dashboard')
    await deleteProject(proj.id)
  }

  const projectTabs = projects.map(p => ({
    id: p.name,
    label: p.description || p.name.replace(/-/g, ' '),
    path: `/dashboard/${p.name}`,
    raw: p,
  }))

  return (
    <>
      {/* Mobile bottom nav */}
      <div className="md:hidden fixed bottom-0 left-0 right-0 z-40 bg-paper border-t border-line-2" style={{ scrollbarWidth: 'none' }}>
        <div className="flex overflow-x-auto" style={{ scrollbarWidth: 'none' }}>
          {projectTabs.flatMap((tab, i) => {
            const isActive = activeSlug === tab.id
            const button = (
              <button
                key={tab.id}
                onClick={() => navigate(tab.path)}
                style={{ borderTop: isActive ? '2px solid #111' : '2px solid transparent', marginTop: -1 }}
                className={`flex flex-col items-center justify-center shrink-0 min-w-[72px] min-h-[56px] py-3.5 px-2 gap-0.5 transition-colors ${
                  isActive ? 'text-ink' : 'text-mute-2'
                }`}
              >
                <span className="font-mono text-[8.5px] font-bold tracking-widest uppercase truncate max-w-[64px] text-center leading-tight">
                  {tab.label}
                </span>
              </button>
            )
            if (i === 0) return [button]
            return [
              <div key={`sep-${i}`} style={{ width: 1, background: '#e6e6e6', alignSelf: 'stretch', margin: '10px 0', flexShrink: 0 }} />,
              button,
            ]
          })}
          <button
            onClick={() => setShowModal(true)}
            className="flex flex-col items-center justify-center shrink-0 min-w-[56px] min-h-[56px] py-3.5 px-2 text-mute-2 border-l border-line-2"
          >
            <span className="text-base leading-none">+</span>
          </button>
        </div>
      </div>

      {/* Desktop sidebar */}
      <nav className="hidden md:flex flex-col w-56 h-screen sticky top-0 shrink-0 bg-surf-2 border-r border-line-2 pt-5 pb-4">

        {/* App title */}
        <div className="px-4 mb-5 shrink-0">
          <div className="text-[16px] font-extrabold text-ink tracking-tight">Tasker v0.2.2</div>
          <div className="font-mono text-[10px] text-mute mt-0.5">workspace · personal</div>
        </div>

        {/* Projects */}
        <div className="flex-1 overflow-y-auto px-2 min-h-0">
          <div className="font-mono text-[9px] font-bold tracking-widest text-mute-2 uppercase px-3 mb-2">
            Projects
          </div>

          {projectTabs.map(tab => {
            const isActive = activeSlug === tab.id
            return (
              <div key={tab.id} className="group/proj relative mb-0.5">
                <button
                  onClick={() => navigate(tab.path)}
                  className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-md text-[13px] transition-colors pr-8 ${
                    isActive
                      ? 'bg-paper border border-line text-ink font-semibold'
                      : 'text-ink-2 hover:bg-surf'
                  }`}
                >
                  <span className={`w-1.5 h-1.5 rounded-full shrink-0 transition-colors ${isActive ? 'bg-ink' : 'bg-line'}`} />
                  <span className="flex-1 text-left truncate">{tab.label}</span>
                </button>
                <button
                  onClick={e => handleDeleteProject(e, tab.raw)}
                  title="Delete project"
                  className="btn-delete absolute right-1.5 top-1/2 -translate-y-1/2 opacity-0 group-hover/proj:opacity-100 transition-opacity"
                >
                  ×
                </button>
              </div>
            )
          })}

          <button
            onClick={() => setShowModal(true)}
            className="w-full flex items-center gap-2 px-3 py-2 rounded-md text-[13px] text-mute hover:bg-surf transition-colors mt-1"
          >
            <span>+</span>
            <span>New project</span>
          </button>
        </div>

        {/* Sign out */}
        <div className="px-2 pt-3 border-t border-line-2 shrink-0">
          <button
            onClick={handleSignOut}
            className="w-full flex items-center gap-2 px-3 py-2 rounded-md text-[13px] text-mute hover:bg-surf transition-colors"
          >
            <span>⇠</span>
            <span>Sign out</span>
          </button>
        </div>
      </nav>

      {showModal && (
        <NewProjectModal
          onClose={() => setShowModal(false)}
          onCreated={handleCreated}
        />
      )}
    </>
  )
}
