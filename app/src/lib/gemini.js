import { getAISettings, PROVIDERS } from './aiSettings'

const BUILTIN_KEY = import.meta.env.VITE_GEMINI_API_KEY

function getCallConfig() {
  const { provider, apiKey, model, customBaseUrl } = getAISettings()
  const p = PROVIDERS[provider] ?? PROVIDERS.gemini
  const customKey = apiKey?.trim()
  const key = customKey || (provider === 'gemini' ? BUILTIN_KEY : '')
  const fallbackKey = (customKey && provider === 'gemini' && customKey !== BUILTIN_KEY)
    ? BUILTIN_KEY : null
  const baseUrl = p.customEndpoint ? (customBaseUrl?.trim() || '') : p.baseUrl
  return { baseUrl, key, model: model || p.defaultModel, fallbackKey, format: p.format ?? 'openai' }
}

async function post(baseUrl, key, body, format = 'openai') {
  if (format === 'anthropic') return postAnthropic(baseUrl, key, body)
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
    body: JSON.stringify(body),
  })
  const data = await res.json()
  if (!res.ok) {
    const err = new Error(data.error?.message ?? JSON.stringify(data.error) ?? `HTTP ${res.status}`)
    err.status = res.status
    throw err
  }
  return data.choices[0].message.content
}

