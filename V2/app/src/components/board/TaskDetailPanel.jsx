import { useEffect, useRef, useState } from 'react'
import { X, Calendar, MoreHorizontal, Crosshair, Sparkles, GripVertical, HardDrive } from 'lucide-react'
import { uploadFileToDrive, driveFileUrl, deleteDriveFile } from '../../lib/driveFiles'
import clsx from 'clsx'
import { DndContext, closestCenter, PointerSensor, useSensor, useSensors } from '@dnd-kit/core'
import { SortableContext, useSortable, verticalListSortingStrategy, arrayMove } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { useTaskStore } from '../../store/useTaskStore'
import { updateTaskFields } from '../../hooks/useTasks'
import FlowBlockedDialog from './DependencyWarningDialog'
import ReviewVerdictPanel from './ReviewVerdictPanel'
import AgentActivityPanel from './AgentActivityPanel'
import TaskGuidance from './TaskGuidance'
import CustomStatusField from './CustomStatusField'
import { useTaskDiscussion } from '../../hooks/useTaskDiscussion'
import { chatAboutTask, generateFocusSteps, synthesizeTaskToContext } from '../../lib/gemini'

function toRelative(iso) {
  const now = new Date()
  const d = new Date(iso)
  const diffDays = Math.round((d.getTime() - now.getTime()) / 86400000)
  if (diffDays === 0) return 'today'
  if (diffDays === 1) return 'tomorrow'
  if (diffDays === -1) return 'yesterday'
  if (diffDays > 0) return `in ${diffDays}d`
  return `${-diffDays}d ago`
}

const STATUS_OPTS = [
  { id: 'pending',     label: 'Pending' },
  { id: 'in_progress', label: 'In progress' },
  { id: 'done',        label: 'Done' },
]

const PRIORITY_OPTS = [
  { id: 'rush',   label: 'Rush',   activeCls: 'bg-priority-rush border-priority-rush text-white' },
  { id: 'high',   label: 'High',   activeCls: 'bg-priority-high border-priority-high text-white' },
  { id: 'medium', label: 'Med',    activeCls: 'bg-priority-med  border-priority-med  text-white' },
  { id: 'low',    label: 'Low',    activeCls: 'bg-ink border-ink text-paper' },
]

function SortableMilestone({ id, step, checked, onToggle, onDelete }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id })
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.4 : 1 }}
      className="flex items-start gap-2.5 py-1.5 border-b border-line-2 last:border-0 group/step"
    >
      <button
        {...listeners} {...attributes}
        className="shrink-0 mt-0.5 cursor-grab active:cursor-grabbing text-mute opacity-0 group-hover/step:opacity-100 transition-opacity"
        tabIndex={-1}
      >
        <GripVertical className="h-3.5 w-3.5" />
      </button>
      <button
        onClick={onToggle}
        style={{
          width: 15, height: 15, borderRadius: 3, flexShrink: 0, marginTop: 1,
          border: `1.25px solid ${checked ? '#D97757' : 'var(--color-line)'}`,
          background: checked ? '#D97757' : 'var(--color-paper)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
          transition: 'background 0.15s, border-color 0.15s',
        }}
      >
        {checked && <span style={{ color: '#fff', fontSize: 8, fontWeight: 900, lineHeight: 1 }}>✓</span>}
      </button>
      <span className={clsx('flex-1 text-[12.5px] leading-snug', checked ? 'text-mute line-through' : 'text-ink-2')}>
        {(step.kind === 'prerequisite' || step.kind === 'question') && (
          <span
            className={clsx(
              'mr-1.5 align-middle rounded px-1 py-px text-[8.5px] font-mono font-bold uppercase tracking-wider border',
              step.kind === 'prerequisite' ? 'border-accent/40 text-accent' : 'border-line text-mute-2'
            )}
            title={step.kind === 'prerequisite' ? 'Prerequisite — settle before resolving the seed' : 'Open question — answer during resolution'}
          >
            {step.kind === 'prerequisite' ? 'prereq' : 'Q'}
          </span>
        )}
        {step.summary}
      </span>
      <button onClick={onDelete} className="opacity-0 group-hover/step:opacity-100 btn-delete transition-opacity shrink-0">
        ×
      </button>
    </div>
  )
}

