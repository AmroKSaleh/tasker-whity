import { createClient } from 'npm:@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
}

const RESOURCE_METADATA_URL = 'https://smarttasksxdd.netlify.app/.well-known/oauth-authorization-server'

// ── Scoring (mirrors scoring.js) ─────────────────────────────
const PRIORITY_SCORES: Record<string, number> = { rush: 100, high: 60, medium: 30, low: 10 }

function scoreTask(task: any, now = new Date()): number {
  if (task.status === 'done') return -1
  if (task.status === 'in_progress') return -1
  if (task.tags?.includes('reference')) return -1
  if (task.pinned) return 9999
  let score = PRIORITY_SCORES[task.priority] ?? 0
  if (task.due_date) {
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    const due = new Date(task.due_date)
    const dueDay = new Date(due.getFullYear(), due.getMonth(), due.getDate())
    const diff = Math.round((dueDay.getTime() - today.getTime()) / 86400000)
    if (diff < 0) score += 80
    else if (diff === 0) score += 50
    else if (diff <= 3) score += 20
  }
  if (task.skip_count > 0) score = Math.max(1, Math.round(score / (1 + task.skip_count * 0.3)))
  return score
}

function rankTasks(tasks: any[]): any[] {
  return tasks
    .map(t => ({ t, score: scoreTask(t) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || new Date(a.t.created_at).getTime() - new Date(b.t.created_at).getTime())
    .map(({ t, score }) => ({ ...t, _score: score }))
}

// ── Auth ─────────────────────────────────────────────────────
async function hashKey(raw: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw))
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('')
}

function fireAndForget(thenable: any) {
  const wrapped = Promise.resolve(thenable).then(() => {}, () => {})
  const er = (globalThis as any).EdgeRuntime
  if (er?.waitUntil) er.waitUntil(wrapped)
}

async function resolveApiKey(sb: any, raw: string): Promise<string | null> {
  // Try API key (hashed)
  if (raw.startsWith('tsk_') || raw.startsWith('tsk__')) {
    const hash = await hashKey(raw)
    const { data } = await sb.from('user_api_keys').select('user_id').eq('key_hash', hash).maybeSingle()
    if (data?.user_id) {
      fireAndForget(sb.from('user_api_keys').update({ last_used_at: new Date().toISOString() }).eq('key_hash', hash))
      return data.user_id
    }
  }
  // Try OAuth2 access token
  const { data: tok } = await sb.from('oauth_tokens')
    .select('user_id, expires_at')
    .eq('access_token', raw)
    .maybeSingle()
  if (tok?.user_id) {
    if (tok.expires_at && new Date(tok.expires_at) < new Date()) return null
    return tok.user_id
  }
  return null
}

// ── JSON-RPC helpers ─────────────────────────────────────────
function json(body: any, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })
}
function rpcOk(result: any, id: any)    { return json({ jsonrpc: '2.0', result, id }) }
function rpcErr(code: number, msg: string, id: any) { return json({ jsonrpc: '2.0', error: { code, message: msg }, id }, code === -32001 ? 401 : 400) }
function toolOk(text: string, id: any)  { return rpcOk({ content: [{ type: 'text', text }] }, id) }
function toolFail(msg: string, id: any) { return rpcOk({ content: [{ type: 'text', text: `Error: ${msg}` }], isError: true }, id) }

// ── Project resolver helper ───────────────────────────────────
async function resolveProject(sb: any, userId: string, projectId: string) {
  let { data } = await sb.from('projects').select('id, name, slug, prefix, context').eq('slug', projectId).eq('user_id', userId).maybeSingle()
  if (!data) ({ data } = await sb.from('projects').select('id, name, slug, prefix, context').eq('id', projectId).eq('user_id', userId).maybeSingle())
  if (!data) ({ data } = await sb.from('projects').select('id, name, slug, prefix, context').ilike('prefix', projectId).eq('user_id', userId).maybeSingle())
  return data
}

// ── Default project resolver ──────────────────────────────────
async function resolveDefaultProject(sb: any, userId: string) {
  const { data } = await sb.from('user_settings').select('default_project_id').eq('user_id', userId).maybeSingle()
  if (!data?.default_project_id) return null
  const { data: project } = await sb.from('projects').select('id, name, slug, prefix, context').eq('id', data.default_project_id).eq('user_id', userId).maybeSingle()
  return project ?? null
}

// ── GitHub helpers ────────────────────────────────────────────
const GITHUB_API = 'https://api.github.com'

async function githubFetch(token: string, path: string, options: RequestInit = {}): Promise<any> {
  const res = await fetch(`${GITHUB_API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      ...(options.headers ?? {}),
    },
  })
  if (res.status === 401) throw new Error('GitHub token is invalid. Reconnect using github_connect.')
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.message || `GitHub API error ${res.status}`)
  }
  return res.json()
}

async function loadGitHubToken(sb: any, userId: string): Promise<string | null> {
  const { data } = await sb.from('user_settings').select('github_access_token').eq('user_id', userId).maybeSingle()
  return data?.github_access_token ?? null
}

const GH_PRIORITY_PATTERN = /rush|urgent|critical|p0|high|important|p1|medium|p2|low|p3/

function mapIssuePriority(labels: any[]): string {
  const names = labels.map((l: any) => l.name.toLowerCase())
  if (names.some((n: string) => /rush|urgent|critical|p0/.test(n))) return 'rush'
  if (names.some((n: string) => /high|important|p1/.test(n))) return 'high'
  if (names.some((n: string) => /medium|p2/.test(n))) return 'medium'
  if (names.some((n: string) => /low|p3/.test(n))) return 'low'
  return 'medium'
}

function getIssueSectionName(labels: any[]): string | null {
  const nonPriority = labels.find((l: any) => !GH_PRIORITY_PATTERN.test(l.name.toLowerCase()))
  return nonPriority ? nonPriority.name : null
}

async function fetchAllIssues(token: string, repo: string, cap = 500): Promise<{ issues: any[], capped: boolean }> {
  const issues: any[] = []
  let page = 1
  while (true) {
    const batch: any[] = await githubFetch(token, `/repos/${repo}/issues?state=open&per_page=100&page=${page}`)
    issues.push(...batch.filter((i: any) => !i.pull_request))
    const hasMore = batch.length === 100
    if (!hasMore || issues.length >= cap) {
      return { issues: issues.slice(0, cap), capped: issues.length >= cap && hasMore }
    }
    page++
  }
}

// Write-back: push one task to its GitHub issue. Updates title/body/state on a
// linked issue, or creates a new issue (and links it) when unlinked.
async function pushTaskToGitHub(
  sb: any, token: string, repo: string, task: any,
): Promise<{ action: 'updated' | 'created', number: number }> {
  const state = task.status === 'done' ? 'closed' : 'open'
  const title = task.text
  const body = task.detail ?? ''
  if (task.github_issue_number) {
    await githubFetch(token, `/repos/${repo}/issues/${task.github_issue_number}`, {
      method: 'PATCH',
      body: JSON.stringify({ title, body, state }),
    })
    return { action: 'updated', number: task.github_issue_number }
  }
  // New issues are always created open; close afterward if the task is done.
  const created = await githubFetch(token, `/repos/${repo}/issues`, {
    method: 'POST',
    body: JSON.stringify({ title, body }),
  })
  if (state === 'closed') {
    await githubFetch(token, `/repos/${repo}/issues/${created.number}`, {
      method: 'PATCH',
      body: JSON.stringify({ state: 'closed' }),
    })
  }
  await sb.from('tasks').update({ github_issue_number: created.number }).eq('id', task.id)
  return { action: 'created', number: created.number }
}

// ── Task resolver helper ──────────────────────────────────────
async function resolveTask(sb: any, userId: string, taskRef: string) {
  // Accept PREFIX-NNN short IDs (e.g. TDE-31)
  const shortMatch = taskRef.match(/^([A-Za-z]{2,4})-(\d+)$/)
  if (shortMatch) {
    const prefix = shortMatch[1].toUpperCase()
    const shortId = parseInt(shortMatch[2], 10)
    const { data: project } = await sb.from('projects')
      .select('id').eq('user_id', userId).eq('prefix', prefix).maybeSingle()
    if (project) {
      const { data: task } = await sb.from('tasks')
        .select('id, text, input, output, status, short_id').eq('project_id', project.id).eq('short_id', shortId).maybeSingle()
      if (task) return task
    }
  }
  // Fall back to UUID
  const { data } = await sb.from('tasks')
    .select('id, text, input, output, status, short_id').eq('id', taskRef).eq('user_id', userId).maybeSingle()
  return data ?? null
}

// ── Flow I/O helpers (contract layer — TDE-137) ───────────────
// A flow is a connected component of the project-wide I/O graph. Edges are
// authoritative on the INPUT side. The `input` field is read through here so
// BOTH the legacy single-source shape and the new edge-list shape work.
//
//   new input:  { edges: [ { source_task_id, expected_type?, contract: { rules: Rule[] } } ] }
//   legacy:     { source_task_id, expected_type, validation_rules }
//   Rule:       { id, label, rule, description?, kind: 'check'|'judgment', severity: 'blocker'|'warning' }
//
// Each input edge carries the CONSUMER's acceptance criteria for that one
// incoming artifact (fan-in = multiple edges). `output` holds the producer's
// single definition-of-done contract plus the validation ledger.
function inputEdges(input: any): Array<{ source_task_id: string, expected_type?: string, contract: { rules: any[] } }> {
  if (!input) return []
  if (Array.isArray(input.edges)) {
    return input.edges.filter((e: any) => e && e.source_task_id)
  }
  if (input.source_task_id) {
    // Legacy single-source shape → one edge; fold validation_rules into a judgment rule.
    const rules = input.validation_rules
      ? [{ id: 'legacy', label: 'Validation rules', rule: input.validation_rules, kind: 'judgment', severity: 'blocker' }]
      : []
    return [{ source_task_id: input.source_task_id, expected_type: input.expected_type, contract: { rules } }]
  }
  return []
}

// All upstream source task IDs this task consumes from (the tasks that block it).
function inputSourceIds(input: any): string[] {
  return inputEdges(input).map(e => e.source_task_id)
}

// The producer's output contract ({ rules: [] } if none set).
function outputContract(output: any): { rules: any[] } {
  if (output?.contract?.rules) return output.contract
  return { rules: [] }
}

// Normalize a single authored rule into the canonical shape (defaults + a stable id).
function normalizeRule(r: any, i: number): any {
  return {
    id: r.id || `r${i + 1}`,
    label: r.label || r.rule?.toString().slice(0, 40) || `Rule ${i + 1}`,
    rule: r.rule,
    description: r.description || null,
    kind: r.kind === 'check' ? 'check' : 'judgment',
    severity: r.severity === 'warning' ? 'warning' : 'blocker',
  }
}

// Upstream source tasks NOT yet done (the blockers for a fan-in task). Reads both I/O shapes.
async function unmetSources(sb: any, input: any): Promise<Array<{ id: string, text: string, status: string }>> {
  const ids = inputSourceIds(input)
  if (!ids.length) return []
  const { data } = await sb.from('tasks').select('id, text, status').in('id', ids)
  return (data || []).filter((t: any) => t.status !== 'done')
}

// Build the standard "flow blocked, ask the user" response from a list of unmet upstream tasks.
function flowBlockedResponse(unmet: Array<{ text: string, status: string }>): string {
  const names = unmet.map(s => `"${s.text}"`).join(', ')
  const first = unmet[0]
  const single = unmet.length === 1
  return JSON.stringify({
    status: 'flow_blocked',
    action_required: 'ASK_USER',
    instruction: 'Do NOT proceed silently. Present this to the user as a dialog using the AskUserQuestion tool (a clickable prompt, like a permission request). Show the two options below and wait for their choice. If they choose to override, retry this same tool call with proceed_anyway: true.',
    message: `This task is part of a flow that requires ${names} to be complete first.`,
    question: single
      ? `"${first.text}" isn't done yet (${first.status}). How do you want to proceed?`
      : `${unmet.length} upstream tasks aren't done yet (${names}). How do you want to proceed?`,
    options: [
      { label: single ? `Complete "${first.text}" first` : `Complete the ${unmet.length} upstream tasks first`, recommended: true },
      { label: 'Start anyway (override)', proceed_anyway: true },
    ],
  })
}

async function getOrCreateBacklog(sb: any, projectId: string): Promise<string> {
  const { data: existing } = await sb.from('sections')
    .select('id').eq('project_id', projectId).eq('name', 'Backlog').maybeSingle()
  if (existing) return existing.id
  const { data: last } = await sb.from('sections')
    .select('sort_order').eq('project_id', projectId).order('sort_order', { ascending: false }).limit(1).maybeSingle()
  const sortOrder = (last?.sort_order ?? -1) + 1
  const { data } = await sb.from('sections')
    .insert({ project_id: projectId, name: 'Backlog', sort_order: sortOrder })
    .select('id').single()
  return data.id
}

// Standing behavioral directives surfaced to the connected agent at session start.
// Advisory — the MCP can't enforce agent behavior — but injected so every agent
// using Tasker gets a consistent baseline.
const ASSISTANT_DIRECTIVES = [
  'When you begin working on a task, the FIRST thing to do is set its status to in_progress. Calling get_task does this automatically; if you start work without calling get_task, set it explicitly via update_task before doing anything else. When the work is genuinely and verifiably complete, mark it done with complete_task; otherwise leave it in_progress.',
  'When a request is ambiguous, default to the most obvious interpretation and proceed, briefly stating the assumption you made. Do NOT ask a clarifying question for read-only / list / display / search requests — bias toward action over questions.',
  'Only pause to ask the user to clarify or confirm when the action is destructive or outward-facing (deleting, bulk-completing, pushing to GitHub, or anything hard to reverse), OR when the request genuinely cannot be resolved from the conversation and context.',
  'When the user wants to BUILD A NEW FLOW (a multi-step process toward a goal, with quality checks between the steps), call build_new_flow to get the interview playbook + project grounding — do NOT free-form a plan. You then run the grill-me-style interview yourself (one question at a time, always recommend a path), propose the tasks and their input/output contracts, get ONE confirmation of the whole flow at the end, and only then persist via create_task + set_task_output + set_task_input.',
  'REVISION LOOP: When submit_validation_result returns action="regenerate" — redo the producing task (apply the specific gate failures as revision instructions), complete it, then call validate_output + submit_validation_result again. Continue until action="pass" or action="ask_human". When action="ask_human" — the retry limit (3) has been reached; STOP and use AskUserQuestion to present the failures to the human and ask how to proceed. UPSTREAM CASCADE: if the root cause is in the input the producer received (not fixable by redoing the producer alone), you may re-run at most 2 tasks further upstream from the original failure; beyond that depth, stop and ask the human.',
  'VALIDATION INDEPENDENCE: Flows use TWO agents per handoff — executor (you) and validator (a separate subagent). When a task has output contract rules, call store_artifact with the VERBATIM produced content before complete_task. Then call validate_output — if judgment rules exist, the response includes a complete validator_agent_prompt with the artifact already embedded (served from the server, not from you). Spawn a validator subagent using the Agent tool and pass validator_agent_prompt as the prompt — do not modify it. The subagent grades and calls submit_validation_result with validator="independent-subagent". You do NOT evaluate judgment rules yourself. For kind=check rules only (deterministic counts/commands) you may self-evaluate without a subagent.',
  'CHECK RULE EXECUTION: For kind=check rules, ACTUALLY RUN the check — do NOT assert or claim. How: (1) word/character count → count manually word-by-word or run `echo "..." | wc -w` via Bash and put the exact number in the note; (2) command (e.g. "npm test exits 0") → run it with the Bash tool, capture stdout/stderr, put the exit code + output in the note; (3) keyword/pattern → read the artifact and search it, put the match result in the note; (4) file existence → use Glob/Read, put the found path in the note. Submitting a check result with no note is REJECTED. A note of "I checked, it passes" is not evidence — the raw observed value is. FAIL EVIDENCE: any failing rule (kind=judgment OR kind=check) also REQUIRES a note — the specific deficiency: what exactly did not meet the rule and why. "fail" alone is REJECTED. This applies to the validator subagent too.',
]