async function postAnthropic(baseUrl, key, body) {
  const systemMsg = body.messages.find(m => m.role === 'system')
  let userMsgs = body.messages.filter(m => m.role !== 'system')
  // Anthropic has no response_format — append JSON instruction to last user message
  if (body.response_format) {
    const last = userMsgs[userMsgs.length - 1]
    userMsgs = [
      ...userMsgs.slice(0, -1),
      { ...last, content: last.content + '\n\nReturn only valid JSON with no additional text or markdown.' },
    ]
  }
  const res = await fetch(`${baseUrl}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: body.model,
      max_tokens: 8096,
      messages: userMsgs,
      ...(systemMsg && { system: systemMsg.content }),
    }),
  })
  const data = await res.json()
  if (!res.ok) {
    const err = new Error(data.error?.message ?? `HTTP ${res.status}`)
    err.status = res.status
    throw err
  }
  return data.content[0].text
}

async function callGemini(prompt, json = false) {
  const { baseUrl, key, model, fallbackKey, format } = getCallConfig()
  const body = {
    model,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.3,
    ...(json && { response_format: { type: 'json_object' } }),
  }
  try {
    return await post(baseUrl, key, body, format)
  } catch (err) {
    if (fallbackKey && (err.status === 401 || err.status === 403)) {
      return await post(baseUrl, fallbackKey, body, format)
    }
    throw err
  }
}

async function callGeminiChat(messages, systemPrompt = null, json = false) {
  const { baseUrl, key, model, fallbackKey, format } = getCallConfig()
  const msgs = systemPrompt
    ? [{ role: 'system', content: systemPrompt }, ...messages]
    : messages
  const body = {
    model,
    messages: msgs,
    temperature: 0.6,
    ...(json && { response_format: { type: 'json_object' } }),
  }
  try {
    return await post(baseUrl, key, body, format)
  } catch (err) {
    if (fallbackKey && (err.status === 401 || err.status === 403)) {
      return await post(baseUrl, fallbackKey, body, format)
    }
    throw err
  }
}

export async function testAIConnection({ provider, apiKey, model, customBaseUrl }) {
  const p = PROVIDERS[provider] ?? PROVIDERS.gemini
  const baseUrl = p.customEndpoint ? (customBaseUrl?.trim() || '') : p.baseUrl
  if (p.customEndpoint && !baseUrl) throw new Error('Enter a custom endpoint URL first.')
  const key = apiKey?.trim() || (provider === 'gemini' ? BUILTIN_KEY : '')
  if (!key && !p.customEndpoint) throw new Error('No API key — enter one above or switch to Gemini.')
  await post(baseUrl, key, {
    model: model || p.defaultModel || 'gpt-4o',
    messages: [{ role: 'user', content: 'Reply with just the word: ok' }],
    max_tokens: 5,
    temperature: 0,
  }, p.format ?? 'openai')
}

const READINESS_FORMAT = `
Response format: Return ONLY a valid JSON object with two fields:
{
  "message": "your full response text here",
  "ready": false
}
Set "ready" to true only when you have a clear enough picture of: (1) what the project is trying to achieve, (2) why it matters, (3) what success looks like, and (4) at least one key risk or constraint. When you set ready to true, naturally acknowledge it in your message — e.g. "I think I have enough to generate a solid project for you. Ready when you are." — then stop asking questions.`

const PROJECT_COACH_SYSTEM_FOCUSED = `You are a sharp project planning coach inside a task management app called Tasker. Your job is to make sure the user has genuinely thought through what they are building and why, before any tasks are created.

Rules:
- Ask exactly one targeted question per response — never a list of questions.
- If the user is unsure, hesitant, or asks for your opinion, engage with them — help them think through it. That is part of your job.
- Push back on vague goals, weak justifications, or scope that seems wrong. Do not let things slide.
- Challenge assumptions. If something isn't clearly justified, ask why.
- Keep every response to 2–4 sentences. Be direct and opinionated.
- The guardrail: ONLY respond with the guardrail message (in the message field) if the user is clearly asking about something with zero connection to work, productivity, or this project — for example asking about the weather, requesting a joke, or asking you to write a poem. Uncertainty about the project itself, asking for suggestions, or saying "I don't know" are all fair game and should be engaged with normally. Guardrail message: "We are here trying to use time well, not waste it >.<"
- Exception to the guardrail: if the user asks what model or AI you are, answer briefly and honestly (you are an AI assistant built into Tasker).
- Never suggest, list, or describe tasks during the discussion. Task creation only happens when Generate is clicked.
${READINESS_FORMAT}`

const PROJECT_COACH_SYSTEM_CONVERSATIONAL = `You are a friendly but thoughtful project planning collaborator inside a task management app called Tasker. Your job is to help the user think through their project in a relaxed, exploratory way before tasks are created.

Rules:
- Engage naturally — you can ask follow-up questions, share opinions, brainstorm ideas, and explore possibilities with the user.
- Be warm and collaborative rather than interrogative. You are thinking through this together, not interrogating them.
- Still gently steer the conversation toward clarity on goals, scope, and approach — but without the hard pushback.
- If the user is unsure or asks for your input, engage openly and helpfully.
- Keep responses concise but conversational — not rigid.
- The guardrail: ONLY respond with the guardrail message (in the message field) if the user is clearly asking about something with absolutely zero connection to work, productivity, or this project. Guardrail message: "We are here trying to use time well, not waste it >.<"
- Exception to the guardrail: if the user asks what model or AI you are, answer briefly and honestly (you are an AI assistant built into Tasker).
- Never suggest, list, or describe tasks during the discussion. Task creation only happens when Generate is clicked.
${READINESS_FORMAT}`

function extractJSON(text) {
  const cleaned = text.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim()
  return JSON.parse(cleaned)
}

export async function discussProject(messages, mode = 'focused') {
  const system = mode === 'conversational'
    ? PROJECT_COACH_SYSTEM_CONVERSATIONAL
    : PROJECT_COACH_SYSTEM_FOCUSED
  try {
    const text = await callGeminiChat(messages, system, true)
    const parsed = extractJSON(text)
    return { message: parsed.message ?? text, ready: parsed.ready === true }
  } catch (err) {
    console.error('[Gemini discussProject]', err)
    throw err
  }
}

export async function generateProjectSummary(conversationMessages) {
  const systemPrompt = `You are a project planning assistant. Based on this discussion, extract a structured project summary.
Return ONLY a valid JSON object. Omit (set to null) any field that was genuinely not discussed.
{
  "goal": "One clear sentence: what does success look like for this project?",
  "why": "The motivation or driver — why does this matter?",
  "scope": "What is explicitly in scope, and what is out",
  "constraints": "Time, budget, team size, key dependencies",
  "definition_of_done": "Concrete signal that the project is finished",
  "risks": "Flagged unknowns, blockers, or open questions from the discussion",
  "ai_behavior": "How the user wants the AI to work with them — proactive flagging, or wait until asked. Leave null if not discussed."
}
Be specific and concrete. Extract what was actually said — do not invent.`

  const messages = [
    ...conversationMessages,
    { role: 'user', content: 'Now generate the project summary from our discussion.' },
  ]
  try {
    const text = await callGeminiChat(messages, systemPrompt, true)
    return extractJSON(text)
  } catch (err) {
    console.error('[Gemini generateProjectSummary]', err)
    throw err
  }
}

export async function generateProjectFromDiscussion(conversationMessages, summary = null) {
  const summaryBlock = summary
    ? '\nConfirmed project context:\n' + Object.entries(summary)
        .filter(([, v]) => v)
        .map(([k, v]) => `- ${k.replace(/_/g, ' ')}: ${v}`)
        .join('\n') + '\n'
    : ''

  const systemPrompt = `You are a project planning assistant. Based on the conversation${summary ? ' and confirmed project context' : ''}, generate a structured project plan.${summaryBlock}
Return ONLY a valid JSON object:
{
  "name": "url-safe-slug",
  "description": "Human Readable Project Name",
  "sections": [
    {
      "title": "Task List Name",
      "groups": [
        { "name": "Stage Name", "tasks": [{ "text": "Task title", "priority": "high|medium|low|rush|null" }] }
      ],
      "tasks": [{ "text": "Ungrouped task", "priority": null }]
    }
  ]
}
Rules:
- Create 2-5 sections based on natural project phases or areas
- Only add groups/stages where the work genuinely has distinct sub-phases
- Each section or group should have 3-6 specific, actionable tasks
- name must be lowercase with hyphens only (no spaces or special chars)
- sections[].tasks holds ungrouped tasks; sections[].groups holds staged work`

  const messages = [
    ...conversationMessages,
    { role: 'user', content: 'Generate the complete project structure now based on our discussion.' },
  ]
  try {
    const text = await callGeminiChat(messages, systemPrompt, true)
    return extractJSON(text)
  } catch (err) {
    console.error('[Gemini generateFromDiscussion]', err)
    throw err
  }
}

export async function generateProjectStructure(description) {
  const prompt = `You are a project planning assistant. The user has provided a project description. Your job is to turn it into a structured task plan.

STEP 1 — Before generating anything, mentally extract from the description:
- Every specific deliverable, feature, or named output mentioned
- Every specific tool, platform, person, or service named
- Every concrete number, metric, or deadline mentioned
- Every distinct area of work (these become sections)
- Everything the description says is already done, already set up, already configured, or partially complete — flag these separately

STEP 2 — Use ONLY what you extracted in Step 1 to build the task list. Do not invent tasks not implied by the description.
- If something is already done: do not create a task for it.
- If something is partially done: the task must say "complete" or "finish", never "set up" or "create".
- Before assigning each priority, ask: what does this task block, or what blocks it, and when is it needed? Let that determine the priority — not assumption.

CRITICAL RULES:
- Every task must use specific names, numbers, and terminology from the description.
- Never write generic tasks like "Review project", "Set up infrastructure", or "Plan the launch".
- If the description mentions specific numbers (e.g. "2,400 signups", "6 device types", "10 weeks"), include them in tasks.
- If the description names specific tools or platforms, use them in tasks.
- Sections must map to the actual areas of work described — not generic phases.
- Section names must be human-readable title case (e.g. "Backend Core", "App Store Launch") — never slugs or lowercase-hyphenated names.
- Tasks must be directly actionable: start with a verb, be concrete enough that someone knows exactly what to do.
- Priority: rush=blocking/ASAP, high=important to success, medium=needed, low=nice-to-have, null=unspecified.

Return ONLY a valid JSON object:
{
  "name": "url-safe-slug",
  "description": "Human Readable Project Name",
  "sections": [
    {
      "name": "Section Name",
      "groups": [
        {
          "name": "Stage Name",
          "tasks": [{ "text": "Specific actionable task", "priority": "rush|high|medium|low|null" }]
        }
      ],
      "tasks": [{ "text": "Ungrouped task", "priority": null }]
    }
  ]
}

Additional rules:
- Create as many sections as the work naturally requires — do not cap the count
- Use groups only where work has genuinely distinct sub-phases
- Each section or group: as many tasks as the work requires — do not pad or trim to hit a number
- name field: lowercase, hyphens only

User description:
"""
${description}
"""`

  try {
    const text = await callGemini(prompt, true)
    return extractJSON(text)
  } catch (err) {
    console.error('[Gemini generateProject]', err)
    throw err
  }
}

export async function generateStageWithTasks(description, context = {}) {
  const ctx = [
    context.sectionTitle && `task list: "${context.sectionTitle}"`,
    context.projectName  && `project: "${context.projectName}"`,
  ].filter(Boolean).join(', ')

  const prompt = `You are a project planning assistant.
Generate a stage/phase${ctx ? ` for the ${ctx}` : ''} based on the user's description.
Return ONLY a valid JSON object:
{
  "name": "Stage Name",
  "tasks": [{ "text": "Task title", "priority": "high|medium|low|rush|null" }]
}
Rules:
- Stage name should be concise (1-4 words)
- Include 3-7 specific, actionable tasks
- Priority: null unless clearly urgent or important

User description: "${description}"`

  try {
    const text = await callGemini(prompt, true)
    return extractJSON(text)
  } catch (err) {
    console.error('[Gemini generateStage]', err)
    throw err
  }
}

export async function parseTaskWithAI(input) {
  const today = new Date().toISOString().split('T')[0]

  const prompt = `You are a task parser for a project management app. Today's date is ${today}.
Parse the user's natural language input into a structured task.
Return ONLY a valid JSON object with these exact fields:
{"text":"short action-oriented title","detail":"extra context or empty string","priority":"rush|high|medium|low or null","due_date":"YYYY-MM-DD or null","tags":[]}
Priority: null if not mentioned. rush=urgent/ASAP, high=important, medium=normal, low=someday.
due_date: resolve relative dates (tomorrow, next Monday, end of week) using today's date.

User input: "${input}"`

  try {
    const text = await callGemini(prompt, true)
    return extractJSON(text)
  } catch (err) {
    console.error('[Gemini parseTask]', err)
    throw err
  }
}

export async function chatAboutTask(messages, task, steps, checkedSteps, projectContext, allTasks) {
  const contextBlock = projectContext
    ? Object.entries(projectContext)
        .filter(([, v]) => v)
        .map(([k, v]) => `- ${k.replace(/_/g, ' ')}: ${v}`)
        .join('\n')
    : null

  const stepsBlock = steps?.length
    ? steps.map((s, i) => `${i + 1}. [${checkedSteps?.[i] ? '✓' : ' '}] ${s.summary}`).join('\n')
    : null

  const otherTasks = allTasks
    .filter(t => t.status !== 'done' && t.id !== task.id)
    .slice(0, 20)
    .map(t => `- [${t.priority || 'no priority'}] ${t.text}${t.status === 'in_progress' ? ' (in progress)' : ''}`)
    .join('\n')

  const systemPrompt = `You are a focused execution coach helping the user work through a specific task right now.

Current task:
- Title: ${task.text}${task.priority ? `\n- Priority: ${task.priority}` : ''}${task.due_date ? `\n- Due: ${task.due_date}` : ''}${task.detail ? `\n- Detail: ${task.detail}` : ''}
${stepsBlock ? `\nSteps to complete this task:\n${stepsBlock}` : ''}
${contextBlock ? `\nProject context:\n${contextBlock}` : ''}
${otherTasks ? `\nOther pending tasks in this project:\n${otherTasks}` : ''}

Rules:
- Help the user execute this specific task right now — be practical and direct
- Answer questions, unblock obstacles, suggest approaches, think through problems together
- Reference checked-off steps to acknowledge progress and help with what's next
- Keep responses concise — the user is mid-work, not reading an essay
- You can reference project context and other tasks if relevant, but stay focused on the current task
- If the user asks what model or AI you are, answer briefly and honestly (you are an AI assistant built into Tasker).`

  try {
    return await callGeminiChat(messages, systemPrompt)
  } catch (err) {
    console.error('[Gemini chatAboutTask]', err)
    throw err
  }
}

export async function synthesizeTaskToContext(task, messages, currentContext) {
  if (!messages?.length) return null

  const contextBlock = currentContext
    ? Object.entries(currentContext)
        .filter(([, v]) => v)
        .map(([k, v]) => `- ${k.replace(/_/g, ' ')}: ${v}`)
        .join('\n')
    : '(no context yet)'

  const discussionBlock = messages
    .map(m => `${m.role === 'user' ? 'User' : 'AI'}: ${m.content}`)
    .join('\n')

  const systemPrompt = `You are a project intelligence system. A user just had a discussion about a task. Your job is to decide if anything said reveals new project-level insight worth adding to the project context.

Rules:
- Only update fields where something genuinely new was learned — a new risk, a changed constraint, a clarified goal, etc.
- Do not repeat information already captured in the current context.
- Do not invent. Only extract from what was actually said.
- If a field needs updating, produce the full merged text (current content + new insight), not just the new part.
- If nothing new was learned at the project level, return {"updated": false}.
- Task-level details (how to do a specific task) are NOT project-level insights — ignore them.

Return ONLY valid JSON:
{"updated": false}
OR
{"updated": true, "changes": {"goal": "...", "risks": "...", "constraints": "..."}}
Only include fields in "changes" that actually changed. Valid field names: goal, why, scope, risks, definition_of_done, constraints, ai_behavior.`

  const userMsg = `Task: ${task.text}${task.detail ? `\nNotes: ${task.detail}` : ''}

Current project context:
${contextBlock}

Discussion:
${discussionBlock}`

  try {
    const text = await callGeminiChat(
      [{ role: 'user', content: userMsg }],
      systemPrompt,
      true
    )
    const parsed = extractJSON(text)
    if (!parsed.updated || !parsed.changes) return null
    return { ...currentContext, ...parsed.changes }
  } catch (err) {
    console.error('[Gemini synthesizeTaskToContext]', err)
    return null
  }
}

export async function generateFocusReason(task, allTasks, discussionMessages = null, projectContext = null) {
  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })

  const otherPending = allTasks
    .filter(t => t.status !== 'done' && t.id !== task.id)
    .slice(0, 30)
    .map(t => {
      const parts = [`[${t.priority || 'no priority'}] ${t.text}`]
      if (t.due_date) parts.push(`due ${t.due_date}`)
      if (t.status === 'in_progress') parts.push('in progress')
      return '- ' + parts.join(', ')
    })
    .join('\n')

  const taskDesc = [
    `Title: ${task.text}`,
    task.priority ? `Priority: ${task.priority}` : null,
    task.due_date ? `Due: ${task.due_date}` : null,
    task.detail ? `Detail: ${task.detail}` : null,
  ].filter(Boolean).join('\n')

  const contextBlock = projectContext
    ? '\nProject context:\n' + Object.entries(projectContext)
        .filter(([, v]) => v)
        .map(([k, v]) => `- ${k.replace(/_/g, ' ')}: ${v}`)
        .join('\n') + '\n'
    : ''

  const discussionBlock = discussionMessages?.length
    ? `\nThe user has discussed this task. Use this conversation to refine your reasoning:\n${
        discussionMessages.map(m => `${m.role === 'user' ? 'User' : 'AI'}: ${m.content}`).join('\n')
      }\n`
    : ''

  const prompt = `You are a sharp productivity coach. Today is ${today}.
The user's current focus task is:
${taskDesc}
${contextBlock}
Other pending tasks in this project:
${otherPending || '(no other tasks)'}
${discussionBlock}
Write 1–2 sentences (max 40 words) on why this task matters right now. Be direct and specific to the task names. No intro phrases.`

  try {
    return await callGemini(prompt)
  } catch (err) {
    console.error('[Gemini focusReason]', err)
    throw err
  }
}

export async function generateFocusSteps(task, allTasks, discussionMessages = null, projectContext = null) {
  const otherPending = allTasks
    .filter(t => t.status !== 'done' && t.id !== task.id)
    .slice(0, 20)
    .map(t => `- ${t.text}`)
    .join('\n')

  const taskDesc = [
    `Title: ${task.text}`,
    task.priority ? `Priority: ${task.priority}` : null,
    task.due_date ? `Due: ${task.due_date}` : null,
    task.detail ? `Detail: ${task.detail}` : null,
  ].filter(Boolean).join('\n')

  const contextBlock = projectContext
    ? '\nProject context:\n' + Object.entries(projectContext)
        .filter(([, v]) => v)
        .map(([k, v]) => `- ${k.replace(/_/g, ' ')}: ${v}`)
        .join('\n') + '\n'
    : ''

  const discussionBlock = discussionMessages?.length
    ? `\nThe user has discussed this task. Use this conversation to generate more relevant steps:\n${
        discussionMessages.map(m => `${m.role === 'user' ? 'User' : 'AI'}: ${m.content}`).join('\n')
      }\n`
    : ''

  const prompt = `You are a productivity coach helping someone execute a specific task.
Task:
${taskDesc}
${contextBlock}
Other pending tasks for context:
${otherPending || '(none)'}
${discussionBlock}
Return a JSON object with a "steps" array of 4–6 steps to complete this task. Each step has:
- "summary": 4–7 word action phrase (the accordion title)
- "detail": 1–2 sentences explaining exactly how to do this step

Example: {"steps":[{"summary":"Research existing solutions","detail":"..."},...]}`

  try {
    const text = await callGemini(prompt, true)
    const parsed = extractJSON(text)
    return Array.isArray(parsed) ? parsed : (parsed.steps ?? [])
  } catch (err) {
    console.error('[Gemini focusSteps]', err)
    throw err
  }
}

export async function scanProjectFlags(tasks, context) {
  if (!context || Object.values(context).every(v => !v)) return []

  const contextBlock = Object.entries(context)
    .filter(([, v]) => v)
    .map(([k, v]) => `- ${k.replace(/_/g, ' ')}: ${v}`)
    .join('\n')

  const taskList = tasks
    .filter(t => t.status !== 'done')
    .slice(0, 40)
    .map(t => `- [${t.priority || 'none'}] ${t.text}${t.status === 'in_progress' ? ' (in progress)' : ''}`)
    .join('\n')

  if (!taskList) return []

  const systemPrompt = `You are a project health checker. Spot genuine issues between a project's stated context and its actual task list. Be conservative — only flag things that are clearly wrong, not minor observations.`

  const userMsg = `Project context:
${contextBlock}

Pending tasks:
${taskList}

Look for:
1. Scope creep — tasks clearly outside the defined scope or goal
2. Priority misalignment — tasks marked high/rush that don't serve the stated goal
3. Blockers — tasks that appear stuck based on constraints or risks already noted in context

Rules:
- Each flag must reference the specific task(s) by name
- Return at most 3 flags. If nothing is clearly wrong, return empty array.

Return ONLY valid JSON: {"flags": [{"type": "scope_creep|priority_mismatch|blocked", "message": "one specific sentence"}]}`

  try {
    const text = await callGeminiChat([{ role: 'user', content: userMsg }], systemPrompt, true)
    const parsed = extractJSON(text)
    return Array.isArray(parsed.flags) ? parsed.flags : []
  } catch (err) {
    console.error('[Gemini scanProjectFlags]', err)
    return []
  }
}

export async function generateDailyBriefing(tasks) {
  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })

  const pending = tasks
    .filter(t => t.status !== 'done')
    .slice(0, 20)
    .map(t => {
      const parts = [`[${t.priority || 'no priority'}] ${t.text}`]
      if (t.due_date) parts.push(`due ${t.due_date}`)
      if (t.status === 'in_progress') parts.push('in progress')
      return '- ' + parts.join(', ')
    })
    .join('\n')

  const prompt = `You are a focused productivity assistant. Today is ${today}.
Write a concise 3-5 sentence daily briefing based on this task list.
Cover: (1) the single most important thing to do today, (2) any upcoming deadlines or blockers, (3) one brief encouraging observation.
Be direct, practical, and specific to the tasks. No bullet points — flowing prose only.

Tasks:
${pending || '(no pending tasks)'}`

  try {
    return await callGemini(prompt)
  } catch (err) {
    console.error('[Gemini briefing]', err)
    throw err
  }
}

