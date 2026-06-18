import { useEffect, useRef, useState } from 'react'
import { X, Calendar, MoreHorizontal, Crosshair, Sparkles, GripVertical } from 'lucide-react'
import clsx from 'clsx'
import { DndContext, closestCenter, PointerSensor, useSensor, useSensors } from '@dnd-kit/core'
import { SortableContext, useSortable, verticalListSortingStrategy, arrayMove } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { useTaskStore } from '../../store/useTaskStore'
import { updateTaskFields } from '../../hooks/useTasks'
import FlowBlockedDialog from './DependencyWarningDialog'
import ReviewVerdictPanel from './ReviewVerdictPanel'
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
