import { useRef, useMemo, useState, useCallback, useEffect } from 'react'
import clsx from 'clsx'
import { Star, Play, Pause, X, GripVertical, MoreHorizontal, AlertTriangle, Trash2, ChevronLeft } from 'lucide-react'
import {
  DndContext, DragOverlay, PointerSensor, KeyboardSensor,
  closestCenter, useSensor, useSensors, useDroppable,
} from '@dnd-kit/core'
import { SortableContext, useSortable, verticalListSortingStrategy, horizontalListSortingStrategy, arrayMove } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { useProjectMilestones } from '../../hooks/useProjectMilestones'
import { useTasks } from '../../hooks/useTasks'
import { useToggleInProgressWithWarning } from '../../hooks/useToggleInProgressWithWarning'
import FlowBlockedDialog from './DependencyWarningDialog'
import { scanProjectFlags } from '../../lib/gemini'
import { useIsDesktop } from './hooks/useMediaQuery'
import { useTaskPanelState } from './hooks/useTaskPanelState'
import { useHorizontalWheelScroll } from './hooks/useHorizontalWheelScroll'
import { updateProject } from '../../hooks/useProjects'
import { useEnvironmentStore } from '../../store/useEnvironmentStore'
import { useGoogleCalendar } from '../../hooks/useGoogleCalendar'
import { useGitHub } from '../../hooks/useGitHub'
import AppShell from '../editorial/AppShell'
import { Kicker, Pill } from '../editorial/atoms'
import { detectFlows } from '../../lib/flowGraph'
import AddTaskInline from './AddTaskInline'
import TaskDetailSheet from './TaskDetailSheet'
import TaskDetailPanel from './TaskDetailPanel'
// import FocusOverlay from '../focus/FocusOverlay' — DISABLED 2026-07-02 (TDE-351)
import KnowledgeBaseModal from '../kb/KnowledgeBaseModal'
import InstructionSetModal from '../is/InstructionSetModal'
import CreateTaskModal from './CreateTaskModal'
import ProjectFilesModal from './ProjectFilesModal'
import AgentQueuePanel from './AgentQueuePanel'
import ProjectContextPanel from './ProjectContextPanel'
import SectionContextSidebar from './SectionContextSidebar'
import FrontPage, { MastheadSky } from './FrontPage'
import BlueprintView from './BlueprintView'

function matchFilter(t, statusFilter, priorityFilter) {
  const statusOk = statusFilter === 'all' ||
    (statusFilter === 'pending' && t.status !== 'done') ||
    (statusFilter === 'done' && t.status === 'done')
  const priorityOk = !priorityFilter || t.priority === priorityFilter
  return statusOk && priorityOk
}

function dueLabel(due_date) {
  if (!due_date) return null
  return new Date(due_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }).toUpperCase()
}