// ── Shared schema: a single contract rule (TDE-137) ──────────
const RULE_SCHEMA = {
  type: 'object',
  description: 'One quality-bar rule. Author these by discussing with the user, then have them confirm.',
  properties: {
    id: { type: 'string', description: 'Optional stable id; auto-assigned if omitted.' },
    label: { type: 'string', description: 'Short human name (e.g. "Cites enough sources").' },
    rule: { type: 'string', description: 'The rule itself — the assertion checked. For kind=judgment, a precise NL criterion. For kind=check, the check spec (e.g. "min_length: 500", "command: npm test exits 0").' },
    description: { type: 'string', description: 'Optional context: why it matters / how to satisfy. Not itself a pass/fail target.' },
    kind: { type: 'string', enum: ['check', 'judgment'], description: 'check = deterministic (counts, patterns, commands); judgment = semantic judgment by you, the agent.' },
    severity: { type: 'string', enum: ['blocker', 'warning'], description: 'blocker fail reopens the producing task; warning fail is recorded but does not block. Default blocker.' },
  },
  required: ['rule'],
}
const CONTRACT_SCHEMA = {
  type: 'object',
  description: 'A quality contract: an ordered list of rules the artifact must satisfy. Context-free / portable — describe the SHAPE of acceptable output, never this run\'s subject.',
  properties: { rules: { type: 'array', items: RULE_SCHEMA } },
  required: ['rules'],
}

// ── Tool definitions ─────────────────────────────────────────
const TOOLS = [
  {
    name: 'list_projects',
    description: 'List all projects with name, slug, progress stats, and context (goal, why, scope).',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_project',
    description: 'Get full project details: context, all sections, and all tasks with their IDs, priorities, statuses, and notes.',
    inputSchema: {
      type: 'object',
      properties: { project_id: { type: 'string', description: 'Project prefix (e.g. TDE), slug, or UUID' } },
      required: ['project_id'],
    },
  },
  {
    name: 'create_project',
    description: 'Create a new project.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        context: { type: 'object', description: 'Optional: { goal, why, scope, risks, done_looks_like }' },
      },
      required: ['name'],
    },
  },
  {
    name: 'update_project_context',
    description: 'Update or extend the project context fields (goal, why, scope, risks, done_looks_like). Merges with existing context.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string' },
        context: { type: 'object', description: 'Fields to update: goal, why, scope, risks, done_looks_like' },
      },
      required: ['project_id', 'context'],
    },
  },
  {
    name: 'update_project',
    description: 'Update a project\'s name or prefix (short ID prefix like "BPW"). The prefix must be 2–5 uppercase letters and unique across your projects.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Project prefix, slug, or UUID' },
        name:   { type: 'string', description: 'New project name (optional)' },
        prefix: { type: 'string', description: 'New prefix, 2–5 uppercase letters e.g. "BPW" (optional)' },
      },
      required: ['project_id'],
    },
  },
  {
    name: 'delete_project',
    description: 'Permanently delete a project and all its sections, tasks, and milestones. Always confirm with the user before calling this.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Project prefix (e.g. TDE), slug, or UUID' },
        confirmed:  { type: 'boolean', description: 'Must be true to confirm permanent deletion' },
      },
      required: ['project_id', 'confirmed'],
    },
  },
  {
    name: 'list_sections',
    description: 'List all sections in a project.',
    inputSchema: {
      type: 'object',
      properties: { project_id: { type: 'string', description: 'Project prefix (e.g. TDE), slug, or UUID' } },
      required: ['project_id'],
    },
  },
  {
    name: 'create_section',
    description: 'Create a new section inside a project.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string' },
        name: { type: 'string' },
      },
      required: ['project_id', 'name'],
    },
  },
  {
    name: 'list_tasks',
    description: 'List tasks. Done tasks are excluded by default — pass status: "all" to include them. If no project_id is provided, the user\'s default project is used when set; otherwise this requires confirmed: true to list across ALL projects.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Project prefix (e.g. TDE), slug, or UUID (optional — falls back to default project if set)' },
        section_id: { type: 'string', description: 'Section UUID (optional)' },
        status:     { type: 'string', enum: ['pending', 'in_progress', 'done', 'all'], description: 'Filter by status. Defaults to excluding done tasks. Pass "all" to include everything.' },
        confirmed:  { type: 'boolean', description: 'Set to true to list tasks across ALL projects (only needed when project_id is omitted AND no default project is set).' },
      },
      required: [],
    },
  },
  {
    name: 'create_task',
    description: 'Create a new task.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string' },
        section_id: { type: 'string', description: 'Optional. Task is ungrouped if omitted.' },
        text:       { type: 'string', description: 'Task title' },
        detail:     { type: 'string', description: 'Optional context or description' },
        priority:   { type: 'string', enum: ['rush', 'high', 'medium', 'low'] },
        due_date:   { type: 'string', description: 'ISO date YYYY-MM-DD (optional)' },
      },
      required: ['project_id', 'text'],
    },
  },
  {
    name: 'update_task',
    description: 'Update task fields. Only provided fields are changed.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id:    { type: 'string', description: 'Task UUID or short ID (e.g. TDE-31)' },
        text:       { type: 'string' },
        detail:     { type: 'string', description: 'Task context' },
        priority:   { type: 'string', enum: ['rush', 'high', 'medium', 'low'] },
        status:     { type: 'string', enum: ['pending', 'in_progress', 'done'] },
        due_date:   { type: 'string' },
        section_id: { type: 'string', description: 'Move task to a different section (use section UUID)' },
        group_id:   { type: 'string', description: 'Move task to a different group (use group UUID), or null to remove from group' },
        pinned:     { type: 'boolean', description: 'Pin or unpin the task' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'complete_task',
    description: 'Mark a task as done.',
    inputSchema: {
      type: 'object',
      properties: { task_id: { type: 'string', description: 'Task UUID or short ID (e.g. TDE-31)' } },
      required: ['task_id'],
    },
  },
  {
    name: 'uncomplete_task',
    description: 'Mark a completed task as not done (resets status to pending).',
    inputSchema: {
      type: 'object',
      properties: { task_id: { type: 'string', description: 'Task UUID or short ID (e.g. TDE-31)' } },
      required: ['task_id'],
    },
  },
  {
    name: 'delete_task',
    description: 'Permanently delete a task.',
    inputSchema: {
      type: 'object',
      properties: { task_id: { type: 'string', description: 'Task UUID or short ID (e.g. TDE-31)' } },
      required: ['task_id'],
    },
  },
  {
    name: 'rank_tasks',
    description: 'Return pending tasks ranked by priority, due date, and skip count. Use this to answer "what should I work on next?" If no project_id is provided, the user\'s default project is used when set; otherwise this requires confirmed: true to rank across ALL projects.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Optional — falls back to default project if set.' },
        confirmed:  { type: 'boolean', description: 'Set to true to rank tasks across ALL projects (only needed when project_id is omitted AND no default project is set).' },
      },
      required: [],
    },
  },
  {
    name: 'get_task',
    description: 'Get full details for a single task: text, context, priority, status, due date, section, project, and milestones. Call this when you are about to START working on a task — a pending task is automatically set to in_progress (pass peek: true to inspect without starting). When you finish, mark it done with complete_task only if the work is genuinely complete; otherwise leave it in_progress.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Task UUID or short ID (e.g. TDE-31)' },
        peek: { type: 'boolean', description: 'If true, just read the task without auto-setting it to in_progress. Use when inspecting/planning rather than starting work.' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'get_knowledge_base',
    description: 'Return all knowledge base entries for a project. Call this when the user signals they want stored project knowledge applied — e.g. "using the information in your knowledge base", "using what you know about X", "using our brand guidelines", "based on our preferences", or any similar intent to reference saved project context.',
    inputSchema: {
      type: 'object',
      properties: { project_id: { type: 'string', description: 'Project prefix (e.g. TDE), slug, or UUID' } },
      required: ['project_id'],
    },
  },
  {
    name: 'get_project_is',
    description: 'Return the Instruction Set (IS) for a project — the structured directives that govern how work in this project should be done (coding style, commit style, PR workflow, output format, etc.). You do not need to call this directly; it is automatically injected when you call get_task.',
    inputSchema: {
      type: 'object',
      properties: { project_id: { type: 'string', description: 'Project prefix (e.g. TDE), slug, or UUID' } },
      required: ['project_id'],
    },
  },
  {
    name: 'create_kb_entry',
    description: 'Create a new Knowledge Base entry for a project. Use this to save reference material, decisions, architecture notes, or any information that should persist and be retrievable across sessions.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Project prefix (e.g. TDE), slug, or UUID' },
        title:      { type: 'string', description: 'Short title for the entry' },
        content:    { type: 'string', description: 'The content to save (markdown supported)' },
      },
      required: ['project_id', 'title', 'content'],
    },
  },
  {
    name: 'create_is_entry',
    description: 'Create a new Instruction Set entry for a project. Use this to save directives, rules, or guidelines that govern how work in this project should be done. IS entries are automatically injected into every get_task response.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Project prefix (e.g. TDE), slug, or UUID' },
        title:      { type: 'string', description: 'Short title for the directive' },
        content:    { type: 'string', description: 'The instruction content (markdown supported)' },
      },
      required: ['project_id', 'title', 'content'],
    },
  },
  {
    name: 'list_milestones',
    description: 'List all milestones (steps) for a task, showing index, text, and whether each is completed.',
    inputSchema: {
      type: 'object',
      properties: { task_id: { type: 'string', description: 'Task UUID or short ID (e.g. TDE-31)' } },
      required: ['task_id'],
    },
  },
  {
    name: 'add_milestone',
    description: 'Add a new milestone (step) to a task.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Task UUID or short ID (e.g. TDE-31)' },
        text:    { type: 'string', description: 'Milestone text' },
      },
      required: ['task_id', 'text'],
    },
  },
  {
    name: 'complete_milestone',
    description: 'Mark a milestone as done by its index (0-based).',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Task UUID or short ID (e.g. TDE-31)' },
        index:   { type: 'number', description: 'Zero-based index of the milestone to complete' },
      },
      required: ['task_id', 'index'],
    },
  },
  {
    name: 'uncomplete_milestone',
    description: 'Mark a completed milestone as not done by its index (0-based).',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Task UUID or short ID (e.g. TDE-31)' },
        index:   { type: 'number', description: 'Zero-based index of the milestone to uncomplete' },
      },
      required: ['task_id', 'index'],
    },
  },
  {
    name: 'delete_milestone',
    description: 'Permanently delete a milestone from a task by its index (0-based).',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Task UUID or short ID (e.g. TDE-31)' },
        index:   { type: 'number', description: 'Zero-based index of the milestone to delete' },
      },
      required: ['task_id', 'index'],
    },
  },
  {
    name: 'github_connect',
    description: 'Connect a GitHub account by saving a Personal Access Token (PAT). Required before using any other GitHub tools.',
    inputSchema: {
      type: 'object',
      properties: {
        token: { type: 'string', description: 'GitHub Personal Access Token (PAT) with "repo" scope' },
      },
      required: ['token'],
    },
  },
  {
    name: 'github_disconnect',
    description: 'Remove the saved GitHub token, disconnecting the GitHub integration.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'github_list_repos',
    description: 'List GitHub repositories accessible with the connected GitHub account.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'github_import_project',
    description: 'Import a GitHub repository as a new Tasker project. Fetches all open issues and creates them as tasks, using labels to assign priorities and sections.',
    inputSchema: {
      type: 'object',
      properties: {
        repo:         { type: 'string', description: 'Repository in owner/repo format (e.g. "octocat/hello-world")' },
        project_name: { type: 'string', description: 'Optional project name. Defaults to the repository name.' },
      },
      required: ['repo'],
    },
  },
  {
    name: 'github_sync_issues',
    description: 'Sync new open issues from the GitHub repository linked to a project. Only imports issues not already in the project.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Project prefix (e.g. TDE), slug, or UUID' },
      },
      required: ['project_id'],
    },
  },
  {
    name: 'github_push_task',
    description: 'Push a single task back to GitHub (write-back). Updates the linked issue\'s title, body, and open/closed state (a done task closes its issue; pending/in_progress reopens it). If the task is not yet linked to an issue, creates a new issue in the project\'s linked repo and links it. Requires the project to have a linked GitHub repo. Always confirm with the user before pushing.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Task UUID or short ID (e.g. TDE-31)' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'github_push_project',
    description: 'Push all of a project\'s tasks back to GitHub (batch write-back). Updates each linked issue\'s title, body, and open/closed state. By default only updates tasks already linked to an issue; set create_missing: true to also create new issues for unlinked tasks. Requires the project to have a linked GitHub repo. Always confirm with the user before pushing.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id:     { type: 'string', description: 'Project prefix (e.g. TDE), slug, or UUID' },
        create_missing: { type: 'boolean', description: 'If true, also create new GitHub issues for tasks not yet linked to one. Defaults to false (update linked tasks only).' },
      },
      required: ['project_id'],
    },
  },
  {
    name: 'list_kb_entries',
    description: 'List Knowledge Base entries for a project — returns id + title + updated_at only (no content). Use this for cheap discovery before update/delete operations.',
    inputSchema: {
      type: 'object',
      properties: { project_id: { type: 'string', description: 'Project prefix (e.g. TDE), slug, or UUID' } },
      required: ['project_id'],
    },
  },
  {
    name: 'update_kb_entry',
    description: 'Update a Knowledge Base entry by id. Provide title and/or content — only provided fields change.',
    inputSchema: {
      type: 'object',
      properties: {
        entry_id: { type: 'string', description: 'UUID of the KB entry. Get it via list_kb_entries or get_knowledge_base.' },
        title:    { type: 'string', description: 'New title (optional)' },
        content:  { type: 'string', description: 'New content (optional, markdown supported)' },
      },
      required: ['entry_id'],
    },
  },
  {
    name: 'delete_kb_entry',
    description: 'Permanently delete a Knowledge Base entry by id.',
    inputSchema: {
      type: 'object',
      properties: { entry_id: { type: 'string', description: 'UUID of the KB entry to delete.' } },
      required: ['entry_id'],
    },
  },
  {
    name: 'list_is_entries',
    description: 'List Instruction Set entries for a project — returns id + title + updated_at only (no content). Use this for cheap discovery before update/delete operations.',
    inputSchema: {
      type: 'object',
      properties: { project_id: { type: 'string', description: 'Project prefix (e.g. TDE), slug, or UUID' } },
      required: ['project_id'],
    },
  },
  {
    name: 'update_is_entry',
    description: 'Update an Instruction Set entry by id. Provide title and/or content — only provided fields change.',
    inputSchema: {
      type: 'object',
      properties: {
        entry_id: { type: 'string', description: 'UUID of the IS entry. Get it via list_is_entries or get_project_is.' },
        title:    { type: 'string', description: 'New title (optional)' },
        content:  { type: 'string', description: 'New content (optional, markdown supported)' },
      },
      required: ['entry_id'],
    },
  },
  {
    name: 'delete_is_entry',
    description: 'Permanently delete an Instruction Set entry by id.',
    inputSchema: {
      type: 'object',
      properties: { entry_id: { type: 'string', description: 'UUID of the IS entry to delete.' } },
      required: ['entry_id'],
    },
  },
  {
    name: '__init_tasker_session',
    description: 'Initialize AI session with behavioral preferences. Returns saved instructions if they exist, or questionnaire structure if first-time setup is needed. Pass show_questionnaire: true to display the questionnaire again with current choices marked.',
    inputSchema: {
      type: 'object',
      properties: {
        show_questionnaire: { type: 'boolean', description: 'If true, always show the questionnaire with current choices marked, even if preferences exist.' },
      },
      required: [],
    },
  },
  {
    name: 'get_ai_instructions',
    description: 'Fetch the user\'s current AI behavioral preferences from Supabase. Returns task_list_format, communication_style, and other settings.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'update_ai_instructions',
    description: 'Save or update AI behavioral preferences. Takes any of: task_list_format, show_completed_tasks, rank_tasks_by, communication_style, multiple_tasks_handling, show_project_context. Only provided fields are changed.',
    inputSchema: {
      type: 'object',
      properties: {
        task_list_format: { type: 'string', enum: ['plain_text', 'markdown_table', 'numbered_list'] },
        show_completed_tasks: { type: 'boolean' },
        rank_tasks_by: { type: 'string', enum: ['sorting_order', 'task_priority'] },
        communication_style: { type: 'string', enum: ['terse', 'detailed', 'conversational'] },
        multiple_tasks_handling: { type: 'string', enum: ['collaborative', 'autonomous'] },
        show_project_context: { type: 'boolean' },
      },
      required: [],
    },
  },
  {
    name: 'list_groups',
    description: 'List all groups in a section.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Project prefix (e.g. TDE), slug, or UUID' },
        section_id: { type: 'string', description: 'Section UUID' },
      },
      required: ['project_id', 'section_id'],
    },
  },
  {
    name: 'create_group',
    description: 'Create a new group inside a section.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Project prefix (e.g. TDE), slug, or UUID' },
        section_id: { type: 'string', description: 'Section UUID' },
        name: { type: 'string', description: 'Group name' },
      },
      required: ['project_id', 'section_id', 'name'],
    },
  },
  {
    name: 'rename_group',
    description: 'Rename an existing group.',
    inputSchema: {
      type: 'object',
      properties: {
        group_id: { type: 'string', description: 'Group UUID' },
        name: { type: 'string', description: 'New group name' },
      },
      required: ['group_id', 'name'],
    },
  },
  {
    name: 'delete_group',
    description: 'Delete a group. Optionally delete all tasks in the group, or move them to ungrouped.',
    inputSchema: {
      type: 'object',
      properties: {
        group_id: { type: 'string', description: 'Group UUID' },
        delete_tasks: { type: 'boolean', description: 'If true, delete all tasks in the group. If false (default), move tasks to ungrouped.' },
      },
      required: ['group_id'],
    },
  },
  {
    name: 'move_task_to_group',
    description: 'Move a task into a group, or move it out of a group (to ungrouped). Pass group_id: null to remove from group.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Task UUID or short ID (e.g. TDE-31)' },
        group_id: { type: 'string', description: 'Group UUID to move to, or null to move to ungrouped' },
        section_id: { type: 'string', description: 'Optional: new section UUID to move task to as well' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'analyze_section',
    description: 'Returns structured analysis of a section without AI inference.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Project prefix (e.g. TDE), slug, or UUID' },
        section_id: { type: 'string', description: 'Section UUID' },
      },
      required: ['project_id', 'section_id'],
    },
  },
  {
    name: 'section_insights',
    description: 'Returns AI-powered analysis of a section (what\'s working, what needs attention, suggested actions).',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Project prefix (e.g. TDE), slug, or UUID' },
        section_id: { type: 'string', description: 'Section UUID' },
      },
      required: ['project_id', 'section_id'],
    },
  },
  {
    name: 'set_task_input',
    description: 'Declare an INPUT EDGE: this task consumes the output of `source_task_id`, and `contract` is the acceptance criteria that upstream output must meet for THIS task to use it (the consumer\'s bar). Call once per upstream source to support fan-in — a task can require multiple inputs (e.g. a draft needing both an outline and research). Upserts the edge for that source by default.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Task UUID or short ID (e.g. TDE-31) — the CONSUMER' },
        source_task_id: { type: 'string', description: 'Upstream task whose output this task consumes (the producer for this edge)' },
        contract: CONTRACT_SCHEMA,
        expected_type: { type: 'string', enum: ['string', 'document', 'code', 'decision', 'other'], description: 'Optional coarse type hint for this input' },
        replace: { type: 'boolean', description: 'If true, replace ALL input edges with just this one. Default false (upsert only this source\'s edge).' },
      },
      required: ['task_id', 'source_task_id'],
    },
  },
  {
    name: 'set_task_output',
    description: 'Set this task\'s OUTPUT CONTRACT — the producer\'s single definition-of-done for the one artifact it produces. Consumers are derived (any task that lists this one as a source), so no target is needed. Keep the contract context-free / portable.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Task UUID or short ID (e.g. TDE-31) — the PRODUCER' },
        contract: CONTRACT_SCHEMA,
      },
      required: ['task_id', 'contract'],
    },
  },
  {
    name: 'store_artifact',
    description: 'Store the actual produced output for a task before completing it. The artifact is embedded directly into the validator_agent_prompt returned by validate_output — the independent validator subagent receives the content from the server, not from the executor. REQUIRED before complete_task on any task whose output contract contains kind=judgment rules.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Task UUID or short ID — the PRODUCER' },
        content: { type: 'string', description: 'The actual produced output — verbatim, not a summary. This is exactly what the independent validator will grade.' },
        format: { type: 'string', enum: ['text', 'markdown', 'code', 'json'], description: 'Optional format hint for the validator. Default: text.' },
      },
      required: ['task_id', 'content'],
    },
  },
  {
    name: 'validate_output',
    description: 'PHASE 1 of a handoff check. Returns the rules to evaluate — the CONSUMER\'s input contract for this edge (the gate) plus the producer\'s own output contract (self-check) — with an instruction for YOU (the agent) to evaluate each rule against the actual produced output, then report results via submit_validation_result. Tasker does NOT run the checks; you do. Does not itself return a verdict.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Task UUID or short ID (e.g. TDE-31) — the PRODUCER whose output to validate' },
        target_task_id: { type: 'string', description: 'Optional: which CONSUMER edge to validate against. Required only if the producer feeds more than one task.' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'submit_validation_result',
    description: 'PHASE 2 of a handoff check. After evaluating the rules returned by validate_output, report per-rule results here. Tasker writes them to the producer\'s feedback ledger, applies the gate (any BLOCKER gate-rule failure → invalid, reopens the producer), and returns the verdict. Warnings are recorded but do not block.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Task UUID or short ID — the PRODUCER (same as validate_output)' },
        target_task_id: { type: 'string', description: 'Optional: the CONSUMER edge validated against (required only if the producer feeds more than one task)' },
        validator: { type: 'string', description: 'Who ran this validation. Required when judgment rules are present. Use "independent-subagent" (fresh Claude session with the artifact), "human" (human reviewed), or "self" (you graded your own work — discloses conflict). Omitting when judgment rules exist flags the ledger as unverified.' },
        results: {
          type: 'array',
          description: 'Per-rule results from your evaluation.',
          items: {
            type: 'object',
            properties: {
              rule_id: { type: 'string', description: 'id of the rule (from validate_output\'s output)' },
              status: { type: 'string', enum: ['pass', 'fail'], description: 'Did the output meet this rule?' },
              note: { type: 'string', description: 'REQUIRED for kind=check rules (pass or fail): the raw observed result of actually running the check — command stdout, exact word/character count, pattern match result, file path found. REQUIRED for any fail (any kind): the specific deficiency — what did not meet the rule and why. Not a claim — concrete evidence. For kind=judgment pass: reasoning recommended but not required.' },
            },
            required: ['rule_id', 'status'],
          },
        },
      },
      required: ['task_id', 'results'],
    },
  },
  {
    name: 'get_validation_feedback',
    description: 'Get the latest validation feedback for a task: its overall status and the per-rule ledger (what failed and why) from the last handoff check.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Task UUID or short ID (e.g. TDE-31)' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'get_flow_order',
    description: 'Returns tasks in a dependency flow sorted in the order they should be tackled (topological execution order). Each task gets a step number showing when it should be worked on relative to the others. Useful for understanding what to do first, second, third in a chain of dependent tasks.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Project prefix (e.g. TDE), slug, or UUID' },
        task_id: { type: 'string', description: 'Optional: task UUID or short ID (e.g. TDE-31) to focus on that task\'s specific flow. If omitted, returns all flows in the project.' },
      },
      required: ['project_id'],
    },
  },
  {
    name: 'get_task_connections',
    description: 'Returns the direct (1-hop) dependencies of a task: tasks it directly requires (blockers) and tasks that directly depend on it (dependents). Use this to understand the immediate context of a single task without seeing the entire flow.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Task UUID or short ID (e.g. BPW-7)' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'build_new_flow',
    description: 'Start building a NEW flow — a chain of contract-linked tasks toward a goal (sections/groups are just filing; the flow is the I/O chain). Call this when the user wants to create a multi-step process/flow from scratch. It does NOT build anything itself: it returns an interview playbook + the project\'s current tasks/sections (grounding). YOU then run a grill-me-style interview, propose the tasks and their input/output contracts, get ONE confirmation of the whole flow at the end, and only then persist via create_task + set_task_output + set_task_input.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Project prefix (e.g. TDE), slug, or UUID the flow belongs to' },
        goal: { type: 'string', description: 'The end goal of the flow in the user\'s words (the final deliverable). Optional — if omitted, the playbook tells you to elicit it first.' },
      },
      required: ['project_id'],
    },
  },
]

