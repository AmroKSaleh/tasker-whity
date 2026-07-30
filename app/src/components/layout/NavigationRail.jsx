import { useState, useRef, useEffect } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import GlobalSearch from './GlobalSearch'
import { DndContext, closestCenter, PointerSensor, useSensor, useSensors } from '@dnd-kit/core'
import { SortableContext, verticalListSortingStrategy, arrayMove, useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { supabase } from '../../lib/supabase'
import { useProjectStore } from '../../store/useProjectStore'
import { deleteProject, reorderProjects, updateProject } from '../../hooks/useProjects'
import { prefetchBoard, prefetchToday } from '../../lib/prefetch'
import NewProjectModal from './NewProjectModal'
import FeedbackModal from './FeedbackModal'

function SortableProjectItem({ tab, isActive, onNavigate, onDelete }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: tab.raw.id })
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.4 : 1 }}
      className="group/proj relative mb-0.5"
    >
      <button
        {...attributes}
        {...listeners}
        tabIndex={-1}
        style={{ cursor: 'grab', touchAction: 'none' }}
        className="absolute left-1 top-1/2 -translate-y-1/2 opacity-0 group-hover/proj:opacity-100 transition-opacity text-mute text-[11px] leading-none z-10 px-0.5"
      >
        ⠿
      </button>
      <button
        onClick={() => onNavigate(tab.path)}
        onMouseEnter={() => prefetchBoard(tab.raw.id)}
        className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-[13px] transition-colors pr-8 pl-6 ${
          isActive
            ? 'bg-paper border border-line text-ink font-semibold shadow-sm'
            : 'text-ink-2 hover:bg-surf-2'
        }`}
      >
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${isActive ? 'bg-ink' : 'bg-line'}`} />
        <span className="flex-1 text-left truncate">{tab.label}</span>
      </button>
      <button
        onClick={e => onDelete(e, tab.raw)}
        title="Delete project"
        className="btn-delete absolute right-1.5 top-1/2 -translate-y-1/2 opacity-0 group-hover/proj:opacity-100 transition-opacity"
      >
        ×
      </button>
    </div>
  )
}

function SortableSheetItem({ project, onDelete, onRename }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: project.id })
  const [name, setName] = useState(project.name || project.slug)

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.4 : 1 }}
      className="flex items-center gap-2 px-2 py-3 border-b border-line-2 last:border-b-0"
    >
      <button
        {...attributes}
        {...listeners}
        style={{ cursor: 'grab', touchAction: 'none' }}
        className="text-mute text-[16px] leading-none px-1.5 py-1 shrink-0"
      >
        ⠿
      </button>
      <input
        value={name}
        onChange={e => setName(e.target.value)}
        onBlur={() => {
          const trimmed = name.trim()
          if (trimmed && trimmed !== (project.name || project.slug)) onRename(project.id, trimmed)
        }}
        className="flex-1 text-[14px] text-ink bg-transparent border-b border-transparent focus:border-line outline-none py-0.5 transition-colors"
        style={{ minWidth: 0 }}
      />
      <button
        onClick={() => onDelete(project)}
        className="btn-delete shrink-0"
        title="Delete project"
      >
        ×
      </button>
    </div>
  )
}