// ── Editorial board card ──
function BoardCard({ task, prefix, onOpen, onToggle, onToggleIP, onFocus, onPin, onDelete }) {
  const done = task.status === 'done'
  const ip = task.status === 'in_progress'
  const seed = task.kind === 'seed'
  const prio = task.priority === 'medium' ? 'med' : task.priority
  // Terminal "AI gave up, needs you" state (TDE-348): the task-level judge escalated
  // to a human after exhausting its self-revision budget. A non-escalated fail is just
  // the AI retrying (status in_progress) and is NOT surfaced loud.
  const needsReview = !!task.review_verdict?.escalated
  const reviewReason = needsReview
    ? (task.review_verdict.results?.find(r => r.status === 'fail')?.note || task.review_verdict.critique || null)
    : null
  const [copiedId, setCopiedId] = useState(false)
  const copyShortId = e => {
    e.stopPropagation()
    navigator.clipboard?.writeText(`${prefix}-${task.short_id}`)
    setCopiedId(true)
    setTimeout(() => setCopiedId(false), 1200)
  }
  return (
    <div
      onClick={() => onOpen(task.id)}
      className={clsx(
        'group relative rounded-xl border px-3 py-2.5 cursor-pointer transition-all duration-150',
        needsReview ? 'border-review/40 bg-review-soft hover:border-review' : seed ? 'border-dashed border-accent/50 bg-accent/[0.03] hover:border-accent' : done ? 'border-line-2 bg-paper opacity-55' : 'border-line-2 bg-paper shadow-sm hover:border-line hover:shadow-card hover:-translate-y-[1px]',
      )}
    >
      {needsReview
        ? <span className="absolute left-[-1px] top-1.5 bottom-1.5 w-[3px] bg-review rounded-sm" />
        : ip && <span className="absolute left-[-1px] top-2 bottom-2 w-0.5 bg-accent rounded-sm" />}
      {needsReview && (
        <div className="mb-1.5 flex items-center gap-1.5">
          <span className="inline-flex items-center gap-1 rounded bg-review text-white text-[9px] font-bold uppercase tracking-[0.06em] px-1.5 py-0.5">◆ Needs review</span>
          <span className="font-mono text-[9px] text-mute uppercase tracking-[0.08em]">AI</span>
        </div>
      )}
      {seed && (
        <div className="mb-1.5">
          <span className="inline-flex items-center gap-1 rounded bg-accent/10 text-accent text-[9px] font-bold uppercase tracking-[0.06em] px-1.5 py-0.5">
            ⚑ Seed → {task.seed_target}
          </span>
        </div>
      )}
      <span className="absolute -left-1 top-1/2 -translate-y-1/2 text-mute-2 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
        <GripVertical size={12} />
      </span>
      {task.task_statuses?.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-2">
          {task.task_statuses.map(ts => ts.status).filter(Boolean).map(s => (
            <span key={s.id} style={{ backgroundColor: s.color, color: '#fff', fontSize: 10, fontWeight: 700, letterSpacing: '0.04em', padding: '2px 7px', borderRadius: 3 }}>
              {s.name}
            </span>
          ))}
        </div>
      )}
      <div className="flex items-start gap-2">
        <input type="checkbox" className="tcheck mt-0.5" checked={done} onClick={e => e.stopPropagation()} onChange={() => onToggle(task)} />
        <div className={clsx('flex-1 min-w-0 text-[12.5px] leading-[17px] font-medium', done ? 'text-mute-2 line-through' : 'text-ink')}>
          {task.text}
        </div>
        <div className="flex items-center gap-0.5 shrink-0 -mt-0.5 -mr-0.5">
          <button
            onClick={e => { e.stopPropagation(); onPin(task.id) }}
            title={task.pinned ? 'Unpin' : 'Pin to top'}
            className={clsx('w-5 h-5 inline-flex items-center justify-center transition-opacity', task.pinned ? 'text-star' : 'opacity-0 group-hover:opacity-100 text-mute-2 hover:text-star')}
          >
            <Star size={12} fill={task.pinned ? 'currentColor' : 'none'} />
          </button>
          <button
            onClick={e => { e.stopPropagation(); onDelete(task.id) }}
            title="Delete task"
            className="w-5 h-5 inline-flex items-center justify-center opacity-0 group-hover:opacity-100 text-mute-2 hover:text-[#ef4444] transition-opacity"
          >
            <X size={12} />
          </button>
        </div>
      </div>
      {needsReview && reviewReason && (
        <div className="mt-1.5 text-[11px] leading-snug text-ink-2 bg-review-soft rounded px-2 py-1 line-clamp-2">{reviewReason}</div>
      )}
      <div className="flex items-center gap-2 mt-2 font-mono text-[9.5px] text-mute tracking-[0.06em]">
        {prefix && task.short_id != null && (
          <button
            onClick={copyShortId}
            title="Click to copy task ID"
            className={clsx('rounded px-1 -mx-1 transition-colors hover:bg-surf-2 hover:text-ink', copiedId ? 'text-accent' : 'text-mute-2')}
          >
            {copiedId ? 'Copied!' : `${prefix}-${task.short_id}`}
          </button>
        )}
        {task.priority && task.priority !== 'medium' && <span className={`dot dot-${prio}`} />}
        {task.priority && task.priority !== 'medium' && <span className="uppercase">{task.priority}</span>}
        {task.due_date && <><span className="text-mute-2">·</span><span>{dueLabel(task.due_date)}</span></>}
        {task.agent_proposal
          ? (task.agent_proposal_confirmed
              ? <span className="inline-flex items-center gap-0.5 rounded bg-priority-done/10 px-1 py-px text-[9px] font-bold uppercase tracking-[0.06em] text-priority-done" title="Confirmed — the agent will execute this">✓ go</span>
              : <span className="inline-flex items-center gap-0.5 rounded bg-review/10 px-1 py-px text-[9px] font-bold uppercase tracking-[0.06em] text-review" title="Agent prepared work — awaiting your confirmation">◇ confirm</span>)
          : task.agent_ready && <span className="inline-flex items-center gap-0.5 rounded bg-accent/10 px-1 py-px text-[9px] font-bold uppercase tracking-[0.06em] text-accent" title="Handed to agent — in the ready-work queue">▶ agent</span>}
        {done && task.review_bar?.rules?.length > 0 && (
          task.review_verdict?.overall === 'pass'
            ? <span className="inline-flex items-center gap-0.5 rounded bg-priority-done/10 px-1 py-px text-[9px] font-bold uppercase tracking-[0.06em] text-priority-done" title="Completion backed by passing check evidence (verified)">✓ verified</span>
            : <span className="inline-flex items-center gap-0.5 rounded bg-amber-500/10 px-1 py-px text-[9px] font-bold uppercase tracking-[0.06em] text-amber-600" title="Done, but no passing verification evidence on file">unverified</span>
        )}
        <span className="flex-1" />
        {!done && (
          <button
            onClick={e => { e.stopPropagation(); onToggleIP(task) }}
            title={ip ? 'Stop progress' : 'Mark in progress'}
            className={clsx('inline-flex items-center justify-center w-4 h-4 rounded', ip ? 'text-accent' : 'opacity-0 group-hover:opacity-100 text-mute-2 hover:text-ink')}
          >
            <Play size={10} fill={ip ? 'currentColor' : 'none'} />
          </button>
        )}
        {/* FOCUS button disabled 2026-07-02
        {!done && (
          <button
            onClick={e => { e.stopPropagation(); onFocus(task.id) }}
            className="hidden group-hover:inline-flex items-center gap-1 h-4 px-1.5 rounded bg-accent text-white text-[9px] font-bold tracking-[0.08em]"
          >
            <Crosshair size={9} /> FOCUS
          </button>
        )}
        */}
      </div>
    </div>
  )
}

// ── Section column ──
// ── Draggable card wrapper ──
function SortableCard({ task, sectionId, groupId, ...cardProps }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
    data: { type: 'task', sectionId, groupId: groupId ?? null },
  })
  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      style={{ transform: CSS.Translate.toString(transform), transition, opacity: isDragging ? 0.4 : 1 }}
    >
      <BoardCard task={task} {...cardProps} />
    </div>
  )
}

// ── Droppable sortable list (one per ungrouped area / group) ──
function DroppableList({ sectionId, groupId, items, children }) {
  const { setNodeRef } = useDroppable({
    id: `${sectionId}::${groupId ?? ''}`,
    data: { type: 'list', sectionId, groupId: groupId ?? null },
  })
  return (
    <SortableContext id={`${sectionId}::${groupId ?? ''}`} items={items} strategy={verticalListSortingStrategy}>
      <div ref={setNodeRef} className="flex flex-col gap-1.5 min-h-[10px]">{children}</div>
    </SortableContext>
  )
}

