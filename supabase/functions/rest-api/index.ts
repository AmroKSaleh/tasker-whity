import { createClient } from 'npm:@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
}

function json(body: any, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })
}
function err(msg: string, status = 400) { return json({ error: msg }, status) }

// ── Auth ─────────────────────────────────────────────────────
async function hashKey(raw: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw))
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('')
}

async function resolveUser(sb: any, bearer: string): Promise<string | null> {
  if (bearer.startsWith('tsk_') || bearer.startsWith('tsk__')) {
    const hash = await hashKey(bearer)
    const { data } = await sb.from('user_api_keys').select('user_id').eq('key_hash', hash).maybeSingle()
    if (data?.user_id) return data.user_id
  }
  const { data } = await sb.from('oauth_tokens').select('user_id, expires_at').eq('access_token', bearer).maybeSingle()
  if (data?.user_id) {
    if (data.expires_at && new Date(data.expires_at) < new Date()) return null
    return data.user_id
  }
  return null
}

// ── Project helpers ──────────────────────────────────────────
async function resolveProject(sb: any, userId: string, id: string) {
  let { data } = await sb.from('projects').select('*').eq('slug', id).eq('user_id', userId).maybeSingle()
  if (!data) ({ data } = await sb.from('projects').select('*').eq('id', id).eq('user_id', userId).maybeSingle())
  return data
}

function slugify(name: string) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '-' + Date.now().toString(36)
}

// TDE-822: prefix is NOT NULL + unique per user (case-insensitive), 2-6 uppercase alphanumerics.
// Kept behaviourally identical to the MCP's deriveProjectPrefix — if you change one, change both.
const PREFIX_MAX = 6
async function deriveProjectPrefix(sb: any, userId: string, name: string): Promise<string | null> {
  const words = String(name || '').toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean)
  let base = words.length >= 2
    ? words.slice(0, PREFIX_MAX).map((w: string) => w[0]).join('')
    : (words[0] || '').slice(0, PREFIX_MAX)
  if (base.length < 2) base = (base + 'PRJ').slice(0, 3)
  base = base.slice(0, PREFIX_MAX)

  const { data: rows } = await sb.from('projects').select('prefix').eq('user_id', userId)
  const taken = new Set((rows || []).map((r: any) => (r.prefix || '').toUpperCase()).filter(Boolean))
  if (!taken.has(base)) return base
  // Suffix with digits until free rather than giving up — returning null here is what used to
  // let a prefix-less project through.
  for (let n = 2; n < 10000; n++) {
    const suffix = String(n)
    const cand = base.slice(0, Math.max(1, PREFIX_MAX - suffix.length)) + suffix
    if (!taken.has(cand)) return cand
  }
  return null
}

// ── Milestone helpers ────────────────────────────────────────
function milestoneLabel(s: any) { return typeof s === 'string' ? s : s?.summary ?? '' }

