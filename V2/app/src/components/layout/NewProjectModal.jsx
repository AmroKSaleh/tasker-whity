import { useState, useRef, useEffect } from 'react'
import { createProject, updateProject, derivePrefix } from '../../hooks/useProjects'
import { generateProjectFromDiscussion, generateProjectSummary, discussProject, generateProjectStructure } from '../../lib/gemini'
import { createProjectWithStructure } from '../../lib/projectBuilder'
import { EXAMPLE_PROJECT } from '../../lib/exampleProject'
import ContextPoints from '../projects/ContextPoints'
import { supabase } from '../../lib/supabase'
import { useGitHub } from '../../hooks/useGitHub'
import { useProjectStore } from '../../store/useProjectStore'
import { useEnvironmentStore } from '../../store/useEnvironmentStore'
const EXAMPLE_TRIGGERS = ['example', 'demo', 'sample', 'tutorial', 'show me how', 'how to use', 'onboard', 'learn from', 'how does this work', 'how do i use']

const MAGIC_PROMPT = `Describe your project in the space below, then send this entire message to your AI:

My project:
[Replace this with a description of your project — what you're building, what problem it solves, any relevant context.]

---

I'm setting up this project in a task management app called Tasker. Before generating anything, read my project description and assess whether you have enough information to fill out each section with specific, non-generic content — especially the Work breakdown, which drives the actual task list in the app.

If key details are missing that would significantly change the work breakdown (such as target platform, tech stack, timeline, team size, budget, or core constraints), ask me up to 5 targeted questions first. Once I answer, generate the full document. If you already have enough context, generate it directly.

When you generate the document, use real details — no placeholder language. Use the exact markdown format below:

# [Project Name]

## Description
[2–3 sentence overview of what this project is]

## Goal
[One clear sentence: what does success look like?]

## Why it matters
[The motivation — why does this project exist or matter?]

## Scope
[What's explicitly in scope, and what's out of scope]

## Constraints
[Time, budget, team size, key dependencies, or technical limits]

## Definition of done
[The specific, concrete signal that this project is complete]

## Known risks
[Key unknowns, blockers, or concerns to be aware of]

## Work breakdown
[Break the project into phases or areas of work. Use this exact format for each phase:

### Phase Name
- Task one
- Task two
- Task three

Each phase should have 3–7 specific, actionable tasks — concrete enough to assign and complete independently. Avoid vague entries like "do research" or "build the UI".]

## Working preferences
[How you want the AI assistant to work with you on this project — e.g. proactively flag risks and blockers, suggest next steps, stay quiet until asked.]`

const SECTION_MAP = {
  'goal': 'goal',
  'why it matters': 'why',
  'why': 'why',
  'scope': 'scope',
  'constraints': 'constraints',
  'definition of done': 'definition_of_done',
  'known risks': 'risks',
  'risks': 'risks',
  'ai working style': 'ai_behavior',
  'ai behavior': 'ai_behavior',
  'working preferences': 'ai_behavior',
  'work breakdown': 'workBreakdown',
  'description': 'description',
}

function parseWorkBreakdown(text) {
  if (!text) return null
  const lines = text.split('\n')
  const sections = []
  let current = null

  for (const line of lines) {
    const trimmed = line.trim()
    if (/^#{2,3} /.test(trimmed)) {
      const raw = trimmed
        .replace(/^#{2,3} /, '')
        .replace(/^Phase \d+\s*[—–-]\s*/i, '')
        .replace(/\s*\(Week[^)]*\)/i, '')
        .trim()
      current = { name: raw, tasks: [] }
      sections.push(current)
    } else if (current && /^[-*] /.test(trimmed)) {
      const taskText = trimmed.replace(/^[-*] /, '').trim()
      if (taskText) current.tasks.push({ text: taskText, priority: null })
    }
  }

  return sections.filter(s => s.tasks.length > 0)
}

