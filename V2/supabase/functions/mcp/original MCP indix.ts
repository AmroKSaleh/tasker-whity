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

async function githubFetch(token: string, path: string): Promise<any> {
  const res = await fetch(`${GITHUB_API}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
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
        .select('id, text').eq('project_id', project.id).eq('short_id', shortId).maybeSingle()
      if (task) return task
    }
  }
  // Fall back to UUID
  const { data } = await sb.from('tasks')
    .select('id, text').eq('id', taskRef).eq('user_id', userId).maybeSingle()
  return data ?? null
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
    description: 'Get full details for a single task: text, context, priority, status, due date, section, project, and milestones.',
    inputSchema: {
      type: 'object',
      properties: { task_id: { type: 'string', description: 'Task UUID or short ID (e.g. TDE-31)' } },
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
]

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
      const { task_id, ...updates } = args
      const allowed = ['text', 'detail', 'priority', 'status', 'due_date', 'section_id', 'pinned']
      const patch: Record<string, any> = {}
      for (const k of allowed) if (updates[k] !== undefined) patch[k] = updates[k]
      const task = await resolveTask(sb, userId, task_id)
      if (!task) return 'Task not found.'

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
      const task = await resolveTask(sb, userId, args.task_id)
      if (!task) return 'Task not found.'
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
      return `Connected GitHub account: ${ghUser.login}${ghUser.name ? ` (${ghUser.name})` : ''}. You can now use github_list_repos, github_import_project, and github_sync_issues.`
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
