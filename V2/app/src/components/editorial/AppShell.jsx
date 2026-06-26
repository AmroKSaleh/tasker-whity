import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import clsx from 'clsx'
import { Home, Folder, Workflow, Calendar, Search, BookOpen, Settings } from 'lucide-react'
import { useSidebarStore } from '../../store/useSidebarStore'
import { useConnectedProviders } from '../../hooks/useConnectedProviders'
import { useParkedCounts } from '../../hooks/useParkedCounts'
import { CONNECTORS } from '../../lib/connectors'
import GlobalSearch from '../search/GlobalSearch'

function RailButton({ icon: Icon, label, active, expanded, onClick, badge }) {
  return (
    <button
      onClick={onClick}
      title={badge ? `${label} · ${badge} parked` : label}
      className={clsx(
        'flex items-center h-9 rounded-md transition-colors w-full',
        active ? 'bg-surf text-ink' : 'text-mute hover:text-ink hover:bg-surf-2',
      )}
    >
      <span className="relative w-14 flex items-center justify-center shrink-0">
        <Icon size={15} />
        {badge > 0 && (
          <span className="absolute top-0.5 right-3 min-w-[15px] h-[15px] px-1 rounded-full bg-accent text-paper text-[9px] font-semibold flex items-center justify-center leading-none">{badge}</span>
        )}
      </span>
      <span className={clsx('text-[12px] font-medium whitespace-nowrap transition-opacity flex-1', expanded ? 'opacity-100' : 'opacity-0')}>{label}</span>
      {expanded && badge > 0 && <span className="mr-3 text-[10px] font-mono text-accent">{badge}</span>}
    </button>
  )
}

// Left icon rail shared by all authenticated surfaces. Collapsed to 56px;
// expands to 200px on hover (as an overlay, so it doesn't reflow content).
// Expanded state is held in a shared store so it persists across navigation
// (the rail remounts on route change, which would otherwise reset CSS :hover).
// `active` ∈ 'today' | 'projects' | 'calendar' | 'search' | 'inbox' | 'settings'
export default function AppShell({ active, rightRail, children, hideSidebar }) {
  const navigate = useNavigate()
  const expanded = useSidebarStore(s => s.expanded)
  const setExpanded = useSidebarStore(s => s.setExpanded)
  const connectedIds = useConnectedProviders()
  const parkedCounts = useParkedCounts()
  const panelConnectors = CONNECTORS.filter(c => c.panelRoute && connectedIds.includes(c.id))
  const [searchOpen, setSearchOpen] = useState(false)

  // ⌘K / Ctrl-K opens global task search from anywhere.
  useEffect(() => {
    function onKey(e) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setSearchOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div className="w-full h-screen flex overflow-hidden bg-paper text-ink">
      {/* LEFT RAIL — 56px footprint, hover-expands as an overlay */}
      {!hideSidebar && (
        <aside className="relative w-14 shrink-0">
          <div
            onMouseEnter={() => setExpanded(true)}
            onMouseLeave={() => setExpanded(false)}
            className={clsx(
              'absolute inset-y-0 left-0 z-40 bg-paper border-r border-line-2 overflow-hidden transition-[width] duration-150 flex flex-col py-3.5',
              expanded ? 'w-[200px]' : 'w-14',
            )}
          >
            <div className="flex flex-col gap-0.5">
            <RailButton icon={Home}     label="Today"    active={active === 'today'}    expanded={expanded} onClick={() => navigate('/home')} />
            <RailButton icon={Folder}   label="Projects" active={active === 'projects'} expanded={expanded} onClick={() => navigate('/projects')} />
            <RailButton icon={Workflow} label="Flows"    active={active === 'flows'}    expanded={expanded} onClick={() => navigate('/flows')} />
            <RailButton icon={Calendar} label="Calendar" active={active === 'calendar'} expanded={expanded} />
            <RailButton icon={Search}   label="Search"   active={active === 'search'}   expanded={expanded} onClick={() => setSearchOpen(true)} />
          </div>
          {panelConnectors.length > 0 && (
            <div className="flex flex-col gap-0.5 mt-1 pt-1 border-t border-line-2">
              {panelConnectors.map(c => (
                <RailButton key={c.id} icon={c.icon} label={c.label} active={active === c.id} expanded={expanded} badge={parkedCounts[c.id]} onClick={() => navigate(c.panelRoute)} />
              ))}
            </div>
          )}
          <div className="flex-1" />
          <div className="flex flex-col gap-0.5">
            <RailButton icon={BookOpen} label="Docs"     active={active === 'docs'}     expanded={expanded} onClick={() => navigate('/docs')} />
            <RailButton icon={Settings} label="Settings" active={active === 'settings'} expanded={expanded} onClick={() => navigate('/settings')} />
          </div>
        </div>
        </aside>
      )}

      {/* MAIN */}
      <main className="flex-1 min-w-0 overflow-auto relative no-scrollbar">
        {children}
      </main>

      {/* RIGHT RAIL */}
      {rightRail}

      <GlobalSearch open={searchOpen} onClose={() => setSearchOpen(false)} />
    </div>
  )
}