function SectionColumn({ section, statusFilter, priorityFilter, prefix, onAddTask, onAddDetailed, onAddGroup, onOpen, onToggle, onToggleIP, onFocus, onPin, onDelete, onFocusSection, onDeleteSection }) {
  const dim = /done|complete/i.test(section.name)
  const ungrouped = section.ungroupedTasks.filter(t => matchFilter(t, statusFilter, priorityFilter))
  const groups = section.groups.map(g => ({ ...g, tasks: g.tasks.filter(t => matchFilter(t, statusFilter, priorityFilter)) }))
  const [menuOpen, setMenuOpen] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [addingGroup, setAddingGroup] = useState(false)
  const [groupName, setGroupName] = useState('')
  function commitGroup() {
    const v = groupName.trim()
    if (v) onAddGroup(section.id, v)
    setGroupName('')
    setAddingGroup(false)
  }
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: section.id, data: { type: 'column' } })
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition, opacity: isDragging ? 0.5 : 1 }}
      className="w-[264px] shrink-0 flex flex-col border-r border-line min-h-0"
    >
      <div className="relative h-11 px-3.5 flex items-center justify-between border-b border-line-2 bg-surf-2 sticky top-0 z-[2]">
        <div className="flex items-center gap-1.5 flex-1 min-w-0 cursor-pointer hover:opacity-80 transition-opacity" onClick={() => onFocusSection(section.id)}>
          <button {...attributes} {...listeners} className="cursor-grab active:cursor-grabbing text-mute-2 hover:text-mute -ml-1" title="Drag to reorder section">
            <GripVertical size={13} />
          </button>
          <Kicker count={section.completedCount} total={section.totalCount} className={dim ? 'text-mute-2' : undefined}>{section.name}</Kicker>
        </div>
        <button className="icon-btn w-[22px] h-[22px]" onClick={() => setMenuOpen(o => !o)}><MoreHorizontal size={11} /></button>
        {menuOpen && (
          <>
            <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} />
            <div className="absolute right-2 top-9 z-20 min-w-[140px] rounded-lg border border-line bg-paper shadow-card py-1">
              <button
                onClick={() => { setMenuOpen(false); setAddingGroup(true) }}
                className="w-full text-left px-3 py-1.5 text-[12px] text-ink-2 hover:bg-surf-2"
              >
                Add group
              </button>
              <button
                onClick={() => { setMenuOpen(false); setConfirmDelete(true) }}
                className="w-full flex items-center gap-1.5 text-left px-3 py-1.5 text-[12px] text-red-500 hover:bg-red-500/10"
              >
                <Trash2 size={11} /> Delete section
              </button>
            </div>
          </>
        )}
        {confirmDelete && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-40"
            onClick={e => { if (e.target === e.currentTarget) setConfirmDelete(false) }}
          >
            <div className="bg-paper rounded-2xl w-full max-w-sm mx-4 shadow-xl flex flex-col">
              <div className="flex items-center justify-between px-6 pt-6 pb-0">
                <p className="text-[15px] font-semibold text-ink">Delete section</p>
                <button onClick={() => setConfirmDelete(false)} className="text-mute hover:text-ink text-lg leading-none transition-colors">×</button>
              </div>
              <div className="flex flex-col gap-4 px-6 pt-3 pb-6">
                <p className="text-[13px] text-ink-2 leading-snug">
                  Delete <span className="font-medium text-ink">{section.name}</span>?
                  {section.totalCount > 0
                    ? <> This permanently deletes the section and its <span className="font-medium text-ink">{section.totalCount} task{section.totalCount !== 1 ? 's' : ''}</span> (and any groups). This cannot be undone.</>
                    : <> The section is empty. This cannot be undone.</>}
                </p>
                <div className="flex justify-end gap-2">
                  <button onClick={() => setConfirmDelete(false)} className="rounded-lg border border-line px-4 py-1.5 text-[13px] text-ink-2 hover:bg-surf-2 transition-colors">Cancel</button>
                  <button
                    onClick={() => { setConfirmDelete(false); onDeleteSection?.(section.id) }}
                    className="flex items-center gap-1.5 rounded-lg bg-red-500 px-4 py-1.5 text-[13px] font-medium text-white hover:bg-red-600 transition-colors"
                  >
                    <Trash2 size={13} /> Delete
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto px-2.5 py-2.5 flex flex-col gap-1.5 col-body">
        {addingGroup && (
          <input
            autoFocus
            value={groupName}
            onChange={e => setGroupName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') commitGroup(); if (e.key === 'Escape') { setGroupName(''); setAddingGroup(false) } }}
            onBlur={commitGroup}
            placeholder="Group name…"
            className="mx-0.5 mb-1 w-full rounded-md border border-accent bg-paper px-2.5 py-2 font-sans text-xs text-ink outline-none placeholder:text-mute-2"
          />
        )}
        <DroppableList sectionId={section.id} groupId={null} items={ungrouped.map(t => t.id)}>
          {ungrouped.map(t => (
            <SortableCard key={t.id} task={t} sectionId={section.id} groupId={null} prefix={prefix}
              onOpen={onOpen} onToggle={onToggle} onToggleIP={onToggleIP} onFocus={onFocus} onPin={onPin} onDelete={onDelete} />
          ))}
        </DroppableList>

        {groups.map(g => (
          <div key={g.id} className="mt-2">
            <div className="flex items-baseline gap-2 mb-1.5 px-0.5">
              <Kicker count={g.tasks.length}>{g.name}</Kicker>
              <span className="flex-1 h-px bg-line-2" />
            </div>
            <div className="flex flex-col gap-1.5">
              <DroppableList sectionId={section.id} groupId={g.id} items={g.tasks.map(t => t.id)}>
                {g.tasks.map(t => (
                  <SortableCard key={t.id} task={t} sectionId={section.id} groupId={g.id} prefix={prefix}
                    onOpen={onOpen} onToggle={onToggle} onToggleIP={onToggleIP} onFocus={onFocus} onPin={onPin} onDelete={onDelete} />
                ))}
              </DroppableList>
              <AddTaskInline label={`Add to ${g.name.toLowerCase()}`} sectionId={section.id} groupId={g.id} onAdd={onAddTask} onAddDetailed={onAddDetailed} />
            </div>
          </div>
        ))}
      </div>
      <div className="border-t border-line-2 px-2.5 py-1.5 shrink-0">
        <AddTaskInline sectionId={section.id} groupId={null} onAdd={onAddTask} onAddDetailed={onAddDetailed} />
      </div>
    </div>
  )
}

