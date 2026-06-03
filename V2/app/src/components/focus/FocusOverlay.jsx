import { useEffect, useState, useRef } from 'react'
import clsx from 'clsx'
import { Clock, X, Sparkles, Check, ChevronDown, ArrowRight } from 'lucide-react'
import { rankTasks } from '../../lib/scoring'
import { generateFocusReason, generateFocusSteps, chatAboutTask, synthesizeTaskToContext } from '../../lib/gemini'
import { useTaskDiscussion } from '../../hooks/useTaskDiscussion'
import { updateTaskFields } from '../../hooks/useTasks'
import { Kicker } from '../editorial/atoms'

function StepAccordion({ steps, checkedSteps, onToggleCheck, onDiscussStep }) {
  const [openIndex, setOpenIndex] = useState(0)
  return (
    <div className="flex flex-col">
      {steps.map((step, i) => {
        const isOpen = openIndex === i
        const isChecked = checkedSteps[i] ?? false
        return (
          <div key={i} className="border-b border-line-2">
            <div className="flex items-center gap-3 py-3 cursor-pointer" onClick={() => setOpenIndex(isOpen ? null : i)}>
              <input
                type="checkbox"
                className="tcheck"
                checked={isChecked}
                onClick={e => e.stopPropagation()}
                onChange={() => onToggleCheck(i)}
              />
              <span className="font-mono text-[10.5px] text-mute-2 shrink-0 min-w-[18px]">{String(i + 1).padStart(2, '0')}</span>
              <span className={clsx(
                'flex-1 text-[13.5px] leading-5 transition-colors',
                isChecked ? 'text-mute-2 line-through' : 'text-ink-2',
              )}>{step.summary}</span>
              <ChevronDown size={13} className={clsx('text-mute-2 transition-transform', isOpen && 'rotate-180')} />
            </div>
            {isOpen && (
              <div className="pl-[50px] pr-1 pb-3.5">
                <p className="text-[12px] leading-[18px] text-mute mb-2.5">{step.detail}</p>
                <button onClick={() => onDiscussStep(i, step)} className="font-mono text-[10px] tracking-[0.08em] uppercase text-accent font-semibold">
                  ✦ Discuss this step
                </button>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

const TOP_SINCE_KEY = id => `tasker_top_since_${id}`
const PIN_DISMISSED_KEY = id => `tasker_pin_dismissed_${id}`

export default function FocusOverlay({ tasks, project, onClose, onContextUpdate, onPinTask, onToggleDone, initialTaskId }) {
  const messagesOnOpenRef = useRef(0)

  const [nudgeDismissed, setNudgeDismissed] = useState(false)
  const [switchedToTop, setSwitchedToTop] = useState(false)
  const [pinPromptDismissed, setPinPromptDismissed] = useState(false)
  const [suggestPinDismissed, setSuggestPinDismissed] = useState(false)

  const ranked = rankTasks(tasks.filter(t => t.status !== 'done'))
  const topTask = ranked[0]
  const requestedTask = initialTaskId
    ? (tasks.find(t => t.id === initialTaskId) ?? topTask)
    : topTask
  const task = switchedToTop ? topTask : requestedTask
  const projectLabel = project?.prefix || project?.name || ''

  const showNudge = Boolean(initialTaskId)
    && !nudgeDismissed
    && Boolean(topTask)
    && Boolean(requestedTask)
    && requestedTask.id !== topTask.id

  const pinnedDaysAgo = task?.pinned && task?.pinned_at
    ? Math.floor((Date.now() - new Date(task.pinned_at).getTime()) / (1000 * 60 * 60 * 24))
    : 0
  const showPinPrompt = Boolean(task?.pinned) && !task?.pin_snoozed
    && pinnedDaysAgo >= 7 && !pinPromptDismissed

  useEffect(() => {
    if (!topTask || showNudge || topTask.pinned) return
    if (!localStorage.getItem(TOP_SINCE_KEY(topTask.id))) {
      localStorage.setItem(TOP_SINCE_KEY(topTask.id), new Date().toISOString())
    }
  }, [topTask?.id, showNudge])

  const topSinceRaw = topTask ? localStorage.getItem(TOP_SINCE_KEY(topTask.id)) : null
  const daysAsTop = topSinceRaw
    ? Math.floor((Date.now() - new Date(topSinceRaw).getTime()) / 86400000)
    : 0
  const showSuggestPin = Boolean(topTask)
    && !topTask.pinned
    && !showNudge
    && daysAsTop >= 3
    && !suggestPinDismissed
    && !localStorage.getItem(PIN_DISMISSED_KEY(topTask?.id))

  const [aiLoading, setAiLoading] = useState(false)
  const [regenerating, setRegenerating] = useState(false)
  const [showSheet, setShowSheet] = useState(false)
  const [chatInput, setChatInput] = useState('')
  const [chatLoading, setChatLoading] = useState(false)
  const [timerHidden, setTimerHidden] = useState(false)
  const [elapsedSeconds, setElapsedSeconds] = useState(0)
  const chatBottomRef = useRef(null)
  const chatInputRef = useRef(null)

  const {
    messages, setMessages, saveMessages,
    steps, setSteps,
    checkedSteps, setCheckedSteps,
    reason, setReason,
    saveStepsAndReason, saveCheckedSteps,
    loading: discussionLoading,
  } = useTaskDiscussion(task?.id)

  useEffect(() => {
    if (!discussionLoading) messagesOnOpenRef.current = messages.length
  }, [discussionLoading])

  function handleClose() {
    onClose()
  }

  useEffect(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [])

  useEffect(() => {
    if (timerHidden) return
    const interval = setInterval(() => {
      setElapsedSeconds(s => s + 1)
    }, 1000)
    return () => clearInterval(interval)
  }, [timerHidden])

  useEffect(() => {
    const handler = e => {
      if (e.key === 'Escape') {
        if (showSheet) setShowSheet(false)
        else handleClose()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose, showSheet])

  // Focus plan is generated on demand via the "Generate plan with AI" button,
  // not auto-fired on entry — avoids a silent inference cost every focus session.

  useEffect(() => {
    chatBottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, chatLoading])

  async function toggleCheck(index) {
    const updated = checkedSteps.map((v, i) => i === index ? !v : v)
    setCheckedSteps(updated)
    await saveCheckedSteps(updated)
  }

  async function handleRegenerate() {
    setRegenerating(true)
    try {
      const [r, s] = await Promise.all([
        generateFocusReason(task, tasks, messages, project?.context).catch(() => null),
        generateFocusSteps(task, tasks, messages, project?.context).catch(() => null),
      ])
      const arr = Array.isArray(s) ? s : null
      const checked = arr ? new Array(arr.length).fill(false) : []
      setReason(r)
      setSteps(arr)
      setCheckedSteps(checked)
      await saveStepsAndReason(arr, checked, r)
    } finally {
      setRegenerating(false)
    }
  }

  async function handleDeprioritize() {
    await updateTaskFields(task.id, { priority: null, skip_count: (task.skip_count || 0) + 1 })
    onClose()
  }

  async function handleChatSend(e) {
    e?.preventDefault()
    const trimmed = chatInput.trim()
    if (!trimmed || chatLoading) return
    const updated = [...messages, { role: 'user', content: trimmed }]
    setMessages(updated)
    await saveMessages(updated)
    setChatInput('')
    setChatLoading(true)
    try {
      const reply = await chatAboutTask(updated, task, steps, checkedSteps, project?.context, tasks)
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

  function handleOpenSheet() {
    setShowSheet(true)
    setTimeout(() => chatInputRef.current?.focus(), 300)
  }

  async function handleDiscussStep(stepIndex, step) {
    setShowSheet(true)
    const content = `Help me walk through step ${stepIndex + 1}: "${step.summary}"`
    const updated = [...messages, { role: 'user', content }]
    setMessages(updated)
    await saveMessages(updated)
    setChatLoading(true)
    try {
      const reply = await chatAboutTask(updated, task, steps, checkedSteps, project?.context, tasks)
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

  async function handleSnoozePin() {
    setPinPromptDismissed(true)
    await updateTaskFields(task.id, { pin_snoozed: true })
  }

  const hasAiResponse = messages.some(m => m.role === 'assistant')

  const today = new Date().toISOString().slice(0, 10)
  const titleMeta = task ? [
    task.priority && `${task.priority.toUpperCase()} PRIORITY`,
    task.due_date && (task.due_date === today ? 'DUE TODAY' : `DUE ${new Date(task.due_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }).toUpperCase()}`),
  ].filter(Boolean) : []

  return (
    <div data-focus="true" className="fixed inset-0 z-50 overflow-hidden bg-paper text-ink">
      {/* Ambient vignette */}
      <div className="absolute inset-0 pointer-events-none" style={{ background: 'radial-gradient(ellipse 70% 50% at 50% 40%, rgba(217,119,87,0.06), transparent 70%)' }} />
      <div className="absolute inset-0 pointer-events-none" style={{ background: 'radial-gradient(ellipse 100% 80% at 50% 100%, rgba(0,0,0,0.6), transparent 50%)' }} />

      {/* Top bar */}
      <header className="relative z-[2] flex items-center justify-between px-8 py-5">
        <Kicker>FOCUS{projectLabel ? ` · ${projectLabel}` : ''}</Kicker>
        <div className="flex items-center gap-1">
          {!timerHidden ? (
            <button onClick={() => setTimerHidden(true)} className="btn btn-sm btn-ghost text-mute">
              <Clock size={12} /> {String(Math.floor(elapsedSeconds / 60)).padStart(2, '0')}:{String(elapsedSeconds % 60).padStart(2, '0')}
            </button>
          ) : (
            <button onClick={() => setTimerHidden(false)} className="w-[52px] h-[26px]" aria-label="Show timer" />
          )}
          <button className="icon-btn text-ink-2" onClick={handleClose} aria-label="Close focus mode"><X size={16} /></button>
        </div>
      </header>

      {/* Main */}
      <main className="no-scrollbar relative z-[1] overflow-auto px-8 pb-10" style={{ height: 'calc(100% - 60px)' }}>
        <div className="max-w-[680px] mx-auto text-center pt-6">

          {!task ? (
            <div className="py-16">
              <p className="text-ink text-2xl font-extrabold mb-2">All clear</p>
              <p className="text-mute text-[13px]">No actionable tasks right now.</p>
            </div>

          ) : showNudge ? (
            <div className="pt-8 text-left max-w-[520px] mx-auto">
              <Kicker className="mb-4">
                {topTask.pinned ? <><span className="text-star">★</span> YOUR MANUALLY PINNED PRIORITY</> : 'YOUR TOP PRIORITY RIGHT NOW'}
              </Kicker>
              <h1 className="text-ink font-extrabold leading-tight tracking-[-0.02em] mb-9" style={{ fontSize: 34 }}>{topTask.text}</h1>
              <div className="flex flex-col gap-2.5">
                <button onClick={() => { setSwitchedToTop(true); setNudgeDismissed(true) }} className="btn-focus justify-start h-[38px]">
                  Go to the top priority task instead
                </button>
                <button
                  onClick={() => { setNudgeDismissed(true); updateTaskFields(topTask.id, { skip_count: (topTask.skip_count || 0) + 1 }) }}
                  className="btn justify-start h-[38px] border-line text-ink-2"
                >Continue anyway</button>
              </div>
            </div>

          ) : (
            <>
              {showPinPrompt && (
                <div className="text-left mb-7 p-4 rounded-lg bg-surf border border-line">
                  <p className="text-accent text-[12px] font-semibold mb-1"><span className="text-star">★</span> Pinned {pinnedDaysAgo} days ago</p>
                  <p className="text-mute text-[13px] mb-3">Is this still your top priority?</p>
                  <div className="flex gap-2.5 flex-wrap">
                    <button onClick={() => setPinPromptDismissed(true)} className="btn-focus btn-sm">Yes, keep it</button>
                    <button onClick={() => { setPinPromptDismissed(true); handleOpenSheet() }} className="btn btn-sm border-line text-ink-2">Let's discuss</button>
                    <button onClick={handleSnoozePin} className="btn btn-sm btn-ghost text-mute-2">Don't show again</button>
                  </div>
                </div>
              )}

              {showSuggestPin && (
                <div className="text-left mb-7 p-4 rounded-lg bg-surf border border-line">
                  <p className="text-accent text-[12px] font-semibold mb-1">Top priority for {daysAsTop} day{daysAsTop !== 1 ? 's' : ''}</p>
                  <p className="text-mute text-[13px] mb-3">Want to commit to this task and pin it to the top?</p>
                  <div className="flex gap-2.5">
                    <button
                      onClick={() => { onPinTask?.(topTask.id); localStorage.removeItem(TOP_SINCE_KEY(topTask.id)); setSuggestPinDismissed(true) }}
                      className="btn-focus btn-sm"
                    ><span className="text-star">★</span> Pin it</button>
                    <button
                      onClick={() => { localStorage.setItem(PIN_DISMISSED_KEY(topTask.id), '1'); setSuggestPinDismissed(true) }}
                      className="btn btn-sm btn-ghost text-mute-2"
                    >Not now</button>
                  </div>
                </div>
              )}

              {/* Title */}
              <Kicker className="justify-center mb-3.5"><span className="text-mute-2">★ ONE THING</span></Kicker>
              <h1 className="text-ink font-extrabold m-0" style={{ fontSize: 38, lineHeight: 1.1, letterSpacing: '-0.03em', textWrap: 'balance' }}>
                {task.text}
              </h1>
              {(titleMeta.length > 0 || task.pinned) && (
                <div className="flex justify-center items-center gap-4 mt-4 text-mute">
                  {titleMeta.map((m, i) => (
                    <span key={i} className="font-mono text-[10.5px] tracking-[0.1em]">{m}</span>
                  ))}
                  {task.pinned && <span className="font-mono text-[10.5px] tracking-[0.1em] text-star">★ PINNED</span>}
                </div>
              )}

              {/* Why */}
              <section className="text-left mt-11 p-[22px] rounded-2xl border border-line-2" style={{ background: 'rgba(255,255,255,0.025)' }}>
                <div className="flex items-center gap-1.5 mb-2.5 text-accent">
                  <Sparkles size={12} />
                  <Kicker className="text-accent">WHY THIS IS YOUR FOCUS</Kicker>
                </div>
                {aiLoading || discussionLoading ? (
                  <p className="font-mono text-[10px] text-mute animate-pulse">Thinking…</p>
                ) : reason ? (
                  <p className="m-0 text-[14px] leading-[22px] text-ink-2">{reason}</p>
                ) : (
                  <p className="text-mute-2 text-[13px]">—</p>
                )}
              </section>

              {/* Steps */}
              <section className="mt-7 text-left">
                <div className="flex items-baseline justify-between mb-3">
                  <Kicker count={steps?.length}>WHAT TO DO</Kicker>
                  {hasAiResponse && (
                    <button onClick={handleRegenerate} disabled={regenerating} className="btn btn-sm btn-ghost text-mute px-1.5">
                      <Sparkles size={11} /> {regenerating ? 'Updating…' : 'Regenerate'}
                    </button>
                  )}
                </div>
                {aiLoading || discussionLoading ? (
                  <p className="font-mono text-[10px] text-mute animate-pulse">Generating steps…</p>
                ) : steps?.length ? (
                  <StepAccordion steps={steps} checkedSteps={checkedSteps} onToggleCheck={toggleCheck} onDiscussStep={handleDiscussStep} />
                ) : (
                  <button onClick={handleRegenerate} disabled={regenerating} className="btn btn-sm btn-ghost text-accent px-1.5">
                    <Sparkles size={11} /> {regenerating ? 'Generating…' : 'Generate plan with AI'}
                  </button>
                )}
              </section>

              {/* Actions */}
              <div className="flex justify-center gap-2 mt-10 pt-7 border-t border-line-2">
                <button onClick={() => { onToggleDone(task); onClose() }} className="btn-focus h-[38px] px-[18px]">
                  <Check size={14} /> Mark as done
                </button>
                <button onClick={handleDeprioritize} className="btn h-[38px] px-4 border-line text-ink-2">
                  Skip — show me later
                </button>
                <button onClick={handleOpenSheet} className="btn btn-ghost h-[38px] px-4 text-mute">
                  <Sparkles size={13} /> Discuss this task
                </button>
              </div>
            </>
          )}
        </div>
      </main>

      {/* Discussion sheet */}
      {showSheet && task && (
        <div className="absolute inset-0 z-30 bg-black/40" onClick={() => setShowSheet(false)}>
          <div
            onClick={e => e.stopPropagation()}
            className="animate-sheet-up absolute inset-x-0 bottom-0 h-[75%] flex flex-col rounded-t-2xl border-t border-line"
            style={{ background: '#0f0f0f', boxShadow: '0 -8px 24px rgba(0,0,0,0.5)' }}
          >
            <div className="flex items-center justify-between px-8 py-3.5 border-b border-line-2 shrink-0">
              <div>
                <Kicker className="text-accent">✦ DISCUSS THIS TASK</Kicker>
                <div className="text-[13px] font-semibold text-ink-2 mt-1 truncate max-w-[420px]">{task.text}</div>
              </div>
              <div className="flex items-center gap-3.5">
                {hasAiResponse && (
                  <button onClick={handleRegenerate} disabled={regenerating} className="font-mono text-[10px] tracking-[0.08em] uppercase text-mute font-semibold">
                    {regenerating ? 'Updating…' : '↺ Update plan'}
                  </button>
                )}
                <button className="icon-btn text-ink-2" onClick={() => setShowSheet(false)}><X size={14} /></button>
              </div>
            </div>

            <div className="flex-1 overflow-auto px-8 py-5 flex flex-col gap-4">
              {messages.length === 0 ? (
                <p className="text-mute-2 text-[13px] text-center mt-6">Ask anything about this task.</p>
              ) : messages.map((msg, i) => (
                <div key={i} className={clsx('flex', msg.role === 'user' ? 'justify-end' : 'justify-start')}>
                  <div className={clsx(
                    'max-w-[70%] px-3.5 py-2.5 rounded-xl text-[13px] leading-[19px]',
                    msg.role === 'user' ? 'bg-accent text-white' : 'bg-surf border border-line-2 text-ink-2',
                  )}>{msg.content}</div>
                </div>
              ))}
              {chatLoading && (
                <div className="flex justify-start">
                  <div className="bg-surf border border-line-2 rounded-xl px-3.5 py-2.5">
                    <span className="font-mono text-[11px] text-mute animate-pulse">···</span>
                  </div>
                </div>
              )}
              <div ref={chatBottomRef} />
            </div>

            <form onSubmit={handleChatSend} className="flex gap-2 mx-8 mb-6 px-3.5 py-3 rounded-[10px] bg-surf border border-line-2 shrink-0">
              <input
                ref={chatInputRef}
                value={chatInput}
                onChange={e => setChatInput(e.target.value)}
                placeholder="Reply to the assistant…"
                disabled={chatLoading}
                className="flex-1 bg-transparent border-0 outline-none text-ink text-[13px] placeholder:text-mute-2"
              />
              <button type="submit" disabled={!chatInput.trim() || chatLoading} className="icon-btn-focus w-[26px] h-[26px] disabled:opacity-30">
                <ArrowRight size={13} />
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
