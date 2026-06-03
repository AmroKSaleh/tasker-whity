const API_KEY = import.meta.env.VITE_GEMINI_API_KEY
const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions'
const MODEL = 'gemini-2.5-flash'

async function callGemini(prompt, json = false) {
  const res = await fetch(BASE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      ...(json && { response_format: { type: 'json_object' } }),
    }),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(JSON.stringify(data.error) ?? `Gemini ${res.status}`)
  return data.choices[0].message.content
}

async function callGeminiChat(messages, systemPrompt = null, json = false) {
  const msgs = systemPrompt
    ? [{ role: 'system', content: systemPrompt }, ...messages]
    : messages
  const res = await fetch(BASE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: msgs,
      temperature: 0.6,
      ...(json && { response_format: { type: 'json_object' } }),
    }),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(JSON.stringify(data.error) ?? `Gemini ${res.status}`)
  return data.choices[0].message.content
}

const PROJECT_COACH_SYSTEM_FOCUSED = `You are a sharp project planning coach inside a task management app called Tasker. Your job is to make sure the user has genuinely thought through what they are building and why, before any tasks are created.

Rules:
- Ask exactly one targeted question per response — never a list of questions.
- If the user is unsure, hesitant, or asks for your opinion, engage with them — help them think through it. That is part of your job.
- Push back on vague goals, weak justifications, or scope that seems wrong. Do not let things slide.
- Challenge assumptions. If something isn't clearly justified, ask why.
- Keep every response to 2–4 sentences. Be direct and opinionated.
- The guardrail: ONLY respond with "We are here trying to use time well, not waste it >.<" if the user is clearly asking about something with zero connection to work, productivity, or this project — for example asking about the weather, requesting a joke, or asking you to write a poem. Uncertainty about the project itself, asking for suggestions, or saying "I don't know" are all fair game and should be engaged with normally.
- Exception to the guardrail: if the user asks what model or AI you are, answer briefly and honestly (you are an AI assistant built into Tasker).
- Never suggest, list, or describe tasks during the discussion. Task creation only happens when Generate is clicked.`

const PROJECT_COACH_SYSTEM_CONVERSATIONAL = `You are a friendly but thoughtful project planning collaborator inside a task management app called Tasker. Your job is to help the user think through their project in a relaxed, exploratory way before tasks are created.

Rules:
- Engage naturally — you can ask follow-up questions, share opinions, brainstorm ideas, and explore possibilities with the user.
- Be warm and collaborative rather than interrogative. You are thinking through this together, not interrogating them.
- Still gently steer the conversation toward clarity on goals, scope, and approach — but without the hard pushback.
- If the user is unsure or asks for your input, engage openly and helpfully.
- Keep responses concise but conversational — not rigid.
- The guardrail: ONLY respond with "We are here trying to use time well, not waste it >.<" if the user is clearly asking about something with absolutely zero connection to work, productivity, or this project — for example asking about the weather, requesting a joke, or asking you to write a poem.
- Exception to the guardrail: if the user asks what model or AI you are, answer briefly and honestly (you are an AI assistant built into Tasker).
- Never suggest, list, or describe tasks during the discussion. Task creation only happens when Generate is clicked.`

function extractJSON(text) {
  const cleaned = text.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim()
  return JSON.parse(cleaned)
}

export async function discussProject(messages, mode = 'focused') {
  const system = mode === 'conversational'
    ? PROJECT_COACH_SYSTEM_CONVERSATIONAL
    : PROJECT_COACH_SYSTEM_FOCUSED
  try {
    return await callGeminiChat(messages, system)
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
  "risks": "Flagged unknowns, blockers, or open questions from the discussion"
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
  const prompt = `You are a project planning assistant for a task management app.
Based on the user's project description, generate a structured project plan.
Return ONLY a valid JSON object:
{
  "name": "url-safe-slug",
  "description": "Human Readable Project Name",
  "sections": [
    {
      "title": "Task List Name",
      "groups": [
        {
          "name": "Stage Name",
          "tasks": [{ "text": "Task title", "priority": "high|medium|low|rush|null" }]
        }
      ],
      "tasks": [{ "text": "Ungrouped task", "priority": null }]
    }
  ]
}
Rules:
- Create 2-5 sections based on natural project phases or areas
- Only add groups/stages inside a section if the work genuinely has distinct sub-phases
- Each section or group should have 3-6 tasks
- Tasks must be specific and actionable
- name must be lowercase with hyphens only (no spaces or special chars)
- sections[].tasks holds ungrouped tasks; sections[].groups holds staged work

User description: "${description}"`

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
    .filter(t => !t.done && t.id !== task.id)
    .slice(0, 20)
    .map(t => `- [${t.priority || 'no priority'}] ${t.text}${t.in_progress ? ' (in progress)' : ''}`)
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

export async function generateFocusReason(task, allTasks, discussionMessages = null) {
  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })

  const otherPending = allTasks
    .filter(t => !t.done && t.id !== task.id)
    .slice(0, 30)
    .map(t => {
      const parts = [`[${t.priority || 'no priority'}] ${t.text}`]
      if (t.due_date) parts.push(`due ${t.due_date}`)
      if (t.in_progress) parts.push('in progress')
      if (t.done) parts.push('done')
      return '- ' + parts.join(', ')
    })
    .join('\n')

  const taskDesc = [
    `Title: ${task.text}`,
    task.priority ? `Priority: ${task.priority}` : null,
    task.due_date ? `Due: ${task.due_date}` : null,
    task.detail ? `Detail: ${task.detail}` : null,
  ].filter(Boolean).join('\n')

  const discussionBlock = discussionMessages?.length
    ? `\nThe user has discussed this task. Use this conversation to refine your reasoning:\n${
        discussionMessages.map(m => `${m.role === 'user' ? 'User' : 'AI'}: ${m.content}`).join('\n')
      }\n`
    : ''

  const prompt = `You are a sharp productivity coach. Today is ${today}.
The user's current focus task is:
${taskDesc}

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

export async function generateFocusSteps(task, allTasks, discussionMessages = null) {
  const otherPending = allTasks
    .filter(t => !t.done && t.id !== task.id)
    .slice(0, 20)
    .map(t => `- ${t.text}`)
    .join('\n')

  const taskDesc = [
    `Title: ${task.text}`,
    task.priority ? `Priority: ${task.priority}` : null,
    task.due_date ? `Due: ${task.due_date}` : null,
    task.detail ? `Detail: ${task.detail}` : null,
  ].filter(Boolean).join('\n')

  const discussionBlock = discussionMessages?.length
    ? `\nThe user has discussed this task. Use this conversation to generate more relevant steps:\n${
        discussionMessages.map(m => `${m.role === 'user' ? 'User' : 'AI'}: ${m.content}`).join('\n')
      }\n`
    : ''

  const prompt = `You are a productivity coach helping someone execute a specific task.
Task:
${taskDesc}

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

export async function generateDailyBriefing(tasks) {
  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })

  const pending = tasks
    .filter(t => !t.done)
    .slice(0, 20)
    .map(t => {
      const parts = [`[${t.priority || 'no priority'}] ${t.text}`]
      if (t.due_date) parts.push(`due ${t.due_date}`)
      if (t.in_progress) parts.push('in progress')
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
