import { useEffect, useState, useRef } from 'react'
import { rankTasks } from '../../lib/scoring'
import { generateFocusReason, generateFocusSteps, chatAboutTask } from '../../lib/gemini'
import { useTaskDiscussion } from '../../hooks/useTaskDiscussion'
import { updateTaskFields } from '../../hooks/useTasks'

function StepAccordion({ steps, checkedSteps, onToggleCheck, onDiscussStep }) {
  const [openIndex, setOpenIndex] = useState(null)

  return (
    <div>
      {steps.map((step, i) => {
        const isOpen = openIndex === i
        const isChecked = checkedSteps[i] ?? false
        return (
          <div key={i} style={{ borderBottom: '1px solid #1a1a1a' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 0' }}>
              <button
                onClick={() => onToggleCheck(i)}
                style={{
                  width: 18, height: 18, borderRadius: '50%',
                  border: `1.5px solid ${isChecked ? '#fff' : '#3a3a3a'}`,
                  background: isChecked ? '#fff' : 'transparent',
                  flexShrink: 0, cursor: 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}
              >
                {isChecked && <span style={{ color: '#000', fontSize: 9, fontWeight: 900, lineHeight: 1 }}>✓</span>}
              </button>
              <button
                onClick={() => setOpenIndex(isOpen ? null : i)}
                style={{
                  flex: 1, display: 'flex', alignItems: 'center', gap: 14,
                  background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left', padding: 0,
                }}
              >
                <span style={{
                  color: isChecked ? '#333' : (isOpen ? '#ccc' : '#888'),
                  fontSize: 13, fontWeight: 500, flex: 1, lineHeight: 1.4,
                  textDecoration: isChecked ? 'line-through' : 'none',
                  transition: 'color 0.15s',
                }}>
                  {step.summary}
                </span>
                <span className="font-mono text-[9px] shrink-0" style={{ color: '#3a3a3a' }}>
                  {isOpen ? '▲' : '▼'}
                </span>
              </button>
            </div>
            {isOpen && (
              <div style={{ paddingBottom: 12, paddingLeft: 28 }}>
                <p style={{ color: '#666', fontSize: 13, lineHeight: 1.7, marginBottom: 10 }}>
                  {step.detail}
                </p>
                <button
                  onClick={() => onDiscussStep(i, step)}
                  style={{
                    fontSize: 11, fontWeight: 600, color: '#444',
                    background: 'none', border: 'none', cursor: 'pointer',
                    padding: 0, transition: 'color 0.15s',
                  }}
                  onMouseEnter={e => e.target.style.color = '#888'}
                  onMouseLeave={e => e.target.style.color = '#444'}
                >✦ Discuss this step</button>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

export default function FocusOverlay({ tasks, project, onClose, onToggleDone }) {
  const ranked = rankTasks(tasks)
  const task = ranked[0]
  const projectLabel = project?.description || project?.name?.replace(/-/g, ' ') || ''

  const [aiLoading, setAiLoading] = useState(false)
  const [regenerating, setRegenerating] = useState(false)
  const [showSheet, setShowSheet] = useState(false)
  const [chatInput, setChatInput] = useState('')
  const [chatLoading, setChatLoading] = useState(false)
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

  // Scroll lock
  useEffect(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [])

  // ESC — collapse sheet first, then close overlay
  useEffect(() => {
    const handler = e => {
      if (e.key === 'Escape') {
        if (showSheet) setShowSheet(false)
        else onClose()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose, showSheet])

  // Generate reason + steps only if not persisted
  useEffect(() => {
    if (!task || discussionLoading) return
    if (steps !== null) return
    setAiLoading(true)
    Promise.all([
      generateFocusReason(task, tasks).catch(() => null),
      generateFocusSteps(task, tasks).catch(() => null),
    ]).then(([r, s]) => {
      const arr = Array.isArray(s) ? s : null
      const checked = arr ? new Array(arr.length).fill(false) : []
      setReason(r)
      setSteps(arr)
      setCheckedSteps(checked)
      saveStepsAndReason(arr, checked, r)
    }).finally(() => setAiLoading(false))
  }, [task?.id, discussionLoading])

  // Auto-scroll chat
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
        generateFocusReason(task, tasks, messages).catch(() => null),
        generateFocusSteps(task, tasks, messages).catch(() => null),
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
    await updateTaskFields(task.id, { priority: null })
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

  const hasAiResponse = messages.some(m => m.role === 'assistant')

  return (
    <div className="fixed inset-0 z-50 flex flex-col" style={{ background: '#000' }}>

      {/* Top bar */}
      <div className="flex items-center justify-between px-8 pt-8 pb-4 shrink-0">
        <div className="font-mono text-[9px] tracking-widest uppercase" style={{ color: '#444' }}>
          Focus · {projectLabel}
        </div>
        <button
          onClick={onClose}
          style={{ color: '#555', fontSize: 22, lineHeight: 1, background: 'none', border: 'none', cursor: 'pointer' }}
          aria-label="Close focus mode"
        >×</button>
      </div>

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto px-8 pb-16">
        <div style={{ maxWidth: 620, width: '100%', margin: '0 auto' }}>
          {!task ? (
            <div className="text-center py-16">
              <p style={{ color: '#fff', fontSize: 24, fontWeight: 800, marginBottom: 8 }}>All clear</p>
              <p style={{ color: '#555', fontSize: 13 }}>No actionable tasks in this project.</p>
            </div>
          ) : (
            <>
              <h1 style={{ color: '#fff', fontSize: 34, fontWeight: 800, lineHeight: 1.2, letterSpacing: '-0.4px', marginBottom: 28 }}>
                {task.text}
              </h1>

              {/* Why */}
              <div style={{ marginBottom: 28 }}>
                <p className="font-mono text-[9px] tracking-widest uppercase" style={{ color: '#3a3a3a', marginBottom: 10 }}>
                  Why this is your focus
                </p>
                {aiLoading || discussionLoading ? (
                  <p className="font-mono text-[10px] animate-pulse" style={{ color: '#444' }}>Thinking…</p>
                ) : reason ? (
                  <p style={{ color: '#888', fontSize: 14, lineHeight: 1.7 }}>{reason}</p>
                ) : (
                  <p style={{ color: '#444', fontSize: 13 }}>—</p>
                )}
              </div>

              {/* Steps */}
              <div style={{ marginBottom: 36 }}>
                <p className="font-mono text-[9px] tracking-widest uppercase" style={{ color: '#3a3a3a', marginBottom: 10 }}>
                  What to do
                </p>
                {aiLoading || discussionLoading ? (
                  <p className="font-mono text-[10px] animate-pulse" style={{ color: '#444' }}>Generating steps…</p>
                ) : steps?.length ? (
                  <StepAccordion steps={steps} checkedSteps={checkedSteps} onToggleCheck={toggleCheck} onDiscussStep={handleDiscussStep} />
                ) : (
                  <p style={{ color: '#444', fontSize: 13 }}>—</p>
                )}
              </div>

              {/* Actions */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ display: 'flex', gap: 10 }}>
                  <button
                    onClick={() => { onToggleDone(task); onClose() }}
                    style={{
                      padding: '10px 20px', borderRadius: 6, fontSize: 13, fontWeight: 700,
                      background: '#fff', color: '#000', border: 'none', cursor: 'pointer',
                    }}
                  >Mark as done</button>
                  <button
                    onClick={handleDeprioritize}
                    style={{
                      padding: '10px 20px', borderRadius: 6, fontSize: 13, fontWeight: 600,
                      background: 'transparent', color: '#555',
                      border: '1px solid #222', cursor: 'pointer',
                    }}
                  >Deprioritize</button>
                </div>
                <button
                  onClick={handleOpenSheet}
                  style={{
                    padding: '10px 20px', borderRadius: 6, fontSize: 13, fontWeight: 600,
                    background: 'transparent', color: '#444',
                    border: '1px solid #1a1a1a', cursor: 'pointer',
                    textAlign: 'left',
                  }}
                >✦ Discuss this task further</button>
              </div>
            </>
          )}
        </div>
      </div>

      {/* ESC hint */}
      {!showSheet && (
        <div className="px-8 pb-8 shrink-0">
          <p className="font-mono text-[9px]" style={{ color: '#2a2a2a' }}>Press ESC to close</p>
        </div>
      )}

      {/* Discussion sheet */}
      {showSheet && task && (
        <div style={{
          position: 'fixed', bottom: 0, left: 0, right: 0,
          height: '75vh',
          background: '#0a0a0a',
          borderTop: '1px solid #1a1a1a',
          display: 'flex', flexDirection: 'column',
          zIndex: 10,
        }}>

          {/* Sheet header */}
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '12px 20px', borderBottom: '1px solid #161616', flexShrink: 0,
          }}>
            <span className="font-mono text-[9px] tracking-widest uppercase" style={{ color: '#333' }}>
              Discussing · {task.text}
            </span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
              {hasAiResponse && (
                <button
                  onClick={handleRegenerate}
                  disabled={regenerating}
                  style={{
                    fontSize: 11, fontWeight: 700,
                    color: regenerating ? '#333' : '#666',
                    background: 'none', border: 'none', cursor: 'pointer',
                    transition: 'color 0.15s',
                  }}
                >
                  {regenerating ? 'Updating…' : '↺ Update plan'}
                </button>
              )}
              <button
                onClick={() => setShowSheet(false)}
                style={{ color: '#444', fontSize: 18, background: 'none', border: 'none', cursor: 'pointer', lineHeight: 1 }}
              >↓</button>
            </div>
          </div>

          {/* Messages */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '16px 20px 0' }}>
            {messages.length === 0 ? (
              <p style={{ color: '#2a2a2a', fontSize: 13, textAlign: 'center', marginTop: 24 }}>
                Ask anything about this task
              </p>
            ) : (
              messages.map((msg, i) => (
                <div key={i} style={{
                  marginBottom: 10,
                  display: 'flex',
                  justifyContent: msg.role === 'user' ? 'flex-end' : 'flex-start',
                }}>
                  <div style={{
                    maxWidth: '85%', padding: '8px 12px',
                    fontSize: 13, lineHeight: 1.6,
                    background: msg.role === 'user' ? '#fff' : '#1a1a1a',
                    color: msg.role === 'user' ? '#000' : '#bbb',
                    borderRadius: msg.role === 'user' ? '10px 10px 2px 10px' : '10px 10px 10px 2px',
                  }}>
                    {msg.content}
                  </div>
                </div>
              ))
            )}
            {chatLoading && (
              <div style={{ display: 'flex', marginBottom: 10 }}>
                <div style={{ background: '#1a1a1a', borderRadius: '10px 10px 10px 2px', padding: '8px 14px' }}>
                  <span className="font-mono text-[11px] animate-pulse" style={{ color: '#555' }}>···</span>
                </div>
              </div>
            )}
            <div ref={chatBottomRef} />
          </div>

          {/* Input */}
          <form
            onSubmit={handleChatSend}
            style={{ padding: '12px 16px', flexShrink: 0, display: 'flex', gap: 10, borderTop: '1px solid #161616' }}
          >
            <input
              ref={chatInputRef}
              value={chatInput}
              onChange={e => setChatInput(e.target.value)}
              placeholder="Ask or discuss…"
              disabled={chatLoading}
              style={{
                flex: 1, background: '#161616',
                border: '1px solid #222', borderRadius: 8,
                padding: '8px 12px', fontSize: 13,
                color: '#fff', outline: 'none',
              }}
            />
            <button
              type="submit"
              disabled={!chatInput.trim() || chatLoading}
              style={{
                background: '#fff', color: '#000', border: 'none',
                borderRadius: 6, padding: '8px 14px', fontSize: 13,
                fontWeight: 700, cursor: 'pointer',
                opacity: !chatInput.trim() || chatLoading ? 0.3 : 1,
                transition: 'opacity 0.15s',
              }}
            >→</button>
          </form>
        </div>
      )}
    </div>
  )
}
