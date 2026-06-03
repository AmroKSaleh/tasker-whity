import { useState, useRef, useEffect } from 'react'
import { createProject } from '../../hooks/useProjects'
import { generateProjectFromDiscussion, generateProjectSummary, discussProject, generateProjectStructure } from '../../lib/gemini'
import { createProjectWithStructure } from '../../lib/projectBuilder'
import { EXAMPLE_PROJECT } from '../../lib/exampleProject'

const EXAMPLE_TRIGGERS = ['example', 'demo', 'sample', 'tutorial', 'show me how', 'how to use', 'onboard', 'learn from', 'how does this work', 'how do i use']

const SUMMARY_FIELDS = [
  { key: 'goal', label: 'Goal' },
  { key: 'why', label: 'Why it matters' },
  { key: 'scope', label: 'Scope' },
  { key: 'constraints', label: 'Constraints' },
  { key: 'definition_of_done', label: 'Definition of done' },
  { key: 'risks', label: 'Known risks' },
]

function ProjectPreview({ structure }) {
  return (
    <div className="bg-surface-container border border-outline-variant rounded-lg p-3 max-h-60 overflow-y-auto">
      <p className="text-title-small font-medium text-on-surface mb-3">{structure.description}</p>
      {(structure.sections ?? []).map((sec, i) => (
        <div key={i} className="mb-3">
          <p className="text-label-medium font-semibold text-on-surface-variant uppercase tracking-wide mb-1">
            {sec.title}
          </p>
          {(sec.groups ?? []).map((grp, j) => (
            <div key={j} className="ml-3 mb-1.5">
              <p className="text-label-small font-medium text-primary mb-0.5">▸ {grp.name}</p>
              {(grp.tasks ?? []).map((t, k) => (
                <p key={k} className="ml-3 text-body-small text-on-surface-variant">
                  • {typeof t === 'string' ? t : t.text}
                </p>
              ))}
            </div>
          ))}
          {(sec.tasks ?? []).map((t, j) => (
            <p key={j} className="ml-3 text-body-small text-on-surface-variant">
              • {typeof t === 'string' ? t : t.text}
            </p>
          ))}
        </div>
      ))}
    </div>
  )
}