// Fallback: scan the full document for ### headings with tasks.
// H3 headings only appear inside Work breakdown in a Magic Prompt document,
// so this is safe to run on the full text when section extraction fails.
function parseWorkBreakdownFromFullDoc(text) {
  if (!text) return null
  const lines = text.split('\n')
  const sections = []
  let current = null
  let inWorkBreakdown = false
  let hasWorkBreakdownHeader = false

  const extractName = (prefix, str) =>
    str.replace(prefix, '')
      .replace(/^Phase \d+\s*[—–-]\s*/i, '')
      .replace(/\s*\(Week[^)]*\)/i, '')
      .trim()

  for (const line of lines) {
    const trimmed = line.trim()
    if (/^## /.test(trimmed)) {
      const heading = trimmed.slice(3).trim().toLowerCase()
      if (heading === 'work breakdown') {
        inWorkBreakdown = true
        hasWorkBreakdownHeader = true
        current = null
      } else if (SECTION_MAP[heading]) {
        inWorkBreakdown = false
        current = null
      } else if (inWorkBreakdown) {
        // H2 phase header inside work breakdown section
        current = { name: extractName(/^## /, trimmed), tasks: [] }
        sections.push(current)
      }
    } else if (/^### /.test(trimmed)) {
      if (inWorkBreakdown || !hasWorkBreakdownHeader) {
        current = { name: extractName(/^### /, trimmed), tasks: [] }
        sections.push(current)
      }
    } else if (current && /^[-*] /.test(trimmed)) {
      const taskText = trimmed.replace(/^[-*] /, '').trim()
      if (taskText) current.tasks.push({ text: taskText, priority: null })
    }
  }

  return sections.filter(s => s.tasks.length > 0)
}

// Fallback: parse the plain-text format produced by the "Copy task list" button.
// Detects • bullets, treats the first non-empty line as the project name,
// and subsequent non-bullet lines as section names.
function parseWorkBreakdownFromPlainText(text) {
  if (!text || !text.includes('•')) return null
  const lines = text.split('\n')
  const sections = []
  let current = null
  let projectNameSkipped = false

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    if (/^[•] /.test(trimmed)) {
      if (current) current.tasks.push({ text: trimmed.slice(2).trim(), priority: null })
    } else if (!trimmed.startsWith('#')) {
      if (!projectNameSkipped) {
        projectNameSkipped = true // first non-empty, non-bullet line = project title, skip it
      } else {
        current = { name: trimmed, tasks: [] }
        sections.push(current)
      }
    }
  }

  return sections.filter(s => s.tasks.length > 0)
}

function parseMarkdownImport(md) {
  const lines = md.split('\n')
  const sections = {}
  let currentKey = null
  let projectName = ''

  for (const line of lines) {
    if (/^# (?!#)/.test(line)) {
      projectName = line.slice(2).trim()
    } else if (/^## /.test(line)) {
      const heading = line.slice(3).trim().toLowerCase()
      const newKey = SECTION_MAP[heading] ?? null
      if (newKey) {
        currentKey = newKey
        if (!sections[currentKey]) sections[currentKey] = []
      } else if (currentKey === 'workBreakdown') {
        // H2 phase header inside Work breakdown — treat as content, not a new section
        sections[currentKey].push(line)
      } else {
        currentKey = null
      }
    } else if (currentKey) {
      sections[currentKey].push(line)
    }
  }

  const clean = key => (sections[key] ?? []).join('\n').trim() || null

  return {
    name: projectName,
    description: clean('description'),
    workBreakdown: clean('workBreakdown'),
    context: {
      goal: clean('goal'),
      why: clean('why'),
      scope: clean('scope'),
      constraints: clean('constraints'),
      definition_of_done: clean('definition_of_done'),
      risks: clean('risks'),
      ai_behavior: clean('ai_behavior'),
    },
  }
}

function ProjectPreview({ structure }) {
  return (
    <div className="bg-surf-2 border border-line rounded-lg p-3 max-h-60 overflow-y-auto">
      <p className="text-[14px] font-medium text-ink mb-3">{structure.description}</p>
      {(structure.sections ?? []).map((sec, i) => (
        <div key={i} className="mb-3">
          <p className="font-mono text-[9px] font-bold text-mute uppercase tracking-widest mb-1">
            {sec.name || sec.title}
          </p>
          {(sec.groups ?? []).map((grp, j) => (
            <div key={j} className="ml-3 mb-1.5">
              <p className="text-[12px] font-medium text-ink-2 mb-0.5">▸ {grp.name}</p>
              {(grp.tasks ?? []).map((t, k) => (
                <p key={k} className="ml-3 text-[12px] text-mute">
                  • {typeof t === 'string' ? t : t.text}
                </p>
              ))}
            </div>
          ))}
          {(sec.tasks ?? []).map((t, j) => (
            <p key={j} className="ml-3 text-[12px] text-mute">
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
  const [prefix, setPrefix] = useState('')
  const [description, setDescription] = useState('')
  // step: 'input' | 'discussing' | 'summarizing' | 'summary' | 'loading' | 'preview' | 'creating'
  const [step, setStep] = useState('input')
  const [preview, setPreview] = useState(null)
  const [error, setError] = useState(null)
  const [chatMessages, setChatMessages] = useState([])
  const [chatInput, setChatInput] = useState('')
  const [chatLoading, setChatLoading] = useState(false)
  const [aiReady, setAiReady] = useState(false)
  const [projectSummary, setProjectSummary] = useState(null)
  const [exampleHidden, setExampleHidden] = useState(() => localStorage.getItem('tasker_example_hidden') === '1')
  const [showGenerateConfirm, setShowGenerateConfirm] = useState(false)
  const [showMagicPrompt, setShowMagicPrompt] = useState(false)
  const [promptCopied, setPromptCopied] = useState(false)
  const [markdownInput, setMarkdownInput] = useState('')
  const [previewCopied, setPreviewCopied] = useState(false)

  // GitHub import state
  const { isConnected: githubConnected, importRepo, fetchRepos } = useGitHub()
  const [githubRepo, setGithubRepo] = useState('')
  const [githubData, setGithubData] = useState(null)
  const [githubName, setGithubName] = useState('')
  const [repoList, setRepoList] = useState([])
  const [repoSearch, setRepoSearch] = useState('')
  const [repoListLoading, setRepoListLoading] = useState(false)
  const [repoListError, setRepoListError] = useState(null)

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
  useEffect(() => {
    if (mode !== 'github' || !githubConnected) return
    setRepoListLoading(true)
    setRepoListError(null)
    fetchRepos()
      .then(repos => setRepoList(repos ?? []))
      .catch(() => setRepoListError('Could not load repositories.'))
      .finally(() => setRepoListLoading(false))
  }, [mode, githubConnected])

  // ── Manual ──
  async function handleManualSubmit(e) {
    e.preventDefault()
    const trimmed = name.trim()
    if (!trimmed) return
    setStep('creating')
    setError(null)
    try {
      const proj = await createProject(trimmed, prefix || derivePrefix(trimmed))
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

  function handleCreateExample() {
    setPreview({ ...EXAMPLE_PROJECT })
    setStep('preview')
  }

  // ── AI: Start discussion ──
  async function handleDiscuss() {
    if (!description.trim()) return
    setError(null)
    const lc = description.toLowerCase()
    if (description.trim().length < 120 && EXAMPLE_TRIGGERS.some(t => lc.includes(t))) {
      setPreview({ ...EXAMPLE_PROJECT })
      setStep('preview')
      return
    }
    const initial = [{ role: 'user', content: description.trim() }]
    setChatMessages(initial)
    setStep('discussing')
    setChatLoading(true)
    try {
      const { message, ready } = await discussProject(initial, 'focused')
      setChatMessages(prev => [...prev, { role: 'assistant', content: message }])
      setAiReady(ready)
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
    if (description.trim().length < 120 && EXAMPLE_TRIGGERS.some(t => lc.includes(t))) {
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

  // ── Markdown import ──
  function handleFileUpload(e) {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = evt => setMarkdownInput(evt.target.result ?? '')
    reader.readAsText(file)
    e.target.value = ''
  }

  async function handleMarkdownImport(mdContent) {
    if (!mdContent.trim()) return
    setStep('loading')
    setError(null)
    try {
      const { name, description: mdDesc, workBreakdown, context } = parseMarkdownImport(mdContent)
      const parsedSections = parseWorkBreakdown(workBreakdown)
        || parseWorkBreakdownFromFullDoc(mdContent)
        || parseWorkBreakdownFromPlainText(mdContent)

      // For plain text input (no # heading), use the first non-empty line as project name
      const firstLine = mdContent.trim().split('\n')[0].replace(/^#+\s*/, '').trim()
      const displayName = name || mdDesc || firstLine || 'Project'

      if (parsedSections?.length) {
        const structure = {
          name: displayName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
          description: displayName,
          sections: parsedSections,
          context,
        }
        setPreview(structure)
        setStep('preview')
      } else {
        const inputText = [mdDesc, workBreakdown].filter(Boolean).join('\n\n') || mdContent
        const structure = await generateProjectStructure(inputText)
        if (name) structure.description = name
        structure.context = context
        setPreview(structure)
        setStep('preview')
      }
    } catch {
      setError('Could not generate project from markdown. Try again.')
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
      const { message, ready } = await discussProject(updated, 'focused')
      setChatMessages(prev => [...prev, { role: 'assistant', content: message }])
      if (ready) setAiReady(true)
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

  // ── GitHub: Fetch repo data ──
  async function handleGitHubFetch(repoOverride) {
    const repo = (repoOverride ?? githubRepo).trim()
    if (!repo) return
    if (!repoOverride) {} else setGithubRepo(repo)
    setStep('loading')
    setError(null)
    try {
      const data = await importRepo(repo)
      setGithubData(data)
      setGithubName(data.repoInfo.name)
      setStep('preview')
    } catch (err) {
      setError(err.message || 'Failed to fetch repository.')
      setStep('input')
    }
  }

  // ── GitHub: Create project ──
  async function handleGitHubCreate() {
    if (!githubData) return
    setStep('creating')
    setError(null)
    try {
      const { data: { user } } = await supabase.auth.getUser()
      const { addProject } = useProjectStore.getState()
      const displayName = githubName.trim() || githubData.repoInfo.name
      const slug = displayName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '') + '-' + Date.now().toString(36)
      const context = {}
      if (githubData.repoInfo.description) context.goal = githubData.repoInfo.description

      const { data: proj } = await supabase.from('projects').insert({
        name: displayName,
        slug,
        description: displayName,
        user_id: user.id,
        context,
        github_repo: githubRepo.trim(),
        prefix: derivePrefix(displayName),
        environment_id: useEnvironmentStore.getState().activeEnvironmentId,
      }).select().single()
      if (!proj) throw new Error('Failed to create project')

      for (let si = 0; si < githubData.sections.length; si++) {
        const sec = githubData.sections[si]
        const { data: section } = await supabase.from('sections').insert({
          project_id: proj.id,
          name: sec.name,
          sort_order: si,
        }).select().single()
        if (!section || !sec.tasks.length) continue
        await supabase.from('tasks').insert(sec.tasks.map((t, ti) => ({
          project_id: proj.id,
          section_id: section.id,
          user_id: user.id,
          text: t.text,
          detail: t.detail,
          priority: t.priority,
          github_issue_number: t.github_issue_number,
          status: 'pending',
          sort_order: ti,
        })))
      }

      if (githubData.readme) {
        await supabase.from('project_knowledge').insert({
          project_id: proj.id,
          user_id: user.id,
          title: 'README',
          content: githubData.readme.slice(0, 10000),
        })
      }

      addProject(proj)
      onCreated(proj)
    } catch (err) {
      setError(err.message || 'Failed to create project.')
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
      <div className={`bg-paper rounded-2xl w-full mx-4 shadow-xl flex flex-col max-h-[90vh] ${
        isWide ? 'max-w-2xl' : 'max-w-lg'
      }`}>

        {/* ── Header ── */}
        <div className={`flex items-center justify-between shrink-0 ${isWide ? 'px-5 pt-5 pb-4 border-b border-line-2' : 'px-6 pt-6 pb-0'}`}>
          <p className="text-[15px] font-semibold text-ink">New Project</p>
          <div className="flex items-center gap-3">
            {step === 'input' && (
              <div className="flex rounded-lg overflow-hidden border border-line text-[12px]">
                {['manual', 'ai', ...(!exampleHidden ? ['example'] : []), 'github'].map(m => (
                  <button
                    key={m}
                    onClick={() => { setMode(m); setError(null) }}
                    className={`px-3 py-1.5 transition-colors ${
                      mode === m
                        ? 'bg-ink text-paper'
                        : 'text-mute hover:bg-surf-2'
                    }`}
                  >
                    {m === 'ai' ? '✦ AI' : m === 'example' ? 'Example' : m === 'github' ? 'GitHub' : 'Manual'}
                  </button>
                ))}
              </div>
            )}
            {isWide && (
              <button
                onClick={onClose}
                className="text-mute hover:text-ink transition-colors text-lg leading-none"
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
              onChange={e => { setName(e.target.value); setPrefix(derivePrefix(e.target.value)) }}
              placeholder="Project name"
              className="w-full bg-surf-2 rounded-lg px-3 py-2.5 text-[13px] text-ink outline-none border border-line focus:border-ink transition-colors placeholder:text-mute-2"
            />
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-mute-2 shrink-0">Prefix</span>
              <input
                value={prefix}
                onChange={e => setPrefix(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 3))}
                placeholder={name ? derivePrefix(name) : 'ABC'}
                maxLength={3}
                className="w-16 bg-surf-2 rounded-lg px-3 py-2 text-[13px] font-mono text-ink outline-none border border-line focus:border-ink transition-colors placeholder:text-mute-2 uppercase"
              />
              <span className="text-[11px] text-mute-2">Tasks will be numbered {prefix || (name ? derivePrefix(name) : 'ABC')}-1, {prefix || (name ? derivePrefix(name) : 'ABC')}-2…</span>
            </div>
            {error && <p className="text-[11px] text-red-500">{error}</p>}
            <div className="flex gap-2 justify-end">
              <button type="button" onClick={onClose}
                className="px-4 py-2 text-[13px] text-mute hover:text-ink transition-colors">
                Cancel
              </button>
              <button type="submit" disabled={!name.trim()}
                className="px-4 py-2 rounded-lg bg-ink text-paper text-[13px] font-medium disabled:opacity-40">
                Create
              </button>
            </div>
          </form>
        )}

        {/* ── GitHub mode: input ── */}
        {mode === 'github' && step === 'input' && (
          <div className="flex flex-col gap-3 px-6 pt-4 pb-6">
            {!githubConnected ? (
              <>
                <p className="text-[13px] text-mute leading-relaxed">
                  Connect your GitHub account to import repositories as projects.
                </p>
                <p className="text-[12px] text-mute-2 leading-relaxed">
                  Go to <strong className="text-ink-2">Settings → GitHub</strong> to connect, or sign out and sign back in with GitHub.
                </p>
                <div className="flex justify-end">
                  <button type="button" onClick={onClose}
                    className="px-4 py-2 text-[13px] text-mute hover:text-ink transition-colors">
                    Close
                  </button>
                </div>
              </>
            ) : (<>
            <p className="text-[13px] text-mute leading-relaxed">
              Select a repo to import. Issues become tasks, labels become sections, and the README is saved to the Knowledge Base.
            </p>

            {/* Repo picker */}
            <input
              ref={inputRef}
              value={repoSearch}
              onChange={e => setRepoSearch(e.target.value)}
              placeholder="Search repos…"
              className="w-full bg-surf-2 rounded-lg px-3 py-2 text-[13px] text-ink outline-none border border-line focus:border-ink transition-colors placeholder:text-mute-2"
            />
            <div className="max-h-56 overflow-y-auto rounded-lg border border-line bg-surf-2 flex flex-col divide-y divide-line-2">
              {repoListLoading ? (
                <p className="px-3 py-3 text-[13px] text-mute animate-pulse">Loading repos…</p>
              ) : repoListError ? (
                <p className="px-3 py-3 text-[12px] text-red-500">{repoListError}</p>
              ) : (() => {
                const filtered = repoList.filter(r =>
                  r.full_name.toLowerCase().includes(repoSearch.toLowerCase()) ||
                  (r.description ?? '').toLowerCase().includes(repoSearch.toLowerCase())
                )
                return filtered.length === 0 ? (
                  <p className="px-3 py-3 text-[13px] text-mute">No repos found.</p>
                ) : filtered.map(repo => (
                  <button
                    key={repo.full_name}
                    onClick={() => handleGitHubFetch(repo.full_name)}
                    className="flex flex-col items-start px-3 py-2.5 hover:bg-paper transition-colors text-left"
                  >
                    <div className="flex items-center gap-2 w-full">
                      <span className="text-[13px] font-medium text-ink">{repo.full_name}</span>
                      {repo.private && (
                        <span className="ml-auto text-[9px] font-mono font-bold text-mute-2 bg-line-2 rounded px-1.5 py-0.5 shrink-0">private</span>
                      )}
                    </div>
                    {repo.description && (
                      <p className="text-[11px] text-mute mt-0.5 line-clamp-1">{repo.description}</p>
                    )}
                  </button>
                ))
              })()}
            </div>

            {/* Manual fallback */}
            <div className="flex items-center gap-3">
              <div className="flex-1 h-px bg-line-2" />
              <span className="text-[11px] text-mute-2 shrink-0">or enter manually</span>
              <div className="flex-1 h-px bg-line-2" />
            </div>
            <form onSubmit={e => { e.preventDefault(); handleGitHubFetch() }} className="flex gap-2">
              <input
                value={githubRepo}
                onChange={e => setGithubRepo(e.target.value)}
                placeholder="owner/repo"
                className="flex-1 bg-surf-2 rounded-lg px-3 py-2.5 text-[13px] font-mono text-ink outline-none border border-line focus:border-ink transition-colors placeholder:text-mute-2"
              />
              <button
                type="submit"
                disabled={!githubRepo.trim()}
                className="px-4 py-2 rounded-lg bg-ink text-paper text-[13px] font-medium disabled:opacity-40"
              >
                Import →
              </button>
            </form>

            {error && <p className="text-[11px] text-red-500">{error}</p>}
            <div className="flex justify-end">
              <button type="button" onClick={onClose}
                className="px-4 py-2 text-[13px] text-mute hover:text-ink transition-colors">
                Cancel
              </button>
            </div>
            </>)}
          </div>
        )}

        {/* ── AI mode: input ── */}
        {mode === 'ai' && step === 'input' && (
          <div className="flex flex-col gap-4 px-6 pt-3 pb-6">

            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => setShowMagicPrompt(true)}
                className="text-[11px] font-semibold text-accent hover:opacity-70 transition-opacity"
              >
                ✦ Magic Prompt
              </button>
            </div>

            {/* Section 1 — Discuss */}
            <div className="flex flex-col gap-2">
              <p className="font-mono text-[9px] font-bold tracking-widest text-mute-2 uppercase">
                Discuss your project
              </p>
              <textarea
                ref={inputRef}
                value={description}
                onChange={e => setDescription(e.target.value)}
                placeholder="Chat with your AI agent to describe your project, what it is, and what you are trying to achieve"
                rows={3}
                className="w-full bg-surf-2 rounded-lg px-3 py-2.5 text-[13px] text-ink outline-none border border-line focus:border-ink transition-colors resize-none placeholder:text-mute-2"
              />
              <div className="flex justify-end">
                {markdownInput.trim() && !description.trim() ? (
                  <button
                    onClick={() => setMarkdownInput('')}
                    className="px-4 py-2 text-[13px] text-mute hover:text-ink transition-colors"
                  >
                    ← Back
                  </button>
                ) : (
                  <button
                    onClick={handleDiscuss}
                    disabled={!description.trim()}
                    className="px-4 py-2 rounded-lg border border-line text-ink text-[13px] disabled:opacity-40 hover:bg-surf-2 transition-colors"
                  >
                    Discuss →
                  </button>
                )}
              </div>
            </div>

            <div className="flex items-center gap-3 -my-1">
              <div className="flex-1 h-px bg-line-2" />
              <span className="text-[11px] text-mute-2 shrink-0">or</span>
              <div className="flex-1 h-px bg-line-2" />
            </div>

            {/* Section 2 — Generate directly */}
            <div className="flex flex-col gap-2">
              <p className="font-mono text-[9px] font-bold tracking-widest text-mute-2 uppercase">
                Use a comprehensive description to generate tasks directly
              </p>
              <div className="relative">
                <textarea
                  value={markdownInput}
                  onChange={e => setMarkdownInput(e.target.value)}
                  placeholder="Place your project description here."
                  rows={3}
                  className="w-full bg-surf-2 rounded-lg px-3 py-2.5 pr-20 text-[13px] text-ink outline-none border border-line focus:border-ink transition-colors resize-none placeholder:text-mute-2"
                />
                <label className="absolute right-2 top-2 cursor-pointer px-2 py-1 rounded border border-line bg-paper text-[11px] text-mute hover:text-ink hover:bg-surf-2 transition-colors">
                  ↑ Upload
                  <input
                    type="file"
                    accept=".md,.markdown,text/markdown"
                    className="hidden"
                    onChange={handleFileUpload}
                  />
                </label>
              </div>
              <div className="flex justify-end">
                {description.trim() && !markdownInput.trim() ? (
                  <button
                    onClick={() => setDescription('')}
                    className="px-4 py-2 text-[13px] text-mute hover:text-ink transition-colors"
                  >
                    ← Back
                  </button>
                ) : (
                  <button
                    onClick={() => handleMarkdownImport(markdownInput)}
                    disabled={!markdownInput.trim()}
                    className="px-4 py-2 rounded-lg bg-ink text-paper text-[13px] font-medium disabled:opacity-40"
                  >
                    Generate →
                  </button>
                )}
              </div>
            </div>

            {error && <p className="text-[11px] text-red-500">{error}</p>}
          </div>
        )}

        {/* ── Example mode ── */}
        {mode === 'example' && step === 'input' && (
          <div className="flex flex-col gap-4 px-6 pt-4 pb-6">
            <p className="text-[13px] text-mute">
              A ready-made <strong className="text-ink font-medium">Product Launch Campaign</strong> project — with task lists, stages, and tasks at every priority level. Focus mode includes pre-written context and steps for every important task.
            </p>
            <ProjectPreview structure={EXAMPLE_PROJECT} />
            {error && <p className="text-[11px] text-red-500">{error}</p>}
            <div className="flex items-center justify-between">
              <button
                onClick={handleHideExample}
                className="text-[11px] text-mute hover:text-ink transition-colors"
              >
                Don't show this again
              </button>
              <div className="flex gap-2">
                <button type="button" onClick={onClose}
                  className="px-4 py-2 text-[13px] text-mute hover:text-ink transition-colors">
                  Cancel
                </button>
                <button onClick={handleCreateExample}
                  className="px-4 py-2 rounded-lg bg-ink text-paper text-[13px] font-medium">
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
                    background: msg.role === 'user' ? 'var(--color-ink)' : 'var(--color-surf-2)',
                    color: msg.role === 'user' ? 'var(--color-paper)' : 'var(--color-ink)',
                    borderRadius: msg.role === 'user' ? '10px 10px 2px 10px' : '10px 10px 10px 2px',
                  }}>
                    {msg.content}
                  </div>
                </div>
              ))}
              {chatLoading && (
                <div className="flex justify-start">
                  <div style={{ background: 'var(--color-surf-2)', borderRadius: '10px 10px 10px 2px', padding: '8px 14px' }}>
                    <span className="font-mono text-[11px] text-mute animate-pulse">···</span>
                  </div>
                </div>
              )}
              <div ref={chatBottomRef} />
            </div>

            {/* Input + actions */}
            <div className="border-t border-line-2">
              <form onSubmit={handleChatSend} className="flex gap-2 px-4 py-3">
                <input
                  autoFocus
                  value={chatInput}
                  onChange={e => setChatInput(e.target.value)}
                  placeholder="Reply…"
                  disabled={chatLoading}
                  className="flex-1 bg-surf-2 rounded-lg px-3 py-2 text-[13px] text-ink outline-none border border-line focus:border-ink transition-colors placeholder:text-mute-2"
                />
                <button
                  type="submit"
                  disabled={!chatInput.trim() || chatLoading}
                  className="px-3 py-2 rounded-lg bg-ink text-paper text-[13px] font-bold disabled:opacity-30 transition-opacity"
                >
                  →
                </button>
              </form>
              {aiReady && (
                <div className="mx-4 mb-3 flex items-center justify-between gap-3 rounded-lg bg-surf-2 border border-line px-3 py-2.5">
                  <span className="text-[12px] text-ink-2 leading-snug">Ready to generate your project</span>
                  <button
                    onClick={handleGenerateSummary}
                    disabled={chatLoading}
                    className="shrink-0 px-3 py-1.5 rounded-md bg-ink text-paper text-[12px] font-semibold disabled:opacity-40"
                  >
                    Generate →
                  </button>
                </div>
              )}
              <div className="flex items-center justify-between px-4 pb-4">
                <button
                  onClick={() => { setStep('input'); setChatMessages([]); setChatInput(''); setAiReady(false) }}
                  className="text-[12px] text-mute hover:text-ink transition-colors"
                >
                  ← Back
                </button>
                {!aiReady && (
                  <button
                    onClick={handleGenerateSummary}
                    disabled={!hasAiResponse || chatLoading}
                    className="px-4 py-2 rounded-md border border-line text-ink text-[12px] disabled:opacity-35 transition-opacity hover:bg-surf-2"
                  >
                    Generate anyway →
                  </button>
                )}
              </div>
            </div>
          </div>
        )}

        {/* ── Summarising ── */}
        {step === 'summarizing' && (
          <div className="flex items-center gap-3 px-6 py-6">
            <span className="text-accent animate-pulse">✦</span>
            <span className="text-[13px] text-mute animate-pulse">Summarising discussion…</span>
          </div>
        )}

        {/* ── Summary review ── */}
        {step === 'summary' && projectSummary && (
          <div className="flex flex-col gap-3 px-5 pt-4 pb-5">
            <p className="text-[11px] text-mute">Review and edit before generating tasks</p>
            <ContextPoints
              points={projectSummary}
              onChange={setProjectSummary}
            />
            {error && <p className="text-[11px] text-red-500">{error}</p>}
            <div className="flex gap-2 justify-end pt-1">
              <button
                onClick={() => setStep('discussing')}
                className="px-4 py-2 text-[13px] text-mute hover:text-ink transition-colors"
              >
                ← Back
              </button>
              <button
                onClick={handleConfirmSummary}
                className="px-4 py-2 rounded-lg bg-ink text-paper text-[13px] font-medium"
              >
                Generate Tasks →
              </button>
            </div>
          </div>
        )}

        {/* ── Loading ── */}
        {step === 'loading' && (
          <div className="flex items-center gap-3 px-6 py-6">
            <span className="text-accent animate-pulse">✦</span>
            <span className="text-[13px] text-mute animate-pulse">
              {mode === 'github' ? 'Fetching from GitHub…' : 'Generating project structure…'}
            </span>
          </div>
        )}

        {/* ── GitHub Preview ── */}
        {mode === 'github' && step === 'preview' && githubData && (
          <div className="flex flex-col gap-3 px-6 pt-4 pb-6">
            <div>
              <label className="text-[11px] font-semibold text-mute uppercase tracking-wide mb-1 block">Project name</label>
              <input
                value={githubName}
                onChange={e => setGithubName(e.target.value)}
                className="w-full bg-surf-2 rounded-lg px-3 py-2 text-[13px] text-ink outline-none border border-line focus:border-ink transition-colors"
              />
            </div>
            {githubData.repoInfo.description && (
              <p className="text-[13px] text-mute leading-relaxed">{githubData.repoInfo.description}</p>
            )}
            <div className="bg-surf-2 border border-line rounded-lg p-3 flex flex-col gap-2">
              <p className="font-mono text-[9px] font-bold text-mute-2 uppercase tracking-widest">
                {githubData.sections.reduce((n, s) => n + s.tasks.length, 0)} issues · {githubData.sections.length} sections
              </p>
              {githubData.sections.map(sec => (
                <div key={sec.name} className="flex items-center justify-between">
                  <span className="text-[13px] text-ink">{sec.name}</span>
                  <span className="font-mono text-[11px] text-mute-2">{sec.tasks.length} tasks</span>
                </div>
              ))}
              {githubData.readme && (
                <p className="text-[11px] text-mute border-t border-line-2 pt-2 mt-1">
                  ✓ README will be saved to Knowledge Base
                </p>
              )}
            </div>
            {error && <p className="text-[11px] text-red-500">{error}</p>}
            <div className="flex gap-2 justify-end">
              <button onClick={() => setStep('input')}
                className="px-4 py-2 text-[13px] text-mute hover:text-ink transition-colors">
                ← Back
              </button>
              <button onClick={handleGitHubCreate}
                className="px-4 py-2 rounded-lg bg-ink text-paper text-[13px] font-medium">
                Create Project
              </button>
            </div>
          </div>
        )}

        {/* ── Preview ── */}
        {step === 'preview' && preview && mode !== 'github' && (
          <div className="flex flex-col gap-3 px-6 pt-4 pb-6">
            <div>
              <label className="text-[11px] font-semibold text-mute uppercase tracking-wide mb-1 block">Project name</label>
              <input
                value={preview.description}
                onChange={e => setPreview(p => ({ ...p, description: e.target.value }))}
                className="w-full bg-surf-2 rounded-lg px-3 py-2 text-[13px] text-ink outline-none border border-line focus:border-ink transition-colors"
              />
            </div>
            <ProjectPreview structure={preview} />
            {error && <p className="text-[11px] text-red-500">{error}</p>}
            <div className="flex gap-2 justify-end items-center">
              {chatMessages.length > 0 && (
                <button
                  onClick={handleConfirmSummary}
                  className="px-4 py-2 text-[13px] text-mute hover:text-ink transition-colors"
                >
                  Regenerate
                </button>
              )}
              <button
                onClick={() => {
                  if (!preview) return
                  const lines = [preview.description || preview.name || 'Project', '']
                  ;(preview.sections ?? []).forEach(sec => {
                    lines.push(sec.name || sec.title || '')
                    ;(sec.tasks ?? []).forEach(t => lines.push(`• ${typeof t === 'string' ? t : t.text}`))
                    ;(sec.groups ?? []).forEach(g => {
                      lines.push(`  ${g.name}`)
                      ;(g.tasks ?? []).forEach(t => lines.push(`  • ${typeof t === 'string' ? t : t.text}`))
                    })
                    lines.push('')
                  })
                  navigator.clipboard.writeText(lines.join('\n').trimEnd())
                  setPreviewCopied(true)
                  setTimeout(() => setPreviewCopied(false), 2000)
                }}
                className="px-4 py-2 text-[13px] text-mute hover:text-ink transition-colors"
              >
                {previewCopied ? 'Copied!' : '⎘ Copy task list'}
              </button>
              <button onClick={handleConfirm}
                className="px-4 py-2 rounded-lg bg-ink text-paper text-[13px] font-medium">
                Create Project
              </button>
            </div>
          </div>
        )}

        {/* ── Creating ── */}
        {step === 'creating' && (
          <div className="flex items-center gap-3 px-6 py-6">
            <span className="text-accent animate-pulse">✦</span>
            <span className="text-[13px] text-mute animate-pulse">Creating your project…</span>
          </div>
        )}

        </div>{/* end scrollable content */}
      </div>

      {/* ── Magic Prompt modal ── */}
      {showMagicPrompt && (
        <div className="fixed inset-0 z-60 flex items-center justify-center bg-black bg-opacity-50">
          <div className="bg-paper rounded-2xl w-full max-w-lg mx-4 shadow-xl flex flex-col max-h-[80vh]">
            <div className="flex items-start justify-between px-5 pt-5 pb-3 shrink-0">
              <div>
                <p className="text-[14px] font-semibold text-ink">Magic Prompt</p>
                <p className="text-[11px] text-mute mt-1 leading-relaxed">
                  Copy this into ChatGPT, Claude, or any AI. Paste the result back here or upload it as a .md file.
                </p>
              </div>
              <button
                onClick={() => { setShowMagicPrompt(false); setPromptCopied(false) }}
                className="text-mute hover:text-ink text-lg leading-none ml-4 shrink-0 mt-0.5"
              >×</button>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto px-5 pb-2">
              <pre className="text-[11.5px] text-ink-2 leading-relaxed whitespace-pre-wrap font-mono bg-surf-2 rounded-lg p-4 border border-line-2">
                {MAGIC_PROMPT}
              </pre>
            </div>
            <div className="px-5 py-4 shrink-0">
              <button
                onClick={() => {
                  navigator.clipboard.writeText(MAGIC_PROMPT)
                  setPromptCopied(true)
                  setTimeout(() => setPromptCopied(false), 2000)
                }}
                className="w-full px-4 py-2.5 rounded-lg bg-ink text-paper text-[13px] font-medium"
              >
                {promptCopied ? '✓ Copied!' : 'Copy prompt'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Generate confirmation popup ── */}
      {showGenerateConfirm && (
        <div className="fixed inset-0 z-60 flex items-center justify-center bg-black bg-opacity-50">
          <div className="bg-paper rounded-2xl w-full max-w-sm mx-4 shadow-xl px-6 py-5 flex flex-col gap-4">
            <div>
              <p className="text-[14px] font-semibold text-ink mb-1">Before you generate</p>
              <p className="text-[13px] text-mute leading-relaxed">
                This skips the discussion entirely and generates your project structure as-is. Only use it if your description already covers the full scope — goals, tasks, priorities, and any constraints. If anything is still vague or unclear, use <strong className="text-ink font-medium">Discuss</strong> instead.
              </p>
            </div>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setShowGenerateConfirm(false)}
                className="px-4 py-2 text-[13px] text-mute hover:text-ink transition-colors"
              >
                Go back
              </button>
              <button
                onClick={() => { setShowGenerateConfirm(false); handleGenerateDirect() }}
                className="px-4 py-2 rounded-lg bg-ink text-paper text-[13px] font-medium"
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