export default function ProjectBoard({ project }) {
  const {
    tasks, sections, groups,
    toggleDone, toggleInProgress: originalToggleInProgress, pinTask,
    createTask, createSection, createGroup, deleteTask, deleteSection,
    reorderTasks, moveTask, reorderSections,
  } = useTasks(project.id)

  const { toggleInProgressWithWarning, dependencyWarning, handleProceed, handleCancel } = useToggleInProgressWithWarning(originalToggleInProgress)

  const { isConnected, pushTask, removeTask } = useGoogleCalendar()
  const { isConnected: ghConnected, syncIssues } = useGitHub()
  const [ghSyncing, setGhSyncing] = useState(false)

  const [statusFilter, setStatusFilter] = useState('pending')
  const [priorityFilter, setPriorityFilter] = useState(null)
  const [showKB, setShowKB] = useState(false)
  const [showIS, setShowIS] = useState(false)
  const [showCreateTask, setShowCreateTask] = useState(false)
  const [showFiles, setShowFiles] = useState(false)
  const [showQueue, setShowQueue] = useState(false)
  const [showContext, setShowContext] = useState(false)
  // const [showFocus, setShowFocus] = useState(false) — DISABLED
  // const [focusTaskId, setFocusTaskId] = useState(null) — DISABLED
  const [panelRefreshKey, setPanelRefreshKey] = useState(0)
  const [projectFlags, setProjectFlags] = useState([])
  const [editingName, setEditingName] = useState(false)
  const [nameDraft, setNameDraft] = useState(project.name)
  const [focusedSectionId, setFocusedSectionId] = useState(null)
  const [showSectionContext, setShowSectionContext] = useState(false)
  const [blueprintMode, setBlueprintMode] = useState(false)
  const [flowNames, setFlowNames] = useState(() => project.context?.flow_names ?? {})

  const isDesktop = useIsDesktop()
  const { selectedTaskId, openTask, closeTask } = useTaskPanelState()
  const scrollerRef = useRef(null)
  useHorizontalWheelScroll(scrollerRef)

  // Pulse bar fills from zero on mount — one quiet moment of arrival.
  const [pulseIn, setPulseIn] = useState(false)
  useEffect(() => {
    const t = setTimeout(() => setPulseIn(true), 80)
    return () => clearTimeout(t)
  }, [])

  // Board view: attention-first Front Page (landing) vs The Stacks (full kanban).
  const [view, setView] = useState(() => {
    try { return localStorage.getItem('tasker_board_view') || 'front' } catch { return 'front' }
  })
  useEffect(() => {
    try { localStorage.setItem('tasker_board_view', view) } catch { /* private mode */ }
  }, [view])

  // Auto-show sidebar when entering section focus mode
  useEffect(() => {
    if (focusedSectionId) {
      setShowSectionContext(true)
    }
  }, [focusedSectionId])

  // Escape exits section focus (mirrors the back button); ignored while typing
  useEffect(() => {
    if (!focusedSectionId) return
    function onKey(e) {
      if (e.key !== 'Escape') return
      const el = document.activeElement
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return
      setFocusedSectionId(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [focusedSectionId])


  const taskIds = useMemo(() => tasks.map(t => t.id), [tasks])
  const { refreshOne } = useProjectMilestones(taskIds)

  // function openFocusForTask(taskId) { setFocusTaskId(taskId); setShowFocus(true) } — DISABLED
  async function createAndOpen(sectionId, text, groupId) {
    const t = await createTask(sectionId, text, groupId)
    if (t) openTask(t.id)
  }

  // ── Drag and drop ──
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor),
  )
  const [activeDragId, setActiveDragId] = useState(null)
  const activeDragTask = activeDragId ? tasks.find(t => t.id === activeDragId) : null

  function handleDragStart({ active }) { setActiveDragId(active.id) }
  function handleDragEnd({ active, over }) {
    setActiveDragId(null)
    if (!over) return
    const a = active.data.current

    // Section (column) reorder
    if (a?.type === 'column') {
      const overCol = over.data.current?.type === 'column' ? over.id : over.data.current?.sectionId
      if (!overCol || overCol === active.id) return
      const oldIdx = sections.findIndex(s => s.id === active.id)
      const newIdx = sections.findIndex(s => s.id === overCol)
      if (oldIdx >= 0 && newIdx >= 0) reorderSections(arrayMove(sections, oldIdx, newIdx))
      return
    }

    if (a?.type !== 'task') return
    const o = over.data.current
    if (o?.type !== 'task' && o?.type !== 'list') return
    const overIsTask = o.type === 'task'
    const toSection = o.sectionId
    const toGroup = o.groupId ?? null
    const fromSection = a.sectionId
    const fromGroup = a.groupId ?? null

    if (fromSection === toSection && fromGroup === toGroup) {
      // Same list: reorder. If we didn't land on a sibling card, leave order as-is.
      if (!overIsTask || over.id === active.id) return
      const peers = boardTasks
        .filter(t => t.section_id === toSection && (t.group_id ?? null) === toGroup)
        .sort((x, y) => (x.sort_order ?? 0) - (y.sort_order ?? 0))
      const oldIdx = peers.findIndex(t => t.id === active.id)
      const newIdx = peers.findIndex(t => t.id === over.id)
      if (oldIdx >= 0 && newIdx >= 0) reorderTasks(arrayMove(peers, oldIdx, newIdx))
    } else {
      // Cross-list: move into target section/group, inserted at the drop position.
      const moved = boardTasks.find(t => t.id === active.id)
      if (!moved) return
      const targetPeers = boardTasks
        .filter(t => t.section_id === toSection && (t.group_id ?? null) === toGroup && t.id !== active.id)
        .sort((x, y) => (x.sort_order ?? 0) - (y.sort_order ?? 0))
      let insertIdx = targetPeers.length
      if (overIsTask) {
        const idx = targetPeers.findIndex(t => t.id === over.id)
        if (idx >= 0) insertIdx = idx
      }
      const newOrder = [...targetPeers.slice(0, insertIdx), moved, ...targetPeers.slice(insertIdx)]
      moveTask(active.id, toSection, toGroup)
      reorderTasks(newOrder)
    }
  }
  function handleDeleteTask(taskId) {
    if (isConnected) removeTask(taskId).catch(() => {})
    deleteTask(taskId)
  }
  const handleRename = useCallback((name) => updateProject(project.id, { name }), [project.id])
  function commitName() {
    setEditingName(false)
    const n = nameDraft.trim()
    if (n && n !== project.name) handleRename(n)
  }
  function handleContextUpdate(updatedContext) {
    updateProject(project.id, { context: updatedContext })
    scanProjectFlags(tasks, updatedContext).then(found => { if (found.length) setProjectFlags(found) }).catch(() => {})
  }

  async function handleSyncIssues() {
    if (!project.github_repo || ghSyncing) return
    setGhSyncing(true)
    try {
      const existingNums = tasks.filter(t => t.github_issue_number != null).map(t => t.github_issue_number)
      const newIssues = await syncIssues(project.github_repo, existingNums)
      if (!newIssues.length) return
      const grouped = {}
      for (const issue of newIssues) {
        const key = issue.sectionName || 'Backlog'
        ;(grouped[key] ||= []).push(issue)
      }
      const sectionMap = new Map(sections.map(s => [s.name, s.id]))
      for (const [sectionName, issues] of Object.entries(grouped)) {
        let targetSectionId = sectionMap.get(sectionName)
        if (!targetSectionId) {
          const newSection = await createSection(sectionName)
          if (newSection) { targetSectionId = newSection.id; sectionMap.set(sectionName, newSection.id) }
        }
        if (!targetSectionId) continue
        for (const issue of issues) {
          await createTask(targetSectionId, issue.text, null, {
            detail: issue.detail ?? null, priority: issue.priority, github_issue_number: issue.github_issue_number,
          })
        }
      }
    } catch (err) {
      console.error('GitHub sync failed:', err)
    } finally {
      setGhSyncing(false)
    }
  }

  // Flow tasks are not project-board citizens (decision 2026-07-01: flows and their
  // tasks live entirely on the Flows page). They leave every denominator here —
  // columns, Pulse %, filter counts, section x/y, Now Band — not merely the cards.
  const flowTaskIds = useMemo(() => {
    const ids = new Set()
    detectFlows(tasks).forEach(f => f.taskIds.forEach(id => ids.add(id)))
    return ids
  }, [tasks])
  const boardTasks = useMemo(() => tasks.filter(t => !flowTaskIds.has(t.id)), [tasks, flowTaskIds])

  const enrichedSections = useMemo(() =>
    sections.map(section => {
      const sectionGroups = groups.filter(g => g.section_id === section.id).sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
      const sectionTasks = boardTasks.filter(t => t.section_id === section.id)
      // A task whose group_id points to a group not in this section (stale/foreign group_id)
      // would otherwise match neither the ungrouped bucket nor any group here, and vanish.
      const groupIds = new Set(sectionGroups.map(g => g.id))
      const ungroupedTasks = sectionTasks.filter(t => !t.group_id || !groupIds.has(t.group_id)).sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
      const enrichedGroups = sectionGroups.map(g => ({
        ...g,
        tasks: sectionTasks.filter(t => t.group_id === g.id).sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)),
      }))
      const completedCount = sectionTasks.filter(t => t.status === 'done').length
      return { ...section, ungroupedTasks, groups: enrichedGroups, totalCount: sectionTasks.length, completedCount }
    }), [boardTasks, sections, groups])

  const filterCounts = useMemo(() => ({
    all: boardTasks.length,
    pending: boardTasks.filter(t => t.status !== 'done').length,
    done: boardTasks.filter(t => t.status === 'done').length,
    rush: boardTasks.filter(t => t.priority === 'rush' && t.status !== 'done').length,
    high: boardTasks.filter(t => t.priority === 'high' && t.status !== 'done').length,
    medium: boardTasks.filter(t => t.priority === 'medium' && t.status !== 'done').length,
  }), [boardTasks])

  const inProgressTasks = useMemo(() => boardTasks.filter(t => t.status === 'in_progress'), [boardTasks])
  const needsYou = useMemo(() => boardTasks.filter(t => t.review_verdict?.escalated), [boardTasks])
  const doneCount = boardTasks.filter(t => t.status === 'done').length
  const pct = boardTasks.length ? Math.round((doneCount / boardTasks.length) * 100) : 0

  // Masthead dateline + one-sentence lede: the whole project in one breath.
  const dateline = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
  const shippedWeek = useMemo(() =>
    boardTasks.filter(t => t.status === 'done' && t.completed_at && (Date.now() - new Date(t.completed_at).getTime()) < 7 * 86400000).length,
    [boardTasks])
  const flying = useMemo(() => inProgressTasks.filter(t => !t.review_verdict?.escalated), [inProgressTasks])
  const lede = (flying.length === 0 && needsYou.length === 0 && shippedWeek === 0)
    ? 'All quiet — nothing in flight right now.'
    : (
      <>
        Right now: <b className="text-ink font-semibold">{flying.length} in flight</b>
        {shippedWeek > 0 && <>, <b className="text-ink font-semibold">{shippedWeek} shipped</b> this week</>}
        {needsYou.length > 0 && <>, and <b className="text-review font-semibold">{needsYou.length === 1 ? 'one needs' : `${needsYou.length} need`} your judgment</b></>}
        .
      </>
    )


  const focusedSection = focusedSectionId ? enrichedSections.find(s => s.id === focusedSectionId) : null

  const focusedUngrouped = focusedSection ? focusedSection.ungroupedTasks.filter(t => matchFilter(t, statusFilter, priorityFilter)) : []

  return (
    <>
      <AppShell
        active="projects"
        rightRail={
          !blueprintMode && focusedSectionId && showSectionContext && focusedSection ? (
            <SectionContextSidebar
              section={focusedSection}
              groups={focusedSection.groups}
              tasks={boardTasks}
              project={project}
              onClose={() => setShowSectionContext(false)}
            />
          ) : null
        }
        hideSidebar={!!focusedSectionId || blueprintMode}
      >
        <div className="h-full flex flex-col board-surface">
          {/* Section-focus header (unchanged surface, own chrome) */}
          {!blueprintMode && focusedSectionId && (
            <header className="px-7 pt-6 pb-4 border-b border-line-2 bg-paper shrink-0">
              <div className="flex items-baseline justify-between gap-6">
                <div className="flex items-center gap-2 min-w-0">
                  <button onClick={() => setFocusedSectionId(null)} title="Back to board (Esc)" className="btn btn-sm mr-2 text-ink-2">
                    <ChevronLeft size={14} /> Back
                  </button>
                  <h1 className="font-display font-semibold text-[26px] leading-[32px] tracking-[-0.01em] m-0">{enrichedSections.find(s => s.id === focusedSectionId)?.name}</h1>
                  <span className="font-mono text-[11px] text-mute tracking-[0.06em] shrink-0 ml-2">· {project.prefix}</span>
                </div>
              </div>
              <div className="flex items-center gap-3 mt-4">
                <div className="flex gap-1.5">
                  <Pill active={statusFilter === 'pending'} count={filterCounts.pending} onClick={() => setStatusFilter('pending')}>Pending</Pill>
                  <Pill active={statusFilter === 'all'} count={filterCounts.all} onClick={() => setStatusFilter('all')}>All</Pill>
                  <Pill active={statusFilter === 'done'} count={filterCounts.done} onClick={() => setStatusFilter('done')}>Done</Pill>
                  <span className="w-px h-[18px] bg-line-2 mx-1 self-center" />
                  <Pill active={priorityFilter === 'rush'} count={filterCounts.rush} onClick={() => setPriorityFilter(f => f === 'rush' ? null : 'rush')}>Rush</Pill>
                  <Pill active={priorityFilter === 'high'} count={filterCounts.high} onClick={() => setPriorityFilter(f => f === 'high' ? null : 'high')}>High</Pill>
                  <Pill active={priorityFilter === 'medium'} count={filterCounts.medium} onClick={() => setPriorityFilter(f => f === 'medium' ? null : 'medium')}>Med</Pill>
                </div>
              </div>
            </header>
          )}

          {/* Masthead — the living front of the project. Constellation behind,
              dateline + lede, serif title, serif Pulse, view tabs. */}
          {!blueprintMode && !focusedSectionId && (
            <header className="relative border-b border-line-2 shrink-0 overflow-hidden masthead">
              <MastheadSky tasks={boardTasks} />
              <div className="relative z-[2] px-7 pt-5">
                <div className="flex items-center gap-2">
                  <Kicker>PROJECTS</Kicker>
                  <span className="text-mute-2">›</span>
                  <Kicker className="text-ink">{project.prefix}</Kicker>
                  <span className="font-mono text-[9.5px] tracking-[0.12em] text-mute-2 uppercase ml-1.5">· {dateline}</span>
                  {project.local_mode && (
                    <span
                      title="Local Mode — this project mirrors to .tasker/ files on your devices; agents work the files and sync back"
                      className="font-mono text-[9px] tracking-[0.12em] uppercase text-accent border border-accent/40 rounded px-1.5 py-0.5 ml-1.5"
                    >⇄ Local Mode</span>
                  )}
                  <span className="flex-1" />
                  {ghConnected && project.github_repo && (
                    <button onClick={handleSyncIssues} disabled={ghSyncing} className="font-mono text-[9.5px] text-mute tracking-[0.1em] inline-flex items-center gap-1.5 mr-2">
                      <span className="dot dot-done" />{ghSyncing ? 'SYNCING…' : 'SYNC ISSUES'}
                    </button>
                  )}
                  <button
                    onClick={() => setShowCreateTask(true)}
                    title="Create a task — lands in Backlog unless you pick a different section"
                    className="btn-primary btn-sm font-mono text-[10px] tracking-[0.12em] uppercase mr-2"
                  >+ Create Task</button>
                  <button
                    onClick={() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true }))}
                    title="Search everything"
                    className="btn btn-sm font-mono text-[10px] tracking-[0.12em] uppercase text-mute hover:text-ink"
                  >⌘K</button>
                  <button onClick={() => setShowKB(true)} title="Knowledge Base — persistent project knowledge the AI accumulates" className="btn btn-sm font-mono text-[10px] tracking-[0.12em] uppercase text-mute hover:text-ink">KB</button>
                  <button onClick={() => setShowIS(true)} title="Instruction Set — per-project rules that shape AI behavior" className="btn btn-sm font-mono text-[10px] tracking-[0.12em] uppercase text-mute hover:text-ink">IS</button>
                  <button onClick={() => setShowFiles(true)} title="Files — documents & files stored in this project's Google Drive folder" className="btn btn-sm font-mono text-[10px] tracking-[0.12em] uppercase text-mute hover:text-ink">Files</button>
                  <button onClick={() => setShowQueue(true)} title="Agent queue — tasks handed to the agent, and those the agent prepared and is awaiting your confirmation on" className="btn btn-sm font-mono text-[10px] tracking-[0.12em] uppercase text-mute hover:text-ink">Queue</button>
                  {!useEnvironmentStore.getState().environments.find(e => e.id === project.environment_id)?.org_id && (
                    <button
                      onClick={() => updateProject(project.id, { local_mode: !project.local_mode })}
                      title={project.local_mode
                        ? 'Local Mode is ON — agents mirror this project to .tasker/ files and sync back. Click to turn off.'
                        : 'Turn on Local Mode — mirror this project to .tasker/ files on your devices (agents pull, work files directly, and sync back). Owner-only.'}
                      className={`btn btn-sm font-mono text-[10px] tracking-[0.12em] uppercase ${project.local_mode ? 'text-accent' : 'text-mute hover:text-ink'}`}
                    >⇄ Local</button>
                  )}
                </div>

                <div className="flex items-end justify-between gap-10 pt-5 pb-4">
                  <div className="min-w-0">
                    {editingName ? (
                      <input
                        autoFocus value={nameDraft}
                        onChange={e => setNameDraft(e.target.value)}
                        onBlur={commitName}
                        onKeyDown={e => { if (e.key === 'Enter') commitName(); if (e.key === 'Escape') { setNameDraft(project.name); setEditingName(false) } }}
                        className="font-display font-semibold text-[38px] leading-[1.05] tracking-[-0.02em] bg-transparent border border-line rounded-md px-2 py-0.5 outline-none focus:border-accent text-ink w-full max-w-[560px]"
                      />
                    ) : (
                      <h1
                        className="font-display font-semibold text-[38px] leading-[1.05] tracking-[-0.02em] m-0 cursor-text truncate"
                        style={{ textWrap: 'balance' }}
                        title="Click to rename"
                        onClick={() => { setNameDraft(project.name); setEditingName(true) }}
                      >{project.name}</h1>
                    )}
                    <p className="m-0 mt-2 text-[13px] text-ink-2 max-w-[62ch]">{lede}</p>
                  </div>
                  <div className="text-right shrink-0 pb-0.5" title={`${doneCount} of ${boardTasks.length} standalone tasks complete`}>
                    <div className="font-display font-semibold text-[36px] leading-none tracking-[-0.02em] tabular-nums">{pct}%</div>
                    <span className="inline-block h-[5px] w-44 rounded-full bg-surf overflow-hidden mt-2.5 mb-1.5">
                      <span
                        className="block h-full bg-ink rounded-full transition-[width] duration-1000 ease-out"
                        style={{ width: pulseIn ? `${pct}%` : '0%' }}
                      />
                    </span>
                    <div className="font-mono text-[9.5px] text-mute tracking-[0.08em]">{doneCount} / {boardTasks.length} STANDALONE TASKS</div>
                  </div>
                </div>

                <nav className="flex gap-7" aria-label="Board views">
                  <button
                    onClick={() => setView('front')}
                    className={clsx(
                      'appearance-none bg-transparent border-0 border-b-2 -mb-px cursor-pointer px-0.5 pt-1 pb-3 font-mono text-[10px] tracking-[0.16em] transition-colors',
                      view === 'front' ? 'text-ink border-ink' : 'text-mute border-transparent hover:text-ink-2',
                    )}
                    style={{ borderBottomStyle: 'solid' }}
                  >FRONT PAGE</button>
                  <button
                    onClick={() => setView('stacks')}
                    className={clsx(
                      'appearance-none bg-transparent border-0 border-b-2 -mb-px cursor-pointer px-0.5 pt-1 pb-3 font-mono text-[10px] tracking-[0.16em] transition-colors',
                      view === 'stacks' ? 'text-ink border-ink' : 'text-mute border-transparent hover:text-ink-2',
                    )}
                    style={{ borderBottomStyle: 'solid' }}
                  >THE STACKS — FULL BOARD</button>
                </nav>
              </div>
            </header>
          )}

          {/* Stacks-only filter strip (filters live with the board they filter) */}
          {!blueprintMode && !focusedSectionId && view === 'stacks' && (
            <div className="shrink-0 flex items-center gap-1.5 px-7 py-2.5 border-b border-line-2 bg-paper">
              <Pill active={statusFilter === 'pending'} count={filterCounts.pending} onClick={() => setStatusFilter('pending')}>Pending</Pill>
              <Pill active={statusFilter === 'all'} count={filterCounts.all} onClick={() => setStatusFilter('all')}>All</Pill>
              <Pill active={statusFilter === 'done'} count={filterCounts.done} onClick={() => setStatusFilter('done')}>Done</Pill>
              <span className="w-px h-[18px] bg-line-2 mx-1 self-center" />
              <Pill active={priorityFilter === 'rush'} count={filterCounts.rush} onClick={() => setPriorityFilter(f => f === 'rush' ? null : 'rush')}>Rush</Pill>
              <Pill active={priorityFilter === 'high'} count={filterCounts.high} onClick={() => setPriorityFilter(f => f === 'high' ? null : 'high')}>High</Pill>
              <Pill active={priorityFilter === 'medium'} count={filterCounts.medium} onClick={() => setPriorityFilter(f => f === 'medium' ? null : 'medium')}>Med</Pill>
            </div>
          )}

          {/* Now Band — stacks-only (the Front Page's Happening Now covers this on landing).
              Collapses entirely when nothing is in flight and nothing needs the human. */}
          {!blueprintMode && !focusedSectionId && view === 'stacks' && (inProgressTasks.length > 0 || needsYou.length > 0) && (
            <div className="shrink-0 flex items-center gap-3 px-7 py-2 border-b border-line-2 bg-paper">
              <Kicker className="text-accent" count={inProgressTasks.length}>IN PROGRESS</Kicker>
              <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar flex-1">
                {inProgressTasks.map(t => (
                  <div key={t.id} className="shrink-0 inline-flex items-center h-6 pl-2.5 pr-1 rounded-pill border border-line bg-paper text-[11.5px] text-ink-2 hover:border-accent transition-colors">
                    <button onClick={() => openTask(t.id)} className="inline-flex items-center gap-1.5 min-w-0">
                      <span className="w-1.5 h-1.5 rounded-full bg-accent shrink-0 dot-live" />
                      {project.prefix && t.short_id != null && (
                        <span className="font-mono text-[9.5px] text-mute tracking-[0.04em] shrink-0">{project.prefix}-{t.short_id}</span>
                      )}
                      <span className="max-w-[210px] truncate">{t.text}</span>
                    </button>
                    <span className="inline-flex items-center gap-0 ml-1 pl-1 border-l border-line-2">
                      {/* Focus button disabled 2026-07-02
                      <button onClick={() => openFocusForTask(t.id)} title="Resume in Focus" className="w-5 h-5 inline-flex items-center justify-center rounded-full text-accent hover:bg-accent hover:text-white transition-colors">
                        <Play size={9} fill="currentColor" />
                      </button>
                      */}
                      <button onClick={() => toggleInProgressWithWarning(t)} title="Pause — clear in-progress" className="w-5 h-5 inline-flex items-center justify-center rounded-full text-mute hover:bg-surf-2 hover:text-ink transition-colors">
                        <Pause size={9} />
                      </button>
                    </span>
                  </div>
                ))}
              </div>
              {needsYou.length > 0 && (
                <button
                  onClick={() => openTask(needsYou[0].id)}
                  title={`The AI escalated after failed self-revision — your call needed on: ${needsYou.map(t => `${project.prefix}-${t.short_id}`).join(', ')}`}
                  className="shrink-0 inline-flex items-center gap-1.5 h-6 px-2.5 rounded-pill bg-review text-white text-[11px] font-bold tracking-[0.04em]"
                >
                  ◆ {needsYou.length} need{needsYou.length === 1 ? 's' : ''} you
                </button>
              )}
            </div>
          )}

          {/* Banners */}
          {!blueprintMode && projectFlags.length > 0 && (
            <div className="shrink-0 flex items-start gap-3 px-7 py-2.5 border-b border-line-2 bg-surf-2">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5 text-accent" />
              <div className="flex-1 flex flex-col gap-1">{projectFlags.map((f, i) => <p key={i} className="text-[12px] text-ink-2 leading-snug">{f.message}</p>)}</div>
              <button onClick={() => setProjectFlags([])} className="shrink-0 text-mute hover:text-ink text-[16px] leading-none">×</button>
            </div>
          )}

          {/* Blueprint canvas — full screen, no chrome */}
          {blueprintMode && (
            <div className="flex-1 min-h-0">
              <BlueprintView
                tasks={tasks}
                sections={sections}
                flowNames={flowNames}
                selectedTaskId={selectedTaskId}
                onTaskSelect={openTask}
                onDeselect={closeTask}
                onExit={() => setBlueprintMode(false)}
                onRenameFlow={(rootTaskId, name) => {
                  const updated = { ...flowNames, [rootTaskId]: name }
                  setFlowNames(updated)
                  const newContext = { ...(project.context ?? {}), flow_names: updated }
                  updateProject(project.id, { context: newContext })
                }}
              />
            </div>
          )}

          {/* Front Page — the attention-first landing view */}
          {!blueprintMode && !focusedSectionId && view === 'front' && (
            <FrontPage
              project={project}
              tasks={boardTasks}
              sections={enrichedSections}
              onOpenTask={openTask}
              onPause={toggleInProgressWithWarning}
              onFocusSection={setFocusedSectionId}
            />
          )}

          {/* Swimlane columns — The Stacks (and section focus) */}
          {(focusedSectionId || view === 'stacks') && <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
            <div ref={scrollerRef} className={clsx('cols-scroll flex-1 min-h-0 overflow-x-auto overflow-y-hidden flex bg-surf-2', blueprintMode && 'hidden')}>
              <SortableContext items={focusedSectionId ? enrichedSections.find(s => s.id === focusedSectionId)?.groups?.map(g => g.id) || [] : enrichedSections.map(s => s.id)} strategy={horizontalListSortingStrategy}>
                {focusedSectionId ? (
                  <>
                    {/* Ungrouped tasks column */}
                    {focusedUngrouped.length > 0 && (
                      <div className="w-[264px] shrink-0 flex flex-col border-r border-line min-h-0">
                        <div className="relative h-11 px-3.5 flex items-center border-b border-line-2 bg-surf-2 sticky top-0 z-[2]">
                          <Kicker count={focusedUngrouped.length}>General</Kicker>
                        </div>
                        <div className="flex-1 min-h-0 overflow-y-auto px-2.5 py-2.5 flex flex-col gap-1.5 col-body">
                          <DroppableList sectionId={focusedSectionId} groupId={null} items={focusedUngrouped.map(t => t.id)}>
                            {focusedUngrouped.map(t => (
                              <SortableCard key={t.id} task={t} sectionId={focusedSectionId} groupId={null} prefix={project.prefix}
                                onOpen={openTask} onToggle={toggleDone} onToggleIP={toggleInProgressWithWarning} onFocus={() => {}} /* DISABLED */ onPin={pinTask} onDelete={handleDeleteTask} />
                            ))}
                          </DroppableList>
                        </div>
                      <div className="border-t border-line-2 px-2.5 py-1.5 shrink-0">
                          <AddTaskInline sectionId={focusedSectionId} groupId={null} onAdd={createTask} onAddDetailed={createAndOpen} />
                        </div>
                      </div>
                    )}
                    {/* Group columns */}
                    {(focusedSection?.groups ?? []).map(group => {
                      const filteredTasks = group.tasks.filter(t => matchFilter(t, statusFilter, priorityFilter))
                      return (
                        <div key={group.id} className="w-[264px] shrink-0 flex flex-col border-r border-line min-h-0">
                          <div className="relative h-11 px-3.5 flex items-center justify-between border-b border-line-2 bg-surf-2 sticky top-0 z-[2]">
                            <Kicker count={filteredTasks.length}>{group.name}</Kicker>
                          </div>
                          <div className="flex-1 min-h-0 overflow-y-auto px-2.5 py-2.5 flex flex-col gap-1.5 col-body">
                            <DroppableList sectionId={focusedSectionId} groupId={group.id} items={filteredTasks.map(t => t.id)}>
                              {filteredTasks.map(t => (
                                <SortableCard key={t.id} task={t} sectionId={focusedSectionId} groupId={group.id} prefix={project.prefix}
                                  onOpen={openTask} onToggle={toggleDone} onToggleIP={toggleInProgressWithWarning} onFocus={() => {}} /* DISABLED */ onPin={pinTask} onDelete={handleDeleteTask} />
                              ))}
                            </DroppableList>
                          </div>
                          <div className="border-t border-line-2 px-2.5 py-1.5 shrink-0">
                            <AddTaskInline label={`Add to ${group.name.toLowerCase()}`} sectionId={focusedSectionId} groupId={group.id} onAdd={createTask} onAddDetailed={createAndOpen} />
                          </div>
                        </div>
                      )
                    })}
                  </>
                ) : (
                  // Section columns in normal mode
                  enrichedSections.map(s => (
                    <SectionColumn
                      key={s.id} section={s} statusFilter={statusFilter} priorityFilter={priorityFilter} prefix={project.prefix}
                      onAddTask={createTask} onAddDetailed={createAndOpen} onAddGroup={createGroup} onOpen={openTask} onToggle={toggleDone} onToggleIP={toggleInProgressWithWarning}
                      onFocus={() => {}} /* DISABLED */ onPin={pinTask} onDelete={handleDeleteTask} onFocusSection={setFocusedSectionId}
                      onDeleteSection={deleteSection}
                    />
                  ))
                )}
              </SortableContext>
              {!focusedSectionId && (
                <div className="w-[200px] shrink-0 p-3">
                  <AddTaskInline label="+ Add section" sectionId={null} groupId={null} onAdd={(_s, name) => name && createSection(name)} />
                </div>
              )}
            </div>
            <DragOverlay>
              {activeDragTask && (
                <div className="w-[244px] rotate-1 shadow-drag rounded-lg">
                  <BoardCard task={activeDragTask} prefix={project.prefix} onOpen={() => {}} onToggle={() => {}} onToggleIP={() => {}} onFocus={() => {}} onPin={() => {}} onDelete={() => {}} />
                </div>
              )}
            </DragOverlay>
          </DndContext>}
        </div>
      </AppShell>

      {selectedTaskId && (
        blueprintMode
          ? <TaskDetailPanel taskId={selectedTaskId} onClose={closeTask} onFocus={() => {}} /* DISABLED */ onMilestoneChange={refreshOne} refreshKey={panelRefreshKey} project={project} onContextUpdate={handleContextUpdate} sidebarCollapsed noBackdrop />
          : <TaskDetailSheet taskId={selectedTaskId} onClose={closeTask} onFocus={() => {}} /* DISABLED */ onMilestoneChange={refreshOne} refreshKey={panelRefreshKey} project={project} onContextUpdate={handleContextUpdate} compact={isDesktop} />
      )}

      {showKB && <KnowledgeBaseModal projectId={project.id} onClose={() => setShowKB(false)} />}
      {showIS && <InstructionSetModal projectId={project.id} onClose={() => setShowIS(false)} />}
      {showCreateTask && (
        <CreateTaskModal
          sections={sections}
          onCreate={createTask}
          onCreateSection={createSection}
          onClose={() => setShowCreateTask(false)}
        />
      )}
      {showFiles && (
        <ProjectFilesModal projectId={project.id} projectName={project.name} onClose={() => setShowFiles(false)} />
      )}
      {showQueue && (
        <AgentQueuePanel projectId={project.id} prefix={project.prefix} onClose={() => setShowQueue(false)} onOpenTask={openTask} />
      )}
      {showContext && <ProjectContextPanel project={project} onClose={() => setShowContext(false)} onContextUpdate={handleContextUpdate} />}

      {/* FocusOverlay DISABLED 2026-07-02 (TDE-351)
      {showFocus && (
        <FocusOverlay
          tasks={boardTasks} project={project}
          onClose={() => { setShowFocus(false); setFocusTaskId(null); if (selectedTaskId) setPanelRefreshKey(k => k + 1) }}
          onContextUpdate={handleContextUpdate}
          onPinTask={pinTask}
          onToggleDone={toggleDone}
          onToggleInProgress={toggleInProgressWithWarning}
          initialTaskId={focusTaskId}
        />
      )}
      */}

      <FlowBlockedDialog
        dependency={dependencyWarning}
        onProceed={handleProceed}
        onCancel={handleCancel}
      />
    </>
  )
}