export default function NewProjectModal({ onClose, onCreated }) {
  const [mode, setMode] = useState('manual')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  // step: 'input' | 'discussing' | 'summarizing' | 'summary' | 'loading' | 'preview' | 'creating'
  const [step, setStep] = useState('input')
  const [preview, setPreview] = useState(null)
  const [error, setError] = useState(null)
  const [chatMessages, setChatMessages] = useState([])
  const [chatInput, setChatInput] = useState('')
  const [chatLoading, setChatLoading] = useState(false)
  const [projectSummary, setProjectSummary] = useState(null)
  const [exampleHidden, setExampleHidden] = useState(() => localStorage.getItem('tasker_example_hidden') === '1')
  const [showGenerateConfirm, setShowGenerateConfirm] = useState(false)

  const inputRef = useRef(null)
  const chatBottomRef = useRef(null)

  useEffect(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [])

  useEffect(() => { inputRef.current?.focus() }, [mode])
  useEffect(() => {
    chatBottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [chatMessages, chatLoading])

  // ── Manual ──
  async function handleManualSubmit(e) {
    e.preventDefault()
    const trimmed = name.trim()
    if (!trimmed) return
    setStep('creating')
    setError(null)
    try {
      const proj = await createProject(trimmed)
      onCreated(proj)
    } catch {
      setError('Failed to create project. Try again.')
      setStep('input')
    }
  }

  // ── Example project ──
  function handleHideExample() {
    localStorage.setItem('tasker_example_hidden', '1')
    setExampleHidden(true)
    setMode('manual')
  }

  async function handleCreateExample() {
    setStep('creating')
    setError(null)
    try {
      const proj = await createProjectWithStructure(EXAMPLE_PROJECT)
      onCreated(proj)
    } catch {
      setError('Failed to create project. Try again.')
      setStep('input')
    }
  }

  // ── AI: Start discussion ──
  async function handleDiscuss() {
    if (!description.trim()) return
    setError(null)
    const lc = description.toLowerCase()
    if (EXAMPLE_TRIGGERS.some(t => lc.includes(t))) {
      setPreview({ ...EXAMPLE_PROJECT })
      setStep('preview')
      return
    }
    const initial = [{ role: 'user', content: description.trim() }]
    setChatMessages(initial)
    setStep('discussing')
    setChatLoading(true)
    try {
      const reply = await discussProject(initial, 'focused')
      setChatMessages(prev => [...prev, { role: 'assistant', content: reply }])
    } catch (err) {
      console.error('[NewProjectModal handleDiscuss]', err)
      setError('Could not start discussion. Try again.')
      setStep('input')
    } finally {
      setChatLoading(false)
    }
  }

  // ── AI: Generate directly from description ──
  async function handleGenerateDirect() {
    if (!description.trim()) return
    setError(null)
    const lc = description.toLowerCase()
    if (EXAMPLE_TRIGGERS.some(t => lc.includes(t))) {
      setPreview({ ...EXAMPLE_PROJECT })
      setStep('preview')
      return
    }
    setStep('loading')
    try {
      const structure = await generateProjectStructure(description.trim())
      setPreview(structure)
      setStep('preview')
    } catch {
      setError('Could not generate project. Try again.')
      setStep('input')
    }
  }

  // ── AI: Send chat message ──
  async function handleChatSend(e) {
    e?.preventDefault()
    const trimmed = chatInput.trim()
    if (!trimmed || chatLoading) return
    if (EXAMPLE_TRIGGERS.some(t => trimmed.toLowerCase().includes(t))) {
      setPreview({ ...EXAMPLE_PROJECT })
      setStep('preview')
      return
    }
    const updated = [...chatMessages, { role: 'user', content: trimmed }]
    setChatMessages(updated)
    setChatInput('')
    setChatLoading(true)
    try {
      const reply = await discussProject(updated, 'focused')
      setChatMessages(prev => [...prev, { role: 'assistant', content: reply }])
    } catch {
      setChatMessages(prev => [...prev, { role: 'assistant', content: 'Something went wrong. Try again.' }])
    } finally {
      setChatLoading(false)
    }
  }

  // ── AI: Generate summary from discussion ──
  async function handleGenerateSummary() {
    setStep('summarizing')
    setError(null)
    try {
      const summary = await generateProjectSummary(chatMessages)
      setProjectSummary(summary)
      setStep('summary')
    } catch {
      setError('Could not generate summary. Try again.')
      setStep('discussing')
    }
  }

  // ── AI: Generate tasks from confirmed summary ──
  async function handleConfirmSummary() {
    setStep('loading')
    setError(null)
    try {
      const structure = await generateProjectFromDiscussion(chatMessages, projectSummary)
      structure.context = projectSummary
      setPreview(structure)
      setStep('preview')
    } catch {
      setError('Could not generate project. Try again.')
      setStep('summary')
    }
  }

  // ── Confirm preview ──
  async function handleConfirm() {
    setStep('creating')
    setError(null)
    try {
      const proj = await createProjectWithStructure(preview)
      onCreated(proj)
    } catch {
      setError('Failed to create project. Try again.')
      setStep('preview')
    }
  }

  const hasAiResponse = chatMessages.some(m => m.role === 'assistant')
  const isWide = mode === 'ai' && ['discussing', 'summarizing', 'summary'].includes(step)

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-40"
      onClick={e => { if (e.target === e.currentTarget && step !== 'creating') onClose() }}
    >
      <div className={`bg-surface-container rounded-2xl w-full mx-4 shadow-xl flex flex-col max-h-[90vh] ${
        isWide ? 'max-w-2xl' : 'max-w-lg'
      }`}>

        {/* ── Header ── */}
        <div className={`flex items-center justify-between shrink-0 ${isWide ? 'px-5 pt-5 pb-4 border-b border-outline-variant' : 'px-6 pt-6 pb-0'}`}>
          <p className="text-title-medium font-medium text-on-surface">New Project</p>
          <div className="flex items-center gap-3">
            {step === 'input' && (
              <div className="flex rounded-lg overflow-hidden border border-outline-variant text-label-medium">
                {['manual', 'ai', ...(!exampleHidden ? ['example'] : [])].map(m => (
                  <button
                    key={m}
                    onClick={() => { setMode(m); setError(null) }}
                    className={`px-3 py-1.5 transition-colors ${
                      mode === m
                        ? 'bg-secondary-container text-on-secondary-container'
                        : 'text-on-surface-variant hover:bg-surface-container-high'
                    }`}
                  >
                    {m === 'ai' ? '✦ AI' : m === 'example' ? 'Example' : 'Manual'}
                  </button>
                ))}
              </div>
            )}
            {isWide && (
              <button
                onClick={onClose}
                className="text-on-surface-variant hover:text-on-surface transition-colors text-lg leading-none"
              >
                ×
              </button>
            )}
          </div>
        </div>

        {/* ── Scrollable content ── */}
        <div className="flex-1 min-h-0 overflow-y-auto">

        {/* ── Manual mode ── */}
        {mode === 'manual' && step === 'input' && (
          <form onSubmit={handleManualSubmit} className="flex flex-col gap-3 px-6 pt-4 pb-6">
            <input
              ref={inputRef}
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="Project name"
              className="w-full bg-surface-container-high rounded-lg px-3 py-2.5 text-body-large text-on-surface outline-none border border-outline-variant focus:border-primary transition-colors"
            />
            {error && <p className="text-label-small text-error">{error}</p>}
            <div className="flex gap-2 justify-end">
              <button type="button" onClick={onClose}
                className="px-4 py-2 text-label-large text-on-surface-variant hover:text-on-surface transition-colors">
                Cancel
              </button>
              <button type="submit" disabled={!name.trim()}
                className="px-4 py-2 rounded-lg bg-primary text-on-primary text-label-large disabled:opacity-40">
                Create
              </button>
            </div>
          </form>
        )}

        {/* ── AI mode: input ── */}
        {mode === 'ai' && step === 'input' && (
          <div className="flex flex-col gap-3 px-6 pt-4 pb-6">
            <textarea
              ref={inputRef}
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="Describe your project… what is it, and what are you trying to achieve?"
              rows={4}
              className="w-full bg-surface-container-high rounded-lg px-3 py-2.5 text-body-medium text-on-surface outline-none border border-outline-variant focus:border-primary transition-colors resize-none"
            />
            {error && <p className="text-label-small text-error">{error}</p>}
            <div className="flex gap-2 justify-end">
              <button type="button" onClick={onClose}
                className="px-4 py-2 text-label-large text-on-surface-variant hover:text-on-surface transition-colors">
                Cancel
              </button>
              <button
                onClick={handleDiscuss}
                disabled={!description.trim()}
                className="px-4 py-2 rounded-lg border border-outline-variant text-on-surface text-label-large disabled:opacity-40 hover:bg-surface-container-high transition-colors"
              >
                Discuss →
              </button>
              <button
                onClick={() => description.trim() && setShowGenerateConfirm(true)}
                disabled={!description.trim()}
                className="px-4 py-2 rounded-lg bg-primary text-on-primary text-label-large disabled:opacity-40"
              >
                Generate →
              </button>
            </div>
          </div>
        )}

        {/* ── Example mode ── */}
        {mode === 'example' && step === 'input' && (
          <div className="flex flex-col gap-4 px-6 pt-4 pb-6">
            <p className="text-body-medium text-on-surface-variant">
              A ready-made <strong className="text-on-surface font-medium">Product Launch Campaign</strong> project — with task lists, stages, and tasks at every priority level. Focus mode includes pre-written context and steps for every important task.
            </p>
            <ProjectPreview structure={EXAMPLE_PROJECT} />
            {error && <p className="text-label-small text-error">{error}</p>}
            <div className="flex items-center justify-between">
              <button
                onClick={handleHideExample}
                className="text-label-small text-mute hover:text-ink transition-colors"
              >
                Don't show this again
              </button>
              <div className="flex gap-2">
                <button type="button" onClick={onClose}
                  className="px-4 py-2 text-label-large text-on-surface-variant hover:text-on-surface transition-colors">
                  Cancel
                </button>
                <button onClick={handleCreateExample}
                  className="px-4 py-2 rounded-lg bg-primary text-on-primary text-label-large">
                  Create Example
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ── AI mode: discussing ── */}
        {mode === 'ai' && step === 'discussing' && (
          <div>
            {/* Messages */}
            <div className="flex flex-col gap-2.5 px-4 py-4 overflow-y-auto" style={{ maxHeight: 320, minHeight: 160 }}>
              {chatMessages.map((msg, i) => (
                <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <div style={{
                    maxWidth: '83%',
                    padding: '8px 12px',
                    fontSize: 13,
                    lineHeight: 1.6,
                    background: msg.role === 'user' ? '#111' : '#f5f5f5',
                    color: msg.role === 'user' ? '#fff' : '#111',
                    borderRadius: msg.role === 'user' ? '10px 10px 2px 10px' : '10px 10px 10px 2px',
                  }}>
                    {msg.content}
                  </div>
                </div>
              ))}
              {chatLoading && (
                <div className="flex justify-start">
                  <div style={{ background: '#f5f5f5', borderRadius: '10px 10px 10px 2px', padding: '8px 14px' }}>
                    <span className="font-mono text-[11px] text-mute animate-pulse">···</span>
                  </div>
                </div>
              )}
              <div ref={chatBottomRef} />
            </div>

            {/* Input + actions */}
            <div style={{ borderTop: '1px solid #e6e6e6' }}>
              <form onSubmit={handleChatSend} className="flex gap-2 px-4 py-3">
                <input
                  autoFocus
                  value={chatInput}
                  onChange={e => setChatInput(e.target.value)}
                  placeholder="Reply…"
                  disabled={chatLoading}
                  className="flex-1 rounded-lg px-3 py-2 text-[13px] text-ink outline-none border border-line focus:border-ink-2 transition-colors"
                  style={{ background: '#f5f5f5' }}
                />
                <button
                  type="submit"
                  disabled={!chatInput.trim() || chatLoading}
                  className="px-3 py-2 rounded-lg bg-ink text-paper text-[13px] font-bold disabled:opacity-30 transition-opacity"
                >
                  →
                </button>
              </form>
              <div className="flex items-center justify-between px-4 pb-4">
                <button
                  onClick={() => { setStep('input'); setChatMessages([]); setChatInput('') }}
                  className="text-[12px] text-mute hover:text-ink transition-colors"
                >
                  ← Back
                </button>
                <button
                  onClick={handleGenerateSummary}
                  disabled={!hasAiResponse || chatLoading}
                  style={{
                    padding: '7px 18px',
                    background: '#111',
                    color: '#fff',
                    border: 'none',
                    borderRadius: 6,
                    fontSize: 12,
                    fontWeight: 700,
                    cursor: 'pointer',
                    opacity: !hasAiResponse || chatLoading ? 0.35 : 1,
                    transition: 'opacity 0.15s',
                  }}
                >
                  Generate →
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ── Summarising ── */}
        {step === 'summarizing' && (
          <div className="flex items-center gap-3 px-6 py-6">
            <span className="text-primary animate-pulse">✦</span>
            <span className="text-body-medium text-on-surface-variant animate-pulse">Summarising discussion…</span>
          </div>
        )}

        {/* ── Summary review ── */}
        {step === 'summary' && projectSummary && (
          <div className="flex flex-col gap-3 px-5 pt-4 pb-5">
            <p className="text-label-small text-on-surface-variant">Review and edit before generating tasks</p>
            {SUMMARY_FIELDS.map(({ key, label }) =>
              projectSummary[key] ? (
                <div key={key}>
                  <label className="text-label-small text-on-surface-variant mb-1 block">{label}</label>
                  <textarea
                    value={projectSummary[key]}
                    onChange={e => setProjectSummary(p => ({ ...p, [key]: e.target.value }))}
                    rows={2}
                    className="w-full bg-surface-container-high rounded-lg px-3 py-2 text-body-small text-on-surface outline-none border border-outline-variant focus:border-primary transition-colors resize-none"
                  />
                </div>
              ) : null
            )}
            {error && <p className="text-label-small text-error">{error}</p>}
            <div className="flex gap-2 justify-end pt-1">
              <button
                onClick={() => setStep('discussing')}
                className="px-4 py-2 text-label-large text-on-surface-variant hover:text-on-surface transition-colors"
              >
                ← Back
              </button>
              <button
                onClick={handleConfirmSummary}
                className="px-4 py-2 rounded-lg bg-primary text-on-primary text-label-large"
              >
                Generate Tasks →
              </button>
            </div>
          </div>
        )}

        {/* ── Loading ── */}
        {step === 'loading' && (
          <div className="flex items-center gap-3 px-6 py-6">
            <span className="text-primary animate-pulse">✦</span>
            <span className="text-body-medium text-on-surface-variant animate-pulse">Generating project structure…</span>
          </div>
        )}

        {/* ── Preview ── */}
        {step === 'preview' && preview && (
          <div className="flex flex-col gap-3 px-6 pt-4 pb-6">
            <div>
              <label className="text-label-small text-on-surface-variant mb-1 block">Project name</label>
              <input
                value={preview.description}
                onChange={e => setPreview(p => ({ ...p, description: e.target.value }))}
                className="w-full bg-surface-container-high rounded-lg px-3 py-2 text-body-large text-on-surface outline-none border border-outline-variant focus:border-primary transition-colors"
              />
            </div>
            <ProjectPreview structure={preview} />
            {error && <p className="text-label-small text-error">{error}</p>}
            <div className="flex gap-2 justify-end">
              <button
                onClick={handleConfirmSummary}
                className="px-4 py-2 text-label-large text-on-surface-variant hover:text-on-surface transition-colors"
              >
                Regenerate
              </button>
              <button onClick={handleConfirm}
                className="px-4 py-2 rounded-lg bg-primary text-on-primary text-label-large">
                Create Project
              </button>
            </div>
          </div>
        )}

        {/* ── Creating ── */}
        {step === 'creating' && (
          <div className="flex items-center gap-3 px-6 py-6">
            <span className="text-primary animate-pulse">✦</span>
            <span className="text-body-medium text-on-surface-variant animate-pulse">Creating your project…</span>
          </div>
        )}

        </div>{/* end scrollable content */}
      </div>

      {/* ── Generate confirmation popup ── */}
      {showGenerateConfirm && (
        <div className="fixed inset-0 z-60 flex items-center justify-center bg-black bg-opacity-50">
          <div className="bg-surface-container rounded-2xl w-full max-w-sm mx-4 shadow-xl px-6 py-5 flex flex-col gap-4">
            <div>
              <p className="text-title-small font-semibold text-on-surface mb-1">Before you generate</p>
              <p className="text-body-medium text-on-surface-variant leading-relaxed">
                This skips the discussion entirely and generates your project structure as-is. Only use it if your description already covers the full scope — goals, tasks, priorities, and any constraints. If anything is still vague or unclear, use <strong className="text-on-surface font-medium">Discuss</strong> instead.
              </p>
            </div>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setShowGenerateConfirm(false)}
                className="px-4 py-2 text-label-large text-on-surface-variant hover:text-on-surface transition-colors"
              >
                Go back
              </button>
              <button
                onClick={() => { setShowGenerateConfirm(false); handleGenerateDirect() }}
                className="px-4 py-2 rounded-lg bg-primary text-on-primary text-label-large"
              >
                Confirm, generate →
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
