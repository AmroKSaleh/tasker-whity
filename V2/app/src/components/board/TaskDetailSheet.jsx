import { useEffect, useRef, useState } from 'react'
import { X, Calendar, Crosshair } from 'lucide-react'
import clsx from 'clsx'
import { useTaskStore } from '../../store/useTaskStore'
import { updateTaskFields } from '../../hooks/useTasks'
import { useSheetDrag } from './hooks/useSheetDrag'
import { useTaskDiscussion } from '../../hooks/useTaskDiscussion'
import { StatusSegmented, PrioritySegmented } from './TaskDetailPanel'
import FlowBlockedDialog from './DependencyWarningDialog'

function Field({ label, children }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="font-mono text-[10px] uppercase tracking-[0.1em] text-mute">{label}</div>
      {children}
    </div>
  )
}

export default function TaskDetailSheet({ taskId, onClose, onFocus, onMilestoneChange, project, onContextUpdate, refreshKey = 0, compact = false }) {
  const messagesOnOpenRef = useRef(0)

  function handleClose() {
    onClose()
  }

  const { handlers, style, dy, isDragging } = useSheetDrag(handleClose)
  const dragProgress = isDragging ? Math.min(1, dy / 220) : 0

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

  // Capture message count when discussion first loads
  useEffect(() => {
    if (!discussionLoading) messagesOnOpenRef.current = messages.length
  }, [discussionLoading])

  const [milestoneInput, setMilestoneInput] = useState('')
  const [dependencyWarning, setDependencyWarning] = useState(null)
  const [pendingUpdates, setPendingUpdates] = useState(null)

  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape') handleClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [messages])

  // Lock body scroll while sheet is open
  useEffect(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [])


  if (!task) return null

  async function patch(updates) {
    await updateTaskFields(task.id, updates, (warning) => {
      setDependencyWarning(warning)
      setPendingUpdates(updates)
    })
  }

  async function handleProceedWithDependencyWarning() {
    if (pendingUpdates) {
      setDependencyWarning(null)
      setPendingUpdates(null)
      useTaskStore.getState().updateTask(task.id, pendingUpdates)
      const { supabase } = await import('../../lib/supabase')
      await supabase.from('tasks').update(pendingUpdates).eq('id', task.id)
    }
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


  return (
    <>
      <div
        className={clsx(
          'fixed inset-0 z-40 animate-fade-in',
          compact ? 'bg-black/30' : 'bg-ink/30'
        )}
        style={{ opacity: compact ? 1 : 1 - dragProgress * 0.8 }}
        onClick={handleClose}
      />
      <div
        role="dialog"
        aria-label="Task detail"
        className={clsx(
          'fixed z-50 flex flex-col bg-paper shadow-sheet border border-line-2',
          compact
            ? 'bottom-0 left-1/2 w-[40vw] min-w-[480px] max-w-[720px] h-[70vh] min-h-[480px] rounded-t-xl overflow-hidden animate-card-rise'
            : 'inset-x-0 bottom-0 max-h-[92vh] rounded-t-sheet'
        )}
        style={
          compact
            ? undefined
            : { height: '88vh', paddingBottom: 'max(22px, env(safe-area-inset-bottom))', ...style }
        }
      >
        {!compact && (
          <div className="touch-none py-5 flex justify-center shrink-0 cursor-grab active:cursor-grabbing" {...handlers}>
            <div className="h-1 w-12 rounded-sm bg-line" />
          </div>
        )}

        <div className="flex flex-col gap-4 overflow-y-auto px-4 pb-6 pt-2">
          {/* Header row */}
          <div className="flex items-center justify-between gap-2">
            <div className="font-mono text-[10px] uppercase tracking-[0.08em] text-mute truncate">
              {project?.prefix && task.short_id != null && <span className="text-mute-2">{project.prefix}-{task.short_id} · </span>}
              <span className="font-medium text-ink-2">{section?.name}</span>
              {group?.name && <>{' · '}{group.name}</>}
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              {onFocus && (
                <button className="icon-btn-focus" onClick={() => onFocus(task.id)} title="Open in Focus mode">
                  <Crosshair className="h-3.5 w-3.5" />
                </button>
              )}
              <button className="icon-btn" onClick={handleClose}>
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>

          <h2
            contentEditable
            suppressContentEditableWarning
            spellCheck={false}
            onBlur={(e) => {
              const text = e.currentTarget.textContent?.trim()
              if (text && text !== task.text) patch({ text })
            }}
            className="m-0 text-[18px] font-semibold leading-tight tracking-[-0.01em] outline-none"
          >
            {task.text}
          </h2>

          <Field label="Status">
            <StatusSegmented value={task.status} onChange={(v) => patch({ status: v })} />
          </Field>

          <Field label="Priority">
            <PrioritySegmented value={task.priority} onChange={(v) => patch({ priority: v })} />
          </Field>

          <Field label="Due date">
            <div className="flex items-center gap-2.5 rounded-md border border-line-2 bg-surf-2 px-3 py-2.5">
              <Calendar className="h-3.5 w-3.5 shrink-0 text-mute" />
              <input
                type="date"
                value={task.due_date || ''}
                onChange={(e) => patch({ due_date: e.target.value || null })}
                className="flex-1 bg-transparent font-mono text-xs text-ink-2 outline-none"
              />
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

          {/* ── Milestones ── */}
          <Field label={milestoneTotal > 0 ? `Milestones · ${milestonePct}%` : 'Milestones'}>
            {milestoneTotal > 0 && (
              <div className="h-1.5 w-full rounded-full bg-line-2 overflow-hidden -mt-0.5">
                <div
                  className="h-full rounded-full transition-all duration-300"
                  style={{ width: `${milestonePct}%`, background: '#D97757' }}
                />
              </div>
            )}
            {(steps ?? []).map((step, i) => (
              <div key={i} className="flex items-start gap-2.5 py-1.5 border-b border-line-2 last:border-0 group/step">
                <button
                  onClick={() => toggleMilestone(i)}
                  style={{
                    width: 15, height: 15, borderRadius: 3, flexShrink: 0, marginTop: 1,
                    border: `1.25px solid ${checkedSteps?.[i] ? '#D97757' : 'var(--color-line)'}`,
                    background: checkedSteps?.[i] ? '#D97757' : 'var(--color-paper)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
                    transition: 'background 0.15s, border-color 0.15s',
                  }}
                >
                  {checkedSteps?.[i] && (
                    <span style={{ color: '#fff', fontSize: 8, fontWeight: 900, lineHeight: 1 }}>✓</span>
                  )}
                </button>
                <span className={clsx(
                  'flex-1 text-[12.5px] leading-snug',
                  checkedSteps?.[i] ? 'text-mute line-through' : 'text-ink-2'
                )}>
                  {step.summary}
                </span>
                <button
                  onClick={() => deleteMilestone(i)}
                  className="opacity-0 group-hover/step:opacity-100 btn-delete transition-opacity shrink-0"
                >
                  ×
                </button>
              </div>
            ))}
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

        </div>
      </div>

      <FlowBlockedDialog
        dependency={dependencyWarning}
        onProceed={handleProceedWithDependencyWarning}
        onCancel={() => {
          setDependencyWarning(null)
          setPendingUpdates(null)
        }}
      />
    </>
  )
}