// ── Group resolver helper ────────────────────────────────────
async function resolveGroup(sb: any, userId: string, groupId: string) {
  const { data: group } = await sb.from('groups')
    .select('*, sections(id, project_id, projects(id, user_id))')
    .eq('id', groupId)
    .single()
  if (!group || group.sections?.projects?.user_id !== userId) return null
  return group
}

// ── Tool handlers ─────────────────────────────────────────────
async function runTool(sb: any, userId: string, name: string, args: any): Promise<string> {
  switch (name) {

    case 'list_projects': {
      const [{ data: projects }, { data: tasks }] = await Promise.all([
        sb.from('projects').select('id, name, slug, prefix, context').eq('user_id', userId).order('sort_order'),
        sb.from('tasks').select('project_id, status').eq('user_id', userId),
      ])
      if (!projects?.length) return 'No projects found.'
      const counts: Record<string, { total: number; done: number }> = {}
      for (const t of (tasks ?? [])) {
        if (!counts[t.project_id]) counts[t.project_id] = { total: 0, done: 0 }
        counts[t.project_id].total++
        if (t.status === 'done') counts[t.project_id].done++
      }
      return projects.map((p: any) => {
        const c = counts[p.id] ?? { total: 0, done: 0 }
        const pct = c.total > 0 ? Math.round((c.done / c.total) * 100) : 0
        const ctx = p.context ?? {}
        return [
          `## ${p.name}  (prefix: ${p.prefix} | slug: ${p.slug} | id: ${p.id})`,
          `Progress: ${c.done}/${c.total} tasks · ${pct}%`,
          ctx.goal ? `Goal: ${ctx.goal}` : null,
          ctx.why  ? `Why:  ${ctx.why}`  : null,
        ].filter(Boolean).join('\n')
      }).join('\n\n')
    }

    case 'get_project': {
      const project = await resolveProject(sb, userId, args.project_id)
      if (!project) return `Project "${args.project_id}" not found.`
      const [{ data: sections }, { data: tasks }] = await Promise.all([
        sb.from('sections').select('*').eq('project_id', project.id).order('sort_order'),
        sb.from('tasks').select('*').eq('project_id', project.id).order('sort_order'),
      ])
      const ctx = project.context ?? {}
      const lines: string[] = [
        `# ${project.name}`,
        `prefix: ${project.prefix} | slug: ${project.slug} | id: ${project.id}`,
        '',
        '## Context',
        ctx.goal            ? `Goal: ${ctx.goal}`                     : null,
        ctx.why             ? `Why: ${ctx.why}`                       : null,
        ctx.scope           ? `Scope: ${ctx.scope}`                   : null,
        ctx.risks           ? `Risks: ${ctx.risks}`                   : null,
        ctx.done_looks_like ? `Done looks like: ${ctx.done_looks_like}` : null,
        '',
      ].filter((l): l is string => l !== null)

      for (const s of (sections ?? [])) {
        lines.push(`## Section: ${s.name}  (id: ${s.id})`)
        const sts = (tasks ?? []).filter((t: any) => t.section_id === s.id)
        if (!sts.length) { lines.push('(empty)'); lines.push(''); continue }
        for (const t of sts) {
          const badges = [t.priority, t.status, t.due_date ? `due ${t.due_date}` : null].filter(Boolean).join(', ')
          lines.push(`- [id: ${t.id}] ${t.text}  (${badges})`)
          if (t.detail) lines.push(`  Notes: ${t.detail}`)
        }
        lines.push('')
      }
      const ungrouped = (tasks ?? []).filter((t: any) => !t.section_id)
      if (ungrouped.length) {
        lines.push('## Ungrouped Tasks')
        for (const t of ungrouped) {
          const badges = [t.priority, t.status, t.due_date ? `due ${t.due_date}` : null].filter(Boolean).join(', ')
          lines.push(`- [id: ${t.id}] ${t.text}  (${badges})`)
          if (t.detail) lines.push(`  Notes: ${t.detail}`)
        }
      }
      return lines.join('\n')
    }

    case 'create_project': {
      const { name, context } = args
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
        + '-' + Date.now().toString(36)
      const { data, error } = await sb.from('projects')
        .insert({ name, slug, user_id: userId, context: context ?? {} })
        .select().single()
      if (error) throw new Error(error.message)
      await getOrCreateBacklog(sb, data.id)
      return `Created project "${name}"\nslug: ${data.slug}\nid:   ${data.id}`
    }

    case 'update_project_context': {
      const project = await resolveProject(sb, userId, args.project_id)
      if (!project) return `Project "${args.project_id}" not found.`
      const merged = { ...(project.context ?? {}), ...args.context }
      await sb.from('projects').update({ context: merged }).eq('id', project.id)
      return `Updated context for "${project.name}".`
    }

    case 'update_project': {
      const project = await resolveProject(sb, userId, args.project_id)
      if (!project) return `Project "${args.project_id}" not found.`
      const updates: Record<string, string> = {}
      if (args.name) updates.name = args.name
      if (args.prefix) {
        const p = args.prefix.trim().toUpperCase()
        if (!/^[A-Z]{2,5}$/.test(p)) return 'Prefix must be 2–5 uppercase letters only (e.g. "BPW").'
        const { data: clash } = await sb.from('projects').select('id').eq('user_id', userId).eq('prefix', p).neq('id', project.id).maybeSingle()
        if (clash) return `Prefix "${p}" is already used by another project.`
        updates.prefix = p
      }
      if (!Object.keys(updates).length) return 'Nothing to update — pass name and/or prefix.'
      await sb.from('projects').update(updates).eq('id', project.id)
      const parts = []
      if (updates.name) parts.push(`name → "${updates.name}"`)
      if (updates.prefix) parts.push(`prefix → ${updates.prefix}`)
      return `Updated project "${project.name}": ${parts.join(', ')}.`
    }

    case 'delete_project': {
      if (!args.confirmed) return 'You must set confirmed: true to delete a project. This is permanent and cannot be undone.'
      const project = await resolveProject(sb, userId, args.project_id)
      if (!project) return `Project "${args.project_id}" not found.`
      const { data: taskRows } = await sb.from('tasks').select('id').eq('project_id', project.id)
      const taskIds = (taskRows ?? []).map((t: any) => t.id)
      if (taskIds.length) {
        await sb.from('task_discussions').delete().in('task_id', taskIds)
        await sb.from('tasks').delete().eq('project_id', project.id)
      }
      const { data: secs } = await sb.from('sections').select('id').eq('project_id', project.id)
      const sectionIds = (secs ?? []).map((s: any) => s.id)
      if (sectionIds.length) {
        await sb.from('groups').delete().in('section_id', sectionIds)
        await sb.from('sections').delete().eq('project_id', project.id)
      }
      await Promise.all([
        sb.from('project_knowledge').delete().eq('project_id', project.id),
        sb.from('project_instructions').delete().eq('project_id', project.id),
      ])
      await sb.from('projects').delete().eq('id', project.id)
      return `Deleted project "${project.name}" and all its data.`
    }

    case 'list_sections': {
      const project = await resolveProject(sb, userId, args.project_id)
      if (!project) return `Project "${args.project_id}" not found.`
      const { data } = await sb.from('sections').select('id, name').eq('project_id', project.id).order('sort_order')
      if (!data?.length) return `No sections in "${project.name}".`
      return data.map((s: any) => `[id: ${s.id}] ${s.name}`).join('\n')
    }

    case 'create_section': {
      const project = await resolveProject(sb, userId, args.project_id)
      if (!project) return `Project "${args.project_id}" not found.`
      const { data: existing } = await sb.from('sections')
        .select('sort_order').eq('project_id', project.id).order('sort_order', { ascending: false }).limit(1).maybeSingle()
      const sortOrder = (existing?.sort_order ?? -1) + 1
      const { data, error } = await sb.from('sections')
        .insert({ project_id: project.id, name: args.name, sort_order: sortOrder })
        .select().single()
      if (error) throw new Error(error.message)
      return `Created section "${args.name}" in "${project.name}"\nid: ${data.id}`
    }

    case 'list_tasks': {
      const { project_id, section_id, status, confirmed } = args
      let query = sb.from('tasks').select('id, short_id, text, priority, status, due_date, detail, section_id, project_id, created_at, project:projects(prefix), section:sections(name)').eq('user_id', userId)
      if (project_id) {
        const p = await resolveProject(sb, userId, project_id)
        if (p) query = query.eq('project_id', p.id)
      } else if (!confirmed) {
        const def = await resolveDefaultProject(sb, userId)
        if (def) {
          query = query.eq('project_id', def.id)
        } else {
          return 'This will list tasks across ALL your projects. Call again with confirmed: true if that\'s what you want, or provide a project_id to scope it.'
        }
      }
      if (section_id) query = query.eq('section_id', section_id)
      if (status === 'all')   { /* no filter */ }
      else if (status)        query = query.eq('status', status)
      else                    query = query.neq('status', 'done')
      const { data } = await query.order('sort_order')
      if (!data?.length) return 'No tasks found.'
      return data.map((t: any) => {
        const shortRef = t.project?.prefix && t.short_id != null ? `${t.project.prefix}-${t.short_id}` : t.id
        const sectionName = t.section?.name ?? 'no section'
        const added = t.created_at ? t.created_at.slice(0, 10) : null
        const badges = [t.priority, t.due_date ? `due ${t.due_date}` : null, t.status !== 'pending' ? t.status : null].filter(Boolean).join(', ')
        return `${shortRef} — ${t.text}${badges ? ` [${badges}]` : ''} · ${sectionName}${added ? ` · added ${added}` : ''}`
      }).join('\n')
    }

    case 'create_task': {
      const { project_id, section_id, text, detail, priority, due_date } = args
      const project = await resolveProject(sb, userId, project_id)
      if (!project) return `Project "${project_id}" not found.`
      const resolvedSectionId = section_id ?? await getOrCreateBacklog(sb, project.id)
      let siblingQuery = sb.from('tasks').select('sort_order').eq('project_id', project.id).eq('section_id', resolvedSectionId)
      const { data: lastSibling } = await siblingQuery.order('sort_order', { ascending: false }).limit(1).maybeSingle()
      const sortOrder = (lastSibling?.sort_order ?? -1) + 1
      const { data, error } = await sb.from('tasks').insert({
        project_id: project.id,
        section_id: resolvedSectionId,
        user_id: userId,
        text,
        detail: detail ?? null,
        priority: priority ?? 'medium',
        due_date: due_date ?? null,
        status: 'pending',
        sort_order: sortOrder,
      }).select().single()
      if (error) throw new Error(error.message)
      return `Created task "${text}"\nid: ${data.id}`
    }

    case 'update_task': {
      const { task_id, proceed_anyway, ...updates } = args
      const allowed = ['text', 'detail', 'priority', 'status', 'due_date', 'section_id', 'group_id', 'pinned']
      const patch: Record<string, any> = {}
      for (const k of allowed) if (k === 'group_id' ? updates[k] !== undefined : updates[k] !== undefined && updates[k] !== null) patch[k] = updates[k]
      const task = await resolveTask(sb, userId, task_id)
      if (!task) return 'Task not found.'

      // Check for unmet flow step when starting work (fan-in: all sources must be done)
      if ((patch.status === 'in_progress' || patch.status === 'done') && task.input && !proceed_anyway) {
        const unmet = await unmetSources(sb, task.input)
        if (unmet.length) return flowBlockedResponse(unmet)
      }

      if (patch.status === 'done') {
        patch.completed_at = new Date().toISOString()
      } else if (patch.status === 'pending' || patch.status === 'in_progress') {
        patch.completed_at = null
      }

      if (patch.pinned === true) {
        const { data: fullTask } = await sb.from('tasks').select('project_id').eq('id', task.id).maybeSingle()
        if (fullTask?.project_id) {
          await sb.from('tasks').update({ pinned: false, pin_snoozed: false }).eq('project_id', fullTask.project_id)
        }
        patch.pinned_at = new Date().toISOString()
        patch.pin_snoozed = false
      } else if (patch.pinned === false) {
        patch.pinned_at = null
      }

      await sb.from('tasks').update(patch).eq('id', task.id)
      return `Updated "${task.text}".`
    }

    case 'complete_task': {
      const { proceed_anyway } = args
      const task = await resolveTask(sb, userId, args.task_id)
      if (!task) return 'Task not found.'

      // Check for unmet flow step (fan-in: all sources must be done)
      if (task.input && !proceed_anyway) {
        const unmet = await unmetSources(sb, task.input)
        if (unmet.length) return flowBlockedResponse(unmet)
      }

      // Block completion if judgment output rules exist but no artifact stored
      if (!proceed_anyway) {
        const out = (task.output && typeof task.output === 'object') ? task.output : {}
        const judgmentRules = (out.contract?.rules || []).filter((r: any) => r.kind === 'judgment')
        if (judgmentRules.length && !out.artifact) {
          return JSON.stringify({
            blocked: true,
            reason: `"${task.text}" has ${judgmentRules.length} kind=judgment output rule(s) but no artifact has been stored. Call store_artifact with the verbatim produced content first — this is what the independent validator will grade. Then call complete_task again.`,
            judgment_rules: judgmentRules.map((r: any) => ({ id: r.id, label: r.label, rule: r.rule })),
            bypass: 'Pass proceed_anyway: true to skip this check (marks validation as unverified).',
          })
        }
      }

      await sb.from('tasks').update({ status: 'done', completed_at: new Date().toISOString() }).eq('id', task.id)
      return `✓ Marked "${task.text}" as done.`
    }

    case 'uncomplete_task': {
      const task = await resolveTask(sb, userId, args.task_id)
      if (!task) return 'Task not found.'
      await sb.from('tasks').update({ status: 'pending', completed_at: null }).eq('id', task.id)
      return `↩ Marked "${task.text}" as not done.`
    }

    case 'delete_task': {
      const task = await resolveTask(sb, userId, args.task_id)
      if (!task) return 'Task not found.'
      await sb.from('tasks').delete().eq('id', task.id)
      return `Deleted "${task.text}".`
    }

    case 'rank_tasks': {
      let query = sb.from('tasks').select('*, project:projects(name, slug, prefix)').eq('user_id', userId).neq('status', 'done')
      if (args.project_id) {
        const p = await resolveProject(sb, userId, args.project_id)
        if (p) query = query.eq('project_id', p.id)
      } else if (!args.confirmed) {
        const def = await resolveDefaultProject(sb, userId)
        if (def) {
          query = query.eq('project_id', def.id)
        } else {
          return 'This will rank tasks across ALL your projects. Call again with confirmed: true if that\'s what you want, or provide a project_id to scope it.'
        }
      }
      const { data } = await query
      if (!data?.length) return 'No pending tasks.'
      const ranked = rankTasks(data)
      return ranked.map((t: any, i: number) => {
        const shortRef = t.project?.prefix && t.short_id != null ? `${t.project.prefix}-${t.short_id}` : null
        const badges = [t.priority, t.due_date ? `due ${t.due_date}` : null, t.project?.name, t.pinned ? '⭐ pinned' : null].filter(Boolean).join(', ')
        return `${i + 1}. [${shortRef ?? t.id}] ${t.text}  (${badges})  score: ${t._score}`
      }).join('\n')
    }

    case 'get_task': {
      const task = await resolveTask(sb, userId, args.task_id)
      if (!task) return 'Task not found.'
      const { data: full } = await sb.from('tasks')
        .select('*, section:sections(name), project:projects(name, prefix)')
        .eq('id', task.id)
        .maybeSingle()
      if (!full) return 'Task not found.'

      // Auto-start: fetching a task's full detail signals that work is beginning.
      // Flip pending → in_progress so the board reflects active work. Never reopen
      // a done task, and leave an already in_progress task as-is. Suppress with peek: true.
      // BUT: if the task has an unmet flow dependency (its source isn't done), do NOT
      // flip silently — surface a warning so the agent can confirm with the user first.
      let justStarted = false
      let flowWarning: { names: string, first: string, status: string, count: number } | null = null
      if (full.status === 'pending' && !args.peek) {
        const unmet = await unmetSources(sb, full.input)
        if (unmet.length) {
          flowWarning = {
            names: unmet.map((u: any) => `"${u.text}"`).join(', '),
            first: unmet[0].text,
            status: unmet[0].status,
            count: unmet.length,
          }
        }
        if (!flowWarning) {
          await sb.from('tasks').update({ status: 'in_progress' }).eq('id', full.id)
          full.status = 'in_progress'
          justStarted = true
        }
      }

      const { data: disc } = await sb.from('task_discussions')
        .select('steps, checked_steps')
        .eq('task_id', task.id)
        .maybeSingle()
      const shortRef = full.project?.prefix && full.short_id != null ? `${full.project.prefix}-${full.short_id}` : full.id
      const lines: string[] = [
        `# ${full.text}`,
        `ID: ${shortRef} | Project: ${full.project?.name ?? '—'} | Section: ${full.section?.name ?? 'Ungrouped'}`,
        `Priority: ${full.priority} | Status: ${full.status}${full.due_date ? ` | Due: ${full.due_date}` : ''}`,
      ]
      if (full.detail) lines.push(`\nContext:\n${full.detail}`)
      const steps: any[] = disc?.steps ?? []
      const checked: boolean[] = disc?.checked_steps ?? []
      if (steps.length) {
        lines.push('\nMilestones:')
        steps.forEach((s: any, i: number) => {
          const label = typeof s === 'string' ? s : s.summary
          lines.push(`  ${checked[i] ? '✓' : '○'} ${label}`)
        })
      }

      // Inject project IS automatically
      if (full.project_id) {
        const { data: isEntries } = await sb.from('project_instructions')
          .select('title, content')
          .eq('project_id', full.project_id)
          .order('created_at')
        if (isEntries?.length) {
          lines.push('\n---')
          lines.push('# Project Instruction Set')
          for (const entry of isEntries) {
            lines.push(`\n## ${entry.title}\n\n${entry.content}`)
          }
        }
      }

      // Workflow directive
      lines.push('\n---')
      if (flowWarning) {
        const dep = flowWarning.count === 1
          ? `"${flowWarning.first}", which is not done yet (currently: ${flowWarning.status})`
          : `${flowWarning.count} upstream tasks that are not done yet (${flowWarning.names})`
        lines.push(`⚠️ FLOW DEPENDENCY — NOT STARTED: This task depends on ${dep}. Its status was left as pending. Do NOT proceed silently — present this to the user via your interactive question tool (AskUserQuestion in Claude Code, AskQuestion in Cursor, or the equivalent): option 1 (recommended) complete the upstream task(s) first; option 2 start anyway. If they choose start-anyway, set this task to in_progress by calling update_task with proceed_anyway: true.`)
      } else if (justStarted) {
        lines.push('▶ Status auto-set to in_progress — you are now working on this task.')
      }
      lines.push('When you finish: call complete_task ONLY if the work is genuinely and verifiably complete. If it is partial, blocked, or unverified, leave it in_progress (do not mark done).')

      return lines.join('\n')
    }

    case 'get_project_is': {
      const project = await resolveProject(sb, userId, args.project_id)
      if (!project) return `Project "${args.project_id}" not found.`
      const { data: entries } = await sb.from('project_instructions')
        .select('id, title, content')
        .eq('project_id', project.id)
        .order('created_at')
      if (!entries?.length) return `No instruction set defined for "${project.name}". Add entries via the IS button in the project header.`
      return [
        `# Instruction Set — ${project.name}`,
        '',
        ...entries.map((e: any) => `## ${e.title}  (id: ${e.id})\n\n${e.content}`),
      ].join('\n\n---\n\n')
    }

    case 'create_kb_entry': {
      const project = await resolveProject(sb, userId, args.project_id)
      if (!project) return `Project "${args.project_id}" not found.`
      const { data, error } = await sb.from('project_knowledge')
        .insert({ project_id: project.id, user_id: userId, title: args.title, content: args.content })
        .select().single()
      if (error) throw new Error(error.message)
      return `Created KB entry "${data.title}" in "${project.name}".`
    }

    case 'create_is_entry': {
      const project = await resolveProject(sb, userId, args.project_id)
      if (!project) return `Project "${args.project_id}" not found.`
      const { data, error } = await sb.from('project_instructions')
        .insert({ project_id: project.id, user_id: userId, title: args.title, content: args.content })
        .select().single()
      if (error) throw new Error(error.message)
      return `Created IS entry "${data.title}" in "${project.name}".`
    }

    case 'get_knowledge_base': {
      const project = await resolveProject(sb, userId, args.project_id)
      if (!project) return `Project "${args.project_id}" not found.`
      const { data: entries } = await sb.from('project_knowledge')
        .select('id, title, content, updated_at')
        .eq('project_id', project.id)
        .order('created_at')
      if (!entries?.length) return `No knowledge base entries for "${project.name}". Add entries via the KB button in the project header.`
      return [
        `# Knowledge Base — ${project.name}`,
        '',
        ...entries.map((e: any) => `## ${e.title}  (id: ${e.id})\n\n${e.content}`),
      ].join('\n\n---\n\n')
    }

    case 'list_kb_entries': {
      const project = await resolveProject(sb, userId, args.project_id)
      if (!project) return `Project "${args.project_id}" not found.`
      const { data } = await sb.from('project_knowledge')
        .select('id, title, updated_at')
        .eq('project_id', project.id)
        .order('created_at')
      if (!data?.length) return `No knowledge base entries for "${project.name}".`
      return data.map((e: any) => `[id: ${e.id}] ${e.title}  (updated ${e.updated_at})`).join('\n')
    }

    case 'update_kb_entry': {
      const fields: any = {}
      if (args.title   !== undefined) fields.title   = args.title
      if (args.content !== undefined) fields.content = args.content
      if (!Object.keys(fields).length) return 'No fields to update. Provide title or content.'
      const { data, error } = await sb.from('project_knowledge')
        .update(fields)
        .eq('id', args.entry_id)
        .eq('user_id', userId)
        .select()
        .maybeSingle()
      if (error) throw new Error(error.message)
      if (!data) return `KB entry "${args.entry_id}" not found.`
      return `Updated KB entry "${data.title}".`
    }

    case 'delete_kb_entry': {
      const { data, error } = await sb.from('project_knowledge')
        .delete()
        .eq('id', args.entry_id)
        .eq('user_id', userId)
        .select()
        .maybeSingle()
      if (error) throw new Error(error.message)
      if (!data) return `KB entry "${args.entry_id}" not found.`
      return `Deleted KB entry "${data.title}".`
    }

    case 'list_is_entries': {
      const project = await resolveProject(sb, userId, args.project_id)
      if (!project) return `Project "${args.project_id}" not found.`
      const { data } = await sb.from('project_instructions')
        .select('id, title, updated_at')
        .eq('project_id', project.id)
        .order('created_at')
      if (!data?.length) return `No instruction set entries for "${project.name}".`
      return data.map((e: any) => `[id: ${e.id}] ${e.title}  (updated ${e.updated_at})`).join('\n')
    }

    case 'update_is_entry': {
      const fields: any = {}
      if (args.title   !== undefined) fields.title   = args.title
      if (args.content !== undefined) fields.content = args.content
      if (!Object.keys(fields).length) return 'No fields to update. Provide title or content.'
      const { data, error } = await sb.from('project_instructions')
        .update(fields)
        .eq('id', args.entry_id)
        .eq('user_id', userId)
        .select()
        .maybeSingle()
      if (error) throw new Error(error.message)
      if (!data) return `IS entry "${args.entry_id}" not found.`
      return `Updated IS entry "${data.title}".`
    }

    case 'delete_is_entry': {
      const { data, error } = await sb.from('project_instructions')
        .delete()
        .eq('id', args.entry_id)
        .eq('user_id', userId)
        .select()
        .maybeSingle()
      if (error) throw new Error(error.message)
      if (!data) return `IS entry "${args.entry_id}" not found.`
      return `Deleted IS entry "${data.title}".`
    }

    case 'list_milestones': {
      const task = await resolveTask(sb, userId, args.task_id)
      if (!task) return 'Task not found.'
      const { data: disc } = await sb.from('task_discussions').select('steps, checked_steps').eq('task_id', task.id).maybeSingle()
      const steps: any[] = disc?.steps ?? []
      const checked: boolean[] = disc?.checked_steps ?? []
      if (!steps.length) return `No milestones for "${task.text}".`
      return steps.map((s: any, i: number) => {
        const label = typeof s === 'string' ? s : s.summary
        return `[${checked[i] ? 'x' : ' '}] (index ${i}) ${label}`
      }).join('\n')
    }

    case 'add_milestone': {
      const task = await resolveTask(sb, userId, args.task_id)
      if (!task) return 'Task not found.'
      const { error } = await sb.rpc('append_milestone', { p_task_id: task.id, p_user_id: userId, p_text: args.text })
      if (error) throw new Error(error.message)
      return `Added milestone "${args.text}" to "${task.text}".`
    }

    case 'complete_milestone': {
      const task = await resolveTask(sb, userId, args.task_id)
      if (!task) return 'Task not found.'
      const { data: label, error } = await sb.rpc('set_milestone_checked', { p_task_id: task.id, p_index: args.index, p_checked: true })
      if (error) throw new Error(error.message)
      if (label === null) return `No milestone at index ${args.index} for "${task.text}".`
      return `✓ Completed milestone ${args.index}: "${label}" on "${task.text}".`
    }

    case 'uncomplete_milestone': {
      const task = await resolveTask(sb, userId, args.task_id)
      if (!task) return 'Task not found.'
      const { data: label, error } = await sb.rpc('set_milestone_checked', { p_task_id: task.id, p_index: args.index, p_checked: false })
      if (error) throw new Error(error.message)
      if (label === null) return `No milestone at index ${args.index} for "${task.text}".`
      return `↩ Marked milestone ${args.index}: "${label}" as not done on "${task.text}".`
    }

    case 'delete_milestone': {
      const task = await resolveTask(sb, userId, args.task_id)
      if (!task) return 'Task not found.'
      const { data: label, error } = await sb.rpc('delete_milestone_at', { p_task_id: task.id, p_index: args.index })
      if (error) throw new Error(error.message)
      if (label === null) return `No milestone at index ${args.index} for "${task.text}".`
      return `Deleted milestone "${label}" from "${task.text}".`
    }

    case 'github_connect': {
      const { token } = args
      let ghUser: any
      try {
        ghUser = await githubFetch(token, '/user')
      } catch (err: any) {
        return `Failed to validate token: ${err.message}`
      }
      await sb.from('user_settings').upsert({ user_id: userId, github_access_token: token })
      return `Connected GitHub account: ${ghUser.login}${ghUser.name ? ` (${ghUser.name})` : ''}. You can now use github_list_repos, github_import_project, github_sync_issues, and push changes back with github_push_task / github_push_project.`
    }

    case 'github_disconnect': {
      await sb.from('user_settings').upsert({ user_id: userId, github_access_token: null })
      return 'GitHub account disconnected. Token removed.'
    }

    case 'github_list_repos': {
      const ghToken = await loadGitHubToken(sb, userId)
      if (!ghToken) return 'No GitHub account connected. Use github_connect first.'
      const repos = await githubFetch(ghToken, '/user/repos?sort=updated&per_page=100&affiliation=owner,collaborator,organization_member')
      if (!repos.length) return 'No repositories found.'
      return repos.map((r: any) =>
        `${r.full_name}${r.private ? ' (private)' : ''}${r.description ? ` — ${r.description}` : ''}`
      ).join('\n')
    }

    case 'github_import_project': {
      const ghToken = await loadGitHubToken(sb, userId)
      if (!ghToken) return 'No GitHub account connected. Use github_connect first.'
      const { repo, project_name } = args

      let issues: any[]
      let capped: boolean
      try {
        ;({ issues, capped } = await fetchAllIssues(ghToken, repo))
      } catch (err: any) {
        return `Failed to fetch issues from ${repo}: ${err.message}`
      }

      const name = project_name ?? repo.split('/')[1]
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
        + '-' + Date.now().toString(36)
      const { data: project, error: pErr } = await sb.from('projects')
        .insert({ name, slug, user_id: userId, context: {}, github_repo: repo })
        .select().single()
      if (pErr) throw new Error(pErr.message)

      if (!issues.length) {
        return `Created project "${name}" (id: ${project.id}). No open issues found in ${repo}.`
      }

      // Build unique section names
      const sectionNames = new Set<string>()
      for (const issue of issues) {
        sectionNames.add(getIssueSectionName(issue.labels) ?? 'Backlog')
      }

      // Create sections in one batch insert
      const sectionRows = [...sectionNames].map((name, i) => ({ project_id: project.id, name, sort_order: i }))
      const { data: createdSecs } = await sb.from('sections').insert(sectionRows).select('id, name')
      const sectionMap: Record<string, string> = {}
      for (const s of (createdSecs ?? [])) sectionMap[s.name] = s.id

      // Create tasks
      const taskInserts = issues.map((issue: any) => ({
        project_id: project.id,
        user_id: userId,
        text: issue.title,
        priority: mapIssuePriority(issue.labels),
        status: 'pending',
        section_id: sectionMap[getIssueSectionName(issue.labels) ?? 'Backlog'] ?? null,
        github_issue_number: issue.number,
        detail: issue.body ? issue.body.slice(0, 5000) : null,
      }))
      await sb.from('tasks').insert(taskInserts)

      const sectionList = [...sectionNames].map(s => `  • ${s}`).join('\n')
      const capNote = capped ? `\n⚠️  Import capped at 500 issues — this repo has more open issues that were not imported.` : ''
      return `Imported "${name}" from ${repo}.\n${issues.length} issues imported as tasks.\nSections:\n${sectionList}\nProject id: ${project.id}${capNote}`
    }

    case 'github_sync_issues': {
      const ghToken = await loadGitHubToken(sb, userId)
      if (!ghToken) return 'No GitHub account connected. Use github_connect first.'

      const project = await resolveProject(sb, userId, args.project_id)
      if (!project) return `Project "${args.project_id}" not found.`

      const { data: fullProject } = await sb.from('projects')
        .select('github_repo').eq('id', project.id).maybeSingle()
      if (!fullProject?.github_repo) {
        return `Project "${project.name}" has no linked GitHub repository. Import it first using github_import_project.`
      }

      const { data: existingTasks } = await sb.from('tasks')
        .select('github_issue_number').eq('project_id', project.id).not('github_issue_number', 'is', null)
      const existingNums = new Set((existingTasks ?? []).map((t: any) => t.github_issue_number))

      let newIssues: any[]
      try {
        const raw = await githubFetch(ghToken, `/repos/${fullProject.github_repo}/issues?state=open&per_page=100`)
        newIssues = raw.filter((i: any) => !i.pull_request && !existingNums.has(i.number))
      } catch (err: any) {
        return `Failed to fetch issues: ${err.message}`
      }

      if (!newIssues.length) return `No new issues to sync for "${project.name}". Already up to date.`

      // Get existing sections
      const { data: sections } = await sb.from('sections').select('id, name').eq('project_id', project.id)
      const sectionMap: Record<string, string> = {}
      for (const s of (sections ?? [])) sectionMap[s.name] = s.id

      // Create missing sections and build task inserts
      const taskInserts = []
      for (const issue of newIssues) {
        const sName = getIssueSectionName(issue.labels) ?? 'Backlog'
        if (!sectionMap[sName]) {
          const { data: sec } = await sb.from('sections')
            .insert({ project_id: project.id, name: sName }).select('id').single()
          sectionMap[sName] = sec.id
        }
        taskInserts.push({
          project_id: project.id,
          user_id: userId,
          text: issue.title,
          priority: mapIssuePriority(issue.labels),
          status: 'pending',
          section_id: sectionMap[sName],
          github_issue_number: issue.number,
          detail: issue.body ? issue.body.slice(0, 5000) : null,
        })
      }
      await sb.from('tasks').insert(taskInserts)
      return `Synced ${newIssues.length} new issue(s) into "${project.name}" from ${fullProject.github_repo}.`
    }

    case 'github_push_task': {
      const ghToken = await loadGitHubToken(sb, userId)
      if (!ghToken) return 'No GitHub account connected. Use github_connect first.'
      const resolved = await resolveTask(sb, userId, args.task_id)
      if (!resolved) return `Task "${args.task_id}" not found.`
      const { data: task } = await sb.from('tasks')
        .select('id, text, detail, status, github_issue_number, project_id')
        .eq('id', resolved.id).maybeSingle()
      if (!task) return `Task "${args.task_id}" not found.`
      const { data: project } = await sb.from('projects')
        .select('name, github_repo').eq('id', task.project_id).maybeSingle()
      if (!project?.github_repo) {
        return `The project for this task has no linked GitHub repository. Import it from GitHub (github_import_project) first.`
      }
      try {
        const { action, number } = await pushTaskToGitHub(sb, ghToken, project.github_repo, task)
        const stateNote = task.status === 'done' ? 'closed' : 'open'
        return `${action === 'created' ? 'Created' : 'Updated'} issue #${number} in ${project.github_repo} (${stateNote}) from task "${task.text}".`
      } catch (err: any) {
        return `Failed to push to GitHub: ${err.message}`
      }
    }

    case 'github_push_project': {
      const ghToken = await loadGitHubToken(sb, userId)
      if (!ghToken) return 'No GitHub account connected. Use github_connect first.'
      const project = await resolveProject(sb, userId, args.project_id)
      if (!project) return `Project "${args.project_id}" not found.`
      const { data: fullProject } = await sb.from('projects')
        .select('github_repo').eq('id', project.id).maybeSingle()
      if (!fullProject?.github_repo) {
        return `Project "${project.name}" has no linked GitHub repository. Import it first using github_import_project.`
      }
      const createMissing = args.create_missing === true
      let query = sb.from('tasks')
        .select('id, text, detail, status, github_issue_number, project_id')
        .eq('project_id', project.id).eq('user_id', userId)
      if (!createMissing) query = query.not('github_issue_number', 'is', null)
      const { data: tasks } = await query
      if (!tasks?.length) {
        return createMissing
          ? `No tasks to push in "${project.name}".`
          : `No tasks in "${project.name}" are linked to a GitHub issue yet. Call again with create_missing: true to create issues for them.`
      }
      let updated = 0, created = 0, failed = 0
      const errors: string[] = []
      for (const task of tasks) {
        try {
          const r = await pushTaskToGitHub(sb, ghToken, fullProject.github_repo, task)
          if (r.action === 'created') created++
          else updated++
        } catch (err: any) {
          failed++
          if (errors.length < 5) errors.push(`  • "${task.text}": ${err.message}`)
        }
      }
      const parts = [`Pushed "${project.name}" → ${fullProject.github_repo}:`, `  ${updated} issue(s) updated`]
      if (created) parts.push(`  ${created} issue(s) created`)
      if (failed) parts.push(`  ${failed} failed:`, ...errors)
      return parts.join('\n')
    }

    case '__init_tasker_session': {
      const { data: settings } = await sb.from('user_settings').select('ai_instructions').eq('user_id', userId).maybeSingle()
      const instructions = settings?.ai_instructions
      const { show_questionnaire } = args

      if (instructions && !show_questionnaire) {
        return JSON.stringify({
          status: 'ready',
          instructions,
          directives: ASSISTANT_DIRECTIVES,
        })
      }

      // Map current preferences to friendly display values
      const currentChoices: Record<string, string> = {}
      if (instructions) {
        currentChoices.task_list_format = instructions.task_list_format === 'plain_text' ? 'Plain text list (Recommended)' :
                                          instructions.task_list_format === 'markdown_table' ? 'Markdown table' : 'Numbered list'
        currentChoices.show_completed_tasks = instructions.show_completed_tasks ? 'Yes' : 'No (Recommended)'
        currentChoices.rank_tasks_by = instructions.rank_tasks_by === 'sorting_order' ? 'Sorting order (Recommended)' : 'Task priority'
        currentChoices.communication_style = instructions.communication_style === 'terse' ? 'Terse' :
                                             instructions.communication_style === 'detailed' ? 'Detailed (Recommended)' : 'Conversational'
        currentChoices.multiple_tasks_handling = instructions.multiple_tasks_handling === 'collaborative' ? 'Collaborative (Recommended)' : 'Autonomous'
        currentChoices.show_project_context = instructions.show_project_context ? 'Yes (Recommended)' : 'No'
      }

      const buildQuestion = (id: number, question: string, options: string[], fieldName: string) => ({
        id,
        question,
        options: options.map(opt => currentChoices[fieldName] === opt ? `${opt} (current choice)` : opt),
      })

      const status = instructions ? 'review_setup' : 'needs_setup'
      const message = instructions
        ? 'Review your AI preferences. Your current choices are marked below.'
        : 'Welcome to Tasker! Let\'s configure how I should work with you. Answer the 6 questions below.'

      const presentation = 'IMPORTANT — how to present this: render each question below to the user as an INTERACTIVE multiple-choice prompt using your client\'s native question/options tool. That tool is named differently per client — AskUserQuestion in Claude Code, AskQuestion in Cursor, or the equivalent interactive picker in your environment — use whichever one your client provides. Present the listed options as selectable choices; do NOT print the questions as plain text or ask the user to type answers. After the user picks, save their choices by calling update_ai_instructions with the matching field values.'

      return JSON.stringify({
        status,
        message,
        presentation,
        questionnaire: {
          questions: [
            buildQuestion(1, 'How should I display task lists?', [
              'Plain text list (Recommended)',
              'Markdown table',
              'Numbered list',
            ], 'task_list_format'),
            buildQuestion(2, 'Show completed tasks by default?', [
              'No (Recommended)',
              'Yes',
            ], 'show_completed_tasks'),
            buildQuestion(3, 'Rank tasks when working on sections by...', [
              'Sorting order (Recommended)',
              'Task priority',
            ], 'rank_tasks_by'),
            buildQuestion(4, 'Communication style?', [
              'Terse',
              'Detailed (Recommended)',
              'Conversational',
            ], 'communication_style'),
            buildQuestion(5, 'Multiple tasks handling?', [
              'Collaborative (Recommended)',
              'Autonomous',
            ], 'multiple_tasks_handling'),
            buildQuestion(6, 'Show project context in my work?', [
              'Yes (Recommended)',
              'No',
            ], 'show_project_context'),
          ],
        },
        directives: ASSISTANT_DIRECTIVES,
      })
    }

    case 'get_ai_instructions': {
      const { data: settings } = await sb.from('user_settings').select('ai_instructions').eq('user_id', userId).maybeSingle()
      const instructions = settings?.ai_instructions

      if (!instructions) {
        return 'No AI preferences saved. Call __init_tasker_session to set them up.'
      }

      return JSON.stringify(instructions)
    }

    case 'update_ai_instructions': {
      const allowed = ['task_list_format', 'show_completed_tasks', 'rank_tasks_by', 'communication_style', 'multiple_tasks_handling', 'show_project_context']
      const updates: Record<string, any> = {}
      for (const k of allowed) if (args[k] !== undefined) updates[k] = args[k]

      if (Object.keys(updates).length === 0) {
        return 'No fields to update. Provide at least one of: task_list_format, show_completed_tasks, rank_tasks_by, communication_style, multiple_tasks_handling, show_project_context.'
      }

      const { data: existing } = await sb.from('user_settings').select('ai_instructions').eq('user_id', userId).maybeSingle()
      const currentInstructions = existing?.ai_instructions ?? {}
      const mergedInstructions = {
        version: 1,
        ...currentInstructions,
        ...updates,
        completed_at: new Date().toISOString(),
      }

      const { error } = await sb.from('user_settings').update({ ai_instructions: mergedInstructions }).eq('user_id', userId)
      if (error) throw new Error(`Failed to save preferences: ${error.message}`)

      return JSON.stringify({
        status: 'saved',
        message: 'Preferences saved successfully.',
        instructions: mergedInstructions,
      })
    }

    case 'list_groups': {
      const project = await resolveProject(sb, userId, args.project_id)
      if (!project) return `Project "${args.project_id}" not found.`

      let query = sb.from('groups').select('id, name, section_id, sections(name)', { count: 'exact' }).eq('project_id', project.id)
      if (args.section_id) query = query.eq('section_id', args.section_id)

      const { data: groups, error } = await query.order('sort_order')
      if (error) throw new Error(error.message)
      if (!groups?.length) return 'No groups found.'

      const { data: taskCounts } = await sb.from('tasks').select('group_id').eq('project_id', project.id)
      const counts: Record<string, number> = {}
      for (const t of (taskCounts ?? [])) {
        if (t.group_id) counts[t.group_id] = (counts[t.group_id] ?? 0) + 1
      }

      return groups.map((g: any) => {
        const count = counts[g.id] ?? 0
        const sectionName = g.sections?.[0]?.name ?? 'Unknown'
        return `${g.name} (id: ${g.id}, section: ${sectionName}, ${count} task${count !== 1 ? 's' : ''})`
      }).join('\n')
    }

    case 'create_group': {
      const project = await resolveProject(sb, userId, args.project_id)
      if (!project) return `Project "${args.project_id}" not found.`

      const { data: section } = await sb.from('sections').select('id').eq('id', args.section_id).eq('project_id', project.id).single()
      if (!section) return `Section not found in project "${args.project_id}".`

      const { data: existingGroups } = await sb.from('groups').select('sort_order').eq('section_id', args.section_id).order('sort_order', { ascending: false }).limit(1)
      const maxSort = existingGroups?.[0]?.sort_order ?? 0

      const { data, error } = await sb.from('groups').insert({
        project_id: project.id,
        section_id: args.section_id,
        name: args.name,
        sort_order: maxSort + 1,
      }).select().single()
      if (error) throw new Error(error.message)

      return `Created group "${data.name}"\nid: ${data.id}`
    }

    case 'rename_group': {
      const group = await resolveGroup(sb, userId, args.group_id)
      if (!group) return `Group not found or access denied.`

      const { error } = await sb.from('groups').update({ name: args.name }).eq('id', args.group_id)
      if (error) throw new Error(error.message)

      return `Renamed group to "${args.name}"`
    }

    case 'delete_group': {
      const group = await resolveGroup(sb, userId, args.group_id)
      if (!group) return `Group not found or access denied.`

      let result = ''
      if (args.delete_tasks) {
        const { count } = await sb.from('tasks').delete().eq('group_id', args.group_id).select('*', { count: 'exact' })
        result = `Deleted group "${group.name}". ${count ?? 0} task${(count ?? 0) !== 1 ? 's' : ''} deleted.`
      } else {
        const { count } = await sb.from('tasks').update({ group_id: null }).eq('group_id', args.group_id).select('*', { count: 'exact' })
        result = `Deleted group "${group.name}". ${count ?? 0} task${(count ?? 0) !== 1 ? 's' : ''} moved to ungrouped.`
      }

      const { error } = await sb.from('groups').delete().eq('id', args.group_id)
      if (error) throw new Error(error.message)

      return result
    }

    case 'move_task_to_group': {
      const task = await resolveTask(sb, userId, args.task_id)
      if (!task) return `Task "${args.task_id}" not found.`

      const updates: any = { group_id: args.group_id ?? null }
      if (args.section_id) updates.section_id = args.section_id

      const { error } = await sb.from('tasks').update(updates).eq('id', task.id)
      if (error) throw new Error(error.message)

      if (args.group_id) {
        const { data: group } = await sb.from('groups').select('name').eq('id', args.group_id).single()
        return `Moved task ${task.prefix ? `${task.prefix}-${task.short_id}` : task.id} to group "${group?.name ?? 'Unknown'}"`
      } else {
        return `Moved task ${task.prefix ? `${task.prefix}-${task.short_id}` : task.id} to ungrouped`
      }
    }

    case 'analyze_section': {
      const project = await resolveProject(sb, userId, args.project_id)
      if (!project) return `Project "${args.project_id}" not found.`

      const { data: section } = await sb.from('sections').select('*').eq('id', args.section_id).eq('project_id', project.id).single()
      if (!section) return `Section not found.`

      const { data: tasks } = await sb.from('tasks').select('*').eq('section_id', args.section_id)
      const { data: groups } = await sb.from('groups').select('*').eq('section_id', args.section_id)

      if (!tasks?.length) return `Section: ${section.name} (empty)`

      const done = tasks.filter((t: any) => t.status === 'done').length
      const inProgress = tasks.filter((t: any) => t.status === 'in_progress').length
      const pending = tasks.filter((t: any) => t.status !== 'done' && t.status !== 'in_progress').length

      const groupBreakdown = (groups ?? []).map((g: any) => {
        const groupTasks = tasks.filter((t: any) => t.group_id === g.id)
        const pct = Math.round((groupTasks.length / tasks.length) * 100)
        return `  - ${g.name}: ${groupTasks.length} task${groupTasks.length !== 1 ? 's' : ''} (${pct}%)`
      })

      const now = new Date()
      const stale = tasks.filter((t: any) => {
        if (t.status === 'done') return false
        const created = new Date(t.created_at)
        const daysSince = Math.floor((now.getTime() - created.getTime()) / 86400000)
        return daysSince > 7
      })

      const lines = [
        `Section: ${section.name} (project: ${project.name} / ${project.prefix})`,
        ``,
        `Task Summary:`,
        `  - Total: ${tasks.length} tasks`,
        `  - Done: ${done}`,
        `  - In Progress: ${inProgress}`,
        `  - Pending: ${pending}`,
        ``,
        `Group Balance (${groups?.length ?? 0} group${groups && groups.length !== 1 ? 's' : ''}):`,
        ...groupBreakdown,
        ``,
        `Stale Tasks (pending > 7 days): ${stale.length}`,
        ...stale.slice(0, 5).map((t: any) => `  - ${t.prefix ? `${t.prefix}-${t.short_id}` : t.id}: ${t.text}`),
      ]

      return lines.filter(l => l !== null).join('\n')
    }

    case 'section_insights': {
      const project = await resolveProject(sb, userId, args.project_id)
      if (!project) return `Project "${args.project_id}" not found.`

      const { data: section } = await sb.from('sections').select('*').eq('id', args.section_id).eq('project_id', project.id).single()
      if (!section) return `Section not found.`

      const { data: tasks } = await sb.from('tasks').select('*').eq('section_id', args.section_id)
      const { data: groups } = await sb.from('groups').select('*').eq('section_id', args.section_id)

      if (!tasks?.length) return `Section is empty. No insights to generate.`

      const done = tasks.filter((t: any) => t.status === 'done').length
      const inProgress = tasks.filter((t: any) => t.status === 'in_progress').length
      const pending = tasks.filter((t: any) => t.status !== 'done' && t.status !== 'in_progress').length

      const groupData = (groups ?? []).map((g: any) => {
        const groupTasks = tasks.filter((t: any) => t.group_id === g.id)
        return { name: g.name, count: groupTasks.length, pct: Math.round((groupTasks.length / tasks.length) * 100) }
      })

      const maxGroup = groupData.reduce((a, b) => a.pct > b.pct ? a : b, { pct: 0 })
      const isImbalanced = maxGroup.pct > 50

      const now = new Date()
      const stale = tasks.filter((t: any) => {
        if (t.status === 'done') return false
        const created = new Date(t.created_at)
        const daysSince = Math.floor((now.getTime() - created.getTime()) / 86400000)
        return daysSince > 7
      })

      const insights = [
        `## Section Analysis: ${section.name}`,
        ``,
        `**What's Working:**`,
        inProgress > 0 ? `- ${inProgress} task${inProgress !== 1 ? 's' : ''} in progress (healthy velocity signal)` : `- No tasks in progress yet`,
        `- ${done} task${done !== 1 ? 's' : ''} completed`,
        ``,
        `**What Needs Attention:**`,
        isImbalanced ? `- Group "${maxGroup.name}" is ${maxGroup.pct}% of workload (imbalanced)` : `- Workload is fairly balanced across groups`,
        stale.length > 0 ? `- ${stale.length} pending task${stale.length !== 1 ? 's' : ''} > 7 days old (may need review)` : `- No stale tasks`,
        pending > inProgress ? `- More pending tasks (${pending}) than in progress (${inProgress}) — consider moving work forward` : `- Good task flow`,
        ``,
        `**Suggested Actions:**`,
        stale.length > 0 ? `- Review stale tasks: ${stale.slice(0, 3).map((t: any) => t.text).join(', ')}` : `- Keep moving at current pace`,
        pending === 0 ? `- All work is assigned or completed — section is in good shape` : `- Prioritize ${Math.ceil(pending / 2)} pending tasks to move to in-progress`,
      ]

      return insights.filter(l => l && l !== '').join('\n')
    }

    case 'get_flow_order': {
      const project = await resolveProject(sb, userId, args.project_id)
      if (!project) return `Project "${args.project_id}" not found.`

      const { data: tasks } = await sb.from('tasks')
        .select('id, text, status, priority, short_id, input, sort_order, section_id')
        .eq('project_id', project.id)
        .eq('user_id', userId)

      if (!tasks?.length) return `No tasks found in project "${project.name}".`

      const taskById = new Map(tasks.map((t: any) => [t.id, t]))

      // Build undirected adjacency for connected-component detection (fan-in: many sources per task)
      const adj = new Map(tasks.map((t: any) => [t.id, new Set<string>()]))
      tasks.forEach((t: any) => {
        for (const src of inputSourceIds(t.input)) {
          if (adj.has(src)) {
            adj.get(t.id)!.add(src)
            adj.get(src)!.add(t.id)
          }
        }
      })

      // Detect flows (connected components with at least one edge)
      const visited = new Set<string>()
      const flows: Array<Set<string>> = []
      tasks.forEach((t: any) => {
        if (visited.has(t.id) || adj.get(t.id)!.size === 0) return
        const component = new Set<string>()
        const queue = [t.id]
        visited.add(t.id)
        while (queue.length) {
          const curr = queue.shift()!
          component.add(curr)
          for (const nb of adj.get(curr)!) {
            if (!visited.has(nb)) { visited.add(nb); queue.push(nb) }
          }
        }
        flows.push(component)
      })

      // If task_id provided, narrow to that task's flow
      let targetFlows = flows
      if (args.task_id) {
        const focusTask = await resolveTask(sb, userId, args.task_id)
        if (!focusTask) return `Task "${args.task_id}" not found.`
        targetFlows = flows.filter(f => f.has(focusTask.id))
        if (!targetFlows.length) return `Task "${focusTask.text}" has no dependency connections. Use set_task_input / set_task_output to link it.`
      }

      if (!targetFlows.length) return `No dependency flows found in project "${project.name}". Use set_task_input / set_task_output to connect tasks into flows.`

      // Topological sort within a flow
      function topoSort(component: Set<string>): any[] {
        const flowTasks = [...component].map(id => taskById.get(id)).filter(Boolean)
        const depths = new Map<string, number>()
        function depth(id: string, stack = new Set<string>()): number {
          if (depths.has(id)) return depths.get(id)!
          if (stack.has(id)) return 0
          stack.add(id)
          const srcs = inputSourceIds(taskById.get(id)?.input).filter((s: string) => taskById.has(s))
          const d = srcs.length ? Math.max(...srcs.map((s: string) => depth(s, stack) + 1)) : 0
          depths.set(id, d)
          return d
        }
        flowTasks.forEach((t: any) => depth(t.id))
        return flowTasks.sort((a: any, b: any) => {
          const da = depths.get(a.id) ?? 0
          const db = depths.get(b.id) ?? 0
          if (da !== db) return da - db
          return (a.sort_order ?? 0) - (b.sort_order ?? 0)
        })
      }

      const statusIcon = (s: string) => s === 'done' ? '✓' : s === 'in_progress' ? '▶' : '○'
      const taskLabel = (t: any) => t.prefix ? `${t.prefix}-${t.short_id}` : `#${t.short_id ?? t.id.slice(0, 8)}`

      const lines: string[] = [`Flow Execution Order — ${project.name} (${project.prefix})`, ``]

      targetFlows.forEach((component, fi) => {
        const sorted = topoSort(component)
        if (targetFlows.length > 1) {
          lines.push(`### Flow ${fi + 1}: "${sorted[0]?.text?.split(' ').slice(0, 5).join(' ')}${sorted[0]?.text?.split(' ').length > 5 ? '…' : ''}"`)
        }
        sorted.forEach((task: any, i: number) => {
          const srcLabels = inputSourceIds(task.input)
            .map((sid: string) => taskById.get(sid)).filter(Boolean).map((s: any) => taskLabel(s))
          const dep = srcLabels.length ? ` ← ${srcLabels.join(', ')}` : ''
          const prio = task.priority ? ` [${task.priority}]` : ''
          lines.push(`Step ${i + 1}  ${statusIcon(task.status)}  ${taskLabel(task)} — ${task.text}${prio}${dep}`)
        })
        if (targetFlows.length > 1) lines.push(``)
      })

      return lines.join('\n').trim()
    }

    case 'get_task_connections': {
      const task = await resolveTask(sb, userId, args.task_id)
      if (!task) return `Task "${args.task_id}" not found.`

      const { data: full } = await sb.from('tasks')
        .select('id, text, status, priority, short_id, input, project_id, project:projects(name, prefix)')
        .eq('id', task.id)
        .maybeSingle()
      if (!full) return `Task not found.`

      const prefix = full.project?.prefix
      const taskRef = (t: any) => prefix && t.short_id != null ? `${prefix}-${t.short_id}` : `#${t.short_id ?? t.id.slice(0, 8)}`
      const statusIcon = (s: string) => s === 'done' ? '✓' : s === 'in_progress' ? '▶' : '○'
      const taskLine = (t: any) => `  ${statusIcon(t.status)}  ${taskRef(t)} — ${t.text}${t.priority ? ` [${t.priority}]` : ''}`

      // Tasks this one directly requires (ALL its input sources — fan-in)
      const sourceIds = inputSourceIds(full.input)
      const { data: requiresList } = sourceIds.length
        ? await sb.from('tasks').select('id, text, status, priority, short_id').in('id', sourceIds).eq('user_id', userId)
        : { data: [] }

      // Tasks that directly depend on this one (they list this task as a source — both data shapes)
      const [{ data: b1 }, { data: b2 }] = await Promise.all([
        sb.from('tasks').select('id, text, status, priority, short_id').eq('user_id', userId).eq('project_id', full.project_id).contains('input', { source_task_id: full.id }),
        sb.from('tasks').select('id, text, status, priority, short_id').eq('user_id', userId).eq('project_id', full.project_id).contains('input', { edges: [{ source_task_id: full.id }] }),
      ])
      const blocksMap = new Map<string, any>()
      ;[...(b1 || []), ...(b2 || [])].forEach((t: any) => blocksMap.set(t.id, t))
      const blocks = [...blocksMap.values()]

      const lines: string[] = [
        `# ${taskRef(full)} — ${full.text}`,
        `Project: ${full.project?.name ?? '—'}`,
        ``,
      ]

      if (requiresList && requiresList.length) {
        lines.push(`## Requires (blocks this task until done)`)
        requiresList.forEach((r: any) => lines.push(taskLine(r)))
        lines.push(``)
      } else {
        lines.push(`## Requires`)
        lines.push(`  (none — this task has no upstream dependency)`)
        lines.push(``)
      }

      if (blocks?.length) {
        lines.push(`## Blocks (depends on this task)`)
        blocks.forEach((b: any) => lines.push(taskLine(b)))
      } else {
        lines.push(`## Blocks`)
        lines.push(`  (none — no tasks depend directly on this one)`)
      }

      return lines.join('\n')
    }

    case 'build_new_flow': {
      const project = await resolveProject(sb, userId, args.project_id)
      if (!project) return `Project "${args.project_id}" not found.`

      // Project grounding (codebase-first, applied to Tasker's own data): existing
      // sections + tasks, so the agent doesn't ask about what it can already see.
      const [{ data: sections }, { data: tasks }] = await Promise.all([
        sb.from('sections').select('id, name').eq('project_id', project.id).order('sort_order'),
        sb.from('tasks').select('short_id, text, status').eq('project_id', project.id).eq('user_id', userId).order('sort_order').limit(80),
      ])
      const sectionList = (sections || []).map((s: any) => ({ id: s.id, name: s.name }))
      const taskList = (tasks || []).map((t: any) => ({
        id: project.prefix && t.short_id != null ? `${project.prefix}-${t.short_id}` : t.short_id,
        text: t.text,
        status: t.status,
      }))

      return JSON.stringify({
        status: 'run_flow_interview',
        mode: 'create',
        goal: args.goal || null,
        instruction: 'You are building a NEW flow with the user. Run the interview below YOURSELF using your interactive question tool (AskUserQuestion / ask_question). A flow = a chain of contract-linked tasks; sections/groups are just filing and do not define the flow. Do NOT create or wire any tasks until the user confirms the whole proposed flow at the end.',
        grill_me_rules: [
          'Ask ONE question at a time; each answer determines the next question.',
          'Every question carries a recommended option, prefixed "(Recommended)", based on best practice + what you can already see.',
          'Project-first (codebase-first): never ask what you can determine from the repo or the project_context below.',
          'Offer multiple-choice options with a custom write-in allowed; keep it conversational.',
        ],
        playbook: [
          '1. GROUND THE START: use project_context below and read the repo if relevant, then ask the user what they already have / where they are starting from. Do not ask about things you can already see.',
          '2. PIN THE GOAL' + (args.goal ? ` (stated: "${args.goal}")` : '') + ': confirm the end goal and treat it as the FINAL task\'s output contract.',
          '3. FORWARD-DECOMPOSE one step at a time toward the goal, recommending a path each time, building the ordered chain of tasks.',
          '4. AUTHOR A CONTRACT PER HANDOFF: for each task propose an output contract (its definition-of-done) and the next task\'s input contract (its acceptance criteria) as structured, CONTEXT-FREE rules — describe the shape of acceptable output, never this run\'s subject. Only make a step its own task if it produces a distinct, checkable output a later step depends on (a contract-worthy handoff); otherwise it is a sub-detail of a task, not its own task.',
          '5. PRESENT THE WHOLE PROPOSED FLOW (tasks + dependency edges + contracts) and ask for ONE confirmation.',
          '6. ON CONFIRM, PERSIST (see persistence).',
        ],
        persistence: {
          when: 'ONLY after the user confirms the whole flow.',
          steps: [
            'create_task for each step (pass section_id from project_context if it belongs in an existing section).',
            'set_task_output(task_id, contract) on each producing task — its definition-of-done.',
            'set_task_input(task_id, source_task_id, contract) on each consuming task — call once per upstream source (fan-in supported). The input contract is the consumer\'s acceptance criteria for that incoming artifact.',
            'Finally call get_flow_order to show the user the ordered flow you built.',
          ],
        },
        project_context: { sections: sectionList, tasks: taskList },
      })
    }

    case 'set_task_input': {
      const task = await resolveTask(sb, userId, args.task_id)
      if (!task) return `Task "${args.task_id}" not found.`
      const source = await resolveTask(sb, userId, args.source_task_id)
      if (!source) return `Source task "${args.source_task_id}" not found.`
      if (source.id === task.id) return `A task cannot be its own input source.`

      const rules = (args.contract?.rules || []).map(normalizeRule)
      const edge = {
        source_task_id: source.id,
        expected_type: args.expected_type || null,
        contract: { rules },
      }

      // Upsert this source's edge (replace=true wipes all others). Supports fan-in.
      let edges = args.replace ? [] : inputEdges(task.input)
      edges = edges.filter((e: any) => e.source_task_id !== source.id && e.source_task_id !== args.source_task_id)
      edges.push(edge)

      const { error } = await sb.from('tasks').update({ input: { edges } }).eq('id', task.id)
      if (error) throw new Error(error.message)

      return `Set input edge on ${args.task_id}: consumes ${args.source_task_id}` +
        (rules.length ? ` with ${rules.length} contract rule${rules.length !== 1 ? 's' : ''}` : ' (no contract rules yet)') +
        `. Total input edges: ${edges.length}.`
    }

    case 'set_task_output': {
      const task = await resolveTask(sb, userId, args.task_id)
      if (!task) return `Task "${args.task_id}" not found.`

      const rules = (args.contract?.rules || []).map(normalizeRule)
      const prev = (task.output && typeof task.output === 'object') ? task.output : {}
      const output = {
        ...prev,
        contract: { rules },
        validation_status: prev.validation_status || 'pending',
      }

      const { error } = await sb.from('tasks').update({ output }).eq('id', task.id)
      if (error) throw new Error(error.message)

      return `Set output contract on ${args.task_id}: ${rules.length} rule${rules.length !== 1 ? 's' : ''} (definition-of-done). Consumers are derived from tasks that list this as a source.`
    }

    case 'store_artifact': {
      const task = await resolveTask(sb, userId, args.task_id)
      if (!task) return `Task "${args.task_id}" not found.`
      const prev = (task.output && typeof task.output === 'object') ? task.output : {}
      await sb.from('tasks').update({
        output: {
          ...prev,
          artifact: args.content,
          artifact_format: args.format || 'text',
          artifact_stored_at: new Date().toISOString(),
        },
      }).eq('id', task.id)
      const wordCount = String(args.content).split(/\s+/).filter(Boolean).length
      return `Artifact stored on "${task.text}" (${wordCount} words, format: ${args.format || 'text'}). Call complete_task when ready — if the task has judgment output rules, validate_output will now embed this artifact directly in the validator prompt.`
    }

    case 'validate_output': {
      const producer = await resolveTask(sb, userId, args.task_id)
      if (!producer) return `Task "${args.task_id}" not found.`

      // Consumers = tasks that list this producer as an input source (both data shapes).
      const [{ data: c1 }, { data: c2 }] = await Promise.all([
        sb.from('tasks').select('id, text, input, status').eq('user_id', userId).contains('input', { source_task_id: producer.id }),
        sb.from('tasks').select('id, text, input, status').eq('user_id', userId).contains('input', { edges: [{ source_task_id: producer.id }] }),
      ])
      const consumerMap = new Map<string, any>()
      ;[...(c1 || []), ...(c2 || [])].forEach((t: any) => consumerMap.set(t.id, t))
      const consumers = [...consumerMap.values()]
      const selfRules = outputContract(producer.output).rules

      if (!consumers.length) {
        if (!selfRules.length) return `"${producer.text}" has no downstream consumer and no output contract — nothing to validate. Add a definition-of-done with set_task_output, or set_task_input on a downstream task.`
        return JSON.stringify({
          status: 'needs_agent_validation',
          instruction: 'Endpoint task (no downstream consumer). Evaluate the producer\'s own output contract (self-check) against the actual produced output, then call submit_validation_result with the per-rule results.',
          producer: producer.text,
          target: null,
          gate_rules: [],
          self_check_rules: selfRules,
          retry_info: { retry_count: (producer.output?.retry_count || 0), retry_limit: 3, retries_remaining: Math.max(0, 3 - (producer.output?.retry_count || 0)) },
        })
      }

      let consumer: any
      if (args.target_task_id) {
        const t = await resolveTask(sb, userId, args.target_task_id)
        consumer = t && consumerMap.get(t.id)
        if (!consumer) return `"${args.target_task_id}" is not a consumer of "${producer.text}". Consumers: ${consumers.map((c: any) => c.text).join(', ')}.`
      } else if (consumers.length === 1) {
        consumer = consumers[0]
      } else {
        return JSON.stringify({
          status: 'ambiguous_target',
          message: `"${producer.text}" feeds ${consumers.length} tasks. Re-call with target_task_id to pick which handoff to validate.`,
          consumers: consumers.map((c: any) => ({ id: c.id, text: c.text })),
        })
      }

      const edge = inputEdges(consumer.input).find((e: any) => e.source_task_id === producer.id)
      const gateRules = edge?.contract?.rules || []

      const hasJudgment = gateRules.some((r: any) => r.kind === 'judgment')
      const storedArtifact: string | null = producer.output?.artifact || null
      const allRuleIds = [...gateRules, ...selfRules].map((r: any) => r.id).join(', ')
      const rulesBlock = [...gateRules, ...selfRules].map((r: any) =>
        `[${r.id}] ${r.label} (${r.kind}, ${r.severity})\nRule: ${r.rule}${r.description ? `\nContext: ${r.description}` : ''}`
      ).join('\n\n')
      const artifactBlock = storedArtifact
        ? `── ARTIFACT (${producer.output?.artifact_format || 'text'}) ─────────────────────────────────────\n${storedArtifact}\n─────────────────────────────────────────────────────────────`
        : `── ARTIFACT ─────────────────────────────────────────────────\n[NO ARTIFACT STORED — executor must call store_artifact first. Do not proceed with grading.]\n─────────────────────────────────────────────────────────────`
      const validatorPrompt = `You are an independent quality validator for a Tasker flow. You have no prior context on how this artifact was produced — grade it strictly based only on what you see below.

PRODUCER: ${producer.text} (task_id: ${producer.id})
CONSUMER: ${consumer.text} (target_task_id: ${consumer.id})

${artifactBlock}

── RULES ────────────────────────────────────────────────────
${rulesBlock}
─────────────────────────────────────────────────────────────

For kind=check rules: evaluate deterministically (count words/lines, check patterns, run commands).
For kind=judgment rules: assess semantically from the artifact alone — no benefit of the doubt.
If uncertain on any rule: default to FAIL.

Call submit_validation_result with:
  task_id: "${producer.id}"
  target_task_id: "${consumer.id}"
  validator: "independent-subagent"
  results: one {rule_id, status, note} per rule — you must cover all rule IDs: ${allRuleIds}`

      const artifactReady = !!storedArtifact
      return JSON.stringify({
        status: hasJudgment && !artifactReady ? 'needs_artifact' : 'needs_agent_validation',
        artifact_stored: artifactReady,
        instruction: !hasJudgment
          ? 'All rules are kind=check (deterministic). Evaluate each against the actual produced output, then call submit_validation_result.'
          : !artifactReady
            ? 'Judgment rules require an independent validator. Call store_artifact with the verbatim produced content first, then call validate_output again — the artifact will be embedded in validator_agent_prompt automatically.'
            : 'Artifact is stored. Spawn a validator subagent using the Agent tool with the validator_agent_prompt below — it is complete, no edits needed. The subagent grades and calls submit_validation_result independently.',
        producer: producer.text,
        target: consumer.text,
        target_task_id: consumer.id,
        gate_rules: gateRules,
        self_check_rules: selfRules,
        retry_info: { retry_count: (producer.output?.retry_count || 0), retry_limit: 3, retries_remaining: Math.max(0, 3 - (producer.output?.retry_count || 0)) },
        ...(hasJudgment ? { validator_agent_prompt: validatorPrompt } : {}),
      })
    }

    case 'submit_validation_result': {
      const producer = await resolveTask(sb, userId, args.task_id)
      if (!producer) return `Task "${args.task_id}" not found.`
      const results = Array.isArray(args.results) ? args.results : []

      // Resolve the consumer edge (to know which rules are gating vs self-check).
      let consumer: any = null
      let gateRules: any[] = []
      let targetText: string | null = null
      let targetId: string | null = null
      if (args.target_task_id) {
        consumer = await resolveTask(sb, userId, args.target_task_id)
      } else {
        const [{ data: c1 }, { data: c2 }] = await Promise.all([
          sb.from('tasks').select('id, text, input').eq('user_id', userId).contains('input', { source_task_id: producer.id }),
          sb.from('tasks').select('id, text, input').eq('user_id', userId).contains('input', { edges: [{ source_task_id: producer.id }] }),
        ])
        const m = new Map<string, any>()
        ;[...(c1 || []), ...(c2 || [])].forEach((t: any) => m.set(t.id, t))
        const cs = [...m.values()]
        if (cs.length === 1) consumer = cs[0]
      }
      if (consumer) {
        const edge = inputEdges(consumer.input).find((e: any) => e.source_task_id === producer.id)
        gateRules = edge?.contract?.rules || []
        targetText = consumer.text
        targetId = consumer.id
      }

      const gateRuleIds = new Set(gateRules.map((r: any) => r.id))
      const selfRules = outputContract(producer.output).rules
      const ruleById = new Map<string, any>()
      ;[...gateRules, ...selfRules].forEach((r: any) => ruleById.set(r.id, r))

      // Reject results missing required notes:
      // - kind=check always needs a note (the actual observed value — pass or fail)
      // - any fail (any kind) needs a note (the specific deficiency)
      const unevidenced = results.filter((res: any) => {
        const rule = ruleById.get(res.rule_id)
        return !res.note && (rule?.kind === 'check' || res.status === 'fail')
      })
      if (unevidenced.length) {
        return JSON.stringify({
          error: 'missing_evidence',
          message: `${unevidenced.length} rule(s) submitted without a required note. Requirements: (1) kind=check rules always need a note — the actual observed result (count, command stdout, pattern match). (2) Any failing rule needs a note — the specific deficiency, not just "fail". Submitting without is rejected.`,
          rules_needing_evidence: unevidenced.map((res: any) => {
            const rule = ruleById.get(res.rule_id)
            const reason = rule?.kind === 'check'
              ? 'kind=check — note must contain the actual observed value'
              : 'status=fail — note must describe the specific deficiency'
            return { rule_id: res.rule_id, label: rule?.label || res.rule_id, rule: rule?.rule, reason }
          }),
        })
      }

      const checkedAt = new Date().toISOString()
      const validator = args.validator || null
      const ledger = results.map((res: any) => {
        const rule = ruleById.get(res.rule_id)
        const isGate = gateRuleIds.has(res.rule_id)
        const isCheck = rule?.kind === 'check'
        const noteLen = (res.note || '').length
        const evidenceQuality = isCheck ? (noteLen === 0 ? 'missing' : noteLen < 15 ? 'weak' : 'good') : null
        return {
          rule_id: res.rule_id,
          label: rule?.label || res.rule_id,
          source: isGate ? 'input' : 'output',
          severity: rule?.severity || 'blocker',
          kind: rule?.kind || 'check',
          status: res.status === 'pass' ? 'pass' : 'fail',
          note: res.note || null,
          validator,
          ...(isCheck ? { evidence_quality: evidenceQuality } : {}),
          checked_at: checkedAt,
        }
      })

      const hasJudgmentGateRules = gateRules.some((r: any) => r.kind === 'judgment')
      const selfGradedRisk = hasJudgmentGateRules && (!validator || validator === 'self')

      const blockingFails = ledger.filter((l: any) => l.source === 'input' && l.status === 'fail' && l.severity === 'blocker')
      const selfFails = ledger.filter((l: any) => l.source === 'output' && l.status === 'fail' && l.severity === 'blocker')
      const warnings = ledger.filter((l: any) => l.status === 'fail' && l.severity === 'warning')
      const valid = blockingFails.length === 0
      const validationStatus = valid ? 'valid' : 'invalid'

      const prevOutput = (producer.output && typeof producer.output === 'object') ? producer.output : {}
      const prevRetryCount = typeof prevOutput.retry_count === 'number' ? prevOutput.retry_count : 0
      const RETRY_LIMIT = 3

      let reopened = false
      let action = valid ? 'pass' : 'regenerate'
      let newRetryCount = prevRetryCount

      if (!valid) {
        newRetryCount = prevRetryCount + 1
        if (newRetryCount >= RETRY_LIMIT) {
          action = 'ask_human'
        } else if (producer.status === 'done') {
          await sb.from('tasks').update({ status: 'in_progress', completed_at: null }).eq('id', producer.id)
          reopened = true
        }
      }

      await sb.from('tasks').update({
        output: {
          ...prevOutput,
          validation_status: validationStatus,
          validated_against: targetId,
          validated_at: checkedAt,
          ledger,
          retry_count: valid ? 0 : newRetryCount,
          ...(action === 'ask_human' ? { retry_blocked: true } : {}),
        },
      }).eq('id', producer.id)

      const fmt = (l: any) => `  ${l.status === 'pass' ? '✓' : '✗'} [${l.severity}] ${l.label}${l.note ? ` — ${l.note}` : ''}`
      return JSON.stringify({
        status: validationStatus,
        action,
        retry_count: valid ? 0 : newRetryCount,
        retries_remaining: valid ? RETRY_LIMIT : Math.max(0, RETRY_LIMIT - newRetryCount),
        validator: validator || 'unverified',
        self_graded_risk: selfGradedRisk,
        ...(selfGradedRisk ? { independence_warning: 'Judgment rules were graded without declaring an independent validator. This result is marked as self-graded in the ledger — it carries less weight than an independent or human verdict. Next time: spawn a fresh subagent or ask the human.' } : {}),
        producer: producer.text,
        target: targetText,
        gate_failures: blockingFails.map(fmt),
        self_check_failures: selfFails.map(fmt),
        warnings: warnings.map(fmt),
        producer_reopened: reopened,
        summary: valid
          ? `Output passed the gate${warnings.length ? ` (${warnings.length} warning(s) noted)` : ''}.${targetText ? ` "${targetText}" can proceed.` : ''}`
          : action === 'ask_human'
            ? `Output REJECTED — retry limit reached (${RETRY_LIMIT} attempts). Stop and ask the human via AskUserQuestion — show them the failures and ask how to proceed.`
            : `Output REJECTED by ${targetText ? `"${targetText}"'s` : 'the'} acceptance criteria — ${blockingFails.length} blocker(s). Attempt ${newRetryCount}/${RETRY_LIMIT}.${reopened ? ' Producer reopened.' : ''} Fix, re-complete the task, then call validate_output + submit_validation_result again.`,
      })
    }

    case 'get_validation_feedback': {
      const task = await resolveTask(sb, userId, args.task_id)
      if (!task) return `Task "${args.task_id}" not found.`
      const out: any = task.output
      if (!out || (!out.ledger && !out.validation_status && !out.feedback)) return `No validation has been run on "${task.text}" yet.`

      const status = out.validation_status || 'pending'
      const lines = [`Validation status: ${status}`]
      if (typeof out.retry_count === 'number' && out.retry_count > 0) {
        lines.push(`Retry count: ${out.retry_count}/3${out.retry_blocked ? ' (limit reached — awaiting human direction)' : ''}`)
      }
      const selfGradedEntries = Array.isArray(out.ledger) ? out.ledger.filter((l: any) => l.kind === 'judgment' && (!l.validator || l.validator === 'self')) : []
      if (selfGradedEntries.length) {
        lines.push(`⚠ Self-graded judgment rules (${selfGradedEntries.length}): ${selfGradedEntries.map((l: any) => l.label).join(', ')} — treat with caution`)
      }
      const weakEvidence = Array.isArray(out.ledger) ? out.ledger.filter((l: any) => l.kind === 'check' && l.evidence_quality === 'weak') : []
      if (weakEvidence.length) {
        lines.push(`⚠ Weak evidence on check rules (${weakEvidence.length}): ${weakEvidence.map((l: any) => l.label).join(', ')} — note too short to be a real run result`)
      }
      if (Array.isArray(out.ledger) && out.ledger.length) {
        lines.push('', 'Last check (per rule):')
        out.ledger.forEach((l: any) => {
          lines.push(`  ${l.status === 'pass' ? '✓' : '✗'} [${l.source === 'input' ? 'gate' : 'self'} · ${l.severity}] ${l.label}${l.note ? ` — ${l.note}` : ''}`)
        })
      } else if (out.feedback) {
        lines.push(`Feedback: ${out.feedback}`) // legacy shape
      }
      return lines.join('\n')
    }

    default:
      throw new Error(`Unknown tool: ${name}`)
  }
}

