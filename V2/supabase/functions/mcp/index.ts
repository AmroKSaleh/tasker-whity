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
async function resolveProject(sb: any, userId: string, projectId: string, logContext?: { tool_name: string, raw_params: any }) {
  let { data } = await sb.from('projects').select('id, name, slug, prefix, context').eq('slug', projectId).eq('user_id', userId).maybeSingle()
  if (!data) ({ data } = await sb.from('projects').select('id, name, slug, prefix, context').eq('id', projectId).eq('user_id', userId).maybeSingle())
  if (!data) ({ data } = await sb.from('projects').select('id, name, slug, prefix, context').ilike('prefix', projectId).eq('user_id', userId).maybeSingle())
  if (!data && logContext) {
    fireAndForget(sb.from('mcp_error_logs').insert({
      user_id: userId,
      tool_name: logContext.tool_name,
      raw_params: logContext.raw_params,
      error_msg: `resolveProject failed: received project_id="${projectId}"`,
    }))
  }
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

// ── Google OAuth: shared refresh + accessor (TDE foundation) ──────────────────
// Exchange a stored refresh token for a fresh access token and persist it.
// Returns null if not configured or the refresh failed (→ user must reconnect).
async function refreshGoogleToken(sb: any, userId: string, refreshToken: string): Promise<string | null> {
  const clientId = Deno.env.get('GOOGLE_CLIENT_ID')
  const clientSecret = Deno.env.get('GOOGLE_CLIENT_SECRET')
  if (!clientId || !clientSecret) return null
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' }),
  })
  const tok = await res.json()
  if (!res.ok || !tok.access_token) {
    console.error('[mcp] google token refresh failed:', tok)
    return null
  }
  const expiry = new Date(Date.now() + Number(tok.expires_in ?? 3600) * 1000).toISOString()
  await sb.from('user_settings').update({ google_access_token: tok.access_token, google_token_expiry: expiry }).eq('user_id', userId)
  return tok.access_token
}