export async function discussProjectOngoing(messages, project, tasks, sections) {
  const contextBlock = project.context && Object.values(project.context).some(Boolean)
    ? Object.entries(project.context)
        .filter(([, v]) => v)
        .map(([k, v]) => `- ${k.replace(/_/g, ' ')}: ${v}`)
        .join('\n')
    : '(no context captured yet)'

  const pending = tasks.filter(t => t.status !== 'done')
  const done = tasks.filter(t => t.status === 'done')
  const rushHigh = pending
    .filter(t => t.priority === 'rush' || t.priority === 'high')
    .slice(0, 8)
    .map(t => `  - [${t.priority}] ${t.text}`)
    .join('\n')

  const sectionSummary = sections
    .map(s => {
      const count = tasks.filter(t => t.section_id === s.id && t.status !== 'done').length
      return `  - ${s.name} (${count} pending)`
    })
    .join('\n')

  const system = `You are a project strategist embedded in Tasker. You have full visibility into this project's goals, context, and current task state. Your role is to be a direct thinking partner — help the user think through priorities, spot issues, re-evaluate direction, plan what comes next, or work through any decision.

Project: ${project.name}

Context:
${contextBlock}

Current state: ${pending.length} pending, ${done.length} done
Sections:
${sectionSummary || '  (none)'}
${rushHigh ? `\nHigh/rush priority tasks:\n${rushHigh}` : ''}

Rules:
- Be direct and opinionated — you have the full project picture, use it
- Push back on vague questions with specific observations from the task list
- Keep responses tight (2–4 sentences unless the question demands more)
- If the user wants to update the project context, confirm what you would change — they can edit it in the Context tab`

  try {
    return await callGeminiChat(messages, system)
  } catch (err) {
    console.error('[Gemini discussProjectOngoing]', err)
    throw err
  }
}