// ── Entry point ───────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors })
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed. Use POST.' }), {
      status: 405,
      headers: { ...cors, 'Content-Type': 'application/json', 'Allow': 'POST, OPTIONS' },
    })
  }

  let body: any
  try { body = await req.json() } catch { return rpcErr(-32700, 'Parse error', null) }

  const { method, params, id } = body

  // Allow discovery methods without auth so clients can verify the server is alive
  if (method === 'initialize') {
    return rpcOk({ protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'tasker', version: '1.0.0' } }, id)
  }
  if (method === 'notifications/initialized') {
    return new Response(null, { status: 204, headers: cors })
  }
  if (method === 'tools/list') {
    return rpcOk({ tools: TOOLS }, id)
  }
  if (method === 'ping') {
    return rpcOk({}, id)
  }

  // All other methods require auth
  const authHeader = req.headers.get('authorization') ?? req.headers.get('Authorization') ?? ''
  if (!authHeader.startsWith('Bearer ')) {
    return new Response(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'Missing Bearer token' }, id: null }), {
      status: 401,
      headers: { ...cors, 'Content-Type': 'application/json', 'WWW-Authenticate': `Bearer resource_metadata="${RESOURCE_METADATA_URL}"` },
    })
  }

  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } })
  const userId = await resolveApiKey(sb, authHeader.slice(7).trim())
  if (!userId) {
    return new Response(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'Invalid token' }, id: null }), {
      status: 401,
      headers: { ...cors, 'Content-Type': 'application/json', 'WWW-Authenticate': `Bearer error="invalid_token", resource_metadata="${RESOURCE_METADATA_URL}"` },
    })
  }

  try {
    switch (method) {

      case 'tools/call': {
        const { name, arguments: toolArgs } = params
        try {
          const text = await runTool(sb, userId, name, toolArgs ?? {})
          return toolOk(text, id)
        } catch (err: any) {
          return toolFail(err.message, id)
        }
      }

      case 'ping':
        return rpcOk({}, id)

      default:
        return rpcErr(-32601, `Method not found: ${method}`, id)
    }
  } catch (err: any) {
    return rpcErr(-32603, err.message, id)
  }
})