export default function NavigationRail() {
  const navigate = useNavigate()
  const location = useLocation()
  const { projects } = useProjectStore()
  const [showModal, setShowModal] = useState(false)
  const [showReorder, setShowReorder] = useState(false)
  const [showSearch, setShowSearch] = useState(false)
  const [showFeedback, setShowFeedback] = useState(false)

  useEffect(() => {
    function onKey(e) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        setShowSearch(true)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  const longPressTimer = useRef(null)
  const longPressActive = useRef(false)

  const activeSlug = location.pathname.split('/dashboard/')[1] || ''
  const isToday = location.pathname === '/today'

  function handleCreated(proj) {
    setShowModal(false)
    if (proj) navigate(`/dashboard/${proj.slug}`)
  }

  async function handleDeleteProject(e, proj) {
    e.stopPropagation()
    if (!window.confirm(`Delete "${proj.name}" and all its tasks? This cannot be undone.`)) return
    if (activeSlug === proj.slug) navigate('/dashboard')
    await deleteProject(proj.id)
  }

  async function handleDeleteInSheet(proj) {
    if (!window.confirm(`Delete "${proj.name}" and all its tasks? This cannot be undone.`)) return
    setShowReorder(false)
    if (activeSlug === proj.slug) navigate('/dashboard')
    await deleteProject(proj.id)
  }

  async function handleRenameProject(id, newName) {
    await updateProject(id, { name: newName })
  }

  // Desktop DnD
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))

  function handleProjectDragEnd({ active, over }) {
    if (!over || active.id === over.id) return
    const oldIdx = projects.findIndex(p => p.id === active.id)
    const newIdx = projects.findIndex(p => p.id === over.id)
    if (oldIdx === -1 || newIdx === -1) return
    reorderProjects(arrayMove(projects, oldIdx, newIdx))
  }

  // Mobile sheet DnD
  const sheetSensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }))

  function handleSheetDragEnd({ active, over }) {
    if (!over || active.id === over.id) return
    const oldIdx = projects.findIndex(p => p.id === active.id)
    const newIdx = projects.findIndex(p => p.id === over.id)
    if (oldIdx === -1 || newIdx === -1) return
    reorderProjects(arrayMove(projects, oldIdx, newIdx))
  }

  // Long-press detection for mobile project tabs
  function handleLongPressStart() {
    longPressActive.current = false
    longPressTimer.current = setTimeout(() => {
      longPressActive.current = true
      setShowReorder(true)
    }, 500)
  }

  function handleLongPressEnd() {
    clearTimeout(longPressTimer.current)
  }

  function handleMobileProjectClick(path) {
    if (longPressActive.current) {
      longPressActive.current = false
      return
    }
    navigate(path)
  }

  const tabs = projects.map(p => ({
    slug: p.slug,
    label: p.name || p.slug?.replace(/-/g, ' '),
    path: `/dashboard/${p.slug}`,
    raw: p,
  }))

  return (
    <>
      {/* Mobile bottom nav */}
      <div className="md:hidden fixed bottom-0 left-0 right-0 z-40 bg-paper border-t border-line-2" style={{ scrollbarWidth: 'none' }}>
        <div className="flex overflow-x-auto" style={{ scrollbarWidth: 'none' }}>
          {/* Today tab */}
          <button
            onClick={() => navigate('/today')}
            onMouseEnter={prefetchToday}
            style={{ borderTop: isToday ? '2px solid var(--color-ink)' : '2px solid transparent', marginTop: -1 }}
            className={`flex flex-col items-center justify-center shrink-0 min-w-[64px] min-h-[56px] py-3.5 px-2 transition-colors ${
              isToday ? 'text-ink' : 'text-mute-2'
            }`}
          >
            <span className="font-mono text-[8.5px] font-bold tracking-widest uppercase">Today</span>
          </button>
          <div style={{ width: 1, background: 'var(--color-line-2)', alignSelf: 'stretch', margin: '10px 0', flexShrink: 0 }} />
          {tabs.flatMap((tab, i) => {
            const isActive = activeSlug === tab.slug
            const btn = (
              <button
                key={tab.slug}
                onPointerDown={handleLongPressStart}
                onPointerUp={handleLongPressEnd}
                onPointerCancel={handleLongPressEnd}
                onClick={() => handleMobileProjectClick(tab.path)}
                onMouseEnter={() => prefetchBoard(tab.raw.id)}
                style={{ borderTop: isActive ? '2px solid var(--color-ink)' : '2px solid transparent', marginTop: -1 }}
                className={`flex flex-col items-center justify-center shrink-0 min-w-[72px] min-h-[56px] py-3.5 px-2 transition-colors ${
                  isActive ? 'text-ink' : 'text-mute-2'
                }`}
              >
                <span className="font-mono text-[8.5px] font-bold tracking-widest uppercase truncate max-w-[64px] text-center leading-tight">
                  {tab.label}
                </span>
              </button>
            )
            if (i === 0) return [btn]
            return [
              <div key={`sep-${i}`} style={{ width: 1, background: 'var(--color-line-2)', alignSelf: 'stretch', margin: '10px 0', flexShrink: 0 }} />,
              btn,
            ]
          })}
          <button
            onClick={() => setShowSearch(true)}
            style={{ borderTop: '2px solid transparent', marginTop: -1 }}
            className="flex flex-col items-center justify-center shrink-0 min-w-[56px] min-h-[56px] py-3.5 px-2 border-l border-line-2 text-mute-2"
          >
            <span className="font-mono text-[8.5px] font-bold tracking-widest uppercase">⌕</span>
          </button>
          <button
            onClick={() => navigate('/settings')}
            style={{ borderTop: location.pathname === '/settings' ? '2px solid var(--color-ink)' : '2px solid transparent', marginTop: -1 }}
            className={`flex flex-col items-center justify-center shrink-0 min-w-[56px] min-h-[56px] py-3.5 px-2 border-l border-line-2 transition-colors ${
              location.pathname === '/settings' ? 'text-ink' : 'text-mute-2'
            }`}
          >
            <span className="font-mono text-[8.5px] font-bold tracking-widest uppercase">⚙</span>
          </button>
          <button
            onClick={() => setShowModal(true)}
            className="flex flex-col items-center justify-center shrink-0 min-w-[56px] min-h-[56px] py-3.5 px-2 text-mute-2 border-l border-line-2"
          >
            <span className="text-base leading-none">+</span>
          </button>
        </div>
      </div>

      {/* Mobile reorder bottom sheet */}
      {showReorder && (
        <div className="md:hidden fixed inset-0 z-50 flex flex-col justify-end">
          <div className="fixed inset-0 bg-black/40" onClick={() => setShowReorder(false)} />
          <div className="relative bg-paper rounded-t-2xl shadow-xl" style={{ maxHeight: '70vh', overflowY: 'auto' }}>
            <div className="flex items-center justify-between px-5 pt-5 pb-3 border-b border-line-2">
              <p className="text-[14px] font-semibold text-ink">Manage Projects</p>
              <button
                onClick={() => setShowReorder(false)}
                className="px-3 py-1 rounded-lg bg-ink text-paper text-[12px] font-medium"
              >
                Done
              </button>
            </div>
            <div className="px-3 py-2">
              <DndContext sensors={sheetSensors} collisionDetection={closestCenter} onDragEnd={handleSheetDragEnd}>
                <SortableContext items={projects.map(p => p.id)} strategy={verticalListSortingStrategy}>
                  {projects.map(p => (
                    <SortableSheetItem
                      key={p.id}
                      project={p}
                      onDelete={handleDeleteInSheet}
                      onRename={handleRenameProject}
                    />
                  ))}
                </SortableContext>
              </DndContext>
            </div>
            <div className="h-6" />
          </div>
        </div>
      )}

      {/* Desktop sidebar */}
      <nav className="hidden md:flex flex-col w-52 h-screen sticky top-0 shrink-0 border-r border-line-2 pt-5 pb-4" style={{ background: 'var(--color-surf-2)' }}>

        {/* Wordmark */}
        <button
          onClick={() => navigate('/home')}
          className="px-4 mb-6 shrink-0 flex items-center gap-2 hover:opacity-70 transition-opacity"
        >
          <span style={{ color: '#D97757', fontSize: 14, fontWeight: 700 }}>✦</span>
          <span className="text-[15px] font-extrabold text-ink tracking-tight">Tasker</span>
        </button>

        {/* Search */}
        <div className="px-2 mb-1">
          <button
            onClick={() => setShowSearch(true)}
            className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-[13px] text-mute hover:bg-surf-2 transition-colors"
          >
            <span className="text-[11px]">⌕</span>
            <span>Search</span>
            <span className="ml-auto font-mono text-[10px] text-mute-2">⌘K</span>
          </button>
        </div>

        {/* Today */}
        <div className="px-2 mb-3">
          <button
            onClick={() => navigate('/today')}
            onMouseEnter={prefetchToday}
            className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-[13px] transition-colors ${
              isToday
                ? 'bg-paper border border-line text-ink font-semibold shadow-sm'
                : 'text-ink-2 hover:bg-surf-2'
            }`}
          >
            <span className="text-[11px]">◎</span>
            <span>Today</span>
          </button>
        </div>

        {/* Projects */}
        <div className="flex-1 overflow-y-auto px-2 min-h-0">
          <div className="font-mono text-[9px] font-bold tracking-widest text-mute-2 uppercase px-2 mb-2">
            Projects
          </div>

          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleProjectDragEnd}>
            <SortableContext items={projects.map(p => p.id)} strategy={verticalListSortingStrategy}>
              {tabs.map(tab => (
                <SortableProjectItem
                  key={tab.slug}
                  tab={tab}
                  isActive={activeSlug === tab.slug}
                  onNavigate={navigate}
                  onDelete={handleDeleteProject}
                />
              ))}
            </SortableContext>
          </DndContext>

          <button
            onClick={() => setShowModal(true)}
            className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-[13px] text-mute hover:bg-surf-2 transition-colors mt-1"
          >
            <span>+</span>
            <span>New project</span>
          </button>
        </div>

        {/* Settings + Sign out */}
        <div className="px-2 pt-3 border-t border-line-2 shrink-0 flex flex-col gap-0.5">
          <button
            onClick={() => navigate('/settings')}
            className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-[13px] transition-colors ${
              location.pathname === '/settings'
                ? 'bg-paper border border-line text-ink font-semibold shadow-sm'
                : 'text-mute hover:bg-surf-2'
            }`}
          >
            <span>⚙</span>
            <span>Settings</span>
          </button>
          <button
            onClick={() => setShowFeedback(true)}
            className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-[13px] text-mute hover:bg-surf-2 transition-colors"
          >
            <span>✉</span>
            <span>Feedback and Suggestions</span>
          </button>
          <button
            onClick={() => supabase.auth.signOut()}
            className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-[13px] text-mute hover:bg-surf-2 transition-colors"
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

      {showSearch && (
        <GlobalSearch onClose={() => setShowSearch(false)} />
      )}
      {showFeedback && (
        <FeedbackModal onClose={() => setShowFeedback(false)} />
      )}
    </>
  )
}