export async function synthesizeProjectDiscussion(messages, currentContext) {
  if (!messages?.length) return null

  const contextBlock = currentContext && Object.values(currentContext).some(Boolean)
    ? Object.entries(currentContext)
        .filter(([, v]) => v)
        .map(([k, v]) => `- ${k.replace(/_/g, ' ')}: ${v}`)
        .join('\n')
    : '(no context yet)'

  const discussionBlock = messages
    .map(m => `${m.role === 'user' ? 'User' : 'AI'}: ${m.content}`)
    .join('\n')

  const systemPrompt = `You are a project intelligence system. A user just had a strategic discussion about their project. Decide if anything said reveals new project-level insight worth adding to the project context.

Rules:
- Only update fields where something genuinely new was learned — a new risk, a changed constraint, a clarified goal, a scope decision, etc.
- Do not repeat information already captured in the current context.
- Do not invent. Only extract from what was actually said.
- If a field needs updating, produce the full merged text (current content + new insight), not just the new part.
- If nothing new was learned, return {"updated": false}.

Return ONLY valid JSON:
{"updated": false}
OR
{"updated": true, "changes": {"goal": "...", "risks": "..."}}
Only include fields in "changes" that actually changed. Valid field names: goal, why, scope, risks, definition_of_done, constraints, ai_behavior.`

  const userMsg = `Current project context:\n${contextBlock}\n\nDiscussion:\n${discussionBlock}`

  try {
    const text = await callGeminiChat(
      [{ role: 'user', content: userMsg }],
      systemPrompt,
      true
    )
    const parsed = extractJSON(text)
    if (!parsed.updated || !parsed.changes) return null
    return { ...currentContext, ...parsed.changes }
  } catch (err) {
    console.error('[Gemini synthesizeProjectDiscussion]', err)
    return null
  }
}

export async function analyzeGitHubIssues(issues) {
  const issueList = issues.map(i => {
    const labels = i.labels?.map(l => l.name).join(', ') || 'none'
    const body = i.body ? i.body.slice(0, 400).replace(/\n+/g, ' ') : '(no description)'
    return `#${i.number} — ${i.title}\nLabels: ${labels}\n${body}`
  }).join('\n\n---\n\n')

  const prompt = `You are analyzing GitHub issues for a software project. Assign accurate priorities and identify what needs immediate focus.

Priority guide:
- rush: security vulnerabilities, data loss, production-blocking bugs
- high: significant user impact, blocks other issues, important features
- medium: useful improvements, non-blocking bugs
- low: minor polish, nice-to-have, future ideas

Issues:
${issueList}

Return ONLY valid JSON:
{
  "priorities": [
    { "issue_number": 1, "priority": "rush|high|medium|low" }
  ],
  "focus": [1, 2, 3],
  "summary": "1-2 sentences on the most critical items and recommended focus order"
}`

  try {
    const text = await callGemini(prompt, true)
    return extractJSON(text)
  } catch (err) {
    console.error('[Gemini analyzeGitHubIssues]', err)
    throw err
  }
}