// ── Entry point ──────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors })

  // Parse path: strip /functions/v1/rest-api prefix
  const url = new URL(req.url)
  const path = url.pathname.replace(/^\/functions\/v1\/rest-api/, '') || '/'
  const segments = path.split('/').filter(Boolean)
  const method = req.method

  // Auth
  const authHeader = req.headers.get('authorization') ?? ''
  if (!authHeader.startsWith('Bearer ')) return err('Missing Bearer token', 401)
  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } })
  const userId = await resolveUser(sb, authHeader.slice(7).trim())
  if (!userId) return err('Invalid token', 401)

  // Body
  let body: any = {}
  if (method !== 'GET' && method !== 'DELETE') {
    try { body = await req.json() } catch { /* empty body ok */ }
  }

  // ── Routes ────────────────────────────────────────────────

  // GET /projects
  if (method === 'GET' && segments[0] === 'projects' && !segments[1]) {
    const [{ data: projects }, { data: tasks }] = await Promise.all([
      sb.from('projects').select('id, name, slug, context').eq('user_id', userId).order('sort_order'),
      sb.from('tasks').select('project_id, status').eq('user_id', userId),
    ])
    const counts: Record<string, { total: number; done: number }> = {}
    for (const t of tasks ?? []) {
      if (!counts[t.project_id]) counts[t.project_id] = { total: 0, done: 0 }
      counts[t.project_id].total++
      if (t.status === 'done') counts[t.project_id].done++
    }
    return json((projects ?? []).map((p: any) => {
      const c = counts[p.id] ?? { total: 0, done: 0 }
      return { ...p, progress: { done: c.done, total: c.total, percent: c.total > 0 ? Math.round(c.done / c.total * 100) : 0 } }
    }))
  }

  // POST /projects
  if (method === 'POST' && segments[0] === 'projects' && !segments[1]) {
    if (!body.name) return err('name is required')
    // TDE-822: this path used to insert no prefix at all, producing projects whose tasks could
    // never be addressed as PREFIX-n. prefix is now NOT NULL + unique per user in the DB.
    const prefix = await deriveProjectPrefix(sb, userId, body.prefix || body.name)
    if (!prefix) return err('Could not derive a unique project prefix; pass an explicit prefix.', 409)
    const { data, error } = await sb.from('projects').insert({ name: body.name, slug: slugify(body.name), user_id: userId, prefix, context: body.context ?? {} }).select().single()
    if (error) return err(error.message, 500)
    return json(data, 201)
  }

  // GET /projects/:id
  if (method === 'GET' && segments[0] === 'projects' && segments[1] && !segments[2]) {
    const project = await resolveProject(sb, userId, segments[1])
    if (!project) return err('Project not found', 404)
    const [{ data: sections }, { data: tasks }] = await Promise.all([
      sb.from('sections').select('*').eq('project_id', project.id).order('sort_order'),
      sb.from('tasks').select('*').eq('project_id', project.id).order('sort_order'),
    ])
    return json({ ...project, sections: sections ?? [], tasks: tasks ?? [] })
  }

  // PATCH /projects/:id/context
  if (method === 'PATCH' && segments[0] === 'projects' && segments[1] && segments[2] === 'context') {
    const project = await resolveProject(sb, userId, segments[1])
    if (!project) return err('Project not found', 404)
    const merged = { ...(project.context ?? {}), ...body }
    await sb.from('projects').update({ context: merged }).eq('id', project.id)
    return json({ ok: true })
  }

  // GET /projects/:id/sections
  if (method === 'GET' && segments[0] === 'projects' && segments[1] && segments[2] === 'sections') {
    const project = await resolveProject(sb, userId, segments[1])
    if (!project) return err('Project not found', 404)
    const { data } = await sb.from('sections').select('id, name, sort_order').eq('project_id', project.id).order('sort_order')
    return json(data ?? [])
  }

  // POST /projects/:id/sections
  if (method === 'POST' && segments[0] === 'projects' && segments[1] && segments[2] === 'sections') {
    const project = await resolveProject(sb, userId, segments[1])
    if (!project) return err('Project not found', 404)
    if (!body.name) return err('name is required')
    const { data, error } = await sb.from('sections').insert({ project_id: project.id, name: body.name }).select().single()
    if (error) return err(error.message, 500)
    return json(data, 201)
  }

  // GET /tasks — query: project_id, section_id, status
  if (method === 'GET' && segments[0] === 'tasks' && !segments[1]) {
    const { project_id, section_id, status } = Object.fromEntries(url.searchParams)
    let query = sb.from('tasks').select('id, text, detail, priority, status, due_date, section_id, project_id').eq('user_id', userId)
    if (project_id) {
      const p = await resolveProject(sb, userId, project_id)
      if (p) query = query.eq('project_id', p.id)
    }
    if (section_id) query = query.eq('section_id', section_id)
    if (status) query = query.eq('status', status)
    const { data } = await query.order('sort_order')
    return json(data ?? [])
  }

  // GET /tasks/ranked — query: project_id
  if (method === 'GET' && segments[0] === 'tasks' && segments[1] === 'ranked') {
    const { project_id } = Object.fromEntries(url.searchParams)
    let query = sb.from('tasks').select('*, project:projects(name,slug)').eq('user_id', userId).eq('status', 'pending')
    if (project_id) {
      const p = await resolveProject(sb, userId, project_id)
      if (p) query = query.eq('project_id', p.id)
    }
    const { data } = await query
    const SCORES: Record<string, number> = { rush: 100, high: 60, medium: 30, low: 10 }
    const now = new Date()
    const ranked = (data ?? [])
      .map((t: any) => {
        if (t.status !== 'pending') return null
        let score = SCORES[t.priority] ?? 0
        if (t.due_date) {
          const diff = Math.round((new Date(t.due_date).setHours(0,0,0,0) - now.setHours(0,0,0,0)) / 86400000)
          if (diff < 0) score += 80; else if (diff === 0) score += 50; else if (diff <= 3) score += 20
        }
        if (t.skip_count > 0) score = Math.max(1, Math.round(score / (1 + t.skip_count * 0.3)))
        return { ...t, _score: score }
      })
      .filter(Boolean)
      .sort((a: any, b: any) => b._score - a._score)
    return json(ranked)
  }

  // POST /tasks
  if (method === 'POST' && segments[0] === 'tasks' && !segments[1]) {
    if (!body.project_id || !body.text) return err('project_id and text are required')
    const project = await resolveProject(sb, userId, body.project_id)
    if (!project) return err('Project not found', 404)
    const { data, error } = await sb.from('tasks').insert({
      project_id: project.id, section_id: body.section_id ?? null,
      user_id: userId, text: body.text, detail: body.detail ?? null,
      priority: body.priority ?? 'medium', due_date: body.due_date ?? null, status: 'pending',
    }).select().single()
    if (error) return err(error.message, 500)
    return json(data, 201)
  }

  // PATCH /tasks/:id
  if (method === 'PATCH' && segments[0] === 'tasks' && segments[1] && !segments[2]) {
    const { data: task } = await sb.from('tasks').select('id').eq('id', segments[1]).eq('user_id', userId).maybeSingle()
    if (!task) return err('Task not found', 404)
    const allowed: Record<string, any> = {}
    for (const k of ['text', 'detail', 'priority', 'status', 'due_date']) if (body[k] !== undefined) allowed[k] = body[k]
    await sb.from('tasks').update(allowed).eq('id', segments[1])
    return json({ ok: true })
  }

  // POST /tasks/:id/complete
  if (method === 'POST' && segments[0] === 'tasks' && segments[1] && segments[2] === 'complete') {
    const { data: task } = await sb.from('tasks').select('id, text').eq('id', segments[1]).eq('user_id', userId).maybeSingle()
    if (!task) return err('Task not found', 404)
    await sb.from('tasks').update({ status: 'done', completed_at: new Date().toISOString() }).eq('id', segments[1])
    return json({ ok: true, message: `Marked "${task.text}" as done.` })
  }

  // POST /tasks/:id/uncomplete
  if (method === 'POST' && segments[0] === 'tasks' && segments[1] && segments[2] === 'uncomplete') {
    const { data: task } = await sb.from('tasks').select('id, text').eq('id', segments[1]).eq('user_id', userId).maybeSingle()
    if (!task) return err('Task not found', 404)
    await sb.from('tasks').update({ status: 'pending', completed_at: null }).eq('id', segments[1])
    return json({ ok: true, message: `Marked "${task.text}" as not done.` })
  }

  // DELETE /tasks/:id
  if (method === 'DELETE' && segments[0] === 'tasks' && segments[1] && !segments[2]) {
    const { data: task } = await sb.from('tasks').select('id').eq('id', segments[1]).eq('user_id', userId).maybeSingle()
    if (!task) return err('Task not found', 404)
    await sb.from('tasks').delete().eq('id', segments[1])
    return json({ ok: true })
  }

  // GET /tasks/:id/milestones
  if (method === 'GET' && segments[0] === 'tasks' && segments[1] && segments[2] === 'milestones' && !segments[3]) {
    const { data: task } = await sb.from('tasks').select('id, text').eq('id', segments[1]).eq('user_id', userId).maybeSingle()
    if (!task) return err('Task not found', 404)
    const { data: disc } = await sb.from('task_discussions').select('steps, checked_steps').eq('task_id', segments[1]).maybeSingle()
    const steps: any[] = disc?.steps ?? []
    const checked: boolean[] = disc?.checked_steps ?? []
    return json(steps.map((s: any, i: number) => ({ index: i, text: milestoneLabel(s), done: checked[i] ?? false })))
  }

  // POST /tasks/:id/milestones
  if (method === 'POST' && segments[0] === 'tasks' && segments[1] && segments[2] === 'milestones' && !segments[3]) {
    if (!body.text) return err('text is required')
    const { data: task } = await sb.from('tasks').select('id').eq('id', segments[1]).eq('user_id', userId).maybeSingle()
    if (!task) return err('Task not found', 404)
    const { data: disc } = await sb.from('task_discussions').select('id, steps, checked_steps').eq('task_id', segments[1]).maybeSingle()
    const steps = [...(disc?.steps ?? []), { summary: body.text, detail: '' }]
    const checked = [...(disc?.checked_steps ?? []), false]
    if (disc) {
      await sb.from('task_discussions').update({ steps, checked_steps: checked, updated_at: new Date().toISOString() }).eq('id', disc.id)
    } else {
      await sb.from('task_discussions').insert({ task_id: segments[1], user_id: userId, steps, checked_steps: checked, messages: [] })
    }
    return json({ ok: true, index: steps.length - 1 }, 201)
  }

  // POST /tasks/:id/milestones/:n/complete
  if (method === 'POST' && segments[0] === 'tasks' && segments[1] && segments[2] === 'milestones' && segments[3] && segments[4] === 'complete') {
    const idx = parseInt(segments[3])
    const { data: disc } = await sb.from('task_discussions').select('id, steps, checked_steps').eq('task_id', segments[1]).maybeSingle()
    if (!disc?.steps?.length || isNaN(idx) || idx < 0 || idx >= disc.steps.length) return err('Milestone not found', 404)
    const checked = [...(disc.checked_steps ?? new Array(disc.steps.length).fill(false))]
    checked[idx] = true
    await sb.from('task_discussions').update({ checked_steps: checked, updated_at: new Date().toISOString() }).eq('id', disc.id)
    return json({ ok: true })
  }

  // POST /tasks/:id/milestones/:n/uncomplete
  if (method === 'POST' && segments[0] === 'tasks' && segments[1] && segments[2] === 'milestones' && segments[3] && segments[4] === 'uncomplete') {
    const idx = parseInt(segments[3])
    const { data: disc } = await sb.from('task_discussions').select('id, steps, checked_steps').eq('task_id', segments[1]).maybeSingle()
    if (!disc?.steps?.length || isNaN(idx) || idx < 0 || idx >= disc.steps.length) return err('Milestone not found', 404)
    const checked = [...(disc.checked_steps ?? new Array(disc.steps.length).fill(false))]
    checked[idx] = false
    await sb.from('task_discussions').update({ checked_steps: checked, updated_at: new Date().toISOString() }).eq('id', disc.id)
    return json({ ok: true })
  }

  // DELETE /tasks/:id/milestones/:n
  if (method === 'DELETE' && segments[0] === 'tasks' && segments[1] && segments[2] === 'milestones' && segments[3]) {
    const idx = parseInt(segments[3])
    const { data: disc } = await sb.from('task_discussions').select('id, steps, checked_steps').eq('task_id', segments[1]).maybeSingle()
    if (!disc?.steps?.length || isNaN(idx) || idx < 0 || idx >= disc.steps.length) return err('Milestone not found', 404)
    const steps = disc.steps.filter((_: any, i: number) => i !== idx)
    const checked = (disc.checked_steps ?? []).filter((_: any, i: number) => i !== idx)
    await sb.from('task_discussions').update({ steps, checked_steps: checked, updated_at: new Date().toISOString() }).eq('id', disc.id)
    return json({ ok: true })
  }

  return err('Not found', 404)
})