// Return a VALID Google access token for the user, refreshing if it's expired
// (60s skew). null if Google isn't connected or the refresh failed. This is the
// single accessor every Google service tool (Drive/Gmail/Tasks) should call.
// deno-lint-ignore no-unused-vars -- foundation accessor; first consumer is the Drive tool (TDE)
async function loadGoogleAccessToken(sb: any, userId: string): Promise<string | null> {
  const { data } = await sb.from('user_settings')
    .select('google_access_token, google_refresh_token, google_token_expiry')
    .eq('user_id', userId).maybeSingle()
  if (!data?.google_access_token) return null
  const expired = !data.google_token_expiry || new Date(data.google_token_expiry).getTime() <= Date.now() + 60_000
  if (!expired) return data.google_access_token
  if (!data.google_refresh_token) return null
  return await refreshGoogleToken(sb, userId, data.google_refresh_token)
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
  const shortMatch = taskRef.match(/^([A-Za-z]{2,6})-(\d+)$/)
  if (shortMatch) {
    const prefix = shortMatch[1]
    const shortId = parseInt(shortMatch[2], 10)
    // Use resolveProject (ilike, slug, or UUID) so the lookup is consistent with all other tools
    const project = await resolveProject(sb, userId, prefix)
    if (project) {
      const { data: task } = await sb.from('tasks')
        .select('id, text, detail, input, output, status, short_id, flow_id, flow_step, project_id, review_enabled, review_bar, review_verdict')
        .eq('project_id', project.id).eq('short_id', shortId).eq('user_id', userId)
        .maybeSingle()
      if (task) return task
    }
  }
  // Fall back to UUID
  const { data } = await sb.from('tasks')
    .select('id, text, detail, input, output, status, short_id, flow_id, flow_step, project_id, review_enabled, review_bar, review_verdict').eq('id', taskRef).eq('user_id', userId).maybeSingle()
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

// The producer's output contract ({ rules: [], confirmed: false } if none set).
function outputContract(output: any): { rules: any[], confirmed: boolean } {
  if (output?.contract?.rules) return { ...output.contract, confirmed: output.contract.confirmed === true }
  return { rules: [], confirmed: false }
}

// ── TDE-261 task-level output judge: eligibility & flow-exclusivity ──────────
// HARD RULE: task-level review applies ONLY to non-flow tasks (flow tasks are
// governed by their flow gates — mutual exclusivity). A reviewable task must
// also have a checkable deliverable; discussion/decision/milestone-only tasks
// have nothing to judge.
function isFlowTask(task: any): boolean {
  return !!task?.flow_id
}
function hasCheckableDeliverable(task: any): boolean {
  if (outputContract(task?.output).rules.length > 0) return true
  if (Array.isArray(task?.review_bar?.rules) && task.review_bar.rules.length > 0) return true
  if (task?.output?.artifact) return true
  return false
}
function isReviewEligible(task: any): boolean {
  if (isFlowTask(task)) return false        // flow-exclusivity guard
  return hasCheckableDeliverable(task)
}

// TDE-269: controlled vocabulary for the optional KB category (a SOFT retrieval hint, never a hard filter).
const KB_CATEGORIES = ['architecture', 'database', 'deployment', 'mcp', 'flows', 'design', 'product', 'gtm', 'reference', 'other']

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

// Detect vague rules that are hard to enforce or trivially self-pass.
const VAGUE_RULE_WORDS = /\b(readable|clarity|clear|good|nice|appropriate|reasonable|relevant|professional|adequate|sufficient|proper|well.written|high.quality|comprehensive|thorough|engaging|interesting|helpful|useful)\b/i
function lintRule(r: any): string | null {
  const text = (r.rule || '').trim()
  if (text.length < 15) return 'rule is too short to be checkable — add a specific, measurable criterion'
  const match = text.match(VAGUE_RULE_WORDS)
  if (match) return `vague language "${match[0]}" — replace with a concrete, verifiable criterion (e.g. instead of "readable" → "each sentence under 25 words, no unexplained jargon"; instead of "comprehensive" → "covers all N sections listed in the outline")`
  return null
}

// All upstream tasks NOT yet done, walking the WHOLE chain (transitive), not just direct parents.
// Dedupes via `seen` and is cycle-safe. Only recurses past tasks that are themselves unmet —
// a done source means its own upstream is already satisfied.
async function unmetSourcesDeep(sb: any, input: any, seen = new Set<string>()): Promise<Array<{ id: string, text: string, status: string }>> {
  const ids = inputSourceIds(input).filter((id: string) => !seen.has(id))
  if (!ids.length) return []
  ids.forEach((id: string) => seen.add(id))
  const { data } = await sb.from('tasks').select('id, text, status, input').in('id', ids)
  const result: Array<{ id: string, text: string, status: string }> = []
  for (const t of (data || [])) {
    if (t.status !== 'done') {
      result.push({ id: t.id, text: t.text, status: t.status })
      const deeper = await unmetSourcesDeep(sb, t.input, seen)
      result.push(...deeper)
    }
  }
  return result
}

// Hard block: dependencies are enforced server-side, no agent-settable override.
function flowHardBlockedResponse(unmet: Array<{ text: string, status: string }>): string {
  const names = unmet.map(s => `"${s.text}"`).join(', ')
  const single = unmet.length === 1
  return JSON.stringify({
    status: 'flow_blocked',
    blocked: true,
    enforced: true,
    message: `Blocked: this task depends on ${names}, which ${single ? 'is' : 'are'} not done yet. Dependencies are enforced — there is no override. Finish the upstream task${single ? '' : 's'} first, or, if the dependency no longer applies, remove the edge with set_task_input before retrying.`,
    unmet: unmet.map(s => ({ text: s.text, status: s.status })),
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

// Returned in the `instructions` field of the initialize response — the one place the
// MCP can teach the model at CONNECTION time, with no tool call required (clients that
// support InitializeResult.instructions feed it into the model's context). Keep it tight:
// the mental model + the first move + the few rules that must hold even if the model
// never calls __init_tasker_session. The detailed playbook stays in ASSISTANT_DIRECTIVES.
const TASKER_SERVER_INSTRUCTIONS = `Tasker is a task manager that lives inside your AI workflow. Hierarchy: Project → Section → Group → Task → Milestone. Tasks can be linked by I/O edges (one task's output is another's input) into FLOWS — multi-step processes with quality gates (contracts) between steps.

FIRST MOVE: at the start of a Tasker session call __init_tasker_session. It returns the user's behavioral preferences plus the full directive playbook (task lifecycle, running flows, validation, dependency rules). Read and follow those directives.

Rules that always apply, even before you call anything else:
- To work a task, set it in_progress (get_task does this automatically). Mark it done only when genuinely, verifiably complete.
- Flow dependencies are HARD-ENFORCED server-side: you cannot start or complete a task whose upstream source tasks aren't done. Finish upstream first, or remove the edge.
- For a multi-step goal that needs quality checks between steps, build a flow (build_new_flow) and run it (run_flow) — don't free-form a plan.
- Refer to tasks by short ID (e.g. TDE-52), never UUIDs. Default to pending tasks; don't surface done tasks unless asked. Don't number tasks.
- ORGANIC TASK LIFECYCLE: when a discussion, decision, or exploration task reaches a clear conclusion in conversation, mark it done and open a follow-up action task capturing the outcome — without waiting to be told. Limit: only when the conclusion is unambiguous and the next step is obvious. Don't create tasks speculatively.`

// Standing behavioral directives surfaced to the connected agent at session start.
// Advisory — the MCP can't enforce agent behavior — but injected so every agent
// using Tasker gets a consistent baseline.
const ASSISTANT_DIRECTIVES = [
  'When you begin working on a task, the FIRST thing to do is set its status to in_progress. Calling get_task does this automatically; if you start work without calling get_task, set it explicitly via update_task before doing anything else. When the work is genuinely and verifiably complete, mark it done with complete_task; otherwise leave it in_progress.',
  'When a request is ambiguous, default to the most obvious interpretation and proceed, briefly stating the assumption you made. Do NOT ask a clarifying question for read-only / list / display / search requests — bias toward action over questions.',
  'Only pause to ask the user to clarify or confirm when the action is destructive or outward-facing (deleting, bulk-completing, pushing to GitHub, or anything hard to reverse), OR when the request genuinely cannot be resolved from the conversation and context.',
  'When the user wants to BUILD A NEW FLOW (a multi-step process toward a goal, with quality checks between the steps), call build_new_flow to get the interview playbook + project grounding — do NOT free-form a plan. You then run the grill-me-style interview yourself (one question at a time, always recommend a path), propose the tasks and their input/output contracts, get ONE confirmation of the whole flow at the end, and only then persist via create_task + set_task_output + set_task_input.',
  'REVISION LOOP: When submit_validation_result returns action="regenerate" — redo the producing task (apply the specific gate failures as revision instructions), complete it, then call validate_output + submit_validation_result again. Continue until action="pass" or action="ask_human". When action="ask_human" — the retry limit (3) has been reached; STOP and call get_task_critique on the producer task to get the clean validator notes, then use AskUserQuestion to present those findings to the human and ask how to proceed. UPSTREAM CASCADE: if the root cause is in the input the producer received (not fixable by redoing the producer alone), you may re-run at most 2 tasks further upstream from the original failure; beyond that depth, stop and ask the human.',
  'VALIDATION INDEPENDENCE: Flows use TWO agents per handoff — executor (you) and validator (a separate subagent). When a task has output contract rules, call store_artifact with the VERBATIM produced content before complete_task. Then: (A) if all rules are kind=check AND you already know the rules, skip validate_output entirely — call submit_validation_result directly with your check results (1 call instead of 2); (B) if judgment rules exist, call validate_output to get the validator_agent_prompt, spawn an adversarial validator subagent via the Agent tool passing that prompt unmodified — the subagent starts from FAIL prior and calls submit_validation_result with validator="independent-subagent". You do NOT evaluate judgment rules yourself. MULTI-VOTE: for high-stakes flows with multiple judgment blockers, spawn 3 independent validators and only accept pass if majority (2 of 3) agree — split = fail, surface to human.',
  'FLOW IDENTITY: After persisting a new flow (after all create_task + set_task_output + set_task_input calls), call name_flow with all task IDs and a descriptive name (e.g. "Blog Post Publication Flow"). Optionally add a context string — the goal, constraints, or background that applies to all tasks. At the start of any flow run, call get_flow_context to orient yourself. Use update_flow_context to log progress or decisions that future agents in the flow should know.',
  'RUN FLOW: When the user asks you to run, execute, or start a flow — call run_flow first (with flow_id or any task_id in the flow). Read the playbook it returns. Then self-sequence through every step in order: execute → store_artifact → complete_task → validate → handle action. Do NOT prompt the user between steps unless action=ask_human. The flow runs to completion (or human intervention) in one session.',
  'CHECK RULE EXECUTION: For kind=check rules, ACTUALLY RUN the check — do NOT assert or claim. Submit two fields: (1) observed_value — the raw datum from running it: exact word count ("1,542 words"), command output ("exit 0: All 24 tests passed"), file path ("/src/index.ts found"), pattern match ("keyword \'auth\' found at line 47"). Submitting without observed_value is REJECTED by the server. (2) note — interpretation of the observed_value against the rule (e.g. "1,542 words — exceeds the 1,000-word minimum"). How to produce observed_value: word/char count → run `echo "..." | wc -w` via Bash; command check → run it via Bash, capture stdout + exit code; file existence → Glob/Read, record the path; pattern → Grep/Read and record the match. FAIL EVIDENCE: any failing rule (kind=judgment OR kind=check) ALSO requires a note — the specific deficiency. This applies to the validator subagent too.',
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
    description: 'List all projects with name, slug, progress stats, and context (goal, why, scope). If you have not yet called __init_tasker_session this session, call it first — it returns the user\'s preferences and the playbook for using Tasker correctly (task lifecycle, flows, dependency rules).',
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
    description: 'Create a new project. Auto-seeds a baseline Instruction Set (task hygiene + working preferences); after creating, propose 2–4 project-specific IS additions for the user to confirm.',
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
    name: 'delete_section',
    description: 'Delete a section. By default REFUSES if the section still has tasks (move them to another section first, e.g. via update_task/move_task_to_group). Pass delete_tasks: true to delete the section together with all its tasks and groups. Irreversible — confirm with the user before calling.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id:   { type: 'string', description: 'Project prefix (e.g. TDE), slug, or UUID' },
        section_id:   { type: 'string', description: 'Section UUID' },
        delete_tasks: { type: 'boolean', description: 'If true, delete the section AND every task/group in it. If false (default), the section must already be empty or the call is refused.' },
      },
      required: ['project_id', 'section_id'],
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
    description: 'Create a single task. For a multi-step process toward a goal — where steps hand off to each other and need quality checks between them — do NOT create tasks ad hoc; use build_new_flow instead.',
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
    description: 'Update task fields. Only provided fields are changed. Pass append:true to ADD the provided detail to the existing detail (separated by a blank line) instead of replacing it — use it to accumulate notes/context on a task without resending the whole field. Note: setting status to in_progress or done is hard-blocked if the task has unmet upstream flow dependencies — finish the source task(s) first (the response explains which).',
    inputSchema: {
      type: 'object',
      properties: {
        task_id:    { type: 'string', description: 'Task UUID or short ID (e.g. TDE-31)' },
        text:       { type: 'string' },
        detail:     { type: 'string', description: 'Task context. Replaces the existing detail unless append:true is also passed.' },
        append:     { type: 'boolean', description: 'If true, the provided detail is appended to the existing detail (separated by a blank line) instead of replacing it. Default false. Lets you add notes/context without resending the whole field.' },
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
    description: 'Mark a task as done. Blocked (with an explanation) if the task has unmet upstream flow dependencies, or if it has kind=judgment output-contract rules but no artifact stored yet — in that case call store_artifact with the produced content first.',
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
    description: 'Permanently delete a task. Irreversible — confirm with the user before calling.',
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
      properties: {
        project_id: { type: 'string', description: 'Project prefix (e.g. TDE), slug, or UUID' },
        source: { type: 'string', enum: ['user', 'agent', 'all'], description: 'Filter by who created the entry. Defaults to "all".' },
      },
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
        source:     { type: 'string', enum: ['user', 'agent'], description: 'Who is creating this entry. Pass "agent" when writing a learning on task completion per the Dynamic KB rule. Defaults to "agent" when called by an AI agent.' },
        category:   { type: 'string', enum: ['architecture', 'database', 'deployment', 'mcp', 'flows', 'design', 'product', 'gtm', 'reference', 'other'], description: 'Optional category (controlled vocab). A SOFT hint that prioritises this entry in KB title-scan retrieval — never a hard filter.' },
      },
      required: ['project_id', 'title', 'content'],
    },
  },
  {
    name: 'create_is_entry',
    description: 'Create a new project Instruction Set entry — directives/rules that govern how work in this project is done. Auto-injected into every get_task. Set universal:true for rules that must apply even inside a flow that has its own IS (e.g. short IDs, deploy rules, code style); otherwise a flow IS replaces non-universal project rules for that flow\'s tasks.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Project prefix (e.g. TDE), slug, or UUID' },
        title:      { type: 'string', description: 'Short title for the directive' },
        content:    { type: 'string', description: 'The instruction content (markdown supported)' },
        universal:  { type: 'boolean', description: 'If true, this rule always applies, even inside a flow with its own IS. Default false.' },
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
    description: 'Permanently delete a milestone from a task by its index (0-based). Irreversible — confirm with the user before calling.',
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
    name: 'github_push_file',
    description: 'Commit a text file to a path in a connected GitHub repo — the canonical way to persist flow/task artifacts to version control. If the file already exists it is updated (the existing SHA is fetched automatically). Path convention for flow artifacts: .tasker/artifacts/{flow-short-id}/{filename}. Requires a GitHub account connected via github_connect and a repo to write to (falls back to the project\'s linked repo if task_id is supplied and omitted).',
    inputSchema: {
      type: 'object',
      properties: {
        path:    { type: 'string', description: 'File path within the repo, e.g. ".tasker/artifacts/BKT-F1/report.md"' },
        content: { type: 'string', description: 'Text content to write' },
        repo:    { type: 'string', description: 'GitHub repo in "owner/name" format (e.g. "acme/my-project"). Falls back to the project\'s linked repo when task_id is provided.' },
        task_id: { type: 'string', description: 'Optional: any task in the flow — used to derive the repo and suggested artifact path when repo is omitted.' },
        message: { type: 'string', description: 'Commit message. Defaults to "chore: store Tasker artifact".' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'github_read_file',
    description: 'Read a file from a connected GitHub repo. Returns the decoded text content. Use to retrieve a previously stored flow/task artifact.',
    inputSchema: {
      type: 'object',
      properties: {
        path:    { type: 'string', description: 'File path within the repo, e.g. ".tasker/artifacts/BKT-F1/report.md"' },
        repo:    { type: 'string', description: 'GitHub repo in "owner/name" format. Falls back to the project\'s linked repo when task_id is provided.' },
        task_id: { type: 'string', description: 'Optional: any task in the flow — used to derive the repo when repo is omitted.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'list_kb_entries',
    description: 'List Knowledge Base entries for a project — returns id + title + source + updated_at only (no content). Use this for cheap discovery before update/delete operations.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Project prefix (e.g. TDE), slug, or UUID' },
        source: { type: 'string', enum: ['user', 'agent', 'all'], description: 'Filter by who created the entry. Defaults to "all".' },
      },
      required: ['project_id'],
    },
  },
  {
    name: 'get_kb_entries',
    description: 'Fetch the FULL content of specific Knowledge Base entries by id (or title) — the selective-pull companion to the KB titles index shown in get_task. Use this to read only the few entries relevant to the current task, instead of get_knowledge_base (which dumps the whole KB). Pass ids (preferred — from the index) and/or titles (case-insensitive partial match).',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Project prefix (e.g. TDE), slug, or UUID' },
        ids:        { type: 'array', items: { type: 'string' }, description: 'KB entry UUIDs (from the get_task index or list_kb_entries).' },
        titles:     { type: 'array', items: { type: 'string' }, description: 'Optional: case-insensitive partial title matches, as an alternative/supplement to ids.' },
      },
      required: ['project_id'],
    },
  },
  {
    name: 'kb_health',
    description: 'Report stale Knowledge Base entries (not touched in 60+ days), grouped by source. Also opportunistically auto-archives stale AGENT entries (a daily cron does this too; calling this just makes it immediate). Stale USER entries are returned for the human to confirm — never auto-archived. Use this to keep the KB lean.',
    inputSchema: {
      type: 'object',
      properties: { project_id: { type: 'string', description: 'Project prefix (e.g. TDE), slug, or UUID' } },
      required: ['project_id'],
    },
  },
  {
    name: 'archive_kb_entry',
    description: 'Archive a Knowledge Base entry (hides it from default reads but keeps it recoverable — never deletes). Pass restore:true to bring an archived entry back. Confirm with the user before archiving their own (source=user) entries.',
    inputSchema: {
      type: 'object',
      properties: {
        entry_id: { type: 'string', description: 'UUID of the KB entry (from list_kb_entries or kb_health).' },
        restore:  { type: 'boolean', description: 'If true, un-archive (restore) the entry instead of archiving it.' },
      },
      required: ['entry_id'],
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
        category: { type: 'string', enum: ['architecture', 'database', 'deployment', 'mcp', 'flows', 'design', 'product', 'gtm', 'reference', 'other'], description: 'Set/change the category (controlled vocab); pass null to clear. Soft retrieval hint, not a filter.' },
      },
      required: ['entry_id'],
    },
  },
  {
    name: 'delete_kb_entry',
    description: 'Permanently delete a Knowledge Base entry by id. Irreversible — confirm with the user before calling.',
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
    description: 'Update a project Instruction Set entry by id. Provide title, content, and/or universal — only provided fields change.',
    inputSchema: {
      type: 'object',
      properties: {
        entry_id:  { type: 'string', description: 'UUID of the IS entry. Get it via list_is_entries or get_project_is.' },
        title:     { type: 'string', description: 'New title (optional)' },
        content:   { type: 'string', description: 'New content (optional, markdown supported)' },
        universal: { type: 'boolean', description: 'Set true so this rule applies even inside flows with their own IS; false to scope it to non-flow / fallback only.' },
      },
      required: ['entry_id'],
    },
  },
  {
    name: 'delete_is_entry',
    description: 'Permanently delete an Instruction Set entry by id. Irreversible — confirm with the user before calling.',
    inputSchema: {
      type: 'object',
      properties: { entry_id: { type: 'string', description: 'UUID of the IS entry to delete.' } },
      required: ['entry_id'],
    },
  },
  {
    name: 'get_flow_is',
    description: 'Get a flow\'s Instruction Set — the directives that govern tasks in this flow. When a flow has its own IS it REPLACES the project\'s non-universal IS for that flow\'s tasks (universal project rules still apply). Identify the flow by flow_id (UUID or name) or any task_id in it.',
    inputSchema: {
      type: 'object',
      properties: {
        flow_id:    { type: 'string', description: 'Flow UUID or name (partial match OK)' },
        task_id:    { type: 'string', description: 'Any task in the flow (UUID or short ID) — alternative to flow_id' },
        project_id: { type: 'string', description: 'Narrows a flow-name lookup' },
      },
      required: [],
    },
  },
  {
    name: 'list_flow_is_entries',
    description: 'List a flow\'s IS entries (id + title + updated_at only). Cheap discovery before update/delete. Identify the flow by flow_id or task_id.',
    inputSchema: {
      type: 'object',
      properties: {
        flow_id:    { type: 'string', description: 'Flow UUID or name' },
        task_id:    { type: 'string', description: 'Any task in the flow' },
        project_id: { type: 'string', description: 'Narrows a flow-name lookup' },
      },
      required: [],
    },
  },
  {
    name: 'create_flow_is_entry',
    description: 'Add an Instruction Set entry to a flow. Once a flow has any IS entry, its IS governs the flow\'s tasks (replacing the project\'s non-universal IS; universal project rules still apply). Identify the flow by flow_id or task_id.',
    inputSchema: {
      type: 'object',
      properties: {
        flow_id:    { type: 'string', description: 'Flow UUID or name' },
        task_id:    { type: 'string', description: 'Any task in the flow' },
        project_id: { type: 'string', description: 'Narrows a flow-name lookup' },
        title:      { type: 'string', description: 'Short title for the directive' },
        content:    { type: 'string', description: 'The instruction content (markdown supported)' },
      },
      required: ['title', 'content'],
    },
  },
  {
    name: 'update_flow_is_entry',
    description: 'Update a flow IS entry by id. Provide title and/or content — only provided fields change.',
    inputSchema: {
      type: 'object',
      properties: {
        entry_id: { type: 'string', description: 'UUID of the flow IS entry (from list_flow_is_entries)' },
        title:    { type: 'string', description: 'New title (optional)' },
        content:  { type: 'string', description: 'New content (optional)' },
      },
      required: ['entry_id'],
    },
  },
  {
    name: 'delete_flow_is_entry',
    description: 'Permanently delete a flow IS entry by id. If it was the flow\'s last IS entry, the flow\'s tasks revert to the full project IS. Irreversible — confirm with the user.',
    inputSchema: {
      type: 'object',
      properties: { entry_id: { type: 'string', description: 'UUID of the flow IS entry to delete.' } },
      required: ['entry_id'],
    },
  },
  {
    name: 'get_flow_kb',
    description: 'Get a flow\'s Knowledge Base — reference material auto-loaded on every task in the flow. Identify the flow by flow_id (UUID or name) or any task_id in it.',
    inputSchema: {
      type: 'object',
      properties: {
        flow_id:    { type: 'string', description: 'Flow UUID or name (partial match OK)' },
        task_id:    { type: 'string', description: 'Any task in the flow' },
        project_id: { type: 'string', description: 'Narrows a flow-name lookup' },
      },
      required: [],
    },
  },
  {
    name: 'list_flow_kb_entries',
    description: 'List a flow\'s KB entries (id + title + updated_at only). Cheap discovery before update/delete. Identify the flow by flow_id or task_id.',
    inputSchema: {
      type: 'object',
      properties: {
        flow_id:    { type: 'string', description: 'Flow UUID or name' },
        task_id:    { type: 'string', description: 'Any task in the flow' },
        project_id: { type: 'string', description: 'Narrows a flow-name lookup' },
      },
      required: [],
    },
  },
  {
    name: 'create_flow_kb_entry',
    description: 'Add a Knowledge Base entry to a flow. Flow KB auto-loads on every task in the flow (unlike project KB, which is on-demand). Identify the flow by flow_id or task_id.',
    inputSchema: {
      type: 'object',
      properties: {
        flow_id:    { type: 'string', description: 'Flow UUID or name' },
        task_id:    { type: 'string', description: 'Any task in the flow' },
        project_id: { type: 'string', description: 'Narrows a flow-name lookup' },
        title:      { type: 'string', description: 'Short title for the entry' },
        content:    { type: 'string', description: 'The content to save (markdown supported)' },
      },
      required: ['title', 'content'],
    },
  },
  {
    name: 'update_flow_kb_entry',
    description: 'Update a flow KB entry by id. Provide title and/or content — only provided fields change.',
    inputSchema: {
      type: 'object',
      properties: {
        entry_id: { type: 'string', description: 'UUID of the flow KB entry (from list_flow_kb_entries)' },
        title:    { type: 'string', description: 'New title (optional)' },
        content:  { type: 'string', description: 'New content (optional)' },
      },
      required: ['entry_id'],
    },
  },
  {
    name: 'delete_flow_kb_entry',
    description: 'Permanently delete a flow KB entry by id. Irreversible — confirm with the user.',
    inputSchema: {
      type: 'object',
      properties: { entry_id: { type: 'string', description: 'UUID of the flow KB entry to delete.' } },
      required: ['entry_id'],
    },
  },
  {
    name: '__init_tasker_session',
    description: 'Call FIRST in any Tasker session. Returns the user\'s behavioral preferences, a summary of current settings, and the directive playbook for using Tasker well (task lifecycle, running flows, validation, dependency rules). First-time users get a setup questionnaire; pass show_questionnaire: true to review or change settings later.',
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
    description: 'Delete a group. By default its tasks are moved to ungrouped (set delete_tasks: true to delete them instead). Confirm with the user before calling — especially with delete_tasks: true.',
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
    description: 'Returns a structured, factual breakdown of a section (task counts by status, group balance, stale tasks) — no AI judgment. Use for raw numbers; use section_insights when you want interpretation and suggested actions.',
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
    description: 'Returns interpreted analysis of a section (what\'s working, what needs attention, suggested actions). Use analyze_section instead when you only need raw counts/facts.',
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
    name: 'enable_task_review',
    description: 'Enable the task-level output judge (TDE-261) on a STANDALONE task. Two modes: (1) call WITHOUT `bar` to get grounding (the task\'s text + the governing IS) and the instruction to author a checkable acceptance bar from text+IS only (Phase 1 — no KB); (2) call WITH `bar: { rules: [...] }` to FREEZE that bar as the task\'s review snapshot and turn review on. Refuses flow tasks (mutual exclusivity — flow gates govern those). Refuses to overwrite an existing frozen bar unless force:true.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Task UUID or short ID — the task to enable review on (must NOT be in a flow).' },
        bar:     { ...CONTRACT_SCHEMA, description: 'The authored bar to freeze: { rules: [ { label, kind: check|judgment, rule, severity } ] }. Omit to get grounding + authoring instructions instead.' },
        force:   { type: 'boolean', description: 'Re-derive/overwrite an existing frozen bar. Default false (frozen snapshots are not mutated).' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'review_task',
    description: 'Run the task-level output judge (TDE-261) on a review-enabled STANDALONE task. Returns the single-task judging protocol with the frozen bar and the stored artifact (read SERVER-SIDE, not from your claims — independence). Mirrors the flow loop store_artifact → validate_output → submit_validation_result: you run check rules inline and spawn a fresh independent subagent for judgment rules, then call submit_task_review with the per-rule results. Refuses flow tasks (mutual exclusivity).',
    inputSchema: {
      type: 'object',
      properties: { task_id: { type: 'string', description: 'The review-enabled task to judge.' } },
      required: ['task_id'],
    },
  },
  {
    name: 'submit_task_review',
    description: 'Record the task-level judge verdict (TDE-261). Computes overall pass/fail from per-rule results against the frozen bar, writes review_verdict, and applies the gate: a blocker failure REOPENS the task (status→in_progress) with the critique; after 3 failed attempts it escalates to the human (action=ask_human). On pass the task stays done. Returns the action: pass | regenerate | ask_human.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id:   { type: 'string', description: 'The reviewed task (same as review_task).' },
        validator: { type: 'string', description: 'Who graded — use "independent-subagent" when judgment rules were graded by a fresh subagent.' },
        results: {
          type: 'array',
          description: 'Per-rule results.',
          items: {
            type: 'object',
            properties: {
              rule_id:        { type: 'string', description: 'id of the bar rule' },
              status:         { type: 'string', enum: ['pass', 'fail'] },
              observed_value: { type: 'string', description: 'Required for check rules — the raw datum.' },
              note:           { type: 'string', description: 'Required for any fail — the specific deficiency.' },
            },
            required: ['rule_id', 'status'],
          },
        },
      },
      required: ['task_id', 'results'],
    },
  },
  {
    name: 'remove_task_input',
    description: 'Remove an input edge (dependency) from a task. Pass source_task_id to drop just that edge, or omit it to remove ALL input edges. The source task is untouched. Use to dismantle I/O dependencies (the delete counterpart of set_task_input).',
    inputSchema: {
      type: 'object',
      properties: {
        task_id:        { type: 'string', description: 'The CONSUMER task (UUID or short ID)' },
        source_task_id: { type: 'string', description: 'Optional: the upstream source whose edge to remove. Omit to remove all input edges.' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'clear_task_output',
    description: 'Clear a task\'s output contract (its definition-of-done rules) — the delete counterpart of set_task_output. Any stored artifact and validation status are kept.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Task UUID or short ID (e.g. TDE-31) — the PRODUCER' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'delete_flow',
    description: 'Delete a NAMED FLOW: removes the flow\'s name/context record and unlinks its tasks (clears flow_id/flow_step). The tasks themselves and their I/O edges are NOT deleted — only the flow grouping/identity (the delete counterpart of name_flow). To also dismantle the chain, use remove_task_input on the edges. Irreversible — confirm with the user before calling.',
    inputSchema: {
      type: 'object',
      properties: {
        flow_id:    { type: 'string', description: 'Flow UUID, or flow name (partial match OK). Or pass task_id instead.' },
        task_id:    { type: 'string', description: 'Any task in the flow (UUID or short ID) — alternative to flow_id.' },
        project_id: { type: 'string', description: 'Narrows a flow-name lookup; helpful with a short task_id.' },
      },
      required: [],
    },
  },
  {
    name: 'store_artifact',
    description: 'Store the actual produced output for a task before completing it. The artifact is embedded directly into the validator_agent_prompt returned by validate_output — the independent validator subagent receives the content from the server, not from the executor. REQUIRED before complete_task on any task whose output contract contains kind=judgment rules. Pass commit_to_repo: true + filename to also commit the artifact to the project\'s linked GitHub repo at .tasker/artifacts/{flow-short-id or task-short-id}/{filename}.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id:        { type: 'string', description: 'Task UUID or short ID — the PRODUCER' },
        content:        { type: 'string', description: 'The actual produced output — verbatim, not a summary. This is exactly what the independent validator will grade.' },
        format:         { type: 'string', enum: ['text', 'markdown', 'code', 'json'], description: 'Optional format hint for the validator. Default: text.' },
        commit_to_repo: { type: 'boolean', description: 'If true, also commit the artifact to the project\'s linked GitHub repo. Requires the project to have a linked repo (github_import_project) and a connected GitHub account.' },
        filename:       { type: 'string', description: 'Filename for the committed file (e.g. "report.md"). Required when commit_to_repo is true. The path in the repo will be .tasker/artifacts/{flow-short-id or task-short-id}/{filename}.' },
      },
      required: ['task_id', 'content'],
    },
  },
  {
    name: 'validate_output',
    description: 'PHASE 1 of a handoff check. Returns the rules to evaluate — the CONSUMER\'s input contract for this edge (the gate) plus the producer\'s own output contract (self-check) — plus a validator_agent_prompt when judgment rules are present. Call this when you need to (a) learn which rules apply, or (b) get the validator_agent_prompt for a judgment-rule contract. For contracts with ONLY kind=check rules and you already know the rules, you may skip this call and call submit_validation_result directly — the response will tell you when this shortcut applies.',
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
    description: 'Report per-rule validation results. Writes to the producer\'s feedback ledger, applies the gate (any BLOCKER gate-rule failure → invalid, reopens producer), returns the verdict. Can be called standalone (without a prior validate_output) for contracts with only kind=check rules when the rules are already known — collapses the two-call flow to one. Always required for judgment rules (called by the validator subagent). Warnings recorded but do not block.',
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
              observed_value: { type: 'string', description: 'REQUIRED for kind=check rules. The raw datum from actually running the check — not an interpretation, the value itself. Examples: "1,542 words" (word count), "exit 0 — All 24 tests passed" (command), "/src/index.ts found" (file exists), "keyword \'authentication\' found at line 47" (pattern). If you cannot produce a concrete observed value, you have not run the check.' },
              note: { type: 'string', description: 'REQUIRED for any fail (any kind): the specific deficiency — what did not meet the rule and why. REQUIRED for kind=check rules: interpretation of the observed_value (e.g. "1,542 words — exceeds 1,000-word minimum"). For kind=judgment pass: reasoning recommended.' },
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
    name: 'confirm_contract',
    description: 'Human-bless a contract on a task. Agent-authored contracts are AI-QA\'d (QA is performed by AI, not a meat sack) — stamped contract_blessed: false in the validation ledger. Call this after the human has reviewed and approved the quality bar. Confirmation is non-destructive; any subsequent call to set_task_output or set_task_input resets the contract to AI-QA\'d.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Task UUID or short ID' },
        contract_type: { type: 'string', enum: ['output', 'input'], description: 'Which contract to confirm: "output" (this task\'s own quality bar) or "input" (the gate rules on an incoming edge). Default: "output".' },
        source_task_id: { type: 'string', description: 'Required when contract_type is "input" and the task has multiple input edges — identifies which edge\'s contract to confirm.' },
        confirmed_by: { type: 'string', description: 'Who confirmed it. Default: "human".' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'list_flows',
    description: 'List all named flows in a project — flow name, step count, overall status (pending/in_progress/done), and the flow ID you can pass to run_flow.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Project prefix (e.g. TDE), slug, or UUID' },
      },
      required: ['project_id'],
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
    name: 'get_task_critique',
    description: 'Get the validator\'s critique for a task — what passed, what failed, and the specific notes from the independent validator subagent. Cleaner than get_validation_feedback for the "what did the validator say?" question. Surface this to the human when action=ask_human, or call it to understand why a gate failed.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'The producer task (UUID or short ID)' },
        target_task_id: { type: 'string', description: 'Optional: which consumer edge\'s critique to show. Required only if the producer feeds more than one task.' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'get_flow_audit',
    description: 'Full validation audit trail for a flow — who validated, when, which rules passed/failed, evidence notes, retry counts, and contract blessing status. Returns a step-by-step report across all tasks in the flow. Use for compliance review, debugging a failed run, or understanding what the flow produced and why.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Any task in the flow (UUID or short ID). The tool finds all other tasks in the same flow automatically.' },
      },
      required: ['task_id'],
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
    name: 'name_flow',
    description: 'Give a flow a human name and optional shared context bag. Creates a named flow record and links all specified tasks to it. Call this after building a new flow (after all create_task + set_task_output + set_task_input calls). The name appears in get_flow_order output and can be retrieved with get_flow_context. A short ID (e.g. BKT-F1) is auto-assigned if not provided.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Project prefix, slug, or UUID' },
        name: { type: 'string', description: 'Human name for the flow (e.g. "Blog Post Publication Flow")' },
        task_ids: { type: 'array', items: { type: 'string' }, description: 'All task IDs in the flow (UUIDs or short IDs).' },
        context: { type: 'string', description: 'Optional shared context for the flow — background, goals, constraints, or instructions that apply to all tasks in this flow.' },
        short_id: { type: 'string', description: 'Optional custom short ID (e.g. "BKT-F3"). Must be unique across all your flows. Auto-generated if omitted.' },
      },
      required: ['project_id', 'name', 'task_ids'],
    },
  },
  {
    name: 'get_flow_context',
    description: 'Get the name and shared context for the flow a task belongs to. Call at the start of a flow run to orient yourself.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Any task in the flow' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'update_flow_context',
    description: 'Update the shared context bag for a named flow, or rename it, or set/change its short ID. Pass any task ID in the flow.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Any task in the flow' },
        context: { type: 'string', description: 'New shared context (replaces existing)' },
        name: { type: 'string', description: 'Optional: rename the flow' },
        short_id: { type: 'string', description: 'Optional: set or change the flow short ID (e.g. "BKT-F2"). Must be unique across all your flows.' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'run_flow',
    description: 'Get the full execution playbook for an existing flow — ordered steps with their contracts, current status, and the step-by-step protocol to run the flow to completion. Call this at the start of any flow run. The playbook tells you exactly what to produce at each step, what the quality gates check, and how to sequence store_artifact → complete_task → validate_output → submit_validation_result for each handoff.',
    inputSchema: {
      type: 'object',
      properties: {
        flow_id: { type: 'string', description: 'Flow UUID or flow name (partial match OK, e.g. "define docs structure"). Preferred over task_id.' },
        task_id: { type: 'string', description: 'Any task in the flow — the server will find the whole flow from it. Use when you only have a task reference.' },
        project_id: { type: 'string', description: 'Project slug, prefix, or UUID. Narrows name lookup when using flow name; required when using task_id with a short ID like TDE-12.' },
      },
    },
  },
  {
    name: 'save_flow_as_template',
    description: 'Save an existing flow as a reusable Flow Template. Captures the step structure, titles, detail scaffolds, and contracts. The template can later be instantiated via instantiate_flow_template to create a new flow pre-populated with the same structure.',
    inputSchema: {
      type: 'object',
      properties: {
        flow_id: { type: 'string', description: 'Flow UUID or name to save as a template.' },
        task_id: { type: 'string', description: 'Any task in the flow — alternative to flow_id.' },
        name: { type: 'string', description: 'Name for the template (e.g. "Blog Post Publication").' },
        description: { type: 'string', description: 'Optional description of what this template is for.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'list_flow_templates',
    description: 'List all saved Flow Templates for the current user, with step counts.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'instantiate_flow_template',
    description: 'Create a new flow from a saved Flow Template. Copies the scaffold structure into real tasks in the specified project/section. Provide context (e.g. the goal or subject) to fill {{placeholders}} in step titles and details. Returns the created task IDs and calls name_flow automatically.',
    inputSchema: {
      type: 'object',
      properties: {
        template_id: { type: 'string', description: 'UUID of the template to instantiate.' },
        template_name: { type: 'string', description: 'Template name (partial match) — alternative to template_id.' },
        project_id: { type: 'string', description: 'Project prefix, slug, or UUID to create the flow in.' },
        section_id: { type: 'string', description: 'Section UUID to place tasks in. If omitted, a new section is created.' },
        flow_name: { type: 'string', description: 'Name for the new flow. Defaults to the template name.' },
        context: { type: 'object', description: 'Key/value pairs used to fill {{placeholders}} in step titles/details. E.g. { "topic": "TDE-152 launch" }.' },
      },
      required: ['project_id'],
    },
  },
  {
    name: 'recompute_flow_steps',
    description: 'Recompute and re-stamp the step order (flow_step) for a named flow. Use this after adding, removing, or changing I/O edges — name_flow stamps step numbers at creation time and they go stale if the DAG is edited afterward. Accepts flow_id (UUID or name) or any task_id in the flow.',
    inputSchema: {
      type: 'object',
      properties: {
        flow_id: { type: 'string', description: 'Flow UUID or flow name (partial match OK). Preferred over task_id.' },
        task_id: { type: 'string', description: 'Any task in the flow — the server finds the flow from it.' },
        project_id: { type: 'string', description: 'Narrows name or short-ID lookup.' },
      },
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

// Resolve a named flow from { flow_id (UUID or name) | task_id }. Returns {id, name} or null.
async function resolveFlow(sb: any, userId: string, args: any): Promise<{ id: string, name: string } | null> {
  const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)
  if (args.flow_id && isUuid(args.flow_id)) {
    const { data } = await sb.from('flows').select('id, name').eq('id', args.flow_id).eq('user_id', userId).maybeSingle()
    return data || null
  }
  if (args.flow_id) {
    let q = sb.from('flows').select('id, name').eq('user_id', userId).ilike('name', `%${args.flow_id}%`)
    if (args.project_id) { const p = await resolveProject(sb, userId, args.project_id); if (p) q = q.eq('project_id', p.id) }
    const { data } = await q
    return (data && data.length === 1) ? data[0] : null
  }
  if (args.task_id) {
    const task = await resolveTask(sb, userId, args.task_id)
    if (task?.flow_id) {
      const { data } = await sb.from('flows').select('id, name').eq('id', task.flow_id).eq('user_id', userId).maybeSingle()
      return data || null
    }
  }
  return null
}

// ── Tool handlers ─────────────────────────────────────────────
async function runTool(sb: any, userId: string, name: string, args: any, rawParams?: any): Promise<string> {
  const logCtx = { tool_name: name, raw_params: rawParams }
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
      const project = await resolveProject(sb, userId, args.project_id, logCtx)
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

      // A baseline Instruction Set (task hygiene + working preferences) is seeded
      // automatically by an AFTER INSERT trigger on `projects` (TDE-193), so it applies
      // to every creation path. Here we just nudge the assistant to tailor it.
      return `Created project "${name}"\nslug: ${data.slug}\nid:   ${data.id}` +
        `\n\nA baseline Instruction Set (task hygiene + working preferences) was applied automatically.` +
        `\n\nNEXT — tailor it: from what you know about this project (stack, language, conventions, workflow, output/commit style), propose 2–4 specific IS additions and ask the user to confirm before adding them via create_is_entry. Set universal:true for rules that must hold even inside flows (e.g. code style, deploy rules). Don't assume — propose, then add only what's confirmed.`
    }

    case 'update_project_context': {
      const project = await resolveProject(sb, userId, args.project_id, logCtx)
      if (!project) return `Project "${args.project_id}" not found.`
      const merged = { ...(project.context ?? {}), ...args.context }
      await sb.from('projects').update({ context: merged }).eq('id', project.id)
      return `Updated context for "${project.name}".`
    }

    case 'update_project': {
      const project = await resolveProject(sb, userId, args.project_id, logCtx)
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
      const project = await resolveProject(sb, userId, args.project_id, logCtx)
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
      const project = await resolveProject(sb, userId, args.project_id, logCtx)
      if (!project) return `Project "${args.project_id}" not found.`
      const { data } = await sb.from('sections').select('id, name').eq('project_id', project.id).order('sort_order')
      if (!data?.length) return `No sections in "${project.name}".`
      return data.map((s: any) => `[id: ${s.id}] ${s.name}`).join('\n')
    }

    case 'create_section': {
      const project = await resolveProject(sb, userId, args.project_id, logCtx)
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

    case 'delete_section': {
      const project = await resolveProject(sb, userId, args.project_id, logCtx)
      if (!project) return `Project "${args.project_id}" not found.`
      const { data: section } = await sb.from('sections')
        .select('id, name').eq('id', args.section_id).eq('project_id', project.id).maybeSingle()
      if (!section) return `Section not found in "${project.name}".`

      const { data: secTasks } = await sb.from('tasks').select('id').eq('section_id', section.id)
      const taskCount = secTasks?.length ?? 0
      if (taskCount > 0 && !args.delete_tasks) {
        return `Section "${section.name}" still has ${taskCount} task${taskCount !== 1 ? 's' : ''}. Move them to another section first, or pass delete_tasks: true to delete the section together with its tasks.`
      }
      if (taskCount > 0 && args.delete_tasks) {
        const { error: te } = await sb.from('tasks').delete().eq('section_id', section.id)
        if (te) throw new Error(te.message)
      }
      await sb.from('groups').delete().eq('section_id', section.id)
      const { error } = await sb.from('sections').delete().eq('id', section.id)
      if (error) throw new Error(error.message)
      return `Deleted section "${section.name}"${taskCount > 0 && args.delete_tasks ? ` and its ${taskCount} task${taskCount !== 1 ? 's' : ''}` : ''}.`
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
      const siblingQuery = sb.from('tasks').select('sort_order').eq('project_id', project.id).eq('section_id', resolvedSectionId)
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
      const { task_id, append, ...updates } = args
      const allowed = ['text', 'detail', 'priority', 'status', 'due_date', 'section_id', 'group_id', 'pinned']
      const patch: Record<string, any> = {}
      for (const k of allowed) if (k === 'group_id' ? updates[k] !== undefined : updates[k] !== undefined && updates[k] !== null) patch[k] = updates[k]
      const task = await resolveTask(sb, userId, task_id)
      if (!task) return 'Task not found.'

      // Append mode (TDE-181): add to the existing detail instead of replacing it, so
      // callers can accumulate notes/context on a task without resending the whole field.
      let appended = false
      if (append === true && patch.detail !== undefined) {
        const { data: cur } = await sb.from('tasks').select('detail').eq('id', task.id).maybeSingle()
        const existing = (cur?.detail ?? '').trim()
        patch.detail = existing ? `${existing}\n\n${patch.detail}` : patch.detail
        appended = true
      }

      // Enforce flow dependencies (full upstream chain) when starting or completing work.
      // Hard block — not bypassable via proceed_anyway. Finish upstream or drop the edge.
      if ((patch.status === 'in_progress' || patch.status === 'done') && task.input) {
        const unmet = await unmetSourcesDeep(sb, task.input)
        if (unmet.length) return flowHardBlockedResponse(unmet)
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
      return `Updated "${task.text}".${appended ? ' (appended to detail)' : ''}`
    }

    case 'complete_task': {
      const { proceed_anyway } = args
      const task = await resolveTask(sb, userId, args.task_id)
      if (!task) return 'Task not found.'

      // Enforce flow dependencies (full upstream chain). Hard block — not bypassable.
      if (task.input) {
        const unmet = await unmetSourcesDeep(sb, task.input)
        if (unmet.length) return flowHardBlockedResponse(unmet)
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
      // TDE-261 trigger: a review-enabled non-flow task gets judged on completion.
      let reviewNudge = ''
      if (task.review_enabled && !isFlowTask(task) && task.review_bar?.rules?.length) {
        reviewNudge = `\n\n⟳ Task-level review is ON for this task. Run review_task("${args.task_id}") to judge the output against the frozen bar (${task.review_bar.rules.length} rule(s)). store_artifact first if you have not.`
      }
      return `✓ Marked "${task.text}" as done.` + reviewNudge
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
        const unmet = await unmetSourcesDeep(sb, full.input)
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

      // TDE-261/267: surface the task-level review verdict (per-rule + critique) when present.
      if (full.review_verdict) {
        const v: any = full.review_verdict
        lines.push(`\nReview verdict: ${String(v.overall || '').toUpperCase()}${v.escalated ? ' (escalated to human)' : ''}${v.attempt ? ` · attempt ${v.attempt}/3` : ''}`)
        for (const r of (v.results || [])) {
          const barRule = (full.review_bar?.rules || []).find((x: any) => x.id === r.rule_id)
          const label = barRule?.label || r.rule_id
          const extra = r.observed_value ? ` — ${r.observed_value}` : (r.status === 'fail' && r.note ? ` — ${r.note}` : '')
          lines.push(`  ${r.status === 'pass' ? '✓' : '✗'} ${label}${extra}`)
        }
        if (v.critique) lines.push(`  Critique:\n${String(v.critique).split('\n').map((l: string) => '    ' + l).join('\n')}`)
      }

      // Inject the governing Instruction Set (TDE-233 flow-level IS).
      // - Task not in a flow → full project IS (as before).
      // - Task in a flow that has its own IS → universal project IS + flow IS
      //   (the project's non-universal IS is suppressed for this task).
      // - Task in a flow with no flow IS → full project IS (safe fallback).
      if (full.project_id) {
        const { data: projIs } = await sb.from('project_instructions')
          .select('title, content, universal')
          .eq('project_id', full.project_id)
          .order('created_at')
        let flowIs: any[] = []
        if (full.flow_id) {
          const { data } = await sb.from('flow_instructions')
            .select('title, content').eq('flow_id', full.flow_id).order('created_at')
          flowIs = data || []
        }
        if (flowIs.length) {
          const universalProj = (projIs || []).filter((e: any) => e.universal)
          if (universalProj.length) {
            lines.push('\n---')
            lines.push('# Project Instruction Set (universal)')
            for (const entry of universalProj) lines.push(`\n## ${entry.title}\n\n${entry.content}`)
          }
          lines.push('\n---')
          lines.push('# Flow Instruction Set (governs this flow — replaces the project\'s non-universal IS)')
          for (const entry of flowIs) lines.push(`\n## ${entry.title}\n\n${entry.content}`)
        } else if (projIs?.length) {
          lines.push('\n---')
          lines.push('# Project Instruction Set')
          for (const entry of projIs) lines.push(`\n## ${entry.title}\n\n${entry.content}`)
        }
      }

      // Inject the flow's Knowledge Base on every task in the flow (TDE-233).
      if (full.flow_id) {
        const { data: flowKb } = await sb.from('flow_knowledge')
          .select('title, content').eq('flow_id', full.flow_id).order('created_at')
        if (flowKb?.length) {
          lines.push('\n---')
          lines.push('# Flow Knowledge Base')
          for (const entry of flowKb) lines.push(`\n## ${entry.title}\n\n${entry.content}`)
        }
      }

      // TDE-254: inject a lightweight KB TITLES INDEX (not full content) so every task
      // surfaces what project knowledge exists. The agent pulls full content for only
      // the relevant entries via get_kb_entries — cheap reads, no whole-KB dump.
      if (full.project_id) {
        const { data: kbTitles } = await sb.from('project_knowledge')
          .select('id, title, source, category')
          .eq('project_id', full.project_id)
          .is('archived_at', null)
          .order('created_at')
        if (kbTitles?.length) {
          const cap = 60
          lines.push('\n---')
          lines.push(`# Project Knowledge Base — index (${kbTitles.length} entr${kbTitles.length === 1 ? 'y' : 'ies'}, titles only)`)
          lines.push('Pull full content for the few relevant to THIS task via get_kb_entries(project_id, ids:[...]). Do NOT pull them all.')
          for (const e of kbTitles.slice(0, cap)) lines.push(`  • [${e.id}]${e.category ? ` {${e.category}}` : ''}${e.source === 'agent' ? ' (ai)' : ''} ${e.title}`)
          if (kbTitles.length > cap) lines.push(`  … and ${kbTitles.length - cap} more — use list_kb_entries to see all.`)
        }
      }

      // Workflow directive
      lines.push('\n---')
      if (flowWarning) {
        const dep = flowWarning.count === 1
          ? `"${flowWarning.first}", which is not done yet (currently: ${flowWarning.status})`
          : `${flowWarning.count} upstream tasks that are not done yet (${flowWarning.names})`
        lines.push(`⛔ FLOW DEPENDENCY — BLOCKED: This task depends on ${dep}. Dependencies are enforced server-side — it was left pending and cannot be started or completed until the upstream task(s) are done. Work the upstream task(s) first, or, if the dependency no longer applies, remove the edge with set_task_input. There is no override.`)
      } else if (justStarted) {
        lines.push('▶ Status auto-set to in_progress — you are now working on this task.')
      }
      lines.push('When you finish: call complete_task ONLY if the work is genuinely and verifiably complete. If it is partial, blocked, or unverified, leave it in_progress (do not mark done).')

      return lines.join('\n')
    }

    case 'get_project_is': {
      const project = await resolveProject(sb, userId, args.project_id, logCtx)
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
      const project = await resolveProject(sb, userId, args.project_id, logCtx)
      if (!project) return `Project "${args.project_id}" not found.`
      const source = args.source === 'user' ? 'user' : 'agent'
      if (args.category && !KB_CATEGORIES.includes(args.category)) return `Invalid category "${args.category}". Allowed: ${KB_CATEGORIES.join(', ')} (or omit).`
      const { data, error } = await sb.from('project_knowledge')
        .insert({ project_id: project.id, user_id: userId, title: args.title, content: args.content, source, category: args.category ?? null })
        .select().single()
      if (error) throw new Error(error.message)
      return `Created KB entry "${data.title}" in "${project.name}".`
    }

    case 'create_is_entry': {
      const project = await resolveProject(sb, userId, args.project_id, logCtx)
      if (!project) return `Project "${args.project_id}" not found.`
      const { data, error } = await sb.from('project_instructions')
        .insert({ project_id: project.id, user_id: userId, title: args.title, content: args.content, universal: args.universal === true })
        .select().single()
      if (error) throw new Error(error.message)
      return `Created IS entry "${data.title}" in "${project.name}".${data.universal ? ' Marked universal — it applies even inside flows that have their own IS.' : ''}`
    }

    case 'get_knowledge_base': {
      const project = await resolveProject(sb, userId, args.project_id, logCtx)
      if (!project) return `Project "${args.project_id}" not found.`
      let q = sb.from('project_knowledge')
        .select('id, title, content, source, updated_at')
        .eq('project_id', project.id)
        .is('archived_at', null)
        .order('created_at')
      if (args.source && args.source !== 'all') q = q.eq('source', args.source)
      const { data: entries } = await q
      if (!entries?.length) return `No knowledge base entries for "${project.name}". Add entries via the KB button in the project header.`
      return [
        `# Knowledge Base — ${project.name}`,
        '',
        ...entries.map((e: any) => `## ${e.title}  (id: ${e.id}) [${e.source}]\n\n${e.content}`),
      ].join('\n\n---\n\n')
    }

    case 'get_kb_entries': {
      const project = await resolveProject(sb, userId, args.project_id, logCtx)
      if (!project) return `Project "${args.project_id}" not found.`
      const ids: string[] = Array.isArray(args.ids) ? args.ids : []
      const titles: string[] = Array.isArray(args.titles) ? args.titles : []
      if (!ids.length && !titles.length) return 'Provide ids and/or titles to fetch (use the KB index in get_task or list_kb_entries to find them).'
      const collected = new Map<string, any>()
      if (ids.length) {
        const { data } = await sb.from('project_knowledge')
          .select('id, title, content, source')
          .eq('project_id', project.id).is('archived_at', null).in('id', ids)
        for (const e of (data || [])) collected.set(e.id, e)
      }
      for (const t of titles) {
        const { data } = await sb.from('project_knowledge')
          .select('id, title, content, source')
          .eq('project_id', project.id).is('archived_at', null).ilike('title', `%${t}%`)
        for (const e of (data || [])) collected.set(e.id, e)
      }
      const entries = [...collected.values()]
      if (!entries.length) return `No matching KB entries found in "${project.name}".`
      return [
        `# Knowledge Base — ${entries.length} selected entr${entries.length === 1 ? 'y' : 'ies'} (${project.name})`,
        '',
        ...entries.map((e: any) => `## ${e.title}  (id: ${e.id}) [${e.source}]\n\n${e.content}`),
      ].join('\n\n---\n\n')
    }

    case 'list_kb_entries': {
      const project = await resolveProject(sb, userId, args.project_id, logCtx)
      if (!project) return `Project "${args.project_id}" not found.`
      let q = sb.from('project_knowledge')
        .select('id, title, source, updated_at')
        .eq('project_id', project.id)
        .is('archived_at', null)
        .order('created_at')
      if (args.source && args.source !== 'all') q = q.eq('source', args.source)
      const { data } = await q
      if (!data?.length) return `No knowledge base entries for "${project.name}".`
      return data.map((e: any) => `[id: ${e.id}] [${e.source}] ${e.title}  (updated ${e.updated_at})`).join('\n')
    }

    case 'kb_health': {
      const project = await resolveProject(sb, userId, args.project_id, logCtx)
      if (!project) return `Project "${args.project_id}" not found.`
      const cutoff = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString()
      const { data: stale } = await sb.from('project_knowledge')
        .select('id, title, source, updated_at, reviewed_at')
        .eq('project_id', project.id)
        .is('archived_at', null)
        .order('updated_at')
      const isStale = (e: any) => (e.reviewed_at ?? e.updated_at) < cutoff
      const staleEntries = (stale ?? []).filter(isStale)
      const agentStale = staleEntries.filter((e: any) => e.source === 'agent')
      const userStale  = staleEntries.filter((e: any) => e.source !== 'agent')

      // Auto-archive stale agent entries immediately (mirrors the daily cron sweep).
      let archivedCount = 0
      if (agentStale.length) {
        const { error } = await sb.from('project_knowledge')
          .update({ archived_at: new Date().toISOString() })
          .in('id', agentStale.map((e: any) => e.id))
        if (!error) archivedCount = agentStale.length
      }

      const lines = [`# KB Health — ${project.name}`, '']
      lines.push(archivedCount
        ? `Auto-archived ${archivedCount} stale AI entr${archivedCount === 1 ? 'y' : 'ies'} (60+ days untouched):`
        : `No stale AI entries to archive.`)
      agentStale.forEach((e: any) => lines.push(`  • [archived] ${e.title} (id: ${e.id})`))
      lines.push('')
      if (userStale.length) {
        lines.push(`${userStale.length} of YOUR entries look stale (60+ days untouched). These were NOT archived — confirm each with the user before calling archive_kb_entry:`)
        userStale.forEach((e: any) => lines.push(`  • ${e.title} (id: ${e.id}, updated ${e.updated_at})`))
      } else {
        lines.push(`None of your own entries are stale.`)
      }
      return lines.join('\n')
    }

    case 'archive_kb_entry': {
      const restore = args.restore === true
      const { data, error } = await sb.from('project_knowledge')
        .update({ archived_at: restore ? null : new Date().toISOString() })
        .eq('id', args.entry_id)
        .eq('user_id', userId)
        .select()
        .maybeSingle()
      if (error) throw new Error(error.message)
      if (!data) return `KB entry "${args.entry_id}" not found.`
      return `${restore ? 'Restored' : 'Archived'} KB entry "${data.title}".`
    }

    case 'update_kb_entry': {
      const fields: any = {}
      if (args.title   !== undefined) fields.title   = args.title
      if (args.content !== undefined) fields.content = args.content
      if (args.category !== undefined) {
        if (args.category !== null && !KB_CATEGORIES.includes(args.category)) return `Invalid category "${args.category}". Allowed: ${KB_CATEGORIES.join(', ')} (or null to clear).`
        fields.category = args.category
      }
      if (!Object.keys(fields).length) return 'No fields to update. Provide title, content, or category.'
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
      const project = await resolveProject(sb, userId, args.project_id, logCtx)
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
      if (args.title     !== undefined) fields.title     = args.title
      if (args.content   !== undefined) fields.content   = args.content
      if (args.universal !== undefined) fields.universal = args.universal === true
      if (!Object.keys(fields).length) return 'No fields to update. Provide title, content, or universal.'
      const { data, error } = await sb.from('project_instructions')
        .update(fields)
        .eq('id', args.entry_id)
        .eq('user_id', userId)
        .select()
        .maybeSingle()
      if (error) throw new Error(error.message)
      if (!data) return `IS entry "${args.entry_id}" not found.`
      return `Updated IS entry "${data.title}".${args.universal !== undefined ? (data.universal ? ' Now universal (applies even inside flows).' : ' No longer universal.') : ''}`
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

    // ── Flow-level Instruction Set (TDE-233) ──
    case 'get_flow_is': {
      const flow = await resolveFlow(sb, userId, args)
      if (!flow) return `Flow not found. Pass flow_id (UUID or name) or a task_id that belongs to the flow.`
      const { data: entries } = await sb.from('flow_instructions').select('id, title, content').eq('flow_id', flow.id).order('created_at')
      if (!entries?.length) return `No flow IS defined for "${flow.name}". Tasks in this flow fall back to the project IS.`
      return [`# Flow Instruction Set — ${flow.name}`, '', ...entries.map((e: any) => `## ${e.title}  (id: ${e.id})\n\n${e.content}`)].join('\n\n---\n\n')
    }
    case 'list_flow_is_entries': {
      const flow = await resolveFlow(sb, userId, args)
      if (!flow) return `Flow not found. Pass flow_id or a task_id in the flow.`
      const { data } = await sb.from('flow_instructions').select('id, title, updated_at').eq('flow_id', flow.id).order('created_at')
      if (!data?.length) return `No flow IS entries for "${flow.name}".`
      return data.map((e: any) => `[id: ${e.id}] ${e.title}  (updated ${e.updated_at})`).join('\n')
    }
    case 'create_flow_is_entry': {
      const flow = await resolveFlow(sb, userId, args)
      if (!flow) return `Flow not found. Pass flow_id or a task_id in the flow.`
      const { data, error } = await sb.from('flow_instructions').insert({ flow_id: flow.id, user_id: userId, title: args.title, content: args.content }).select().single()
      if (error) throw new Error(error.message)
      return `Created flow IS entry "${data.title}" on flow "${flow.name}". Flow IS now governs this flow's tasks (replacing the project's non-universal IS).`
    }
    case 'update_flow_is_entry': {
      const fields: any = {}
      if (args.title   !== undefined) fields.title   = args.title
      if (args.content !== undefined) fields.content = args.content
      if (!Object.keys(fields).length) return 'No fields to update. Provide title or content.'
      const { data, error } = await sb.from('flow_instructions').update(fields).eq('id', args.entry_id).eq('user_id', userId).select().maybeSingle()
      if (error) throw new Error(error.message)
      if (!data) return `Flow IS entry "${args.entry_id}" not found.`
      return `Updated flow IS entry "${data.title}".`
    }
    case 'delete_flow_is_entry': {
      const { data, error } = await sb.from('flow_instructions').delete().eq('id', args.entry_id).eq('user_id', userId).select().maybeSingle()
      if (error) throw new Error(error.message)
      if (!data) return `Flow IS entry "${args.entry_id}" not found.`
      return `Deleted flow IS entry "${data.title}".`
    }

    // ── Flow-level Knowledge Base (TDE-233) ──
    case 'get_flow_kb': {
      const flow = await resolveFlow(sb, userId, args)
      if (!flow) return `Flow not found. Pass flow_id (UUID or name) or a task_id that belongs to the flow.`
      const { data: entries } = await sb.from('flow_knowledge').select('id, title, content').eq('flow_id', flow.id).order('created_at')
      if (!entries?.length) return `No flow KB entries for "${flow.name}".`
      return [`# Flow Knowledge Base — ${flow.name}`, '', ...entries.map((e: any) => `## ${e.title}  (id: ${e.id})\n\n${e.content}`)].join('\n\n---\n\n')
    }
    case 'list_flow_kb_entries': {
      const flow = await resolveFlow(sb, userId, args)
      if (!flow) return `Flow not found. Pass flow_id or a task_id in the flow.`
      const { data } = await sb.from('flow_knowledge').select('id, title, updated_at').eq('flow_id', flow.id).order('created_at')
      if (!data?.length) return `No flow KB entries for "${flow.name}".`
      return data.map((e: any) => `[id: ${e.id}] ${e.title}  (updated ${e.updated_at})`).join('\n')
    }
    case 'create_flow_kb_entry': {
      const flow = await resolveFlow(sb, userId, args)
      if (!flow) return `Flow not found. Pass flow_id or a task_id in the flow.`
      const { data, error } = await sb.from('flow_knowledge').insert({ flow_id: flow.id, user_id: userId, title: args.title, content: args.content }).select().single()
      if (error) throw new Error(error.message)
      return `Created flow KB entry "${data.title}" on flow "${flow.name}". It auto-loads on every task in this flow.`
    }
    case 'update_flow_kb_entry': {
      const fields: any = {}
      if (args.title   !== undefined) fields.title   = args.title
      if (args.content !== undefined) fields.content = args.content
      if (!Object.keys(fields).length) return 'No fields to update. Provide title or content.'
      const { data, error } = await sb.from('flow_knowledge').update(fields).eq('id', args.entry_id).eq('user_id', userId).select().maybeSingle()
      if (error) throw new Error(error.message)
      if (!data) return `Flow KB entry "${args.entry_id}" not found.`
      return `Updated flow KB entry "${data.title}".`
    }
    case 'delete_flow_kb_entry': {
      const { data, error } = await sb.from('flow_knowledge').delete().eq('id', args.entry_id).eq('user_id', userId).select().maybeSingle()
      if (error) throw new Error(error.message)
      if (!data) return `Flow KB entry "${args.entry_id}" not found.`
      return `Deleted flow KB entry "${data.title}".`
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
      return `Connected GitHub account: ${ghUser.login}${ghUser.name ? ` (${ghUser.name})` : ''}. You can now use github_list_repos, github_import_project, github_sync_issues, push changes back with github_push_task / github_push_project, and commit flow artifacts to the repo with github_push_file / github_read_file.`
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

      const project = await resolveProject(sb, userId, args.project_id, logCtx)
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
      const project = await resolveProject(sb, userId, args.project_id, logCtx)
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

    case 'github_push_file': {
      const ghToken = await loadGitHubToken(sb, userId)
      if (!ghToken) return 'No GitHub account connected. Use github_connect first.'

      // Resolve repo — explicit arg or fall back to the task's project repo
      let repo: string | null = args.repo || null
      if (!repo && args.task_id) {
        const task = await resolveTask(sb, userId, args.task_id)
        if (task) {
          const { data: proj } = await sb.from('projects').select('github_repo').eq('id', task.project_id).maybeSingle()
          repo = proj?.github_repo || null
        }
      }
      if (!repo) return 'No repo specified and no linked repo found. Pass repo: "owner/name" or supply a task_id whose project has a linked repo.'

      const path: string = args.path
      const content: string = args.content
      const message: string = args.message || 'chore: store Tasker artifact'

      // Check if file already exists (need SHA for updates)
      let sha: string | undefined
      try {
        const existing = await githubFetch(ghToken, `/repos/${repo}/contents/${path}`)
        sha = existing.sha
      } catch (_) { /* file doesn't exist yet, that's fine */ }

      const body: any = { message, content: btoa(unescape(encodeURIComponent(content))) }
      if (sha) body.sha = sha

      await githubFetch(ghToken, `/repos/${repo}/contents/${path}`, {
        method: 'PUT',
        body: JSON.stringify(body),
      })

      return `${sha ? 'Updated' : 'Created'} file "${path}" in ${repo}.`
    }

    case 'github_read_file': {
      const ghToken = await loadGitHubToken(sb, userId)
      if (!ghToken) return 'No GitHub account connected. Use github_connect first.'

      let repo: string | null = args.repo || null
      if (!repo && args.task_id) {
        const task = await resolveTask(sb, userId, args.task_id)
        if (task) {
          const { data: proj } = await sb.from('projects').select('github_repo').eq('id', task.project_id).maybeSingle()
          repo = proj?.github_repo || null
        }
      }
      if (!repo) return 'No repo specified and no linked repo found. Pass repo: "owner/name" or supply a task_id whose project has a linked repo.'

      const file = await githubFetch(ghToken, `/repos/${repo}/contents/${args.path}`)
      if (!file.content) return `File "${args.path}" found but has no readable content (may be a binary or large file).`
      const decoded = decodeURIComponent(escape(atob(file.content.replace(/\n/g, ''))))
      return `File: ${args.path}\nRepo: ${repo}\nSize: ${file.size} bytes\n\n---\n\n${decoded}`
    }

    case '__init_tasker_session': {
      const { data: settings } = await sb.from('user_settings').select('ai_instructions').eq('user_id', userId).maybeSingle()
      const instructions = settings?.ai_instructions
      const { show_questionnaire } = args

      if (instructions && !show_questionnaire) {
        const settings_summary = {
          task_list_format: instructions.task_list_format === 'plain_text' ? 'plain text' :
                            instructions.task_list_format === 'markdown_table' ? 'markdown table' : 'numbered list',
          show_completed_tasks: instructions.show_completed_tasks ? 'shown' : 'hidden',
          rank_tasks_by: instructions.rank_tasks_by === 'sorting_order' ? 'sorting order' : 'task priority',
          communication_style: instructions.communication_style,
          multiple_tasks_handling: instructions.multiple_tasks_handling,
          show_project_context: instructions.show_project_context ? 'shown' : 'hidden',
        }
        return JSON.stringify({
          status: 'ready',
          instructions,
          settings_summary,
          presentation: 'Begin your FIRST response of this session with exactly ONE compact line summarizing the current settings (from settings_summary), ending with — say "change settings" to adjust. Put this line at the very TOP, before anything else, then immediately carry on with whatever the user asked for. Format it as a single line, e.g.: `⚙ Tasker: plain-text lists · done hidden · sorting order · detailed · collaborative — say "change settings" to adjust`. Do NOT put it at the bottom, do NOT use multiple bullets, and do NOT render the questionnaire. Only show this once, on the first response. When the user later asks to change/review settings, call __init_tasker_session again with show_questionnaire: true to get the review questionnaire with their current choices marked.',
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
      const project = await resolveProject(sb, userId, args.project_id, logCtx)
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
      const project = await resolveProject(sb, userId, args.project_id, logCtx)
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

      // Count affected rows via the returned data length — the `count` field on a
      // chained update/delete select is unreliable here and reports 0 even on success.
      let result = ''
      if (args.delete_tasks) {
        const { data, error } = await sb.from('tasks').delete().eq('group_id', group.id).select('id')
        if (error) throw new Error(error.message)
        const n = data?.length ?? 0
        result = `Deleted group "${group.name}". ${n} task${n !== 1 ? 's' : ''} deleted.`
      } else {
        const { data, error } = await sb.from('tasks').update({ group_id: null }).eq('group_id', group.id).select('id')
        if (error) throw new Error(error.message)
        const n = data?.length ?? 0
        result = `Deleted group "${group.name}". ${n} task${n !== 1 ? 's' : ''} moved to ungrouped.`
      }

      const { error } = await sb.from('groups').delete().eq('id', group.id)
      if (error) throw new Error(error.message)

      return result
    }

    case 'move_task_to_group': {
      const task = await resolveTask(sb, userId, args.task_id)
      if (!task) return `Task "${args.task_id}" not found.`

      // Treat empty string / "null" as a request to ungroup, not an invalid uuid.
      const targetGroup = (args.group_id == null || args.group_id === '' || args.group_id === 'null') ? null : args.group_id
      const updates: any = { group_id: targetGroup }
      if (args.section_id) updates.section_id = args.section_id

      const { error } = await sb.from('tasks').update(updates).eq('id', task.id)
      if (error) throw new Error(error.message)

      if (targetGroup) {
        const { data: group } = await sb.from('groups').select('name').eq('id', targetGroup).single()
        return `Moved task ${task.prefix ? `${task.prefix}-${task.short_id}` : task.id} to group "${group?.name ?? 'Unknown'}"`
      } else {
        return `Moved task ${task.prefix ? `${task.prefix}-${task.short_id}` : task.id} to ungrouped`
      }
    }

    case 'analyze_section': {
      const project = await resolveProject(sb, userId, args.project_id, logCtx)
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
      const project = await resolveProject(sb, userId, args.project_id, logCtx)
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

    case 'get_flow_audit': {
      const task = await resolveTask(sb, userId, args.task_id)
      if (!task) return `Task "${args.task_id}" not found.`

      // Get project + flow info
      const { data: taskFull } = await sb.from('tasks')
        .select('id, project_id, project:projects(id, name, prefix)')
        .eq('id', task.id).eq('user_id', userId).maybeSingle()
      if (!taskFull) return 'Task not found.'

      const project = taskFull.project
      const projectId = taskFull.project_id

      let flowName: string | null = null
      let flowContext: string | null = null
      if (task.flow_id) {
        const { data: flow } = await sb.from('flows').select('name, context').eq('id', task.flow_id).eq('user_id', userId).maybeSingle()
        if (flow) { flowName = flow.name; flowContext = flow.context }
      }

      const { data: allTasks } = await sb.from('tasks')
        .select('id, text, status, short_id, flow_step, input, output, flow_id')
        .eq('project_id', projectId).eq('user_id', userId)
      if (!allTasks?.length) return 'No tasks found.'

      const taskById = new Map(allTasks.map((t: any) => [t.id, t]))

      // Find the component containing this task (flow_id membership or BFS)
      let componentIds: Set<string>
      if (task.flow_id) {
        componentIds = new Set(allTasks.filter((t: any) => t.flow_id === task.flow_id).map((t: any) => t.id))
      } else {
        const adj = new Map(allTasks.map((t: any) => [t.id, new Set<string>()]))
        allTasks.forEach((t: any) => {
          for (const src of inputSourceIds(t.input)) {
            if (adj.has(src)) { adj.get(t.id)!.add(src); adj.get(src)!.add(t.id) }
          }
        })
        componentIds = new Set<string>([task.id])
        const queue = [task.id]
        while (queue.length) {
          const curr = queue.shift()!
          for (const nb of (adj.get(curr) || [])) {
            if (!componentIds.has(nb)) { componentIds.add(nb); queue.push(nb) }
          }
        }
      }

      // Sort: persistent flow_step if available, else topo-sort
      const componentTasks = [...componentIds].map(id => taskById.get(id)).filter(Boolean)
      const hasFlowSteps = componentTasks.some((t: any) => t.flow_step != null)
      let sorted: any[]
      if (hasFlowSteps) {
        sorted = componentTasks.sort((a: any, b: any) => (a.flow_step ?? 999) - (b.flow_step ?? 999))
      } else {
        const depths = new Map<string, number>()
        const auditDepth = (id: string, stack = new Set<string>()): number => {
          if (depths.has(id)) return depths.get(id)!
          if (stack.has(id)) return 0
          stack.add(id)
          const srcs = inputSourceIds(taskById.get(id)?.input).filter((s: string) => taskById.has(s))
          const d = srcs.length ? Math.max(...srcs.map((s: string) => auditDepth(s, stack) + 1)) : 0
          depths.set(id, d); return d
        }
        componentTasks.forEach((t: any) => auditDepth(t.id))
        sorted = componentTasks.sort((a: any, b: any) => (depths.get(a.id) ?? 0) - (depths.get(b.id) ?? 0))
      }

      const prefix = project?.prefix || ''
      const taskRef = (t: any) => prefix && t.short_id != null ? `${prefix}-${t.short_id}` : `#${t.short_id ?? t.id.slice(0, 8)}`
      const auditStepLabel = (t: any, i: number) => t.flow_step != null ? `Step ${t.flow_step} · ${taskRef(t)}` : `Step ${i + 1} · ${taskRef(t)}`
      const statusIcon = (s: string) => s === 'done' ? '✓' : s === 'in_progress' ? '▶' : '○'
      const SEP = '─'.repeat(56)

      const lines: string[] = [
        `Audit Trail — ${flowName ? `"${flowName}"` : `${project?.name || projectId} (unnamed flow)`}`,
        ...(flowContext ? [`Context: ${flowContext}`] : []),
        '',
      ]

      let totalValidated = 0, totalPass = 0, totalFail = 0, totalRetries = 0, totalBlocked = 0, totalProvisional = 0

      sorted.forEach((t: any, i: number) => {
        lines.push(SEP)
        lines.push(`${auditStepLabel(t, i)}  ${statusIcon(t.status)}  — ${t.text}`)
        const ledgers = t.output?.validation_ledgers

        if (!ledgers || !Object.keys(ledgers).length) {
          lines.push(t.output?.ledger?.length ? '  [legacy ledger — re-validate to upgrade]' : '  No validation recorded.')
        } else {
          Object.entries(ledgers).forEach(([edgeKey, edgeLedger]: [string, any]) => {
            totalValidated++
            const consumerTask = edgeKey !== 'self' ? taskById.get(edgeKey) : null
            const gateLabel = consumerTask ? `→ ${taskRef(consumerTask)} "${consumerTask.text.slice(0, 40)}${consumerTask.text.length > 40 ? '…' : ''}"` : 'Self-check'
            const vstatus = edgeLedger.validation_status || 'unknown'
            if (vstatus === 'valid') totalPass++; else totalFail++
            const retries = edgeLedger.retry_count || 0
            if (retries > 0) totalRetries += retries
            if (edgeLedger.retry_blocked) totalBlocked++

            const validators = [...new Set((edgeLedger.ledger || []).map((l: any) => l.validator).filter(Boolean))]
            const validatorStr = validators.length ? validators.join(', ') : 'unverified'
            const allBlessed = (edgeLedger.ledger || []).every((l: any) => l.contract_blessed !== false)
            if (!allBlessed) totalProvisional++

            lines.push('')
            lines.push(`  Gate: ${gateLabel}`)
            lines.push(`  Status: ${vstatus.toUpperCase()} | Validator: ${validatorStr} | Contract: ${allBlessed ? 'confirmed' : 'AI-QA\'d'}`)
            if (edgeLedger.validated_at) lines.push(`  At: ${edgeLedger.validated_at}`)
            if (retries > 0) lines.push(`  Retries: ${retries}${edgeLedger.retry_blocked ? ' (limit reached)' : ''}`)
            lines.push('')
            ;(edgeLedger.ledger || []).forEach((l: any) => {
              const ev = l.evidence_quality ? ` [${l.evidence_quality} evidence]` : ''
              lines.push(`  ${l.status === 'pass' ? '✓' : '✗'} [${l.source === 'input' ? 'gate' : 'self'} · ${l.severity} · ${l.kind}] ${l.label}${ev}`)
              if (l.note) lines.push(`      ↳ ${l.note}`)
            })
          })
        }
        lines.push('')
      })

      lines.push(SEP)
      lines.push(`Summary: ${sorted.length} tasks | ${totalValidated} edges validated | ${totalPass} pass | ${totalFail} fail | ${totalRetries} retries | ${totalBlocked} human-blocked | ${totalProvisional} AI-QA'd contract${totalProvisional !== 1 ? 's' : ''}`)
      return lines.join('\n')
    }

    case 'list_flows': {
      const project = await resolveProject(sb, userId, args.project_id, logCtx)
      if (!project) return `Project "${args.project_id}" not found.`
      const { data: flows } = await sb.from('flows')
        .select('id, name, short_id, created_at')
        .eq('project_id', project.id)
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
      if (!flows?.length) return `No named flows in project "${project.name}". Use name_flow to name a flow, or build_new_flow to create one.`
      // For each flow, fetch task stats
      const lines = [`Flows in ${project.name} (${project.prefix || project.slug}):\n`]
      for (const flow of flows) {
        const { data: tasks } = await sb.from('tasks')
          .select('id, status, flow_step, short_id, text, project:projects(prefix)')
          .eq('flow_id', flow.id)
          .eq('user_id', userId)
          .order('flow_step', { ascending: true })
        const ts = tasks || []
        const total = ts.length
        const done = ts.filter((t: any) => t.status === 'done').length
        const inProg = ts.filter((t: any) => t.status === 'in_progress').length
        const overall = done === total && total > 0 ? 'done' : inProg > 0 || done > 0 ? 'in_progress' : 'pending'
        lines.push(flow.short_id ? `${flow.name}  [${flow.short_id}]` : flow.name)
        lines.push(`  id: ${flow.id}`)
        lines.push(`  steps: ${total} · ${done}/${total} done · ${overall}`)
        if (ts.length) {
          const stepLines = ts.map((t: any) => {
            const ref = t.project?.prefix && t.short_id != null ? `${t.project.prefix}-${t.short_id}` : t.id
            return `    Step ${t.flow_step ?? '?'} · ${ref} — ${t.text} [${t.status}]`
          })
          lines.push(...stepLines)
        }
        lines.push('')
      }
      return lines.join('\n')
    }

    case 'get_flow_order': {
      const project = await resolveProject(sb, userId, args.project_id, logCtx)
      if (!project) return `Project "${args.project_id}" not found.`

      const { data: tasks } = await sb.from('tasks')
        .select('id, text, status, priority, short_id, flow_step, input, sort_order, section_id, flow_id')
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

      // Topological sort within a flow (prefers flow_step, falls back to graph depth)
      function topoSort(component: Set<string>): any[] {
        const flowTasks = [...component].map(id => taskById.get(id)).filter(Boolean)
        if (flowTasks.some((t: any) => t.flow_step != null)) {
          return flowTasks.sort((a: any, b: any) => (a.flow_step ?? 999) - (b.flow_step ?? 999))
        }
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
      const orderStepLabel = (t: any, i: number) => t.flow_step != null ? `Step ${t.flow_step} · ${taskLabel(t)}` : `Step ${i + 1} · ${taskLabel(t)}`

      // Look up named flows for any tasks that have flow_id set
      const flowIds = [...new Set((tasks || []).map((t: any) => t.flow_id).filter(Boolean))]
      const flowNameMap = new Map<string, string>()
      const flowContextMap = new Map<string, string>()
      if (flowIds.length) {
        const { data: namedFlows } = await sb.from('flows').select('id, name, context').in('id', flowIds).eq('user_id', userId)
        ;(namedFlows || []).forEach((f: any) => {
          flowNameMap.set(f.id, f.name)
          if (f.context) flowContextMap.set(f.id, f.context)
        })
      }

      const lines: string[] = [`Flow Execution Order — ${project.name} (${project.prefix})`, ``]

      targetFlows.forEach((component, fi) => {
        const sorted = topoSort(component)
        const namedFlowId = sorted.find((t: any) => t.flow_id)?.flow_id
        const flowName = namedFlowId ? flowNameMap.get(namedFlowId) : null
        const flowContext = namedFlowId ? flowContextMap.get(namedFlowId) : null
        if (targetFlows.length > 1) {
          const label = flowName || `"${sorted[0]?.text?.split(' ').slice(0, 5).join(' ')}${sorted[0]?.text?.split(' ').length > 5 ? '…' : ''}"`
          lines.push(`### Flow ${fi + 1}: ${flowName ? `"${flowName}"` : label}`)
          if (flowContext) lines.push(`Context: ${flowContext}`)
        } else if (flowName) {
          lines[0] = `Flow: "${flowName}" — ${project.name} (${project.prefix})`
          if (flowContext) lines.push(`Context: ${flowContext}`, ``)
        }
        sorted.forEach((task: any, i: number) => {
          const srcLabels = inputSourceIds(task.input)
            .map((sid: string) => taskById.get(sid)).filter(Boolean).map((s: any) => taskLabel(s))
          const dep = srcLabels.length ? ` ← ${srcLabels.join(', ')}` : ''
          const prio = task.priority ? ` [${task.priority}]` : ''
          lines.push(`${orderStepLabel(task, i)}  ${statusIcon(task.status)}  — ${task.text}${prio}${dep}`)
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

    case 'run_flow': {
      // Resolve the flow — either directly by flow_id, or by finding the connected component a task belongs to.
      let flowRecord: any = null
      let flowTasks: any[] = []

      if (args.flow_id) {
        // Accept UUID or name (partial, case-insensitive)
        const looksLikeUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(args.flow_id)
        let flow: any = null
        if (looksLikeUuid) {
          const { data } = await sb.from('flows').select('id, name, short_id, context, project_id').eq('id', args.flow_id).eq('user_id', userId).maybeSingle()
          flow = data
        } else {
          // Name lookup — optionally scoped to a project
          let q = sb.from('flows').select('id, name, short_id, context, project_id').eq('user_id', userId).ilike('name', `%${args.flow_id}%`)
          if (args.project_id) {
            const p = await resolveProject(sb, userId, args.project_id)
            if (p) q = q.eq('project_id', p.id)
          }
          const { data } = await q.order('created_at', { ascending: false }).limit(5)
          if (data && data.length === 1) { flow = data[0] }
          else if (data && data.length > 1) {
            return `Multiple flows match "${args.flow_id}":\n` + data.map((f: any) => `  • ${f.name} (id: ${f.id})`).join('\n') + `\nPass the exact flow id to disambiguate.`
          }
        }
        if (!flow) return `Flow "${args.flow_id}" not found.`
        flowRecord = flow
        const { data: tasks } = await sb.from('tasks')
          .select('id, text, status, priority, short_id, flow_step, input, output, sort_order, project_id, project:projects(name, prefix)')
          .eq('flow_id', flow.id).eq('user_id', userId)
        flowTasks = tasks || []
      } else if (args.task_id) {
        const anchor = await resolveTask(sb, userId, args.task_id)
        if (!anchor) return `Task "${args.task_id}" not found.`

        // If the anchor has a flow_id, fetch the whole named flow
        if (anchor.flow_id) {
          const { data: flow } = await sb.from('flows').select('id, name, short_id, context, project_id').eq('id', anchor.flow_id).eq('user_id', userId).maybeSingle()
          flowRecord = flow || null
          const { data: tasks } = await sb.from('tasks')
            .select('id, text, status, priority, short_id, flow_step, input, output, sort_order, project_id, project:projects(name, prefix)')
            .eq('flow_id', anchor.flow_id).eq('user_id', userId)
          flowTasks = tasks || []
        } else {
          // BFS over the I/O graph to find the connected component
          const project = args.project_id
            ? await resolveProject(sb, userId, args.project_id)
            : null
          const projectId = project?.id || (await sb.from('tasks').select('project_id').eq('id', anchor.id).maybeSingle()).data?.project_id
          if (!projectId) return `Could not determine project for task "${args.task_id}". Pass project_id.`

          const { data: allTasks } = await sb.from('tasks')
            .select('id, text, status, priority, short_id, flow_step, input, output, sort_order, project_id, project:projects(name, prefix)')
            .eq('project_id', projectId).eq('user_id', userId)
          const all = allTasks || []
          const taskById = new Map(all.map((t: any) => [t.id, t]))

          const adj = new Map(all.map((t: any) => [t.id, new Set<string>()]))
          all.forEach((t: any) => {
            for (const src of inputSourceIds(t.input)) {
              if (adj.has(src)) { adj.get(t.id)!.add(src); adj.get(src)!.add(t.id) }
            }
          })

          const component = new Set<string>()
          const queue = [anchor.id]
          const visited = new Set([anchor.id])
          while (queue.length) {
            const curr = queue.shift()!
            component.add(curr)
            for (const nb of (adj.get(curr) || [])) {
              if (!visited.has(nb)) { visited.add(nb); queue.push(nb) }
            }
          }
          if (component.size <= 1) return `Task "${anchor.text}" has no I/O connections — not part of a flow. Use set_task_input / set_task_output to link tasks into a flow, or call build_new_flow to design one.`
          flowTasks = [...component].map((id: string) => taskById.get(id)).filter(Boolean)
        }
      } else {
        return 'Provide either flow_id or task_id to identify the flow.'
      }

      if (!flowTasks.length) return 'No tasks found in this flow.'

      // Sort: use persistent flow_step if available, fall back to topo-sort
      const hasSteps = flowTasks.some((t: any) => t.flow_step != null)
      let sorted: any[]
      if (hasSteps) {
        sorted = [...flowTasks].sort((a: any, b: any) => (a.flow_step ?? 999) - (b.flow_step ?? 999))
      } else {
        const taskById2 = new Map(flowTasks.map((t: any) => [t.id, t]))
        const depths2 = new Map<string, number>()
        function depth2(id: string, stack = new Set<string>()): number {
          if (depths2.has(id)) return depths2.get(id)!
          if (stack.has(id)) return 0
          stack.add(id)
          const srcs = inputSourceIds(taskById2.get(id)?.input).filter((s: string) => taskById2.has(s))
          const d = srcs.length ? Math.max(...srcs.map((s: string) => depth2(s, stack) + 1)) : 0
          depths2.set(id, d)
          return d
        }
        flowTasks.forEach((t: any) => depth2(t.id))
        sorted = [...flowTasks].sort((a: any, b: any) => {
          const da = depths2.get(a.id) ?? 0
          const db = depths2.get(b.id) ?? 0
          return da !== db ? da - db : (a.sort_order ?? 0) - (b.sort_order ?? 0)
        })
      }

      const prefix = sorted[0]?.project?.prefix || ''
      const taskById = new Map(sorted.map((t: any) => [t.id, t]))
      const taskRef = (t: any) => prefix && t.short_id != null ? `${prefix}-${t.short_id}` : `#${t.short_id ?? t.id.slice(0, 8)}`
      // Primary label: "Step N · TDE-103" when step is known, else just "TDE-103"
      const stepLabel = (t: any, i: number) => {
        const step = t.flow_step ?? (i + 1)
        return `Step ${step} · ${taskRef(t)}`
      }
      const statusIcon = (s: string) => s === 'done' ? '✓' : s === 'in_progress' ? '▶' : '○'

      const completedCount = sorted.filter((t: any) => t.status === 'done').length
      const pendingFrom = sorted.findIndex((t: any) => t.status !== 'done')
      const allDone = completedCount === sorted.length

      const lines: string[] = []
      lines.push(flowRecord ? `Flow: "${flowRecord.name}"${flowRecord.short_id ? `  [${flowRecord.short_id}]` : ''}` : `Flow (unnamed — call name_flow to register it)`)
      if (flowRecord?.context) lines.push(`Context: ${flowRecord.context}`)
      lines.push(`Progress: ${completedCount}/${sorted.length} steps complete`)
      if (allDone) {
        lines.push(`\nStatus: COMPLETE — all steps done.`)
        lines.push(`\nSteps:`)
        sorted.forEach((t: any, i: number) => {
          lines.push(`  ${statusIcon(t.status)}  ${stepLabel(t, i)} — ${t.text}`)
        })
        return lines.join('\n')
      }
      lines.push('')

      // Per-step details
      lines.push('── STEPS ──────────────────────────────────────────')
      sorted.forEach((t: any, i: number) => {
        const isDone = t.status === 'done'
        const isCurrent = i === pendingFrom
        const marker = isDone ? '✓ DONE' : isCurrent ? '▶ NEXT' : '○ WAITING'
        lines.push(``)
        lines.push(`${stepLabel(t, i)}  [${marker}]  — ${t.text}`)

        // Incoming gate contracts (what this task demands from its producers)
        const edges = inputEdges(t.input)
        if (edges.length) {
          edges.forEach((e: any) => {
            const src = taskById.get(e.source_task_id)
            const srcLabel = src ? `${stepLabel(src, sorted.indexOf(src))} "${src.text.slice(0, 35)}${src.text.length > 35 ? '…' : ''}"` : e.source_task_id.slice(0, 8)
            lines.push(`  Requires output from: ${srcLabel}`)
            const gateRules = e.contract?.rules || []
            if (gateRules.length) {
              const blessed = e.contract?.confirmed ? 'confirmed' : 'AI-QA\'d'
              lines.push(`  Gate contract [${blessed}]:`)
              gateRules.forEach((r: any) => {
                lines.push(`    [${r.severity} · ${r.kind}] ${r.label}: ${r.rule}`)
              })
            }
          })
        }

        // Output contract (what this task must produce)
        const outContract = outputContract(t.output)
        if (outContract.rules.length) {
          const blessed = outContract.confirmed ? 'confirmed' : 'AI-QA\'d'
          lines.push(`  Output contract [${blessed}]:`)
          outContract.rules.forEach((r: any) => {
            lines.push(`    [${r.severity} · ${r.kind}] ${r.label}: ${r.rule}`)
          })
        }

        // Validation status if already run
        const vs = t.output?.validation_status
        if (vs) {
          lines.push(`  Last validation: ${vs.toUpperCase()}${t.output?.validated_at ? ` at ${t.output.validated_at}` : ''}`)
        }
      })

      lines.push('')
      lines.push('── EXECUTION PROTOCOL ─────────────────────────────')
      lines.push(`Resume at ${stepLabel(sorted[pendingFrom], pendingFrom)}: "${sorted[pendingFrom].text}"`)
      lines.push('')
      lines.push('For each step:')
      lines.push('  1. Call get_task(task_id) — sets it in_progress automatically.')
      lines.push('  2. Do the work. Produce the artifact.')
      lines.push('  3. Call store_artifact(task_id, verbatim_content) — REQUIRED before completing if judgment output rules exist.')
      lines.push('  4. Call complete_task(task_id).')
      lines.push('  5. Validate the output:')
      lines.push('       A. Check-only rules → call submit_validation_result directly (skip validate_output).')
      lines.push('       B. Judgment rules → call validate_output to get validator_agent_prompt, then spawn a fresh')
      lines.push('          adversarial validator subagent via the Agent tool passing that prompt unmodified.')
      lines.push('  6. On action=pass → proceed to the next step.')
      lines.push('     On action=regenerate → redo this step, re-validate. Max 3 attempts.')
      lines.push('     On action=ask_human → call get_task_critique, then use AskUserQuestion to present to the human.')
      lines.push('  7. Repeat until all steps are done.')
      lines.push('')
      lines.push('Rules:')
      lines.push('  • Do NOT skip a gate — every step with a gate contract MUST be validated before the next step runs.')
      lines.push('  • The validator subagent starts from a FAIL prior — it needs concrete evidence in the artifact to flip to pass.')
      lines.push('  • If a task has no output contract, complete it and move on (no validation needed).')

      return lines.join('\n')
    }

    case 'build_new_flow': {
      const project = await resolveProject(sb, userId, args.project_id, logCtx)
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
          '4. AUTHOR A CONTRACT PER HANDOFF: for each task propose an output contract (its definition-of-done) and the next task\'s input contract (its acceptance criteria) as structured, CONTEXT-FREE rules — describe the shape of acceptable output, never this run\'s subject. Only make a step its own task if it produces a distinct, checkable output a later step depends on (a contract-worthy handoff); otherwise it is a sub-detail of a task, not its own task. RULE QUALITY: push toward sharp, checkable rules. Prefer kind=check with concrete params (word count, test command, file existence). For kind=judgment, require an objective criterion ("each sentence under 25 words" not "readable") and a stated way to verify it. Actively push back on vague rules like "good quality", "clear", "comprehensive" — ask the user what SPECIFICALLY makes it pass.',
          '5. PRESENT THE WHOLE PROPOSED FLOW (tasks + dependency edges + contracts) and ask for ONE confirmation.',
          '6. ON CONFIRM, PERSIST (see persistence).',
        ],
        persistence: {
          when: 'ONLY after the user confirms the whole flow.',
          steps: [
            'create_task for each step (pass section_id from project_context if it belongs in an existing section).',
            'set_task_output(task_id, contract) on each producing task — its definition-of-done.',
            'set_task_input(task_id, source_task_id, contract) on each consuming task — call once per upstream source (fan-in supported). The input contract is the consumer\'s acceptance criteria for that incoming artifact.',
            'name_flow(project_id, name, task_ids, context?) — give the flow a human name and optional shared context bag (goals, constraints, background). Pass ALL task IDs in the flow.',
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
        contract: { rules, confirmed: false },
      }

      // Upsert this source's edge (replace=true wipes all others). Supports fan-in.
      let edges = args.replace ? [] : inputEdges(task.input)
      edges = edges.filter((e: any) => e.source_task_id !== source.id && e.source_task_id !== args.source_task_id)
      edges.push(edge)

      const { error } = await sb.from('tasks').update({ input: { edges } }).eq('id', task.id)
      if (error) throw new Error(error.message)

      // Auto-recompute flow_step if either task belongs to a named flow.
      const flowId = task.flow_id || source.flow_id || null
      let recomputeNote = ''
      if (flowId) {
        const { data: flowMembers } = await sb.from('tasks')
          .select('id, text, short_id, input')
          .eq('flow_id', flowId).eq('user_id', userId)
        if (flowMembers?.length) {
          // Fetch the freshly updated task so inputSourceIds sees the new edge
          const { data: freshTask } = await sb.from('tasks').select('id, input').eq('id', task.id).single()
          const memberMap = new Map(flowMembers.map((t: any) => [t.id, t]))
          if (freshTask) memberMap.set(task.id, freshTask)
          const memberArr = [...memberMap.values()]
          const rdepths = new Map<string, number>()
          function rdepth(id: string, stack = new Set<string>()): number {
            if (rdepths.has(id)) return rdepths.get(id)!
            if (stack.has(id)) return 0
            stack.add(id)
            const srcs = inputSourceIds(memberMap.get(id)?.input).filter((s: string) => memberMap.has(s))
            const d = srcs.length ? Math.max(...srcs.map((s: string) => rdepth(s, stack) + 1)) : 0
            rdepths.set(id, d)
            return d
          }
          memberArr.forEach((t: any) => rdepth(t.id))
          const rsorted = [...memberArr].sort((a: any, b: any) => (rdepths.get(a.id) ?? 0) - (rdepths.get(b.id) ?? 0))
          await Promise.all(rsorted.map((t: any, i: number) =>
            sb.from('tasks').update({ flow_step: i + 1 }).eq('id', t.id)
          ))
          recomputeNote = ` Step order auto-recomputed (${rsorted.length} tasks renumbered).`
        }
      }

      const lintWarnings = rules.map((r: any) => { const w = lintRule(r); return w ? `  "${r.label}": ${w}` : null }).filter(Boolean)
      return `Set input edge on ${args.task_id}: consumes ${args.source_task_id}` +
        (rules.length ? ` with ${rules.length} contract rule${rules.length !== 1 ? 's' : ''} (AI-QA'd — QA is performed by AI, not a meat sack. confirm_contract to have a human bless it)` : ' (no contract rules yet)') +
        `. Total input edges: ${edges.length}.${recomputeNote}`
        + (lintWarnings.length ? `\n\n⚠ Rule quality warnings (${lintWarnings.length}):\n${lintWarnings.join('\n')}\nPrefer kind=check with concrete params. For kind=judgment, specify an objective criterion + a stated way to verify it.` : '')
    }

    case 'set_task_output': {
      const task = await resolveTask(sb, userId, args.task_id)
      if (!task) return `Task "${args.task_id}" not found.`

      const rules = (args.contract?.rules || []).map(normalizeRule)
      const prev = (task.output && typeof task.output === 'object') ? task.output : {}
      const output = {
        ...prev,
        contract: { rules, confirmed: false },
        validation_status: prev.validation_status || 'pending',
      }

      const { error } = await sb.from('tasks').update({ output }).eq('id', task.id)
      if (error) throw new Error(error.message)

      const lintWarnings = rules.map((r: any) => { const w = lintRule(r); return w ? `  "${r.label}": ${w}` : null }).filter(Boolean)
      return `Set output contract on ${args.task_id}: ${rules.length} rule${rules.length !== 1 ? 's' : ''} (definition-of-done). Contract is AI-QA'd (QA is performed by AI, not a meat sack) until a human confirms it via confirm_contract. Consumers are derived from tasks that list this as a source.`
        + (lintWarnings.length ? `\n\n⚠ Rule quality warnings (${lintWarnings.length}):\n${lintWarnings.join('\n')}\nPrefer kind=check with concrete params. For kind=judgment, specify an objective criterion + a stated way to verify it.` : '')
    }

    case 'enable_task_review': {
      const task = await resolveTask(sb, userId, args.task_id)
      if (!task) return `Task "${args.task_id}" not found.`
      // HARD RULE (TDE-261): task-level review applies ONLY to non-flow tasks.
      if (isFlowTask(task)) return `"${task.text}" is part of a flow — task-level review does not apply (the flow's gates govern its quality). Mutual exclusivity (TDE-261).`

      const existing = task.review_bar
      // Mode 2: a bar was supplied → freeze it as the review snapshot.
      if (args.bar?.rules) {
        if (existing?.rules?.length && !args.force) {
          return `"${task.text}" already has a frozen review bar (${existing.rules.length} rule(s), frozen ${existing.frozen_at}). Pass force:true to re-derive and overwrite.`
        }
        const rules = (args.bar.rules || []).map(normalizeRule)
        if (!rules.length) return `The bar must contain at least one rule.`
        const review_bar = { rules, frozen_at: new Date().toISOString(), source: 'task_text+IS+KB' }
        const { error } = await sb.from('tasks').update({ review_bar, review_enabled: true }).eq('id', task.id)
        if (error) throw new Error(error.message)
        const lintWarnings = rules.map((r: any) => { const w = lintRule(r); return w ? `  "${r.label}": ${w}` : null }).filter(Boolean)
        return `Review enabled on "${task.text}" — bar frozen with ${rules.length} rule(s).`
          + (lintWarnings.length ? `\n\n⚠ Rule quality warnings (${lintWarnings.length}):\n${lintWarnings.join('\n')}` : '')
      }

      // Mode 1: no bar → dispenser. Return grounding (task text + IS) for the agent to author the bar.
      if (existing?.rules?.length && !args.force) {
        return `Review already enabled on "${task.text}" — frozen bar has ${existing.rules.length} rule(s) (frozen ${existing.frozen_at}). Pass force:true to re-derive.`
      }
      const { data: projIs } = await sb.from('project_instructions')
        .select('title, content, universal').eq('project_id', task.project_id).order('created_at')
      const isBlock = (projIs || []).map((e: any) => `## ${e.title}${e.universal ? ' (universal)' : ''}\n${e.content}`).join('\n\n')
      // TDE-268 (Phase 2): include a KB TITLES INDEX so the bar can be enriched from
      // relevant KB entries via title-scan → get_kb_entries (selective pull, soft cap + flag).
      const { data: kbTitles } = await sb.from('project_knowledge')
        .select('id, title, source, category').eq('project_id', task.project_id).is('archived_at', null).order('created_at')
      const KB_CAP = 5
      const kbIndex = (kbTitles || []).map((e: any) => `  • [${e.id}]${e.category ? ` {${e.category}}` : ''}${e.source === 'agent' ? ' (ai)' : ''} ${e.title}`).join('\n')
      return [
        `BAR ASSEMBLY (Phase 2) for "${task.text}".`,
        `Assemble the review bar from THREE sources: TASK TEXT + IS + the few RELEVANT KB entries.`,
        ``,
        `── TASK INTENT ──`,
        `# ${task.text}`,
        task.detail || '(no additional context)',
        ``,
        `── GOVERNING INSTRUCTION SET (standards to enforce) ──`,
        isBlock || '(no project IS)',
        ``,
        `── PROJECT KB — TITLES INDEX (${(kbTitles || []).length}) ──`,
        kbIndex || '(no KB entries)',
        `TITLE-SCAN: pick ONLY the entries whose titles are topically relevant to THIS task (aim ≤ ${KB_CAP}). The optional {category} tag is a SOFT hint to prioritise — NOT a filter: still pick a relevant entry even if its category differs from the task's. Then call get_kb_entries(project_id, ids:[...]) to pull the full content of ONLY those and derive rules from them. If MORE than ${KB_CAP} entries look genuinely relevant, do NOT silently drop the extras — FLAG it (list them) so the task can be scoped, then proceed with the top ${KB_CAP}.`,
        ``,
        `── INSTRUCTION ──`,
        `Derive a small set (aim 3–5) of CHECKABLE acceptance rules grounded in the intent + IS + the relevant KB you pulled. Each rule: { label, kind: "check"|"judgment", rule, severity: "blocker"|"warning" }. Prefer kind=check with concrete params; for judgment use an objective, verifiable criterion. Then call enable_task_review again with bar: { rules: [...] } to FREEZE the snapshot.`,
      ].join('\n')
    }

    case 'review_task': {
      const task = await resolveTask(sb, userId, args.task_id)
      if (!task) return `Task "${args.task_id}" not found.`
      if (isFlowTask(task)) return `"${task.text}" is in a flow — use the flow gate (run_flow), not task-level review. Mutual exclusivity (TDE-261).`
      if (!task.review_enabled || !task.review_bar?.rules?.length) return `Review is not enabled on "${task.text}". Call enable_task_review first to assemble + freeze a bar.`
      const artifact = task.output?.artifact
      if (!artifact) return `No artifact stored for "${task.text}". Call store_artifact("${args.task_id}", <verbatim output>) first — the judge grades the stored artifact server-side, not your claims.`
      const rules = task.review_bar.rules
      const checks = rules.filter((r: any) => r.kind === 'check')
      const judgments = rules.filter((r: any) => r.kind === 'judgment')
      const attempt = task.review_verdict?.attempt ?? 0
      return [
        `TASK-LEVEL JUDGE — "${task.text}"  (attempt ${attempt + 1} of 3)`,
        `Grade the STORED ARTIFACT below against the frozen bar. The artifact comes from the server (independence — not your claims).`,
        ``,
        `── FROZEN BAR (${rules.length} rule(s)) ──`,
        ...rules.map((r: any) => `[${r.id}] (${r.kind}, ${r.severity}) ${r.label}: ${r.rule}`),
        ``,
        `── STORED ARTIFACT (${task.output?.artifact_format || 'text'}) ──`,
        String(artifact),
        ``,
        `── PROTOCOL (mirrors store_artifact → validate_output → submit_validation_result) ──`,
        `1. CHECK rules (${checks.length}): run each for real; record observed_value.`,
        `2. JUDGMENT rules (${judgments.length}): spawn a FRESH independent subagent (Agent tool, FAIL prior) with the artifact + each judgment rule. Do NOT grade judgment rules yourself.`,
        `3. Call submit_task_review("${args.task_id}", results, validator:"independent-subagent") — one result per rule (rule_id, status, observed_value for checks, note for fails).`,
        `On a blocker fail submit_task_review reopens this task with the critique; after 3 attempts it escalates to the human.`,
      ].join('\n')
    }

    case 'submit_task_review': {
      const task = await resolveTask(sb, userId, args.task_id)
      if (!task) return `Task "${args.task_id}" not found.`
      const bar = task.review_bar?.rules || []
      if (!bar.length) return `"${task.text}" has no frozen review bar. Call enable_task_review first.`
      const byId = new Map(bar.map((r: any) => [r.id, r]))
      const results = args.results || []
      const fails = results.filter((x: any) => x.status === 'fail')
      const blockerFail = fails.some((x: any) => { const r: any = byId.get(x.rule_id); return !r || r.severity !== 'warning' })
      const prior = task.review_verdict?.attempt ?? 0
      const overall = blockerFail ? 'fail' : 'pass'
      const attempt = overall === 'fail' ? prior + 1 : prior
      const critique = fails.map((x: any) => { const r: any = byId.get(x.rule_id); return `• ${(r?.label) || x.rule_id}: ${x.note || 'failed'}` }).join('\n')
      const escalate = overall === 'fail' && attempt >= 3
      const review_verdict = { overall, results, critique, validated_at: new Date().toISOString(), attempt, escalated: escalate, validator: args.validator || 'self' }
      const update: any = { review_verdict }
      if (overall === 'fail') update.status = 'in_progress'   // reopen the producer
      const { error } = await sb.from('tasks').update(update).eq('id', task.id)
      if (error) throw new Error(error.message)
      if (overall === 'pass') return `✓ REVIEW PASSED — "${task.text}". ${results.length} rule(s) graded, all blockers satisfied. (action=pass)`
      if (escalate) return `⛔ REVIEW FAILED (attempt ${attempt}/3) — retry limit reached. ESCALATE TO HUMAN (action=ask_human).\nCritique:\n${critique}`
      return `↩ REVIEW FAILED (attempt ${attempt}/3) — task reopened (action=regenerate). Apply this critique and re-run:\n${critique}`
    }

    case 'remove_task_input': {
      const task = await resolveTask(sb, userId, args.task_id)
      if (!task) return `Task "${args.task_id}" not found.`
      const edges = inputEdges(task.input)
      if (!edges.length) return `"${task.text}" has no input edges to remove.`
      let kept: any[]
      if (args.source_task_id) {
        const source = await resolveTask(sb, userId, args.source_task_id)
        const srcId = source?.id || args.source_task_id
        kept = edges.filter((e: any) => e.source_task_id !== srcId && e.source_task_id !== args.source_task_id)
        if (kept.length === edges.length) return `No input edge from "${args.source_task_id}" found on "${task.text}".`
      } else {
        kept = []
      }
      const { error } = await sb.from('tasks').update({ input: { edges: kept } }).eq('id', task.id)
      if (error) throw new Error(error.message)
      const removed = edges.length - kept.length
      return `Removed ${removed} input edge${removed !== 1 ? 's' : ''} from "${task.text}". ${kept.length} remaining.`
    }

    case 'clear_task_output': {
      const task = await resolveTask(sb, userId, args.task_id)
      if (!task) return `Task "${args.task_id}" not found.`
      const prev = (task.output && typeof task.output === 'object') ? task.output : {}
      if (!prev.contract?.rules?.length) return `"${task.text}" has no output contract to clear.`
      const output = { ...prev, contract: { rules: [], confirmed: false } }
      const { error } = await sb.from('tasks').update({ output }).eq('id', task.id)
      if (error) throw new Error(error.message)
      return `Cleared the output contract on "${task.text}". Stored artifact and validation status were kept.`
    }

    case 'delete_flow': {
      let flow: any = null
      const looksLikeUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)
      if (args.flow_id && looksLikeUuid(args.flow_id)) {
        const { data } = await sb.from('flows').select('id, name').eq('id', args.flow_id).eq('user_id', userId).maybeSingle()
        flow = data
      } else if (args.flow_id) {
        let q = sb.from('flows').select('id, name').eq('user_id', userId).ilike('name', `%${args.flow_id}%`)
        if (args.project_id) { const p = await resolveProject(sb, userId, args.project_id); if (p) q = q.eq('project_id', p.id) }
        const { data } = await q
        if (!data?.length) return `No flow matches "${args.flow_id}".`
        if (data.length > 1) return `Multiple flows match "${args.flow_id}":\n` + data.map((f: any) => `  • ${f.name} (id: ${f.id})`).join('\n') + `\nPass the exact flow id.`
        flow = data[0]
      } else if (args.task_id) {
        const task = await resolveTask(sb, userId, args.task_id)
        if (!task) return `Task "${args.task_id}" not found.`
        if (!task.flow_id) return `"${task.text}" is not linked to a named flow.`
        const { data } = await sb.from('flows').select('id, name').eq('id', task.flow_id).eq('user_id', userId).maybeSingle()
        flow = data
      } else {
        return 'Provide flow_id or task_id to identify the flow to delete.'
      }
      if (!flow) return 'Flow not found.'
      const { data: unlinked } = await sb.from('tasks').update({ flow_id: null, flow_step: null }).eq('flow_id', flow.id).eq('user_id', userId).select('id')
      const { error } = await sb.from('flows').delete().eq('id', flow.id).eq('user_id', userId)
      if (error) throw new Error(error.message)
      const n = unlinked?.length ?? 0
      return `Deleted flow "${flow.name}". Unlinked ${n} task${n !== 1 ? 's' : ''} (the tasks and their I/O edges were kept).`
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
      let repoNote = ''
      if (args.commit_to_repo && args.filename) {
        const ghToken = await loadGitHubToken(sb, userId)
        if (ghToken) {
          const { data: proj } = await sb.from('projects').select('github_repo, prefix').eq('id', task.project_id).maybeSingle()
          if (proj?.github_repo) {
            // Determine artifact folder: use flow short_id > flow id prefix > task short_id
            let folder = `${task.project_id.slice(0, 8)}`
            if (task.flow_id) {
              const { data: flow } = await sb.from('flows').select('short_id, id').eq('id', task.flow_id).maybeSingle()
              folder = flow?.short_id || flow?.id?.slice(0, 8) || folder
            } else if (task.short_id != null && proj.prefix) {
              folder = `${proj.prefix}-${task.short_id}`
            }
            const filePath = `.tasker/artifacts/${folder}/${args.filename}`
            try {
              let sha: string | undefined
              try {
                const existing = await githubFetch(ghToken, `/repos/${proj.github_repo}/contents/${filePath}`)
                sha = existing.sha
              } catch {
                // no existing file at this path yet — create it without a sha
              }
              const body: any = { message: `chore: store Tasker artifact (${folder})`, content: btoa(unescape(encodeURIComponent(args.content))) }
              if (sha) body.sha = sha
              await githubFetch(ghToken, `/repos/${proj.github_repo}/contents/${filePath}`, { method: 'PUT', body: JSON.stringify(body) })
              repoNote = ` Also committed to ${proj.github_repo} at ${filePath}.`
            } catch (err: any) {
              repoNote = ` (GitHub commit failed: ${err.message})`
            }
          } else {
            repoNote = ' (skipped GitHub commit — project has no linked repo)'
          }
        } else {
          repoNote = ' (skipped GitHub commit — no GitHub account connected)'
        }
      }
      return `Artifact stored on "${task.text}" (${wordCount} words, format: ${args.format || 'text'}).${repoNote} Call complete_task when ready — if the task has judgment output rules, validate_output will now embed this artifact directly in the validator prompt.`
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
        const selfBlessed = outputContract(producer.output).confirmed
        const selfEdgeRetry = (producer.output?.validation_ledgers?.['self']?.retry_count ?? producer.output?.retry_count) || 0
        return JSON.stringify({
          status: 'needs_agent_validation',
          instruction: 'Endpoint task (no downstream consumer). Evaluate the producer\'s own output contract (self-check) against the actual produced output, then call submit_validation_result with the per-rule results.',
          producer: producer.text,
          target: null,
          gate_rules: [],
          self_check_rules: selfRules,
          contract_status: { gate_contract: 'none', output_contract: selfBlessed ? 'confirmed' : 'provisional' },
          ...(!selfBlessed ? { provisional_warning: 'QA is performed by AI, not a meat sack. Validation will proceed but ledger entries will be stamped contract_blessed: false. Use confirm_contract to have a human bless the quality bar.' } : {}),
          retry_info: { retry_count: selfEdgeRetry, retry_limit: 3, retries_remaining: Math.max(0, 3 - selfEdgeRetry) },
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
      const gateContractBlessed = edge?.contract?.confirmed === true
      const selfContractBlessed = outputContract(producer.output).confirmed

      const hasJudgment = gateRules.some((r: any) => r.kind === 'judgment')
      const storedArtifact: string | null = producer.output?.artifact || null
      const allRuleIds = [...gateRules, ...selfRules].map((r: any) => r.id).join(', ')
      const rulesBlock = [...gateRules, ...selfRules].map((r: any) =>
        `[${r.id}] ${r.label} (${r.kind}, ${r.severity})\nRule: ${r.rule}${r.description ? `\nContext: ${r.description}` : ''}`
      ).join('\n\n')
      const artifactBlock = storedArtifact
        ? `── ARTIFACT (${producer.output?.artifact_format || 'text'}) ─────────────────────────────────────\n${storedArtifact}\n─────────────────────────────────────────────────────────────`
        : `── ARTIFACT ─────────────────────────────────────────────────\n[NO ARTIFACT STORED — executor must call store_artifact first. Do not proceed with grading.]\n─────────────────────────────────────────────────────────────`
      const validatorPrompt = `You are an adversarial quality validator. Your job is to find reasons this artifact FAILS — not reasons it passes. Start from a FAIL prior on every judgment rule and look for concrete evidence in the artifact to flip it to pass. If the evidence is absent, ambiguous, or only partially satisfies the rule: it stays FAIL. No benefit of the doubt. No generous interpretation. You have no knowledge of how this artifact was produced or why.

PRODUCER: ${producer.text} (task_id: ${producer.id})
CONSUMER: ${consumer.text} (target_task_id: ${consumer.id})

${artifactBlock}

── RULES ────────────────────────────────────────────────────
${rulesBlock}
─────────────────────────────────────────────────────────────

For kind=judgment rules: prior is FAIL. You need clear, concrete evidence from the artifact to flip to pass. Partial match, vague similarity, or "it could be interpreted as" is not enough — stay FAIL.
For kind=check rules: ACTUALLY RUN the check — count words/lines, run commands via Bash, search for patterns. Record the raw result as observed_value (e.g. "1,542 words", "exit 0: All 24 tests passed", "/src/index.ts found at line 3"). Submitting without observed_value is REJECTED.
Any fail REQUIRES a note naming the specific deficiency. Any pass on a judgment rule REQUIRES a note citing the concrete evidence that cleared it. Any check rule REQUIRES observed_value.

Call submit_validation_result with:
  task_id: "${producer.id}"
  target_task_id: "${consumer.id}"
  validator: "independent-subagent"
  results: one {rule_id, status, observed_value (check rules only), note} per rule — you must cover all rule IDs: ${allRuleIds}`

      const artifactReady = !!storedArtifact
      const isProvisional = (!gateContractBlessed && gateRules.length > 0) || (!selfContractBlessed && selfRules.length > 0)
      const edgeRetry = (producer.output?.validation_ledgers?.[consumer.id]?.retry_count ?? producer.output?.retry_count) || 0
      return JSON.stringify({
        status: hasJudgment && !artifactReady ? 'needs_artifact' : 'needs_agent_validation',
        artifact_stored: artifactReady,
        instruction: !hasJudgment
          ? 'All rules are kind=check (deterministic). Evaluate each against the actual produced output, then call submit_validation_result. SHORTCUT: if you already knew these rules before calling validate_output, next time skip this call — call submit_validation_result directly with the task_id and your check results (no prior validate_output needed for check-only contracts).'
          : !artifactReady
            ? 'Judgment rules require an independent validator. Call store_artifact with the verbatim produced content first, then call validate_output again — the artifact will be embedded in validator_agent_prompt automatically.'
            : 'Artifact is stored. Spawn a validator subagent using the Agent tool with the validator_agent_prompt below — it is complete, no edits needed. The subagent grades and calls submit_validation_result independently.',
        producer: producer.text,
        target: consumer.text,
        target_task_id: consumer.id,
        gate_rules: gateRules,
        self_check_rules: selfRules,
        contract_status: {
          gate_contract: gateRules.length ? (gateContractBlessed ? 'confirmed' : 'provisional') : 'none',
          output_contract: selfRules.length ? (selfContractBlessed ? 'confirmed' : 'provisional') : 'none',
        },
        ...(isProvisional ? { provisional_warning: 'QA is performed by AI, not a meat sack. Validation will proceed but ledger entries will be stamped contract_blessed: false. Use confirm_contract to have a human bless the quality bar.' } : {}),
        retry_info: { retry_count: edgeRetry, retry_limit: 3, retries_remaining: Math.max(0, 3 - edgeRetry) },
        ...(hasJudgment ? { validator_agent_prompt: validatorPrompt } : {}),
        ...(!hasJudgment ? {
          check_execution_guide: [...gateRules, ...selfRules].filter((r: any) => r.kind === 'check').map((r: any) => ({
            rule_id: r.id,
            label: r.label,
            rule: r.rule,
            required: `observed_value (the raw result of running this check) + note (interpretation). Both rejected if missing.`,
          })),
        } : {}),
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
      let gateContractBlessed = false
      if (consumer) {
        const edge = inputEdges(consumer.input).find((e: any) => e.source_task_id === producer.id)
        gateRules = edge?.contract?.rules || []
        gateContractBlessed = edge?.contract?.confirmed === true
        targetText = consumer.text
        targetId = consumer.id
      }

      const gateRuleIds = new Set(gateRules.map((r: any) => r.id))
      const selfOutputContract = outputContract(producer.output)
      const selfRules = selfOutputContract.rules
      const selfContractBlessed = selfOutputContract.confirmed
      const ruleById = new Map<string, any>()
      ;[...gateRules, ...selfRules].forEach((r: any) => ruleById.set(r.id, r))

      // Reject results missing required evidence:
      // - kind=check always needs observed_value (the raw datum from running the check)
      // - kind=check also needs a note (interpretation of the observed_value)
      // - any fail (any kind) needs a note (the specific deficiency)
      const missingObservedValue = results.filter((res: any) => {
        const rule = ruleById.get(res.rule_id)
        return rule?.kind === 'check' && !res.observed_value
      })
      if (missingObservedValue.length) {
        return JSON.stringify({
          error: 'missing_observed_value',
          message: `${missingObservedValue.length} check rule(s) submitted without observed_value. For kind=check rules, you MUST actually run the check and record the raw result — exact word count, command stdout + exit code, file path found, pattern match result. A description of the output is not an observed value. Run the check. Record what you observed.`,
          rules_needing_observed_value: missingObservedValue.map((res: any) => {
            const rule = ruleById.get(res.rule_id)
            return {
              rule_id: res.rule_id,
              label: rule?.label || res.rule_id,
              rule: rule?.rule,
              how_to_check: rule?.description || 'Run the check described in the rule. Record the raw output as observed_value.',
            }
          }),
        })
      }

      const unevidenced = results.filter((res: any) => {
        const rule = ruleById.get(res.rule_id)
        return !res.note && (rule?.kind === 'check' || res.status === 'fail')
      })
      if (unevidenced.length) {
        return JSON.stringify({
          error: 'missing_evidence',
          message: `${unevidenced.length} rule(s) submitted without a required note. Requirements: (1) kind=check rules need a note interpreting the observed_value. (2) Any failing rule needs a note — the specific deficiency, not just "fail".`,
          rules_needing_evidence: unevidenced.map((res: any) => {
            const rule = ruleById.get(res.rule_id)
            const reason = rule?.kind === 'check'
              ? 'kind=check — note must interpret the observed_value (e.g. "1,542 words — exceeds 1,000-word minimum")'
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
        const observedValueLen = (res.observed_value || '').length
        const evidenceQuality = isCheck ? (observedValueLen === 0 ? 'missing' : observedValueLen < 10 ? 'weak' : 'good') : null
        return {
          rule_id: res.rule_id,
          label: rule?.label || res.rule_id,
          source: isGate ? 'input' : 'output',
          severity: rule?.severity || 'blocker',
          kind: rule?.kind || 'check',
          status: res.status === 'pass' ? 'pass' : 'fail',
          note: res.note || null,
          ...(isCheck ? { observed_value: res.observed_value } : {}),
          validator,
          contract_blessed: isGate ? gateContractBlessed : selfContractBlessed,
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
      const prevLedgers = (prevOutput.validation_ledgers && typeof prevOutput.validation_ledgers === 'object') ? prevOutput.validation_ledgers : {}
      const edgeKey = targetId || 'self'
      const prevEdgeLedger = prevLedgers[edgeKey] || {}
      // Per-edge retry count — fan-out safe (falls back to flat field for old data)
      const prevRetryCount = typeof prevEdgeLedger.retry_count === 'number' ? prevEdgeLedger.retry_count
        : (typeof prevOutput.retry_count === 'number' ? prevOutput.retry_count : 0)
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

      const edgeLedgerEntry = {
        validation_status: validationStatus,
        validated_against: targetId,
        validated_at: checkedAt,
        ledger,
        retry_count: valid ? 0 : newRetryCount,
        ...(action === 'ask_human' ? { retry_blocked: true } : {}),
      }

      const allBlessed = ledger.every((l: any) => l.contract_blessed !== false)
      const critiqueEntry = {
        validated_at: checkedAt,
        validator: validator || 'unverified',
        contract_blessed: allBlessed,
        overall: validationStatus,
        fails: ledger.filter((l: any) => l.status === 'fail').map((l: any) => ({
          rule_id: l.rule_id, label: l.label, kind: l.kind, severity: l.severity, source: l.source, note: l.note,
          ...(l.observed_value ? { observed_value: l.observed_value } : {}),
        })),
        passes: ledger.filter((l: any) => l.status === 'pass').map((l: any) => ({
          rule_id: l.rule_id, label: l.label, kind: l.kind, severity: l.severity, source: l.source, note: l.note,
          ...(l.observed_value ? { observed_value: l.observed_value } : {}),
        })),
      }

      const prevCritiques = (prevOutput.critiques && typeof prevOutput.critiques === 'object') ? prevOutput.critiques : {}

      await sb.from('tasks').update({
        output: {
          ...prevOutput,
          // Per-edge ledger (fan-out safe — each consumer keeps its own record)
          validation_ledgers: { ...prevLedgers, [edgeKey]: edgeLedgerEntry },
          // Per-edge critique (clean human-readable notes from the validator)
          critiques: { ...prevCritiques, [edgeKey]: critiqueEntry },
          // Flat fields kept for backward compat (single-edge / endpoint tasks)
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

    case 'get_task_critique': {
      const task = await resolveTask(sb, userId, args.task_id)
      if (!task) return `Task "${args.task_id}" not found.`
      const out = task.output
      const critiques = (out?.critiques && typeof out.critiques === 'object') ? out.critiques : {}
      const keys = Object.keys(critiques)

      if (!keys.length && !out?.ledger) return `No validation critique recorded for "${task.text}" yet. Run validate_output + submit_validation_result first.`

      // Resolve which edge to show
      let edgeKey: string | null = null
      if (args.target_task_id) {
        const target = await resolveTask(sb, userId, args.target_task_id)
        if (!target) return `Target task "${args.target_task_id}" not found.`
        if (critiques[target.id]) { edgeKey = target.id }
        else return `No critique found for the edge to "${target.text}". Either validation hasn't run for that edge yet, or use get_validation_feedback for raw ledger data.`
      } else if (keys.length === 1) {
        edgeKey = keys[0]
      } else if (keys.length > 1) {
        return JSON.stringify({
          error: 'ambiguous_edge',
          message: `"${task.text}" has critiques for ${keys.length} consumer edges. Re-call with target_task_id to pick one.`,
          available_edges: keys,
        })
      }

      const critique = edgeKey ? critiques[edgeKey] : null

      // Fallback to flat ledger (old data before TDE-215)
      if (!critique && out?.ledger) {
        const fails = (out.ledger as any[]).filter((l: any) => l.status === 'fail')
        const passes = (out.ledger as any[]).filter((l: any) => l.status === 'pass')
        const lines = [
          `Critique for "${task.text}" [legacy format — re-validate to upgrade]`,
          `Status: ${out.validation_status || 'unknown'} | Validator: ${out.ledger[0]?.validator || 'unverified'}`,
          '',
        ]
        if (fails.length) {
          lines.push(`FAILED (${fails.length}):`)
          fails.forEach((l: any) => {
            lines.push(`  ✗ [${l.source === 'input' ? 'gate' : 'self'} · ${l.severity} · ${l.kind}] ${l.label}`)
            lines.push(`      ${l.note || '(no note)'}`)
          })
        } else {
          lines.push('All rules passed.')
        }
        if (passes.length) {
          lines.push('', `PASSED (${passes.length}):`)
          passes.forEach((l: any) => {
            lines.push(`  ✓ [${l.source === 'input' ? 'gate' : 'self'} · ${l.severity} · ${l.kind}] ${l.label}`)
            if (l.note) lines.push(`      ${l.note}`)
          })
        }
        return lines.join('\n')
      }

      if (!critique) return `No critique found for "${task.text}".`

      const lines = [
        `Critique for "${task.text}"`,
        `Status: ${critique.overall?.toUpperCase()} | Validator: ${critique.validator} | Contract: ${critique.contract_blessed ? 'confirmed' : 'AI-QA\'d'}`,
        `At: ${critique.validated_at}`,
        '',
      ]
      if (critique.fails?.length) {
        lines.push(`FAILED (${critique.fails.length}):`)
        critique.fails.forEach((f: any) => {
          lines.push(`  ✗ [${f.source === 'input' ? 'gate' : 'self'} · ${f.severity} · ${f.kind}] ${f.label}`)
          if (f.observed_value) lines.push(`      Observed: ${f.observed_value}`)
          lines.push(`      ${f.note || '(no note)'}`)
        })
      } else {
        lines.push('All rules passed.')
      }
      if (critique.passes?.length) {
        lines.push('', `PASSED (${critique.passes.length}):`)
        critique.passes.forEach((p: any) => {
          lines.push(`  ✓ [${p.source === 'input' ? 'gate' : 'self'} · ${p.severity} · ${p.kind}] ${p.label}`)
          if (p.observed_value) lines.push(`      Observed: ${p.observed_value}`)
          if (p.note) lines.push(`      ${p.note}`)
        })
      }
      return lines.join('\n')
    }

    case 'get_validation_feedback': {
      const task = await resolveTask(sb, userId, args.task_id)
      if (!task) return `Task "${args.task_id}" not found.`
      const out: any = task.output
      if (!out || (!out.ledger && !out.validation_status && !out.feedback && !out.validation_ledgers)) return `No validation has been run on "${task.text}" yet.`

      const lines: string[] = []

      const renderEdgeLedger = (edgeLedger: any, label: string) => {
        const status = edgeLedger.validation_status || 'pending'
        lines.push(`${label} — ${status}`)
        if (typeof edgeLedger.retry_count === 'number' && edgeLedger.retry_count > 0) {
          lines.push(`  Retry count: ${edgeLedger.retry_count}/3${edgeLedger.retry_blocked ? ' (limit reached — awaiting human direction)' : ''}`)
        }
        const ledger = edgeLedger.ledger || []
        const selfGraded = ledger.filter((l: any) => l.kind === 'judgment' && (!l.validator || l.validator === 'self'))
        if (selfGraded.length) lines.push(`  ⚠ Self-graded judgment rules (${selfGraded.length}): ${selfGraded.map((l: any) => l.label).join(', ')}`)
        const weakEv = ledger.filter((l: any) => l.kind === 'check' && l.evidence_quality === 'weak')
        if (weakEv.length) lines.push(`  ⚠ Weak evidence (${weakEv.length}): ${weakEv.map((l: any) => l.label).join(', ')}`)
        const unblessed = ledger.filter((l: any) => l.contract_blessed === false)
        if (unblessed.length) lines.push(`  ⚠ AI-QA'd contract (${unblessed.length} rule${unblessed.length !== 1 ? 's' : ''} — QA is performed by AI, not a meat sack)`)
        if (ledger.length) {
          ledger.forEach((l: any) => {
            lines.push(`  ${l.status === 'pass' ? '✓' : '✗'} [${l.source === 'input' ? 'gate' : 'self'} · ${l.severity}] ${l.label}${l.note ? ` — ${l.note}` : ''}`)
          })
        }
      }

      if (out.validation_ledgers && typeof out.validation_ledgers === 'object') {
        const edgeKeys = Object.keys(out.validation_ledgers)
        if (edgeKeys.length > 1) {
          // Fan-out: show each edge separately
          lines.push(`Validation for "${task.text}" (${edgeKeys.length} edges):`)
          edgeKeys.forEach(key => {
            const edgeLedger = out.validation_ledgers[key]
            const edgeLabel = key === 'self' ? 'Self-check' : `→ consumer ${key.slice(0, 8)}…`
            lines.push('')
            renderEdgeLedger(edgeLedger, edgeLabel)
          })
        } else if (edgeKeys.length === 1) {
          renderEdgeLedger(out.validation_ledgers[edgeKeys[0]], `Validation for "${task.text}"`)
        }
      } else {
        // Fall back to flat fields (old data)
        const status = out.validation_status || 'pending'
        lines.push(`Validation status: ${status}`)
        if (typeof out.retry_count === 'number' && out.retry_count > 0) {
          lines.push(`Retry count: ${out.retry_count}/3${out.retry_blocked ? ' (limit reached — awaiting human direction)' : ''}`)
        }
        const selfGraded = Array.isArray(out.ledger) ? out.ledger.filter((l: any) => l.kind === 'judgment' && (!l.validator || l.validator === 'self')) : []
        if (selfGraded.length) lines.push(`⚠ Self-graded judgment rules (${selfGraded.length}): ${selfGraded.map((l: any) => l.label).join(', ')} — treat with caution`)
        const weakEv = Array.isArray(out.ledger) ? out.ledger.filter((l: any) => l.kind === 'check' && l.evidence_quality === 'weak') : []
        if (weakEv.length) lines.push(`⚠ Weak evidence on check rules (${weakEv.length}): ${weakEv.map((l: any) => l.label).join(', ')} — note too short to be a real run result`)
        const unblessed = Array.isArray(out.ledger) ? out.ledger.filter((l: any) => l.contract_blessed === false) : []
        if (unblessed.length) lines.push(`⚠ AI-QA'd contract (${unblessed.length} rule${unblessed.length !== 1 ? 's' : ''} — QA is performed by AI, not a meat sack) — use confirm_contract to have a human bless the quality bar`)
        if (Array.isArray(out.ledger) && out.ledger.length) {
          lines.push('', 'Last check (per rule):')
          out.ledger.forEach((l: any) => {
            lines.push(`  ${l.status === 'pass' ? '✓' : '✗'} [${l.source === 'input' ? 'gate' : 'self'} · ${l.severity}] ${l.label}${l.note ? ` — ${l.note}` : ''}`)
          })
        } else if (out.feedback) {
          lines.push(`Feedback: ${out.feedback}`)
        }
      }

      return lines.join('\n')
    }

    case 'name_flow': {
      const project = await resolveProject(sb, userId, args.project_id, logCtx)
      if (!project) return `Project "${args.project_id}" not found.`
      const taskIds = Array.isArray(args.task_ids) ? args.task_ids : []
      if (!taskIds.length) return 'task_ids is required and must not be empty.'

      const resolvedTasks = await Promise.all(taskIds.map((id: string) => resolveTask(sb, userId, id)))
      const valid = resolvedTasks.filter(Boolean)
      const skipped = taskIds.length - valid.length
      if (!valid.length) return 'No valid tasks found in task_ids.'

      // Compute short_id: use provided, or auto-generate
      let shortId: string | null = args.short_id || null
      if (!shortId) {
        const prefix = project.prefix
        if (prefix) {
          // Pattern: PREFIX-F{n}, find the highest N already used for this prefix
          const { data: existing } = await sb.from('flows').select('short_id').eq('user_id', userId).like('short_id', `${prefix}-F%`)
          const usedNums = (existing || []).map((f: any) => {
            const m = f.short_id?.match(/^.+-F(\d+)$/)
            return m ? parseInt(m[1], 10) : 0
          })
          const nextN = usedNums.length ? Math.max(...usedNums) + 1 : 1
          shortId = `${prefix}-F${nextN}`
        } else {
          // Prefix-less: Flow Name - F{n}, where n = count of existing short_ids on prefix-less projects + 1
          const { count } = await sb.from('flows')
            .select('id', { count: 'exact', head: true })
            .eq('user_id', userId)
            .not('short_id', 'is', null)
          const nextN = (count ?? 0) + 1
          shortId = `${args.name} - F${nextN}`
        }
      }

      // Reuse existing flow if any task already belongs to one
      const existingFlowId = valid.find((t: any) => t.flow_id)?.flow_id || null
      let flowId: string
      if (existingFlowId) {
        await sb.from('flows').update({ name: args.name, context: args.context || null, short_id: shortId, updated_at: new Date().toISOString() }).eq('id', existingFlowId).eq('user_id', userId)
        flowId = existingFlowId
      } else {
        const { data: flow, error } = await sb.from('flows').insert({ user_id: userId, project_id: project.id, name: args.name, context: args.context || null, short_id: shortId }).select('id').single()
        if (error || !flow) throw new Error(error?.message || 'Failed to create flow')
        flowId = flow.id
      }

      // Topo-sort the valid tasks and assign flow_step (1-based)
      // Tie-break by original task_ids order (agent lists them in intended order)
      const flowTaskById = new Map(valid.map((t: any) => [t.id, t]))
      const originalOrder = new Map(valid.map((t: any, i: number) => [t.id, i]))
      const flowDepths = new Map<string, number>()
      function flowDepth(id: string, stack = new Set<string>()): number {
        if (flowDepths.has(id)) return flowDepths.get(id)!
        if (stack.has(id)) return 0
        stack.add(id)
        const srcs = inputSourceIds(flowTaskById.get(id)?.input).filter((s: string) => flowTaskById.has(s))
        const d = srcs.length ? Math.max(...srcs.map((s: string) => flowDepth(s, stack) + 1)) : 0
        flowDepths.set(id, d)
        return d
      }
      valid.forEach((t: any) => flowDepth(t.id))
      const sortedFlow = [...valid].sort((a: any, b: any) => {
        const da = flowDepths.get(a.id) ?? 0
        const db = flowDepths.get(b.id) ?? 0
        return da !== db ? da - db : (originalOrder.get(a.id) ?? 0) - (originalOrder.get(b.id) ?? 0)
      })

      await Promise.all(sortedFlow.map((t: any, i: number) =>
        sb.from('tasks').update({ flow_id: flowId, flow_step: i + 1 }).eq('id', t.id)
      ))

      const stepList = sortedFlow.map((t: any, i: number) => {
        const ref = t.short_id != null ? `#${t.short_id}` : t.id.slice(0, 8)
        return `  Step ${i + 1}: ${ref} — ${t.text}`
      }).join('\n')
      return `Flow "${args.name}" ${existingFlowId ? 'updated' : 'created'} — ${valid.length} task${valid.length !== 1 ? 's' : ''} assigned step numbers.${skipped ? ` (${skipped} task ID(s) not resolved, skipped)` : ''}\n\n${stepList}\n\nFlow ID: ${flowId.slice(0, 8)}…  Short ID: ${shortId}`
    }

    case 'recompute_flow_steps': {
      // Resolve the flow record
      let flow: any = null
      if (args.flow_id) {
        const { data: f } = await sb.from('flows').select('id, name').or(`id.eq.${args.flow_id},name.ilike.%${args.flow_id}%`).eq('user_id', userId).maybeSingle()
        if (!f) return `Flow "${args.flow_id}" not found.`
        flow = f
      } else if (args.task_id) {
        const anchor = await resolveTask(sb, userId, args.task_id)
        if (!anchor) return `Task "${args.task_id}" not found.`
        if (!anchor.flow_id) return `Task "${anchor.text}" is not linked to a named flow.`
        const { data: f } = await sb.from('flows').select('id, name').eq('id', anchor.flow_id).eq('user_id', userId).maybeSingle()
        if (!f) return `Flow record not found for task "${anchor.text}".`
        flow = f
      } else {
        return 'Provide flow_id or task_id.'
      }
      const { data: tasks } = await sb.from('tasks')
        .select('id, text, short_id, input')
        .eq('flow_id', flow.id).eq('user_id', userId)
      if (!tasks?.length) return `No tasks found in flow "${flow.name}".`
      const taskById = new Map(tasks.map((t: any) => [t.id, t]))
      const depths = new Map<string, number>()
      function recomputeDepth(id: string, stack = new Set<string>()): number {
        if (depths.has(id)) return depths.get(id)!
        if (stack.has(id)) return 0
        stack.add(id)
        const srcs = inputSourceIds(taskById.get(id)?.input).filter((s: string) => taskById.has(s))
        const d = srcs.length ? Math.max(...srcs.map((s: string) => recomputeDepth(s, stack) + 1)) : 0
        depths.set(id, d)
        return d
      }
      tasks.forEach((t: any) => recomputeDepth(t.id))
      const sorted = [...tasks].sort((a: any, b: any) => {
        const da = depths.get(a.id) ?? 0
        const db = depths.get(b.id) ?? 0
        return da !== db ? da - db : 0
      })
      await Promise.all(sorted.map((t: any, i: number) =>
        sb.from('tasks').update({ flow_step: i + 1 }).eq('id', t.id)
      ))
      const stepList = sorted.map((t: any, i: number) => {
        const ref = t.short_id != null ? `#${t.short_id}` : t.id.slice(0, 8)
        return `  Step ${i + 1}: ${ref} — ${t.text}`
      }).join('\n')
      return `Recomputed step order for flow "${flow.name}" — ${sorted.length} tasks renumbered.\n\n${stepList}`
    }

    case 'get_flow_context': {
      const task = await resolveTask(sb, userId, args.task_id)
      if (!task) return `Task "${args.task_id}" not found.`
      if (!task.flow_id) return `"${task.text}" is not linked to a named flow. Call name_flow to give the flow a name and context.`

      const { data: flow } = await sb.from('flows').select('id, name, short_id, context, created_at').eq('id', task.flow_id).eq('user_id', userId).maybeSingle()
      if (!flow) return `Flow record not found for "${task.text}".`

      const { data: members } = await sb.from('tasks').select('short_id, flow_step, text, status, project:projects(prefix)').eq('flow_id', flow.id).eq('user_id', userId).order('flow_step', { ascending: true, nullsFirst: false })
      const lines = [
        `Flow: ${flow.name}${flow.short_id ? `  [${flow.short_id}]` : ''}`,
        `ID: ${flow.id.slice(0, 8)}…`,
        `Tasks: ${(members || []).length}`,
        ...(flow.context ? ['', 'Context:', flow.context] : []),
        '',
        'Members:',
        ...(members || []).map((t: any) => {
          const prefix = t.project?.prefix
          const ref = prefix && t.short_id != null ? `${prefix}-${t.short_id}` : `#${t.short_id}`
          const stepStr = t.flow_step != null ? `Step ${t.flow_step} · ` : ''
          return `  [${t.status}] ${stepStr}${ref} — ${t.text}`
        }),
      ]
      return lines.join('\n')
    }

    case 'update_flow_context': {
      const task = await resolveTask(sb, userId, args.task_id)
      if (!task) return `Task "${args.task_id}" not found.`
      if (!task.flow_id) return `"${task.text}" is not linked to a named flow. Call name_flow first.`

      const updates: any = { updated_at: new Date().toISOString() }
      if (args.context !== undefined) updates.context = args.context
      if (args.name) updates.name = args.name
      if (args.short_id !== undefined) updates.short_id = args.short_id || null

      await sb.from('flows').update(updates).eq('id', task.flow_id).eq('user_id', userId)
      const parts = []
      if (args.name) parts.push(`Renamed to "${args.name}".`)
      if (args.context !== undefined) parts.push('Context saved.')
      if (args.short_id !== undefined) parts.push(args.short_id ? `Short ID set to "${args.short_id}".` : 'Short ID cleared.')
      return `Flow updated.${parts.length ? ' ' + parts.join(' ') : ''}`
    }

    case 'confirm_contract': {
      const task = await resolveTask(sb, userId, args.task_id)
      if (!task) return `Task "${args.task_id}" not found.`
      const contractType = args.contract_type || 'output'
      const confirmedBy = args.confirmed_by || 'human'
      const confirmedAt = new Date().toISOString()

      if (contractType === 'output') {
        const prev = (task.output && typeof task.output === 'object') ? task.output : {}
        const prevContract = prev.contract || {}
        if (!prevContract.rules?.length) return `"${task.text}" has no output contract to confirm. Set one via set_task_output first.`
        await sb.from('tasks').update({
          output: { ...prev, contract: { ...prevContract, confirmed: true, confirmed_at: confirmedAt, confirmed_by: confirmedBy } },
        }).eq('id', task.id)
        return `Output contract on "${task.text}" confirmed by ${confirmedBy}. ${prevContract.rules.length} rule${prevContract.rules.length !== 1 ? 's' : ''} are now human-blessed — future validation ledger entries will be stamped contract_blessed: true.`
      }

      if (contractType === 'input') {
        const edges = inputEdges(task.input)
        if (!edges.length) return `"${task.text}" has no input edges to confirm.`

        let targetEdge: any = null
        if (args.source_task_id) {
          const source = await resolveTask(sb, userId, args.source_task_id)
          if (source) targetEdge = edges.find((e: any) => e.source_task_id === source.id)
        } else if (edges.length === 1) {
          targetEdge = edges[0]
        } else {
          return JSON.stringify({
            error: 'ambiguous_edge',
            message: `"${task.text}" has ${edges.length} input edges. Re-call with source_task_id to specify which edge's contract to confirm.`,
            edges: edges.map((e: any) => ({ source_task_id: e.source_task_id })),
          })
        }

        if (!targetEdge) return `No input edge found on "${task.text}"${args.source_task_id ? ` from "${args.source_task_id}"` : ''}.`
        if (!targetEdge.contract?.rules?.length) return `The input edge on "${task.text}" has no contract rules to confirm.`

        const updatedEdges = edges.map((e: any) =>
          e.source_task_id === targetEdge.source_task_id
            ? { ...e, contract: { ...e.contract, confirmed: true, confirmed_at: confirmedAt, confirmed_by: confirmedBy } }
            : e
        )
        await sb.from('tasks').update({ input: { edges: updatedEdges } }).eq('id', task.id)
        return `Input contract on "${task.text}" (from ${targetEdge.source_task_id}) confirmed by ${confirmedBy}. ${targetEdge.contract.rules.length} rule${targetEdge.contract.rules.length !== 1 ? 's' : ''} are now human-blessed.`
      }

      return `Unknown contract_type "${contractType}". Use "output" or "input".`
    }

    case 'save_flow_as_template': {
      // Resolve source flow tasks
      let sourceTasks: any[] = []
      const flowName = args.name
      if (args.flow_id || args.task_id) {
        let flowId: string | null = null
        if (args.task_id) {
          const anchor = await resolveTask(sb, userId, args.task_id)
          flowId = anchor?.flow_id || null
          if (!flowId) {
            // Unnamed flow: fetch all tasks from the connected component via the task's project
            // For simplicity, skip unnamed flows
            return `Task "${args.task_id}" is not linked to a named flow. Name the flow first with name_flow, then save as template.`
          }
        } else {
          const { data: f } = await sb.from('flows').select('id, name').or(`id.eq.${args.flow_id},name.ilike.%${args.flow_id}%`).eq('user_id', userId).maybeSingle()
          flowId = f?.id || null
          if (!flowId) return `Flow "${args.flow_id}" not found.`
        }
        const { data: tasks } = await sb.from('tasks')
          .select('id, text, detail, input, output, flow_step')
          .eq('flow_id', flowId).eq('user_id', userId)
          .order('flow_step', { ascending: true, nullsFirst: false })
        sourceTasks = tasks || []
      }
      if (!sourceTasks.length && (args.flow_id || args.task_id)) {
        return 'No tasks found in the specified flow.'
      }

      const { data: tmpl, error: tmplErr } = await sb.from('flow_templates')
        .insert({ user_id: userId, name: flowName, description: args.description || null })
        .select('id').single()
      if (tmplErr || !tmpl) throw new Error(tmplErr?.message || 'Failed to create template')

      if (sourceTasks.length) {
        await Promise.all(sourceTasks.map((t: any, i: number) =>
          sb.from('flow_template_steps').insert({
            template_id: tmpl.id,
            step_order: t.flow_step ?? (i + 1),
            title: t.text,
            detail_scaffold: t.detail || null,
            input_contract: t.input ? JSON.stringify(t.input) : null,
            output_contract: t.output ? JSON.stringify(t.output) : null,
          })
        ))
      }

      return `Flow Template "${flowName}" created (id: ${tmpl.id.slice(0, 8)}…) with ${sourceTasks.length} step${sourceTasks.length !== 1 ? 's' : ''}.`
    }

    case 'list_flow_templates': {
      const { data: templates } = await sb.from('flow_templates')
        .select('id, name, description, created_at')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
      if (!templates?.length) return 'No flow templates saved yet. Use save_flow_as_template to create one.'
      const lines = ['Flow Templates:\n']
      for (const t of templates) {
        const { count } = await sb.from('flow_template_steps')
          .select('id', { count: 'exact', head: true }).eq('template_id', t.id)
        lines.push(`  "${t.name}"  id: ${t.id.slice(0, 8)}…  (${count ?? 0} steps)${t.description ? `\n    ${t.description}` : ''}`)
      }
      return lines.join('\n')
    }

    case 'instantiate_flow_template': {
      const project = await resolveProject(sb, userId, args.project_id, logCtx)
      if (!project) return `Project "${args.project_id}" not found.`

      let templateId = args.template_id
      if (!templateId && args.template_name) {
        const { data: t } = await sb.from('flow_templates').select('id').ilike('name', `%${args.template_name}%`).eq('user_id', userId).maybeSingle()
        if (!t) return `Template "${args.template_name}" not found.`
        templateId = t.id
      }
      if (!templateId) return 'Provide template_id or template_name.'

      const { data: template } = await sb.from('flow_templates').select('id, name').eq('id', templateId).eq('user_id', userId).maybeSingle()
      if (!template) return `Template "${templateId}" not found.`

      const { data: steps } = await sb.from('flow_template_steps')
        .select('id, step_order, title, detail_scaffold, input_contract, output_contract')
        .eq('template_id', templateId).order('step_order')
      if (!steps?.length) return `Template "${template.name}" has no steps.`

      // Helper: fill {{key}} placeholders from context
      const ctx = args.context || {}
      function fill(str: string | null): string | null {
        if (!str) return null
        return str.replace(/\{\{(\w+)\}\}/g, (_: string, k: string) => ctx[k] ?? `{{${k}}}`)
      }

      // Resolve section — create one if not provided
      let sectionId = args.section_id || null
      if (!sectionId) {
        const { data: secs } = await sb.from('sections')
          .select('sort_order').eq('project_id', project.id).order('sort_order', { ascending: false }).limit(1)
        const sortOrder = ((secs?.[0]?.sort_order) ?? -1) + 1
        const flowNameForSec = args.flow_name || template.name
        const { data: newSec } = await sb.from('sections')
          .insert({ project_id: project.id, name: flowNameForSec, sort_order: sortOrder })
          .select('id').single()
        sectionId = newSec?.id || null
      }
      if (!sectionId) return 'Failed to create section for flow tasks.'

      const { data: { user: _user } } = await sb.auth.getUser()
      const idMap: Record<string, string> = {}

      for (const step of steps) {
        const title = fill(step.title) ?? step.title
        const detail = fill(step.detail_scaffold)
        const output = step.output_contract ? JSON.parse(step.output_contract) : null
        const { data: task } = await sb.from('tasks')
          .insert({
            user_id: userId, project_id: project.id, section_id: sectionId,
            text: title, detail: detail, status: 'pending', output,
          })
          .select('id').single()
        if (task) idMap[step.id] = task.id
      }

      // Wire input edges using the new task IDs
      for (const step of steps) {
        const newTaskId = idMap[step.id]
        if (!newTaskId || !step.input_contract) continue
        const inputData = JSON.parse(step.input_contract)
        const edges: any[] = inputData.edges || (inputData.source_task_id ? [{ source_task_id: inputData.source_task_id }] : [])
        const resolvedEdges = edges.map((e: any) => {
          const prevStepId = Object.keys(idMap).find(sid => {
            const s = steps.find(x => x.id === sid)
            return s && idMap[s.id] && e.source_task_id
          })
          return { ...e, source_task_id: prevStepId ? idMap[prevStepId] : e.source_task_id }
        }).filter((e: any) => e.source_task_id && Object.values(idMap).includes(e.source_task_id))
        if (resolvedEdges.length) {
          await sb.from('tasks').update({ input: { edges: resolvedEdges } }).eq('id', newTaskId)
        }
      }

      // Create named flow record and link tasks
      const flowName = args.flow_name || template.name
      const taskIds = steps.map(s => idMap[s.id]).filter(Boolean)
      const { data: flowRec } = await sb.from('flows')
        .insert({ user_id: userId, project_id: project.id, name: flowName })
        .select('id').single()
      if (flowRec && taskIds.length) {
        await Promise.all(taskIds.map((tid, i) =>
          sb.from('tasks').update({ flow_id: flowRec.id, flow_step: i + 1 }).eq('id', tid)
        ))
      }

      return `Instantiated template "${template.name}" as flow "${flowName}" — ${taskIds.length} task${taskIds.length !== 1 ? 's' : ''} created in project "${project.name}".${Object.keys(ctx).length ? ` Context applied: ${Object.keys(ctx).join(', ')}.` : ''}`
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
    return rpcOk({
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'tasker', version: '1.0.0' },
      instructions: TASKER_SERVER_INSTRUCTIONS,
    }, id)
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
        const { name, arguments: toolArgs, input: toolInput } = params
        const resolvedArgs = toolArgs ?? toolInput ?? {}
        try {
          const text = await runTool(sb, userId, name, resolvedArgs, params)
          return toolOk(text, id)
        } catch (err: any) {
          fireAndForget(sb.from('mcp_error_logs').insert({
            user_id: userId,
            tool_name: name,
            raw_params: params,
            error_msg: err.message,
          }))
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