function Field({ label, children }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="font-mono text-[10px] uppercase tracking-[0.1em] text-mute">{label}</div>
      {children}
    </div>
  )
}

export function StatusSegmented({ value, onChange }) {
  return (
    <div className="grid grid-cols-3 gap-1.5 rounded-lg bg-surf-2 p-1">
      {STATUS_OPTS.map(o => {
        const active = value === o.id
        return (
          <button
            key={o.id}
            onClick={() => onChange(o.id)}
            className={clsx(
              'flex flex-col items-center gap-1 rounded-md px-1 py-2 text-xs font-medium transition-colors',
              active
                ? 'bg-paper text-ink shadow-sm'
                : 'bg-transparent text-mute hover:text-ink-2',
            )}
          >
            <span className={clsx(
              'h-1.5 w-1.5 rounded-full',
              active && o.id === 'done'        ? 'bg-priority-done'
              : active && o.id === 'in_progress' ? 'bg-accent'
              : active                          ? 'bg-ink-2'
              : 'bg-mute-2'
            )} />
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

export function PrioritySegmented({ value, onChange }) {
  return (
    <div className="grid grid-cols-4 gap-1.5">
      {PRIORITY_OPTS.map(o => {
        const active = value === o.id
        return (
          <button
            key={o.id}
            onClick={() => onChange(o.id === value ? null : o.id)}
            className={clsx(
              'rounded-md border px-1 py-2 font-mono text-[10px] uppercase tracking-[0.08em] transition-colors',
              active ? o.activeCls : 'border-line bg-paper text-mute hover:text-ink-2'
            )}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

function DeleteFileDialog({ file, busy, error, onCancel, onConfirm }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-40"
      onClick={e => { if (e.target === e.currentTarget && !busy) onCancel() }}
    >
      <div className="bg-paper rounded-2xl w-full max-w-sm mx-4 shadow-xl flex flex-col">
        <div className="flex items-center justify-between px-6 pt-6 pb-0">
          <p className="text-[15px] font-semibold text-ink">Remove file</p>
          <button onClick={() => !busy && onCancel()} className="text-mute hover:text-ink text-lg leading-none transition-colors">×</button>
        </div>
        <div className="flex flex-col gap-4 px-6 pt-3 pb-6">
          <p className="text-[13px] text-ink-2 leading-snug">
            <span className="font-medium text-ink">{file.filename}</span> — do you want to remove just the link from this task, or delete the file from Google Drive entirely?
          </p>
          <div className="flex flex-col gap-2">
            <button
              onClick={() => onConfirm('link')}
              disabled={busy}
              className="flex flex-col items-start gap-0.5 rounded-lg border border-line px-4 py-2.5 text-left hover:border-accent hover:bg-accent/[0.04] transition-colors disabled:opacity-50"
            >
              <span className="text-[13px] font-medium text-ink">Remove link only</span>
              <span className="text-[11px] text-mute">Detach from this task. The file stays in Google Drive.</span>
            </button>
            <button
              onClick={() => onConfirm('drive')}
              disabled={busy}
              className="flex flex-col items-start gap-0.5 rounded-lg border border-line px-4 py-2.5 text-left hover:border-red-400 hover:bg-red-500/[0.05] transition-colors disabled:opacity-50"
            >
              <span className="text-[13px] font-medium text-red-500">Delete from Drive completely</span>
              <span className="text-[11px] text-mute">Permanently delete the file from Google Drive. Cannot be undone.</span>
            </button>
          </div>
          {busy && <p className="text-[11px] text-mute">Working…</p>}
          {error && <p className="text-[11px] text-red-400">{error}</p>}
        </div>
      </div>
    </div>
  )
}

export function DriveAttachments({ task }) {
  const [dragging, setDragging] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState(null)
  const [localFiles, setLocalFiles] = useState([])
  const [removedIds, setRemovedIds] = useState(() => new Set())
  const [pendingDelete, setPendingDelete] = useState(null)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState(null)
  const inputRef = useRef(null)

  const persisted = task.output?.drive_files ?? []
  const allFiles = [...persisted, ...localFiles.filter(lf => !persisted.some(p => p.file_id === lf.file_id))]
    .filter(f => !removedIds.has(f.file_id))

  async function handleFiles(files) {
    if (!files.length) return
    setUploading(true)
    setError(null)
    try {
      for (const file of files) {
        const result = await uploadFileToDrive(file, task.id)
        setLocalFiles(prev => [...prev, { file_id: result.file_id, filename: result.filename, uploaded_at: new Date().toISOString() }])
      }
    } catch (e) {
      setError(e.message)
    } finally {
      setUploading(false)
    }
  }

  async function confirmDelete(mode) {
    if (!pendingDelete) return
    setDeleting(true)
    setDeleteError(null)
    try {
      await deleteDriveFile(task.id, pendingDelete.file_id, mode)
      setRemovedIds(prev => new Set(prev).add(pendingDelete.file_id))
      setLocalFiles(prev => prev.filter(f => f.file_id !== pendingDelete.file_id))
      if (task.output) task.output.drive_files = (task.output.drive_files ?? []).filter(f => f.file_id !== pendingDelete.file_id)
      setPendingDelete(null)
    } catch (e) {
      setDeleteError(e.message)
    } finally {
      setDeleting(false)
    }
  }

  return (
    <Field label="Drive files">
      {allFiles.length > 0 && (
        <div className="flex flex-col gap-1">
          {allFiles.map(f => (
            <div
              key={f.file_id}
              className="flex items-center gap-2 rounded-md border border-line-2 bg-surf-2 px-3 py-2 text-[12px] text-ink-2 group"
            >
              <a
                href={driveFileUrl(f.file_id)}
                target="_blank"
                rel="noreferrer"
                className="flex flex-1 min-w-0 items-center gap-2 hover:text-accent transition-colors"
              >
                <HardDrive className="h-3 w-3 shrink-0 text-mute group-hover:text-accent transition-colors" />
                <span className="flex-1 truncate">{f.filename}</span>
                <span className="shrink-0 text-mute text-[10px]">↗</span>
              </a>
              <button
                onClick={() => { setDeleteError(null); setPendingDelete(f) }}
                title="Remove file"
                className="shrink-0 rounded p-0.5 text-mute hover:text-red-500 hover:bg-red-500/10 transition-colors"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      )}
      {pendingDelete && (
        <DeleteFileDialog
          file={pendingDelete}
          busy={deleting}
          error={deleteError}
          onCancel={() => setPendingDelete(null)}
          onConfirm={confirmDelete}
        />
      )}
      <div
        onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => { e.preventDefault(); setDragging(false); handleFiles([...e.dataTransfer.files]) }}
        onClick={() => inputRef.current?.click()}
        className={clsx(
          'flex cursor-pointer items-center justify-center gap-1.5 rounded-md border border-dashed px-3 py-3 text-[12px] transition-colors',
          dragging ? 'border-accent bg-accent/[0.04] text-accent' : 'border-line text-mute hover:border-accent hover:text-accent',
        )}
      >
        <HardDrive className="h-3 w-3 shrink-0" />
        {uploading ? 'Uploading…' : 'Drop files or click to upload to Drive'}
      </div>
      <input ref={inputRef} type="file" multiple className="hidden" onChange={(e) => handleFiles([...e.target.files])} />
      {error && <p className="text-[11px] text-red-400">{error}</p>}
    </Field>
  )
}

export default function TaskDetailPanel({ taskId, onClose, onFocus, onMilestoneChange, project, onContextUpdate, onCalendarSync, sidebarCollapsed = false, noBackdrop = false, refreshKey = 0 }) {
  const ref = useRef(null)
  const messagesOnOpenRef = useRef(0)
  const task     = useTaskStore(s => s.tasks.find(t => t.id === taskId))
  const tasks    = useTaskStore(s => s.tasks)
  const sections = useTaskStore(s => s.sections)
  const groups   = useTaskStore(s => s.groups)

  const section = sections.find(s => s.id === task?.section_id)
  const group   = groups.find(g => g.id === task?.group_id)

  const {
    messages, setMessages, saveMessages,
    steps, setSteps,
    checkedSteps, setCheckedSteps,
    saveSteps, saveCheckedSteps,
    loading: discussionLoading,
    reload,
  } = useTaskDiscussion(taskId)

  useEffect(() => {
    if (refreshKey > 0) reload()
  }, [refreshKey])

  useEffect(() => {
    if (!discussionLoading) messagesOnOpenRef.current = messages.length
  }, [discussionLoading])

  function handleClose() {
    onClose()
  }

  const [chatInput, setChatInput]     = useState('')
  const [chatLoading, setChatLoading] = useState(false)
  const [genLoading, setGenLoading]   = useState(false)
  const [milestoneInput, setMilestoneInput] = useState('')
  const [dependencyWarning, setDependencyWarning] = useState(null)
  const [pendingUpdates, setPendingUpdates] = useState(null)
  const chatBottomRef = useRef(null)
  const chatInputRef  = useRef(null)

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))

  async function handleDragEnd(event) {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const oldIndex = (steps ?? []).findIndex((_, i) => `step-${i}` === active.id)
    const newIndex = (steps ?? []).findIndex((_, i) => `step-${i}` === over.id)
    if (oldIndex === -1 || newIndex === -1) return
    const newSteps   = arrayMove(steps, oldIndex, newIndex)
    const newChecked = arrayMove(checkedSteps ?? [], oldIndex, newIndex)
    setSteps(newSteps)
    setCheckedSteps(newChecked)
    await saveSteps(newSteps, newChecked)
    onMilestoneChange?.(task.id, newSteps, newChecked)
  }

  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape') handleClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [messages])

  useEffect(() => {
    const prev = document.activeElement
    return () => prev?.focus?.()
  }, [taskId])

  useEffect(() => {
    chatBottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, chatLoading])

  if (!task) return null

  async function patch(updates) {
    await updateTaskFields(task.id, updates, (warning) => {
      setDependencyWarning(warning)
      setPendingUpdates(updates)
    })
  }

  async function handleProceedWithDependencyWarning() {
    if (!pendingUpdates) return
    const u = pendingUpdates
    setDependencyWarning(null)
    setPendingUpdates(null)
    await updateTaskFields(task.id, u)
  }

  // ── Milestones ────────────────────────────────────────────────
  const milestoneTotal = steps?.length ?? 0
  const milestoneDone  = (checkedSteps ?? []).filter(Boolean).length
  const milestonePct   = milestoneTotal > 0 ? Math.round((milestoneDone / milestoneTotal) * 100) : 0

  async function addMilestone() {
    const text = milestoneInput.trim()
    if (!text) return
    const newSteps   = [...(steps ?? []), { summary: text, detail: '' }]
    const newChecked = [...(checkedSteps ?? []), false]
    setSteps(newSteps)
    setCheckedSteps(newChecked)
    setMilestoneInput('')
    await saveSteps(newSteps, newChecked)
    onMilestoneChange?.(task.id, newSteps, newChecked)
  }

  async function toggleMilestone(i) {
    const updated = (checkedSteps ?? []).map((v, idx) => idx === i ? !v : v)
    setCheckedSteps(updated)
    await saveCheckedSteps(updated)
    onMilestoneChange?.(task.id, steps, updated)
  }

  async function deleteMilestone(i) {
    const newSteps   = (steps ?? []).filter((_, idx) => idx !== i)
    const newChecked = (checkedSteps ?? []).filter((_, idx) => idx !== i)
    setSteps(newSteps)
    setCheckedSteps(newChecked)
    await saveSteps(newSteps, newChecked)
    onMilestoneChange?.(task.id, newSteps, newChecked)
  }

  async function generateMilestones() {
    setGenLoading(true)
    try {
      const generated = await generateFocusSteps(task, tasks).catch(() => null)
      if (Array.isArray(generated) && generated.length) {
        const newChecked = new Array(generated.length).fill(false)
        setSteps(generated)
        setCheckedSteps(newChecked)
        await saveSteps(generated, newChecked)
        onMilestoneChange?.(task.id, generated, newChecked)
      }
    } finally {
      setGenLoading(false)
    }
  }

  // ── AI Chat ───────────────────────────────────────────────────
  async function sendChat(e) {
    e?.preventDefault()
    const trimmed = chatInput.trim()
    if (!trimmed || chatLoading) return
    const updated = [...messages, { role: 'user', content: trimmed }]
    setMessages(updated)
    await saveMessages(updated)
    setChatInput('')
    setChatLoading(true)
    try {
      const reply = await chatAboutTask(updated, task, steps, checkedSteps, null, tasks)
      const withReply = [...updated, { role: 'assistant', content: reply }]
      setMessages(withReply)
      await saveMessages(withReply)
    } catch {
      const withErr = [...updated, { role: 'assistant', content: 'Something went wrong. Try again.' }]
      setMessages(withErr)
      await saveMessages(withErr)
    } finally {
      setChatLoading(false)
    }
  }

  return (
    <>
      {!noBackdrop && (
        <div
          className="fixed inset-y-0 left-0 z-40 bg-ink/[0.12] animate-fade-in"
          style={{ right: sidebarCollapsed ? 380 : 380 + 288 }}
          onClick={handleClose}
        />
      )}
      <aside
        ref={ref}
        role="dialog"
        aria-label="Task detail"
        className="fixed inset-y-0 z-50 flex w-[380px] flex-col border-l border-line bg-paper shadow-panel animate-slide-in-right"
        style={{ right: sidebarCollapsed ? 0 : 288, transition: 'right 0.2s ease' }}
      >
        {/* Header */}
        <header className="flex items-center justify-between gap-3 border-b border-line-2 px-4.5 pb-3 pt-4 shrink-0">
          <div className="font-mono text-[10px] uppercase tracking-[0.08em] text-mute truncate flex items-center gap-1.5">
            {project?.prefix && task.short_id != null && (
              <span className="border border-line rounded px-1 py-px text-mute-2 shrink-0">
                {project.prefix}-{task.short_id}
              </span>
            )}
            <span className="font-medium text-ink-2">{section?.name}</span>
            {' · '}
            {group?.name ?? 'Ungrouped'}
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            {onFocus && (
              <button
                className="icon-btn-focus"
                onClick={() => onFocus(task.id)}
                title="Open in Focus mode"
              >
                <Crosshair className="h-3.5 w-3.5" />
              </button>
            )}
            <button className="icon-btn"><MoreHorizontal className="h-3.5 w-3.5" /></button>
            <button className="icon-btn" onClick={handleClose} title="Close">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </header>

        {/* Scrollable body */}
        <div className="flex flex-1 flex-col gap-5 overflow-y-auto p-4.5">

          {/* Title */}
          <h2
            contentEditable
            suppressContentEditableWarning
            spellCheck={false}
            onBlur={(e) => {
              const text = e.currentTarget.textContent?.trim()
              if (text && text !== task.text) patch({ text })
            }}
            className="m-0 border-b border-dashed border-transparent text-[19px] font-semibold leading-tight tracking-[-0.01em] outline-none focus:border-accent"
          >
            {task.text}
          </h2>

          {task.kind === 'seed' && (
            <div className="rounded-lg border border-dashed border-accent/50 bg-accent/[0.04] px-3.5 py-3">
              <div className="text-[10px] font-bold uppercase tracking-[0.06em] text-accent mb-1.5">⚑ Seed → {task.seed_target}</div>
              <p className="text-[12px] text-ink-2 leading-relaxed mb-2">
                A placeholder, not work to do directly. Resolve it with your agent in Claude Code —{' '}
                {task.seed_target === 'flow'
                  ? <>it runs <span className="font-mono">build_new_flow</span> from the pre-brief below.</>
                  : <>settle the checklist below, then it calls <span className="font-mono">resolve_seed</span> to create the real, placed task.</>}
                {' '}Checklist items tagged <span className="font-mono text-accent">prereq</span> should be done first; open <span className="font-mono">Q</span>s are answered while resolving.
              </p>
              {/* Legacy: seeds created before the TDE-300 merge stored questions here.
                  New seeds fold them into the milestone checklist below (typed). */}
              {Array.isArray(task.seed_open_questions) && task.seed_open_questions.length > 0 && (
                <div>
                  <div className="text-[9px] font-mono uppercase tracking-widest text-mute-2 mb-1">Open questions</div>
                  <ul className="flex flex-col gap-1">
                    {task.seed_open_questions.map((q, i) => (
                      <li key={i} className="text-[12px] text-ink-2 flex gap-1.5"><span className="text-accent">•</span><span>{q}</span></li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          {task.spawned_from_seed_id && (
            <p className="text-[11px] text-mute-2">↳ created from a resolved seed</p>
          )}

          {task.delegated_to && (
            <div className="flex items-center gap-2 rounded-md border border-line-2 bg-surf-2 px-3 py-2">
              <span className="font-mono text-[9px] uppercase tracking-[0.1em] text-mute shrink-0">Delegated to</span>
              <span className="text-[12px] font-medium text-ink-2 truncate">{task.delegated_to}</span>
              <span className="ml-auto shrink-0 text-[10px] text-mute-2">you own the gate</span>
            </div>
          )}

          <Field label="Status">
            <StatusSegmented value={task.status} onChange={(v) => patch({ status: v })} />
          </Field>

          <CustomStatusField task={task} />

          <Field label="Priority">
            <PrioritySegmented value={task.priority} onChange={(v) => patch({ priority: v })} />
          </Field>

          <Field label="Due date">
            <div className="flex items-center gap-2.5 rounded-md border border-line-2 bg-surf-2 px-3 py-2.5">
              <Calendar className="h-3.5 w-3.5 shrink-0 text-mute" />
              <input
                type="date"
                value={task.due_date || ''}
                onChange={(e) => {
                  const due_date = e.target.value || null
                  patch({ due_date })
                  if (due_date) onCalendarSync?.({ ...task, due_date })
                }}
                className="flex-1 bg-transparent font-mono text-xs text-ink-2 outline-none"
              />
              {task.due_date && (
                <span className="font-mono text-[11px] text-mute">{toRelative(task.due_date)}</span>
              )}
            </div>
          </Field>

          <Field label="Context">
            <textarea
              defaultValue={task.detail || ''}
              key={task.id}
              onBlur={(e) => {
                const detail = e.currentTarget.value
                if (detail !== (task.detail || '')) patch({ detail })
              }}
              placeholder="Add context…"
              className="w-full min-h-[80px] rounded-md border border-line-2 bg-surf-2 p-3 font-sans text-[13px] leading-[1.55] text-ink-2 resize-y focus:outline-none focus:border-accent focus:bg-paper"
            />
          </Field>

          {task.review_verdict && (
            <Field label="Review verdict">
              <ReviewVerdictPanel verdict={task.review_verdict} bar={task.review_bar} />
            </Field>
          )}

          {/* ── Milestones ── */}
          <Field label={milestoneTotal > 0 ? `Milestones · ${milestonePct}%` : 'Milestones'}>
            {/* Progress bar */}
            {milestoneTotal > 0 && (
              <div className="h-1.5 w-full rounded-full bg-line-2 overflow-hidden -mt-0.5">
                <div
                  className="h-full rounded-full transition-all duration-300"
                  style={{ width: `${milestonePct}%`, background: '#D97757' }}
                />
              </div>
            )}

            {/* Generate button when empty */}
            {milestoneTotal === 0 && !discussionLoading && (
              <button
                onClick={generateMilestones}
                disabled={genLoading}
                className="w-full flex items-center justify-center gap-1.5 rounded-md border border-dashed border-line py-2.5 text-[12px] text-mute hover:border-accent hover:text-accent transition-colors disabled:opacity-50"
              >
                <Sparkles className="h-3 w-3" />
                {genLoading ? 'Generating…' : 'Generate with AI'}
              </button>
            )}

            {/* Steps list */}
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
              <SortableContext items={(steps ?? []).map((_, i) => `step-${i}`)} strategy={verticalListSortingStrategy}>
                {(steps ?? []).map((step, i) => (
                  <SortableMilestone
                    key={`step-${i}`}
                    id={`step-${i}`}
                    step={step}
                    checked={checkedSteps?.[i] ?? false}
                    onToggle={() => toggleMilestone(i)}
                    onDelete={() => deleteMilestone(i)}
                  />
                ))}
              </SortableContext>
            </DndContext>

            {/* Add milestone */}
            <form
              onSubmit={(e) => { e.preventDefault(); addMilestone() }}
              className="flex items-center gap-2 pt-1"
            >
              <input
                value={milestoneInput}
                onChange={e => setMilestoneInput(e.target.value)}
                placeholder="Add milestone…"
                className="flex-1 bg-transparent text-[12.5px] text-ink-2 placeholder:text-mute-2 outline-none py-1"
              />
              {milestoneInput.trim() && (
                <button type="submit" className="text-[11px] text-accent font-semibold shrink-0">
                  + Add
                </button>
              )}
            </form>
          </Field>

          <DriveAttachments task={task} />

          {/* ── Guidance for the agent (TDE-383): steering note picked up on next get_task ── */}
          <Field label="Guidance for the agent">
            <TaskGuidance taskId={task.id} />
          </Field>

          {/* ── Agent activity (TDE-374/375): durable, immutable record of what agents did ── */}
          <Field label="Agent activity">
            <AgentActivityPanel taskId={task.id} taskDone={task.status === 'done'} refreshKey={refreshKey} />
          </Field>

          {/* ── AI Agent ── */}
          <Field label="AI Agent">
            <div className="flex flex-col rounded-lg border border-line-2 overflow-hidden">
              {(messages.length > 0 || chatLoading) && (
                <div className="max-h-[200px] overflow-y-auto p-3 flex flex-col gap-2">
                  {messages.map((msg, i) => (
                    <div
                      key={i}
                      className={clsx(
                        'max-w-[85%] rounded-lg px-3 py-2 text-[12.5px] leading-[1.55]',
                        msg.role === 'user'
                          ? 'self-end bg-ink text-paper rounded-br-sm'
                          : 'self-start bg-surf-2 text-ink-2 rounded-bl-sm'
                      )}
                    >
                      {msg.content}
                    </div>
                  ))}
                  {chatLoading && (
                    <div className="self-start bg-surf-2 rounded-lg rounded-bl-sm px-3 py-2">
                      <span className="font-mono text-[11px] text-mute animate-pulse">···</span>
                    </div>
                  )}
                  <div ref={chatBottomRef} />
                </div>
              )}
              <form
                onSubmit={sendChat}
                className={clsx(
                  'flex items-center gap-2 px-3',
                  messages.length > 0 || chatLoading ? 'py-2 border-t border-line-2' : 'py-4'
                )}
              >
                <input
                  ref={chatInputRef}
                  value={chatInput}
                  onChange={e => setChatInput(e.target.value)}
                  placeholder="Ask anything about this task…"
                  disabled={chatLoading}
                  className="flex-1 bg-transparent text-[12.5px] text-ink-2 placeholder:text-mute-2 outline-none"
                />
                <button
                  type="submit"
                  disabled={!chatInput.trim() || chatLoading}
                  className="text-[14px] font-bold text-accent disabled:opacity-30 transition-opacity shrink-0"
                >
                  →
                </button>
              </form>
            </div>
          </Field>

        </div>
      </aside>
      <FlowBlockedDialog
        dependency={dependencyWarning}
        onProceed={handleProceedWithDependencyWarning}
        onCancel={() => { setDependencyWarning(null); setPendingUpdates(null) }}
      />
    </>
  )
}
