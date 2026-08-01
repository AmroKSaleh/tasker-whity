import { createClient } from 'npm:@supabase/supabase-js@2'
import * as jose from 'https://deno.land/x/jose@v4.14.4/index.ts'
import { inputEdges, inputSourceIds, outputContract, lintRule, deriveOutputFromConsumers, contractAdvisories, renderContractAdvisory } from './contract_gate.ts'
import { serializeTaskFile, serializeProjectJson, parseTaskFile, contentHash, kbFileSlug, serializeStructure, parseStructure } from './local_format.ts'
import {
  buildPullMaps, buildProjectMeta, dbRowToTaskerTask, resolveFlushChange, resolveFlushDelete,
  leaseFreeIds, shortIdWithinLease, parseShortRef, LEASE_BLOCK, LEASE_MIN_FREE, UNFILED_SLUG,
  type DbTaskRow, type LeaseState,
} from './sync_core.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
}

// RFC 9728: the WWW-Authenticate `resource_metadata` param must point at the PROTECTED-RESOURCE
// metadata document (which references the authorization server), NOT the RFC 8414 auth-server doc.
const RESOURCE_METADATA_URL = 'https://smarttasksxdd.netlify.app/.well-known/oauth-protected-resource'

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

// ── Timestamps ───────────────────────────────────────────────
// A bare date makes the reader do arithmetic to find out whether it is stale, so
// "last edited" always ships with its distance from now.
function agoLabel(iso: string | null | undefined, now = Date.now()): string | null {
  if (!iso) return null
  const then = new Date(iso).getTime()
  if (!Number.isFinite(then)) return null
  const days = Math.floor((now - then) / 86400000)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 30) return `${days}d ago`
  const months = Math.floor(days / 30)
  return months < 12 ? `${months}mo ago` : `${Math.floor(days / 365)}y ago`
}

// Timestamps are stored UTC but read by a person, and a UTC wall clock is not the time
// they remember working. Accepts an IANA zone ("Asia/Amman") or a fixed offset ("+03:00");
// unset or unparseable falls back to UTC, always labeled so the reader knows which it got.
function zoneLabel(tz?: string | null): string {
  const m = /^([+-])(\d{2}):?(\d{2})$/.exec((tz ?? '').trim())
  if (m) return `GMT${m[1]}${Number(m[2])}${m[3] === '00' ? '' : ':' + m[3]}`
  return tz?.trim() || 'UTC'
}

function formatStamp(iso: string | null | undefined, tz?: string | null, withZone = true): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (!Number.isFinite(d.getTime())) return '—'
  const suffix = withZone ? ` ${zoneLabel(tz)}` : ''
  const m = /^([+-])(\d{2}):?(\d{2})$/.exec((tz ?? '').trim())
  if (m) {
    const mins = (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]))
    return `${new Date(d.getTime() + mins * 60000).toISOString().slice(0, 16).replace('T', ' ')}${suffix}`
  }
  if (tz?.trim()) {
    try {
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: tz.trim(), year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
      }).formatToParts(d)
      const get = (t: string) => parts.find((p: any) => p.type === t)?.value ?? ''
      return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}${suffix}`
    } catch { /* unknown zone — fall through to UTC rather than throwing on a read */ }
  }
  return `${d.toISOString().slice(0, 16).replace('T', ' ')}${withZone ? ' UTC' : ''}`
}

// One lightweight lookup rather than threading the preference through every call site.
async function userTimezone(sb: any, userId: string): Promise<string | null> {
  const { data } = await sb.from('user_settings').select('ai_instructions').eq('user_id', userId).maybeSingle()
  return data?.ai_instructions?.timezone ?? null
}

// ── Auth ─────────────────────────────────────────────────────

async function getScopedClient(userId: string) {
  const secretStr = Deno.env.get('AUTH_JWT_SECRET')
  if (!secretStr) throw new Error('AUTH_JWT_SECRET is required to generate scoped tokens.')
  const secret = new TextEncoder().encode(secretStr)
  const jwt = await new jose.SignJWT({ sub: userId, role: 'authenticated' })
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('5m')
    .sign(secret)
  
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
  if (!anonKey) throw new Error('SUPABASE_ANON_KEY is required to generate scoped tokens.')

  return createClient(SUPABASE_URL, anonKey, {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  })
}

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

// TDE-375: token-derived actor (provenance) — which agent/client a key represents. Kept SEPARATE
// from resolveApiKey and best-effort (never throws) so it can NEVER affect authentication.
async function resolveActor(sb: any, raw: string): Promise<string | null> {
  try {
    if (raw.startsWith('tsk_')) {
      const hash = await hashKey(raw)
      const { data } = await sb.from('user_api_keys').select('agent_label').eq('key_hash', hash).maybeSingle()
      return data?.agent_label ?? null
    }
  } catch (_) { /* provenance is best-effort — swallow and fall through */ }
  return null
}

// TDE-377 (Path B): enqueue an outbound-webhook delivery for every active endpoint the user has
// that subscribes to this event and matches the project (project_id null = all projects). Payload
// follows Linear's proven shape {action,type,actor,data,updatedFrom,webhookTimestamp}. Best-effort
// + fire-and-forget: it must NEVER slow or fail a mutation. The pg_cron drain (webhook-dispatch fn)
// does the HMAC signing + POST + retry ladder — nothing is sent from inside the write handler.
async function emitWebhook(
  sb: any,
  userId: string,
  ev: { projectId: string | null; event: string; action: 'create' | 'update' | 'remove'; type: string; data: any; updatedFrom?: any; actor?: string | null },
): Promise<void> {
  try {
    const { data: hooks } = await sb.from('webhooks')
      .select('id, project_id, events')
      .eq('user_id', userId).eq('active', true)
    if (!hooks?.length) return
    const matching = hooks.filter((h: any) =>
      (h.project_id === null || h.project_id === ev.projectId) &&
      Array.isArray(h.events) && h.events.includes(ev.event))
    if (!matching.length) return
    const payload = {
      event: ev.event,
      action: ev.action,
      type: ev.type,
      actor: ev.actor ?? 'user',
      data: ev.data,
      updatedFrom: ev.updatedFrom ?? null,
      webhookTimestamp: Date.now(),
    }
    const rows = matching.map((h: any) => ({ webhook_id: h.id, user_id: userId, event: ev.event, payload }))
    await sb.from('webhook_deliveries').insert(rows)
  } catch (_) { /* outbound notification is best-effort — never affect the mutation */ }
}

// ── Durable gate history (TDE-818) ────────────────────────────
// Append a row to task_events, the immutable record of what changed on a task's
// contract / gate / review state. Every gate ceremony used to be an in-place overwrite:
// a later set_task_output erased that a human had confirmed, each review attempt
// overwrote the previous verdict, and validation ledgers were keyed per edge rather than
// per attempt. This is the write path that makes that history durable.
//
// AWAITED, unlike emitWebhook. A webhook is a notification and may be dropped; this is the
// audit record, so it is ordered before the tool's response rather than fired into the void.
// It still NEVER fails the mutation — a lost audit row must not block a human confirming a
// contract — but a drop is recorded in mcp_error_logs so it is detectable rather than silent.
async function recordTaskEvent(
  sb: any,
  userId: string,
  ev: {
    taskId: string
    kind: 'contract_set' | 'contract_cleared' | 'contract_confirmed' | 'review_bar_frozen'
        | 'review_bar_cleared' | 'review_submitted' | 'validation_submitted' | 'fields_changed'
    entity: 'output_contract' | 'input_contract' | 'review' | 'validation' | 'task'
    summary: string
    actor?: string | null
    before?: any
    after?: any
    meta?: any
  },
): Promise<void> {
  try {
    const { error } = await sb.from('task_events').insert({
      task_id: ev.taskId,
      user_id: userId,
      kind: ev.kind,
      entity: ev.entity,
      actor: ev.actor ?? null,
      summary: ev.summary,
      before: ev.before ?? null,
      after: ev.after ?? null,
      meta: ev.meta ?? null,
    })
    if (error) throw new Error(error.message)
  } catch (e) {
    fireAndForget(sb.from('mcp_error_logs').insert({
      user_id: userId,
      tool_name: `recordTaskEvent:${ev.kind}`,
      raw_params: { task_id: ev.taskId, entity: ev.entity, summary: ev.summary },
      error_msg: `task_events insert dropped: ${e instanceof Error ? e.message : String(e)}`,
    }))
  }
}

// TDE-819: record a task LIFECYCLE change (status / location / closure) made by a handler that
// writes to `tasks` directly instead of going through update_task. Without this, get_task_history
// was blind to the most basic question a reader asks — a task being COMPLETED left no trace.
// Reuses kind='fields_changed' rather than adding a kind, so the CHECK constraint in migration
// 20260728120000 does not need altering; `meta.via` carries which handler did it.
async function recordLifecycleChange(
  sb: any,
  userId: string,
  ev: { taskId: string; via: string; summary: string; before?: any; after?: any; actor?: string | null; extra?: any },
): Promise<void> {
  await recordTaskEvent(sb, userId, {
    taskId: ev.taskId,
    kind: 'fields_changed',
    entity: 'task',
    actor: ev.actor,
    summary: ev.summary,
    before: ev.before ?? null,
    after: ev.after ?? null,
    meta: {
      via: ev.via,
      fields: Object.keys(ev.after && typeof ev.after === 'object' ? ev.after : {}),
      ...(ev.extra ?? {}),
    },
  })
}

// Compact a contract for storage in task_events: keep the shape and the blessing provenance,
// drop nothing that matters for answering "what was the bar, and had a human blessed it?".
function contractSnapshot(contract: any) {
  if (!contract || typeof contract !== 'object') return null
  return {
    rule_count: Array.isArray(contract.rules) ? contract.rules.length : 0,
    rules: Array.isArray(contract.rules) ? contract.rules : [],
    confirmed: contract.confirmed === true,
    ...(contract.confirmed_at ? { confirmed_at: contract.confirmed_at } : {}),
    ...(contract.confirmed_by ? { confirmed_by: contract.confirmed_by } : {}),
  }
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
  let { data } = await sb.from('projects').select('id, name, slug, prefix, context, active_phase_id').eq('slug', projectId).eq('user_id', userId).maybeSingle()
  if (!data) ({ data } = await sb.from('projects').select('id, name, slug, prefix, context, active_phase_id').eq('id', projectId).eq('user_id', userId).maybeSingle())
  if (!data) ({ data } = await sb.from('projects').select('id, name, slug, prefix, context, active_phase_id').ilike('prefix', projectId).eq('user_id', userId).maybeSingle())
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
  const { data: project } = await sb.from('projects').select('id, name, slug, prefix, context, active_phase_id').eq('id', data.default_project_id).eq('user_id', userId).maybeSingle()
  return project ?? null
}

// ── Phase resolver (TDE-804) ──────────────────────────────────
// Accepts a UUID, a slug, or an exact (case-insensitive) name, scoped to one project so
// two projects may reuse "Phase 1" freely. Returns null for the literal "unphased" too —
// callers that support it must check that sentinel BEFORE calling this.
const PHASE_COLS = 'id, name, slug, sort_order, exit_condition, due_date'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// ── Cursor pagination (TDE-378 item c) ─────────────────────────────────────────
// Keyset pagination on (sortCol, id) — not OFFSET, so results stay stable while
// rows are being edited between pages. Cursor is opaque to the caller: a base64
// [sortValue, id] pair. sortCol must be included in the row's select() so the
// cursor for the LAST row of a page can be built from the fetched data itself.
const DEFAULT_PAGE_SIZE = 50
const MAX_PAGE_SIZE = 200

function encodeCursor(sortValue: string | number, id: string): string {
  return btoa(JSON.stringify([sortValue, id]))
}
function decodeCursor(cursor: string): { sortValue: string | number, id: string } | null {
  try {
    const parsed = JSON.parse(atob(cursor))
    if (!Array.isArray(parsed) || parsed.length !== 2) return null
    const [sortValue, id] = parsed
    if ((typeof sortValue !== 'string' && typeof sortValue !== 'number') || typeof id !== 'string') return null
    return { sortValue, id }
  } catch { return null }
}
// Appends the keyset WHERE for "rows strictly after this cursor" given the query's sort
// direction. ascending: ">" then tie-break "="+">" on id; descending: the mirror "<".
function applyCursor(query: any, sortCol: string, cursor: { sortValue: string | number, id: string } | null, ascending: boolean) {
  if (!cursor) return query
  const op = ascending ? 'gt' : 'lt'
  const sv = typeof cursor.sortValue === 'string' ? `"${cursor.sortValue}"` : cursor.sortValue
  return query.or(`${sortCol}.${op}.${sv},and(${sortCol}.eq.${sv},id.${op}.${cursor.id})`)
}
function clampLimit(n: any): number {
  const v = Number(n)
  if (!Number.isFinite(v) || v <= 0) return DEFAULT_PAGE_SIZE
  return Math.min(Math.floor(v), MAX_PAGE_SIZE)
}

// Relative-duration parser for updated_since filters: "7d", "2w", "1mo", "P2W" (ISO 8601
// duration, weeks/days only — the units Tasker's data actually spans). Absolute ISO dates
// pass through resolveSince unchanged. Returns null (no filter) on anything unparseable —
// callers should not fail loudly on a malformed date the agent can just retry.
function parseRelativeDuration(s: string): number | null {
  const iso = s.match(/^P(?:(\d+)W)?(?:(\d+)D)?$/i)
  if (iso && (iso[1] || iso[2])) {
    const weeks = iso[1] ? parseInt(iso[1], 10) : 0
    const days = iso[2] ? parseInt(iso[2], 10) : 0
    return (weeks * 7 + days) * 24 * 60 * 60 * 1000
  }
  const short = s.match(/^(\d+)\s*(d|day|days|w|wk|week|weeks|mo|month|months)$/i)
  if (short) {
    const n = parseInt(short[1], 10)
    const unit = short[2].toLowerCase()
    if (unit.startsWith('d')) return n * 24 * 60 * 60 * 1000
    if (unit.startsWith('w')) return n * 7 * 24 * 60 * 60 * 1000
    if (unit.startsWith('mo')) return n * 30 * 24 * 60 * 60 * 1000
  }
  return null
}
function resolveSince(s: string): string | null {
  if (!s) return null
  const rel = parseRelativeDuration(s.trim())
  if (rel != null) return new Date(Date.now() - rel).toISOString()
  const t = Date.parse(s)
  return Number.isFinite(t) ? new Date(t).toISOString() : null
}

async function resolvePhase(sb: any, projectId: string, ref: string) {
  if (!ref) return null
  const base = () => sb.from('phases').select(PHASE_COLS).eq('project_id', projectId)
  // Guard the uuid probe: querying a uuid column with a non-uuid string is a PostgREST
  // 400 that supabase-js swallows into data:null — correct, but a wasted round-trip.
  if (UUID_RE.test(ref)) {
    const { data } = await base().eq('id', ref).maybeSingle()
    if (data) return data
  }
  let { data } = await base().eq('slug', ref).maybeSingle()
  if (!data) ({ data } = await base().ilike('name', ref).maybeSingle())
  return data ?? null
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
async function findOrCreateDriveFolder(token: string, parentId: string, name: string): Promise<string> {
  const q = encodeURIComponent(`name='${name}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`)
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id)`, { headers: { Authorization: `Bearer ${token}` } })
  const data = await res.json()
  if (data.files?.length) return data.files[0].id
  const create = await fetch('https://www.googleapis.com/drive/v3/files', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] }),
  })
  const folder = await create.json()
  if (!folder.id) throw new Error(`Failed to create Drive folder "${name}"`)
  return folder.id
}

async function moveDriveFilesToFolder(sb: any, token: string, task: any, userId: string, targetName: string): Promise<void> {
  const driveFiles: any[] = task.output?.drive_files ?? []
  if (!driveFiles.length) return
  const { data: settings } = await sb.from('user_settings').select('google_drive_folder_id').eq('user_id', userId).maybeSingle()
  const taskerRootId = settings?.google_drive_folder_id
  if (!taskerRootId) return
  const { data: proj } = await sb.from('projects').select('google_drive_folder_id').eq('id', task.project_id).maybeSingle()
  const projectFolderId = proj?.google_drive_folder_id
  if (!projectFolderId) return
  const targetFolderId = await findOrCreateDriveFolder(token, projectFolderId, targetName)
  for (const file of driveFiles) {
    try {
      const metaRes = await fetch(`https://www.googleapis.com/drive/v3/files/${file.file_id}?fields=parents`, { headers: { Authorization: `Bearer ${token}` } })
      const meta = await metaRes.json()
      const oldParents = (meta.parents ?? []).join(',')
      await fetch(`https://www.googleapis.com/drive/v3/files/${file.file_id}?addParents=${targetFolderId}&removeParents=${oldParents}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: '{}',
      })
    } catch (e) {
      console.error('[mcp] drive move failed:', file.file_id, e)
    }
  }
}

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
        .select('id, text, detail, input, output, status, short_id, flow_id, flow_step, project_id, section_id, kind, seed_target, seed_open_questions, review_enabled, review_bar, review_verdict, tags')
        .eq('project_id', project.id).eq('short_id', shortId).eq('user_id', userId)
        .maybeSingle()
      if (task) return task
    }
  }
  // Fall back to UUID
  const { data } = await sb.from('tasks')
    .select('id, text, detail, input, output, status, short_id, flow_id, flow_step, project_id, section_id, kind, seed_target, seed_open_questions, review_enabled, review_bar, review_verdict, tags').eq('id', taskRef).eq('user_id', userId).maybeSingle()
  return data ?? null
}

// ── Duplicate defense (TDE-379) — lexical similarity, NO server-side AI ───────
// Bigram Dice coefficient on normalized titles: 1.0 identical, ~0 unrelated. Cheap + deterministic;
// the AI agent (already in the loop) decides what to do with the candidates the server surfaces.
function normTitle(s: string): string {
  return (s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim()
}
function titleBigrams(s: string): string[] {
  const out: string[] = []
  for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2))
  return out
}
function diceSimilarity(a: string, b: string): number {
  const na = normTitle(a), nb = normTitle(b)
  if (!na || !nb) return 0
  if (na === nb) return 1
  const ba = titleBigrams(na), bb = titleBigrams(nb)
  if (!ba.length || !bb.length) return 0
  const counts: Record<string, number> = {}
  for (const g of ba) counts[g] = (counts[g] || 0) + 1
  let matched = 0
  for (const g of bb) if (counts[g] > 0) { matched++; counts[g]-- }
  return (2 * matched) / (ba.length + bb.length)
}
// Existing tasks in the project ranked by title similarity to `text`, above `floor`.
async function findSimilarTasks(sb: any, projectId: string, text: string, floor = 0.5): Promise<any[]> {
  const { data } = await sb.from('tasks').select('id, text, short_id, status, duplicate_of').eq('project_id', projectId)
  return ((data ?? []) as any[])
    .map((t: any) => ({ ...t, sim: diceSimilarity(text, t.text) }))
    .filter((t: any) => t.sim >= floor && !t.duplicate_of)
    .sort((a: any, b: any) => b.sim - a.sim)
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
// The I/O-edge model (inputEdges/inputSourceIds/outputContract), the rule-quality
// linter (lintRule), the derive-from-input governance (deriveOutputFromConsumers),
// and the verifiable contract gate (contractGateViolations) live in contract_gate.ts
// — extracted for unit testing (TDE-287). Imported at the top of this file.

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

// Foundation = the project's grounding, stored in projects.context (TDE-262). Fixed-core
// fields render first in a stable order; any flexible/extra keys the agent added per
// project type render after. One renderer, used by get_project (full) and get_task
// (grounding injection on every task).
const FOUNDATION_LABELS: Record<string, string> = {
  goal: 'Goal',
  why: 'Why (intent)',
  scope: 'Scope (in / out)',
  definition_of_done: 'Success looks like',
  done_looks_like: 'Success looks like',     // legacy alias
  failure: 'Failure looks like (anti-goals)',
  quality_bar: 'Quality bar',
  success_metrics: 'Success metrics',
  audience: 'Audience',
  constraints: 'Constraints',
  risks: 'Risks',
  ai_behavior: 'AI working style / autonomy',
  assumptions: 'Assumptions & open questions',
  coherence_decisions: 'Deliberate decisions (why)',
}
const FOUNDATION_ORDER = ['goal', 'why', 'scope', 'definition_of_done', 'done_looks_like', 'failure', 'quality_bar', 'success_metrics', 'audience', 'constraints', 'risks', 'ai_behavior', 'assumptions', 'coherence_decisions']

function renderFoundation(ctx: any): string[] {
  if (!ctx || typeof ctx !== 'object') return []
  const seen = new Set<string>()
  const out: string[] = []
  const emit = (key: string) => {
    if (seen.has(key)) return
    const val = ctx[key]
    if (val == null || val === '') return
    let text: string
    // coherence_decisions (TDE-300): deliberate decisions + their rationale, captured
    // during the bootstrap probe. Render one-per-line so multi-clause "decision — because"
    // entries stay readable instead of being ';'-smushed into one blob.
    if (key === 'coherence_decisions' && Array.isArray(val)) {
      const entries = val.filter(Boolean).map((v: any) => String(v).trim()).filter(Boolean)
      if (!entries.length) return
      seen.add(key)
      // One multi-line entry: the label takes the caller's "- " prefix (where added),
      // the bullets carry their own "•" — so no double marker in any caller.
      out.push(`${FOUNDATION_LABELS[key]}:\n` + entries.map((e: string) => `  • ${e}`).join('\n'))
      return
    }
    if (Array.isArray(val)) {
      text = val.filter(Boolean).join('; ')
    } else if (typeof val === 'object') {
      // Nested objects (e.g. scope: { in, out }) — flatten to readable sub-fields
      // instead of "[object Object]".
      text = Object.entries(val)
        .filter(([, v]) => v != null && String(v).trim())
        .map(([k, v]) => `${k.replace(/_/g, ' ').toUpperCase()}: ${Array.isArray(v) ? v.filter(Boolean).join('; ') : v}`)
        .join('  ·  ')
    } else {
      text = String(val)
    }
    if (!text.trim()) return
    seen.add(key)
    const label = FOUNDATION_LABELS[key] || key.replace(/_/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase())
    out.push(`${label}: ${text}`)
  }
  for (const k of FOUNDATION_ORDER) emit(k)
  for (const k of Object.keys(ctx)) emit(k)   // flexible / unknown keys, in insertion order
  return out
}

// Derive a 2–5 uppercase-letter prefix (the short-ID handle, e.g. WMP-3) from a project
// name, unique within the user's projects. Returns null if a clean one can't be found.
async function deriveProjectPrefix(sb: any, userId: string, name: string): Promise<string | null> {
  const words = String(name || '').toUpperCase().split(/[^A-Z]+/).filter(Boolean)
  let base = (words.length >= 2 ? words.slice(0, 4).map((w: string) => w[0]).join('') : (words[0] || '').slice(0, 4))
  if (base.length < 2) base = (base + 'PRJ').slice(0, 3)
  base = base.slice(0, 5)
  const { data: rows } = await sb.from('projects').select('prefix').eq('user_id', userId)
  const taken = new Set((rows || []).map((r: any) => (r.prefix || '').toUpperCase()).filter(Boolean))
  for (const suffix of ['', 'X', 'Y', 'Z', 'A', 'B', 'C', 'D', 'E', 'F']) {
    const cand = (base.slice(0, 5 - suffix.length) + suffix)
    if (cand.length >= 2 && cand.length <= 5 && !taken.has(cand)) return cand
  }
  return null
}

// Returned in the `instructions` field of the initialize response — the one place the
// MCP can teach the model at CONNECTION time, with no tool call required (clients that
// support InitializeResult.instructions feed it into the model's context). Keep it tight:
// the mental model + the first move + the few rules that must hold even if the model
// never calls __init_tasker_session. The detailed playbook stays in ASSISTANT_DIRECTIVES.
// ── Local Mode bundle transport (TDE-410 follow-up) ──────────────────────────
// Default pull no longer streams ~300KB of file contents through the agent's
// context: pull_local_project returns a SHORT-LIVED signed bundle URL + a tiny
// hydrate script; the agent runs the script and the bytes go server→disk.
// Token: base64url(payload).base64url(HMAC-SHA256(payload, service key)).

function b64url(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
function b64urlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4))
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad)
  return Uint8Array.from(bin, c => c.charCodeAt(0))
}
async function hmacSign(payload: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(SUPABASE_SERVICE_KEY), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload))
  return b64url(new Uint8Array(sig))
}
const BUNDLE_TOKEN_TTL_MS = 15 * 60 * 1000

async function signBundleToken(projectId: string, userId: string, deviceId: string, cursor: number): Promise<string> {
  const payload = b64url(new TextEncoder().encode(JSON.stringify({
    p: projectId, u: userId, d: deviceId, c: cursor,
    exp: Date.now() + BUNDLE_TOKEN_TTL_MS, n: crypto.randomUUID().slice(0, 8),
  })))
  return `${payload}.${await hmacSign(payload)}`
}
async function verifyBundleToken(token: string): Promise<{ p: string; u: string; d: string; c: number } | null> {
  const dot = token.lastIndexOf('.')
  if (dot < 1) return null
  const payload = token.slice(0, dot)
  if (token.slice(dot + 1) !== await hmacSign(payload)) return null
  try {
    const data = JSON.parse(new TextDecoder().decode(b64urlDecode(payload)))
    if (!data.exp || Date.now() > data.exp) return null
    return data
  } catch { return null }
}

// ── Scoped device tokens (immediate-sync watcher) ────────────────────────────
// A watch.mjs process runs for hours, so the 15-min bundle token won't do. A
// device token is a long-lived, revocable secret scoped to ONE project on ONE
// device: even if it leaks it can only pull/flush that one project's .tasker/.
// We store only its SHA-256 (never the plaintext); the secret is shown once at mint.

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('')
}

// Resolve a presented device token to its scope, or null. Touches last_used_at.
async function resolveDeviceToken(sb: any, token: string): Promise<{ project_id: string; user_id: string; device_id: string } | null> {
  if (!token || !token.startsWith('dt_')) return null
  const hash = await sha256Hex(token)
  const { data } = await sb.from('local_device_tokens')
    .select('id, project_id, user_id, device_id, revoked_at')
    .eq('token_hash', hash).is('revoked_at', null).maybeSingle()
  if (!data) return null
  fireAndForget(sb.from('local_device_tokens').update({ last_used_at: new Date().toISOString() }).eq('id', data.id))
  return { project_id: data.project_id, user_id: data.user_id, device_id: data.device_id }
}

// The whole pull-state build: files map + lease + tombstone diff. Shared by the
// inline tool path and the GET bundle endpoint (single source of truth).
async function buildLocalBundle(sb: any, userId: string, project: any, deviceId: string, cursor: number): Promise<{ error: string } | {
  files: Record<string, string>; cursor: number; prefix: string
  tombstoned_short_ids: number[]; lease: LeaseState; next_free_ids: number[]
}> {
  const [{ data: proj }, { data: sections }, { data: groups }, { data: taskRows }] = await Promise.all([
    sb.from('projects').select('local_mode, local_revision').eq('id', project.id).maybeSingle(),
    sb.from('sections').select('id, name, sort_order, slug').eq('project_id', project.id).order('sort_order'),
    sb.from('groups').select('id, name, section_id, sort_order, slug').eq('project_id', project.id).order('sort_order'),
    sb.from('tasks').select('id, short_id, text, detail, status, priority, due_date, section_id, group_id, sort_order, input, output, review_enabled, review_bar, updated_at, local_rev')
      .eq('project_id', project.id).eq('user_id', userId),
  ])
  if (!proj?.local_mode) return { error: `"${project.name}" is not a Local Mode project. Enable Local Mode first (web app → project settings), then pull again.` }

  const tasks: DbTaskRow[] = (taskRows || []).filter((t: any) => t.short_id != null)
  const prefix = project.prefix || 'TSK'
  const maps = buildPullMaps(prefix, sections || [], groups || [], tasks)
  const maxShort = tasks.reduce((m, t) => Math.max(m, t.short_id || 0), 0)
  const needUnfiled = tasks.some(t => !t.section_id)
  const meta = buildProjectMeta(project.name, prefix, maxShort + 1, sections || [], groups || [], maps, needUnfiled)

  // Grounding is written ONCE per pull as dedicated files — NOT stamped into every
  // task (that footer duplicated the full IS N times → ~2.2x the online token cost;
  // TDE grounding-restructure 2026-07-18). Task files are now footer-free; the agent
  // reads the IS / Foundation / KB grounding once per session, same as online tiering.
  const { data: projIs } = await sb.from('project_instructions').select('title, content').eq('project_id', project.id).order('created_at')

  // Milestones live in task_discussions.steps (+ parallel checked_steps). Emit ONLY
  // plain milestones (kind absent) — seed checklist items (kind question/prerequisite)
  // are NOT milestones and never surface in the file.
  const { data: discRows } = await sb.from('task_discussions').select('task_id, steps, checked_steps').in('task_id', tasks.map(t => t.id))
  const milestonesByTaskId = new Map<string, Array<{ text: string; done: boolean }>>()
  for (const d of discRows || []) {
    const steps: any[] = Array.isArray(d.steps) ? d.steps : []
    const checked: any[] = Array.isArray(d.checked_steps) ? d.checked_steps : []
    const ms: Array<{ text: string; done: boolean }> = []
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i]
      const kind = (s && typeof s === 'object') ? s.kind : undefined
      if (kind === 'question' || kind === 'prerequisite') continue // seed checklist — not a milestone
      const text = typeof s === 'string' ? s : String(s?.summary ?? '')
      if (text) ms.push({ text, done: checked[i] === true })
    }
    if (ms.length) milestonesByTaskId.set(d.task_id, ms)
  }

  const files: Record<string, string> = {}
  files['project.json'] = serializeProjectJson(meta)
  for (const row of tasks) files[`tasks/${prefix}-${row.short_id}.md`] = serializeTaskFile(dbRowToTaskerTask(row, prefix, maps, milestonesByTaskId.get(row.id)))

  // structure.json — the writable manifest for rename/reorder/delete of sections+groups
  // (TDE-713). Excludes the synthetic Unfiled section (not a real row). slug = frozen id.
  files['structure.json'] = serializeStructure({
    sections: meta.sections.filter(s => s.id !== UNFILED_SLUG).map(s => ({ slug: s.id, name: s.name, order: s.order })),
    groups: meta.groups.map(g => ({ slug: g.id, name: g.name, section: g.section, order: g.order })),
  })

  // [prefix]-instruction-set.md — the full project IS, once. The single governing rulebook.
  const lc = prefix.toLowerCase()
  if (projIs?.length) {
    files[`${lc}-instruction-set.md`] = [
      `# ⚖ Instruction Set — governs every task in ${project.name} (project-wide)`,
      '',
      '_READ THIS ONCE at session start. It governs all work in this project. Read-only snapshot, regenerated on every pull — never synced up (edit the IS via the web app / MCP)._',
      '',
      ...projIs.flatMap((e: any) => [`## ${e.title}`, '', e.content, '']),
    ].join('\n')
  }

  // [prefix]-foundation.md — goal/why/scope/success/risks, once.
  const foundationLines = renderFoundation(project.context)
  if (foundationLines.length) {
    files[`${lc}-foundation.md`] = [
      `# ${project.name} — Foundation`,
      '',
      '_The project\'s north star. Read once at session start. Read-only snapshot._',
      '',
      ...foundationLines.map((l: string) => `- ${l}`),
      '',
    ].join('\n')
  }

  // kb/ — one file per KB entry (title + body), mirrored on pull, READ-ONLY offline.
  // Agents read only the 2-3 they need. Authoring stays an MCP ceremony (no KB LWW).
  const { data: kbEntries } = await sb.from('project_knowledge')
    .select('id, title, content, source')
    .eq('project_id', project.id).is('archived_at', null)
    .order('created_at', { ascending: false }).limit(200)
  const kbIndex: Array<{ title: string; file: string }> = []
  const usedKbNames = new Set<string>()
  for (const e of kbEntries || []) {
    let base = kbFileSlug(String(e.title || 'untitled'))
    let name = `${base}.md`
    let n = 2
    while (usedKbNames.has(name)) { name = `${base}-${n}.md`; n++ } // disambiguate collisions
    usedKbNames.add(name)
    kbIndex.push({ title: String(e.title || 'untitled'), file: `kb/${name}` })
    files[`kb/${name}`] = [
      `# ${e.title}`,
      '',
      `_KB entry · source: ${e.source || 'agent'} · READ-ONLY mirror (edit via create_kb_entry/update_kb_entry over MCP)._`,
      '',
      String(e.content || ''),
      '',
    ].join('\n')
  }

  // context.md — the once-per-session entry point: pointers to grounding + KB index.
  const ctxLines: string[] = [
    `# ${project.name} — session grounding (READ-ONLY, regenerated on every pull)`,
    '',
    'Read this once at session start. It points at the grounding files and indexes the KB.',
    '',
  ]
  if (projIs?.length) ctxLines.push(`- **Instruction Set** → \`${lc}-instruction-set.md\` — the rules governing all work here. Read it.`)
  if (foundationLines.length) ctxLines.push(`- **Foundation** → \`${lc}-foundation.md\` — goal / why / scope.`)
  ctxLines.push('')
  if (kbIndex.length) {
    ctxLines.push('## Knowledge Base — index (read only the entries relevant to your task; each is a file in `kb/`)', '')
    for (const k of kbIndex) ctxLines.push(`- ${k.title} → \`${k.file}\``)
    ctxLines.push('')
  }
  files['context.md'] = ctxLines.join('\n')

  files['README.md'] = [
    `# .tasker/ — ${project.name} (Local Mode)`,
    '',
    'This folder is the LOCAL mirror of a Tasker project. Agents: work the tasks by editing these files directly — no per-edit network calls.',
    '',
    `- GROUNDING (read once per session): \`context.md\` points at \`${lc}-instruction-set.md\` (the governing rules — FOLLOW them), \`${lc}-foundation.md\` (goal/why/scope), and indexes \`kb/\` (one file per KB entry; read only the few relevant to your task). These are read-only snapshots, regenerated on every pull, never synced up.`,
    '- One task = one file in tasks/ (YAML frontmatter + markdown body = the task context). Task files no longer carry the IS footer — the IS lives in its own file above.',
    '- PULL before starting work: call pull_local_project — it returns a short-lived bundle URL + a hydrate.mjs script; write the script and run `node hydrate.mjs` to (re)write this folder. (Pass inline:true only if node is unavailable.)',
    `- Create a task: new file tasks/${prefix}-<id>.md using ONLY ids from .sync.json lease/next_free_ids; stamp updated_at (ISO, UTC, now).`,
    '- Edit a task: change the file; ALWAYS re-stamp updated_at. Delete a task: delete the file and report its numeric id in deleted_short_ids on flush.',
    '- FLUSH after each work unit: call flush_local_project with the files you changed + base_cursor from .sync.json; write any hub_wins contents back to disk and update the cursor in .sync.json.',
    '- input / output / review in frontmatter are READ-ONLY carriage (contracts are hub ceremonies). Milestones are hub-only in v1 (not in these files). KB bodies in kb/ are READ-ONLY (author via MCP).',
    '- Never hand-edit .sync.json. context.md and the grounding files are read-only snapshots.',
  ].join('\n')
  files['.gitignore'] = '.sync.json\ncontext.md\n'

  // ID lease (D8): reuse this device's newest block if enough of it is free, else lease a fresh one.
  const { data: myLeases } = await sb.from('local_id_leases').select('lease_start, lease_end')
    .eq('project_id', project.id).eq('device_id', deviceId).eq('user_id', userId).order('lease_end', { ascending: false }).limit(1)
  // IDs are never reused: live tasks AND tombstoned (retired) ids both count as used.
  const { data: allTombs } = await sb.from('local_tombstones').select('short_id').eq('project_id', project.id)
  const used = new Set<number>(tasks.map(t => t.short_id))
  for (const t of allTombs || []) { const n = Number(t.short_id); if (Number.isFinite(n)) used.add(n) }
  let lease: LeaseState | null = myLeases?.length ? { start: myLeases[0].lease_start, end: myLeases[0].lease_end } : null
  // A lease that doesn't sit ABOVE the live short-ID range is invalid — never hand out retired IDs.
  if (lease && lease.start <= maxShort) lease = null
  if (!lease || leaseFreeIds(lease, used).length < LEASE_MIN_FREE) {
    const { data: topLease } = await sb.from('local_id_leases').select('lease_end').eq('project_id', project.id).order('lease_end', { ascending: false }).limit(1)
    const base = Math.max(maxShort, topLease?.[0]?.lease_end || 0)
    lease = { start: base + 1, end: base + LEASE_BLOCK }
    const { error: leaseErr } = await sb.from('local_id_leases').insert({
      project_id: project.id, user_id: userId, device_id: deviceId, lease_start: lease.start, lease_end: lease.end,
    })
    if (leaseErr) return { error: `Failed to lease an ID block: ${leaseErr.message}` }
  }
  const freeIds = leaseFreeIds(lease, used)

  const { data: tombs } = await sb.from('local_tombstones').select('short_id, local_rev')
    .eq('project_id', project.id).gt('local_rev', cursor)
  const newCursor = proj.local_revision || 0
  const hashes: Record<string, string> = {}
  for (const [p, c] of Object.entries(files)) hashes[p] = contentHash(c)
  files['.sync.json'] = JSON.stringify({
    project: project.name, project_id: project.id, prefix, device_id: deviceId,
    cursor: newCursor, lease, next_free_ids: freeIds.slice(0, 10), hashes,
    pulled_note: 'machine-local sync state — never hand-edit, never commit',
  }, null, 2) + '\n'

  return {
    files, cursor: newCursor, prefix,
    tombstoned_short_ids: (tombs || []).map((t: any) => Number(t.short_id)).filter(Number.isFinite),
    lease, next_free_ids: freeIds.slice(0, 10),
  }
}

// The whole flush apply: per-task LWW, edit-beats-delete, lease-gated creates,
// tombstones. Shared by the flush_local_project tool and the device_flush watcher
// endpoint (single source of truth for the sync engine's write path).
async function applyFlush(
  sb: any, userId: string, project: any, deviceId: string, baseCursor: number,
  changed: Array<{ path?: string; content?: string }>, deletedIds: number[],
): Promise<{ error: string } | {
  cursor: number; applied: string[]; created: string[]; deleted: string[]
  created_groups: string[]; created_sections: string[]; structure_changes: string[]
  rejected: string[]; warnings: string[]; hub_wins: Array<{ path: string; content: string; reason: string }>
}> {
  const [{ data: proj }, { data: sections }, { data: groups }, { data: taskRows }, { data: leaseRows }, { data: tombRows }] = await Promise.all([
    sb.from('projects').select('local_mode, local_revision').eq('id', project.id).maybeSingle(),
    sb.from('sections').select('id, name, sort_order, slug').eq('project_id', project.id).order('sort_order'),
    sb.from('groups').select('id, name, section_id, sort_order, slug').eq('project_id', project.id).order('sort_order'),
    sb.from('tasks').select('id, short_id, text, detail, status, priority, due_date, section_id, group_id, sort_order, input, output, review_enabled, review_bar, updated_at, local_rev')
      .eq('project_id', project.id).eq('user_id', userId),
    sb.from('local_id_leases').select('lease_start, lease_end').eq('project_id', project.id).eq('device_id', deviceId).eq('user_id', userId),
    sb.from('local_tombstones').select('short_id, local_rev').eq('project_id', project.id),
  ])
  if (!proj?.local_mode) return { error: `"${project.name}" is not a Local Mode project — nothing to flush.` }
  // hub_wins corrections are footer-free, matching the pull format (grounding lives
  // in dedicated files now, not per-task footers).

  const tasks: DbTaskRow[] = (taskRows || []).filter((t: any) => t.short_id != null)
  const prefix = project.prefix || 'TSK'
  const maps = buildPullMaps(prefix, sections || [], groups || [], tasks)
  const byShort = new Map<number, DbTaskRow>(tasks.map(t => [t.short_id, t]))
  const byUuid = new Map<string, DbTaskRow>(tasks.map(t => [t.id, t]))
  const leases: LeaseState[] = (leaseRows || []).map((l: any) => ({ start: l.lease_start, end: l.lease_end }))
  const tombRevByShort = new Map<number, number>()
  for (const t of tombRows || []) {
    const cur = tombRevByShort.get(t.short_id) ?? -1
    if (t.local_rev > cur) tombRevByShort.set(t.short_id, t.local_rev)
  }

  const applied: string[] = [], created: string[] = [], deleted: string[] = [], rejected: string[] = [], warnings: string[] = []
  const createdGroups: string[] = []
  const createdSections: string[] = []
  const structureChanges: string[] = [] // TDE-713: rename/reorder/delete of sections+groups via structure.json
  const hubWins: Array<{ path: string; content: string; reason: string }> = []

  // Apply structure.json (TDE-713): reconcile the manifest against the hub by FROZEN
  // slug. rename = name changed; reorder = order changed; delete = a hub row whose slug
  // is ABSENT from the manifest (group → its tasks fall to ungrouped; section → REFUSED
  // if it still holds tasks or groups). CREATE is NOT here — that's create-by-reference
  // (a manifest slug with no hub row is ignored with a note). Whole-manifest LWW is
  // handled by the caller via updated_at; here we just apply.
  const applyStructure = async (content: string) => {
    const { manifest, warnings: mw } = parseStructure(content)
    for (const w of mw) warnings.push(`structure.json: ${w.message}`)
    if (!manifest) { rejected.push('structure.json: unparseable'); return }

    const hubSectionBySlug = new Map((sections || []).map((s: any) => [s.slug, s]))
    const hubGroupBySlug = new Map((groups || []).map((g: any) => [g.slug, g]))
    const fileSectionSlugs = new Set(manifest.sections.map(s => s.slug))
    const fileGroupSlugs = new Set(manifest.groups.map(g => g.slug))

    // SECTIONS: rename + reorder
    for (const s of manifest.sections) {
      const hub = hubSectionBySlug.get(s.slug)
      if (!hub) { warnings.push(`structure.json: section slug "${s.slug}" has no hub row — ignored (create sections by referencing them from a task)`); continue }
      const patch: Record<string, unknown> = {}
      if (s.name && s.name !== hub.name) patch.name = s.name
      if (Number.isFinite(s.order) && s.order !== hub.sort_order) patch.sort_order = s.order
      if (Object.keys(patch).length) {
        const { error } = await sb.from('sections').update(patch).eq('id', hub.id).eq('project_id', project.id)
        if (error) rejected.push(`structure.json: section "${s.slug}" update failed — ${error.message}`)
        else structureChanges.push(`section ${s.slug}: ${Object.keys(patch).join('+')}`)
      }
    }
    // GROUPS: rename + reorder (+ section reparent by slug)
    for (const g of manifest.groups) {
      const hub = hubGroupBySlug.get(g.slug)
      if (!hub) { warnings.push(`structure.json: group slug "${g.slug}" has no hub row — ignored (create groups by referencing them from a task)`); continue }
      const patch: Record<string, unknown> = {}
      if (g.name && g.name !== hub.name) patch.name = g.name
      if (Number.isFinite(g.order) && g.order !== hub.sort_order) patch.sort_order = g.order
      const newSecId = g.section ? hubSectionBySlug.get(g.section)?.id : undefined
      if (newSecId && newSecId !== hub.section_id) patch.section_id = newSecId
      if (Object.keys(patch).length) {
        const { error } = await sb.from('groups').update(patch).eq('id', hub.id).eq('project_id', project.id)
        if (error) rejected.push(`structure.json: group "${g.slug}" update failed — ${error.message}`)
        else structureChanges.push(`group ${g.slug}: ${Object.keys(patch).join('+')}`)
      }
    }
    // DELETE groups: hub group absent from the manifest → delete; its tasks fall to ungrouped.
    for (const [slug, hub] of hubGroupBySlug) {
      if (fileGroupSlugs.has(slug as string)) continue
      await sb.from('tasks').update({ group_id: null }).eq('group_id', (hub as any).id).eq('user_id', userId)
      const { error } = await sb.from('groups').delete().eq('id', (hub as any).id).eq('project_id', project.id)
      if (error) rejected.push(`structure.json: group "${slug}" delete failed — ${error.message}`)
      else structureChanges.push(`group ${slug}: deleted (tasks ungrouped)`)
    }
    // DELETE sections: only if empty (no tasks AND no groups). Otherwise REFUSE.
    for (const [slug, hub] of hubSectionBySlug) {
      if (fileSectionSlugs.has(slug as string)) continue
      const secId = (hub as any).id
      const { count: taskCount } = await sb.from('tasks').select('id', { count: 'exact', head: true }).eq('section_id', secId).eq('user_id', userId)
      const stillHasGroup = (groups || []).some((g: any) => g.section_id === secId && fileGroupSlugs.has(g.slug))
      if ((taskCount || 0) > 0 || stillHasGroup) {
        warnings.push(`structure.json: section "${slug}" NOT deleted — still has ${taskCount || 0} task(s)${stillHasGroup ? ' and group(s)' : ''}; empty it first (section delete is guarded)`)
        continue
      }
      const { error } = await sb.from('sections').delete().eq('id', secId).eq('project_id', project.id)
      if (error) rejected.push(`structure.json: section "${slug}" delete failed — ${error.message}`)
      else structureChanges.push(`section ${slug}: deleted (was empty)`)
    }
  }

  // Section create-by-reference: an unknown `section:` slug creates that section
  // (named verbatim = slug-is-name → round-trips exactly, same rationale as groups).
  // Registered in maps immediately so sibling tasks in the same flush reuse it.
  const resolveSectionForTask = async (t: ReturnType<typeof parseTaskFile>['task'] & object): Promise<string | null> => {
    const slug = t.section
    if (!slug || slug === UNFILED_SLUG) return null // unfiled → ungrouped/no section
    const existing = maps.sectionIdBySlug.get(slug)
    if (existing) return existing
    const { data: maxRow } = await sb.from('sections').select('sort_order').eq('project_id', project.id).order('sort_order', { ascending: false }).limit(1)
    const nextSort = (maxRow?.[0]?.sort_order ?? 0) + 1
    const { data: ins, error } = await sb.from('sections').insert({
      project_id: project.id, name: slug, sort_order: nextSort, slug, // frozen slug = the referenced slug (slug-is-name)
    }).select('id').single()
    if (error || !ins) { warnings.push(`${t.id}: could not create section "${slug}" — ${error?.message || 'insert failed'}; task left in the hub's section`); return null }
    maps.sectionIdBySlug.set(slug, ins.id) // sibling tasks reuse it
    createdSections.push(slug)
    return ins.id
  }

  // Create-by-reference (TDE-581): an unknown `group:` slug on a task that has a
  // section creates that group IN that section. The created group is NAMED the slug
  // verbatim (slug-is-name) so it round-trips exactly on the next pull — slugify(slug)
  // === slug, so the reference can never drift. Cosmetic renames stay an MCP/web op.
  // The new group is registered in maps immediately so sibling tasks in the SAME flush
  // referencing the same slug bind to it instead of creating a duplicate.
  const resolveGroupForTask = async (t: ReturnType<typeof parseTaskFile>['task'] & object, sectionId: string | null): Promise<string | null> => {
    if (!t.group) return null
    const g = maps.groupIdBySlug.get(t.group)
    if (g) {
      if (sectionId && g.section_id !== sectionId) {
        warnings.push(`${t.id}: group "${t.group}" exists in another section — left ungrouped`)
        return null
      }
      return g.id
    }
    // Unknown slug → create, but only if we know which section to put it in.
    if (!sectionId) {
      warnings.push(`${t.id}: group "${t.group}" does not exist and the task has no section — left ungrouped`)
      return null
    }
    const { data: maxRow } = await sb.from('groups').select('sort_order').eq('section_id', sectionId).order('sort_order', { ascending: false }).limit(1)
    const nextSort = (maxRow?.[0]?.sort_order ?? 0) + 1
    const { data: ins, error } = await sb.from('groups').insert({
      project_id: project.id, section_id: sectionId, name: t.group, sort_order: nextSort, slug: t.group, // frozen slug = referenced slug
    }).select('id').single()
    if (error || !ins) { warnings.push(`${t.id}: could not create group "${t.group}" — ${error?.message || 'insert failed'}; left ungrouped`); return null }
    maps.groupIdBySlug.set(t.group, { id: ins.id, section_id: sectionId }) // sibling tasks reuse it
    createdGroups.push(t.group)
    return ins.id
  }

  const fileFields = async (t: ReturnType<typeof parseTaskFile>['task'] & object) => {
    const sectionId = await resolveSectionForTask(t)
    const groupId = await resolveGroupForTask(t, sectionId)
    return {
      text: t.title, detail: t.body || null, status: t.status, priority: t.priority,
      due_date: t.due || null, section_id: sectionId, group_id: groupId,
      sort_order: t.order ?? 0, updated_at: t.updated_at || new Date().toISOString(),
    }
  }

  // Reconcile a task's milestones from its file. WHOLE-LIST-REPLACE of the PLAIN
  // milestones (kind absent). CLOBBER GUARD: if the hub row has ANY kind-tagged step
  // (seed question/prerequisite), this is a seed — leave its checklist ENTIRELY
  // untouched and warn instead (seed checklists are MCP-only). Rebuilds steps +
  // checked_steps in one update, preserving any kind-tagged entries in place.
  const reconcileMilestones = async (taskId: string, fileTaskId: string, fileMs: Array<{ text: string; done: boolean }> | undefined) => {
    if (fileMs === undefined) return // milestones: absent in file → do not touch the hub
    const { data: disc } = await sb.from('task_discussions').select('id, steps, checked_steps').eq('task_id', taskId).maybeSingle()
    const steps: any[] = Array.isArray(disc?.steps) ? disc!.steps : []
    const checked: any[] = Array.isArray(disc?.checked_steps) ? disc!.checked_steps : []
    const hasSeedItems = steps.some(s => s && typeof s === 'object' && (s.kind === 'question' || s.kind === 'prerequisite'))
    if (hasSeedItems) {
      warnings.push(`${fileTaskId}: has a seed checklist — milestones in the file were NOT applied (edit seed checklists via MCP)`)
      return
    }
    // No seed items → the whole list is plain milestones; safe to replace wholesale.
    const newSteps = fileMs.map(m => ({ summary: m.text, detail: '' }))
    const newChecked = fileMs.map(m => m.done === true)
    // no-op if unchanged (avoid churn / spurious updated_at bumps)
    const sameLen = steps.length === newSteps.length
    const unchanged = sameLen && newSteps.every((s, i) => String(steps[i]?.summary ?? steps[i] ?? '') === s.summary && (checked[i] === true) === newChecked[i])
    if (unchanged) return
    if (disc?.id) {
      await sb.from('task_discussions').update({ steps: newSteps, checked_steps: newChecked }).eq('id', disc.id)
    } else if (newSteps.length) {
      await sb.from('task_discussions').insert({ task_id: taskId, user_id: userId, steps: newSteps, checked_steps: newChecked, messages: [] })
    }
  }

  for (const f of changed) {
    const path = String(f?.path || '')
    if (path === 'structure.json') { await applyStructure(String(f.content || '')); continue }
    if (!/^tasks\/.+\.md$/.test(path)) { rejected.push(`${path || '(no path)'}: only tasks/*.md and structure.json are applied`); continue }
    const { task, warnings: pw } = parseTaskFile(String(f.content || ''), path)
    for (const w of pw) warnings.push(`${w.path}: ${w.message}`)
    if (!task) { rejected.push(`${path}: unparseable frontmatter`); continue }
    const sid = parseShortRef(task.id)
    if (sid === null) { rejected.push(`${path}: id "${task.id}" is not <PREFIX>-<number>`); continue }
    const hubRow = byShort.get(sid) || null
    const tombRev = tombRevByShort.get(sid) ?? null
    const decision = resolveFlushChange(task.updated_at,
      hubRow ? { updated_at: hubRow.updated_at ?? null, local_rev: hubRow.local_rev ?? 0 } : null,
      tombRev, baseCursor)

    if (decision === 'hub_wins') {
      hubWins.push({ path, content: serializeTaskFile(dbRowToTaskerTask(hubRow!, prefix, maps)), reason: 'hub has a newer (or tied) concurrent edit — write this content back' })
      continue
    }
    const fields = await fileFields(task)
    if (decision === 'apply') {
      // Flow-dependency guard mirrors complete_task: don't let a file edit start/finish a gated task early.
      if ((fields.status === 'done' || fields.status === 'in_progress') && hubRow!.status !== fields.status) {
        const unmet = inputSourceIds(hubRow!.input).map(id => byUuid.get(id)).filter(s => s && s.status !== 'done')
        if (unmet.length) {
          warnings.push(`${task.id}: status change to ${fields.status} blocked — upstream not done (${unmet.map(u => `${prefix}-${u!.short_id}`).join(', ')}); other fields applied`)
          fields.status = hubRow!.status as any
        }
      }
      const { error } = await sb.from('tasks').update(fields).eq('id', hubRow!.id).eq('user_id', userId)
      if (error) rejected.push(`${task.id}: update failed — ${error.message}`)
      else { applied.push(task.id); await reconcileMilestones(hubRow!.id, task.id, task.milestones) }
    } else { // create | resurrect_edit_beats_delete
      if (decision === 'create' && !shortIdWithinLease(sid, leases)) {
        rejected.push(`${task.id}: id ${sid} is outside this device's leased block(s) — use ids from .sync.json next_free_ids`)
        continue
      }
      const { data: insTask, error } = await sb.from('tasks').insert({
        user_id: userId, project_id: project.id, short_id: sid, ...fields,
      }).select('id').single()
      if (error) rejected.push(`${task.id}: insert failed — ${error.message}`)
      else { created.push(task.id); if (insTask?.id) await reconcileMilestones(insTask.id, task.id, task.milestones) }
    }
  }

  for (const sid of deletedIds) {
    const hubRow = byShort.get(sid) || null
    const decision = resolveFlushDelete(hubRow ? { updated_at: hubRow.updated_at ?? null, local_rev: hubRow.local_rev ?? 0 } : null, baseCursor)
    if (decision === 'edit_beats_delete_keep') {
      hubWins.push({ path: `tasks/${prefix}-${sid}.md`, content: serializeTaskFile(dbRowToTaskerTask(hubRow!, prefix, maps)), reason: 'edited on the hub since your pull — edit beats delete; restore this file' })
      continue
    }
    if (!hubRow) { deleted.push(`${prefix}-${sid}`); continue } // already gone — idempotent
    const { data: curProj } = await sb.from('projects').select('local_revision').eq('id', project.id).maybeSingle()
    const nextRev = (curProj?.local_revision || 0) + 1
    await sb.from('projects').update({ local_revision: nextRev }).eq('id', project.id)
    const { error: delErr } = await sb.from('tasks').delete().eq('id', hubRow.id).eq('user_id', userId)
    if (delErr) { rejected.push(`${prefix}-${sid}: delete failed — ${delErr.message}`); continue }
    await sb.from('local_tombstones').insert({
      project_id: project.id, user_id: userId, task_id: hubRow.id, short_id: String(sid), local_rev: nextRev,
    })
    deleted.push(`${prefix}-${sid}`)
  }

  // Structural edits (rename/reorder/delete via structure.json) don't touch tasks.local_rev,
  // so bump the project cursor explicitly so other devices see the change on their next pull.
  if (structureChanges.length) {
    const { data: cur } = await sb.from('projects').select('local_revision').eq('id', project.id).maybeSingle()
    await sb.from('projects').update({ local_revision: (cur?.local_revision || 0) + 1 }).eq('id', project.id)
  }

  const { data: after } = await sb.from('projects').select('local_revision').eq('id', project.id).maybeSingle()
  return { cursor: after?.local_revision || 0, applied, created, deleted, created_groups: createdGroups, created_sections: createdSections, structure_changes: structureChanges, rejected, warnings, hub_wins: hubWins }
}

function hydrateScript(bundleUrl: string): string {
  return [
    '// hydrate.mjs — writes/refreshes the .tasker/ mirror in the CURRENT directory.',
    '// Run: node hydrate.mjs   (then delete this file or keep it; the URL inside expires in ~15 min)',
    "import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'",
    "import { join, dirname } from 'node:path'",
    `const res = await fetch(${JSON.stringify(bundleUrl)})`,
    "if (!res.ok) { console.error('bundle fetch failed:', res.status, await res.text()); process.exit(1) }",
    'const p = await res.json()',
    'for (const [path, content] of Object.entries(p.files)) {',
    "  const f = join('.tasker', path); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, content, 'utf8')",
    '}',
    'for (const sid of p.tombstoned_short_ids || []) {',
    "  const f = join('.tasker', 'tasks', `${p.prefix}-${sid}.md`); if (existsSync(f)) rmSync(f)",
    '}',
    "console.log(JSON.stringify({ status: 'hydrated', file_count: Object.keys(p.files).length, cursor: p.cursor, lease: p.lease, next_free_ids: p.next_free_ids }, null, 2))",
    '',
  ].join('\n')
}

// watch.mjs — immediate-sync watcher. Runs standalone under `node watch.mjs` in
// the directory containing .tasker/. Flushes local edits within ~1s of a save and
// polls the hub every ~15s for changes made online / on another device. Auth is
// the embedded scoped device token (this-project-only). contentHash is inlined to
// match local_format.ts (FNV-1a) so it agrees with the .sync.json the server wrote.
function watchScript(base: string, token: string, projectRef: string): string {
  return [
    '// watch.mjs — live two-way sync for this .tasker/ folder. Run: node watch.mjs',
    '// Leave it running while you (or an agent) edit tasks; Ctrl-C to stop.',
    '// The token below is scoped to THIS project only. Revoke via revoke_device_token.',
    "import { readFileSync, writeFileSync, readdirSync, existsSync, rmSync, mkdirSync, watch } from 'node:fs'",
    "import { join, dirname } from 'node:path'",
    '',
    `const BASE = ${JSON.stringify(base)}`,
    `const TOKEN = ${JSON.stringify(token)}`,
    `const PROJECT = ${JSON.stringify(projectRef)}`,
    "const DIR = '.tasker'",
    "const TASKS = join(DIR, 'tasks')",
    'const POLL_MS = 15000',
    'const DEBOUNCE_MS = 800',
    '',
    '// FNV-1a — byte-identical to the server (local_format.ts contentHash).',
    'function contentHash(text) {',
    '  let h = 0x811c9dc5',
    '  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) }',
    '  return (h >>> 0).toString(16).padStart(8, "0")',
    '}',
    'function loadSync() { return JSON.parse(readFileSync(join(DIR, ".sync.json"), "utf8")) }',
    'function saveSync(s) { writeFileSync(join(DIR, ".sync.json"), JSON.stringify(s, null, 2) + "\\n", "utf8") }',
    'function taskFiles() { return existsSync(TASKS) ? readdirSync(TASKS).filter(f => f.endsWith(".md")) : [] }',
    'function shortId(prefix, name) { const m = new RegExp("^" + prefix + "-(\\\\d+)\\\\.md$").exec(name); return m ? Number(m[1]) : null }',
    'async function api(qs, body) {',
    '  const res = await fetch(`${BASE}?${qs}=${TOKEN}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) })',
    '  const text = await res.text(); let j; try { j = JSON.parse(text) } catch { j = { error: text } }',
    '  if (!res.ok) throw new Error(`${res.status}: ${j.error || text}`)',
    '  return j',
    '}',
    '',
    '// Push local changes: diff current task files against .sync.json hashes.',
    'async function flush() {',
    '  const sync = loadSync()',
    '  const prefix = sync.prefix',
    '  const prev = sync.hashes || {}',
    '  const changed = []',
    '  const present = new Set()',
    '  for (const f of taskFiles()) {',
    '    const rel = `tasks/${f}`; present.add(rel)',
    '    const content = readFileSync(join(TASKS, f), "utf8")',
    '    if (contentHash(content) !== prev[rel]) changed.push({ path: rel, content })',
    '  }',
    '  // Deletions: task files that were in the last sync but are gone now.',
    '  const deleted = []',
    '  for (const rel of Object.keys(prev)) {',
    '    if (rel.startsWith("tasks/") && rel.endsWith(".md") && !present.has(rel)) {',
    '      const sid = shortId(prefix, rel.slice("tasks/".length)); if (sid !== null) deleted.push(sid)',
    '    }',
    '  }',
    '  if (!changed.length && !deleted.length) return',
    '  const r = await api("device_flush", { base_cursor: sync.cursor, changed_files: changed, deleted_short_ids: deleted })',
    '  // Apply hub_wins corrections back to disk.',
    '  for (const hw of r.hub_wins || []) { const f = join(DIR, hw.path); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, hw.content, "utf8") }',
    '  // Recompute hashes from disk (authoritative post-flush state) and store the new cursor.',
    '  const hashes = {}',
    '  for (const [k, v] of Object.entries(prev)) if (!k.startsWith("tasks/")) hashes[k] = v', // keep project.json/context.md/etc hashes
    '  for (const f of taskFiles()) hashes[`tasks/${f}`] = contentHash(readFileSync(join(TASKS, f), "utf8"))',
    '  sync.cursor = r.cursor; sync.hashes = hashes; saveSync(sync)',
    '  const parts = []',
    '  if (r.created?.length) parts.push(`+${r.created.length}`)',
    '  if (r.applied?.length) parts.push(`~${r.applied.length}`)',
    '  if (r.deleted?.length) parts.push(`-${r.deleted.length}`)',
    '  if ((r.hub_wins||[]).length) parts.push(`hub_wins ${r.hub_wins.length}`)',
    '  if ((r.rejected||[]).length) parts.push(`rejected ${r.rejected.length}`)',
    '  console.log(`↑ flush @cursor ${r.cursor} [${parts.join(" ") || "noop"}]`)',
    '  for (const w of r.rejected || []) console.warn("  reject:", w)',
    '}',
    '',
    '// Pull hub changes: only when the hub cursor moved past ours.',
    'let pulling = false',
    'async function pullIfBehind() {',
    '  if (pulling) return; pulling = true',
    '  try {',
    '    const sync = loadSync()',
    '    const { cursor: hubCursor } = await api("device_poll", {})',
    '    if ((hubCursor || 0) <= (sync.cursor || 0)) return',
    '    const b = await api("device_pull", { cursor: sync.cursor })',
    '    suppress = true // do not let our own writes retrigger flush',
    '    for (const [path, content] of Object.entries(b.files)) { const f = join(DIR, path); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, content, "utf8") }',
    '    for (const sid of b.tombstoned_short_ids || []) { const f = join(TASKS, `${b.prefix}-${sid}.md`); if (existsSync(f)) rmSync(f) }',
    '    console.log(`↓ pull  @cursor ${b.cursor} [${Object.keys(b.files).length} files, -${(b.tombstoned_short_ids||[]).length}]`)',
    '    setTimeout(() => { suppress = false }, 300)',
    '  } finally { pulling = false }',
    '}',
    '',
    'let suppress = false',
    'let timer = null',
    'function schedule() {',
    '  if (suppress) return',
    '  clearTimeout(timer)',
    '  timer = setTimeout(() => { flush().catch(e => console.error("flush error:", e.message)) }, DEBOUNCE_MS)',
    '}',
    '',
    'if (!existsSync(join(DIR, ".sync.json"))) { console.error("No .tasker/.sync.json here — run the hydrate step (pull_local_project) first."); process.exit(1) }',
    'console.log(`⇄ watching ${DIR}/ for ${PROJECT} — flush on save, poll hub every ${POLL_MS/1000}s. Ctrl-C to stop.`)',
    '// Initial reconcile both directions.',
    'await pullIfBehind().catch(e => console.error("pull error:", e.message))',
    'await flush().catch(e => console.error("flush error:", e.message))',
    'watch(TASKS, { persistent: true }, () => schedule())',
    'setInterval(() => { pullIfBehind().catch(e => console.error("pull error:", e.message)) }, POLL_MS)',
    '',
  ].join('\n')
}

const TASKER_SERVER_INSTRUCTIONS = `Tasker is a task manager that lives inside your AI workflow. Hierarchy: Project → Section → Group → Task → Milestone. Tasks can be linked by I/O edges (one task's output is another's input) into FLOWS — multi-step processes with quality gates (contracts) between steps.

YOUR NATIVE TASK LIST vs TASKER — ROUTE DURABLE WORK HERE, BY DEFAULT: whenever you are about to record a piece of work, first ask "is this DURABLE?" — does a human want it persisted, shared, reviewed, or quality-gated, or does it outlive this one session? If YES, it belongs in Tasker (create_task) — NOT in your platform's native to-do list. Reach for Tasker by default for real work; do not leave durable items sitting in a native list where they vanish when the session ends. Durable → Tasker: a bug you found while doing something else, a follow-up the human will care about later, work someone assigned you, a decision that needs tracking. Transient → keep native: "read file X", "run the test", "fix the import on line 40" — the private, per-step scratchpad for executing the item in front of you. Your native list stays your execution tool; do NOT mirror those transient sub-steps into Tasker (that just floods the spine with noise). So: pull durable work from get_ready_work, use your native plan to EXECUTE one item, and write the outcome back (complete_task, reviews, stored artifacts). Tasker is the durable spine across sessions, agents, and people; your native list is how you do one item on it.

FIRST MOVE: at the start of a Tasker session call __init_tasker_session. It returns the user's behavioral preferences plus the full directive playbook (task lifecycle, running flows, validation, dependency rules). Read and follow those directives.

LOCAL MODE: some projects are mirrored to .tasker/ files in a repo checkout (opt-in per project). If the working directory has a .tasker/ folder — or a project refuses normal access saying it is Local Mode — work it through FILES, not per-edit MCP calls: PULL before starting work (pull_local_project → it returns a hydrate_script; write it as hydrate.mjs and run "node hydrate.mjs" to materialize/refresh .tasker/ — file bytes never pass through your context), READ .tasker/context.md before working any task (it carries the Foundation + Instruction Set that get_task would inject online — locally, reading it IS that step), edit tasks/<ID>.md files directly as the hot path (always re-stamp updated_at), and FLUSH after each work unit (flush_local_project with your changed files + base_cursor from .sync.json → write any hub_wins corrections back to disk). Completion ceremonies (complete_task, reviews, validation) still run via MCP at flush time. Never hand-edit .sync.json; input/output/review in frontmatter are read-only carriage.

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
  'ATTENTION FIRST (TDE-383): right after __init_tasker_session, call get_my_attention — one cross-task pull of what needs the human/you: tasks awaiting the human\'s review, pending GUIDANCE a human left on tasks (picked up even across sessions), agent sessions AWAITING INPUT (blocked on a question), STALE in-progress work, and OVERDUE items. It is your "what needs me?" triage before picking up anything new. Then act on the highest-priority item.',
  'DURABLE WORK BELONGS IN TASKER (use Tasker by default, not your native list): whenever you are about to record a piece of work, ask "is this DURABLE?" — does a human want it persisted, shared, reviewed, or quality-gated, or does it outlive this session? If YES → create it in Tasker (create_task), do NOT leave it in your platform\'s native to-do list where it vanishes at session end. Durable → Tasker: a bug found while doing something else, a follow-up the human will care about later, work someone assigned you, a decision that needs tracking. Transient → keep native: "read file X", "run the test", "fix the import on line 40" — the private per-step scratchpad for executing the item in front of you; do NOT mirror those into Tasker (it floods the spine with noise). Tasker is the durable spine; your native list is how you execute one item on it. (This is a strong default, not a lock — the MCP cannot disable your host\'s native to-do tool; the choice is yours to make correctly.)',
  'LOCAL MODE WORK BRACKET: projects with Local Mode enabled are mirrored to .tasker/ files in a repo checkout — the FILES are the hot path, not per-edit MCP calls. The bracket: (1) PULL before starting work — call pull_local_project(project, device_id); it returns a hydrate_script: write it as hydrate.mjs in the directory that should contain .tasker/ and run `node hydrate.mjs` (it downloads the bundle over a short-lived signed URL, writes every file, deletes tombstoned task files, and prints a JSON summary with the cursor/lease — you may delete the script after). Only if node is unavailable, re-call with inline:true and write the returned file map yourself. (2) GROUND: every task file ends with a ⚖ GOVERNANCE footer carrying the FULL Instruction Set — it is auto-injected on every pull precisely so reading a task means reading its rules; FOLLOW it, never edit it (it is stripped on flush, never synced). Read .tasker/context.md once per session for the Foundation + KB index. (3) WORK the tasks by reading/editing tasks/<ID>.md directly — task body = context, frontmatter = fields; ALWAYS re-stamp updated_at (ISO, UTC) on every edit; create new tasks ONLY with ids from .sync.json next_free_ids; delete = remove the file and remember its numeric id. (4) FLUSH after each work unit (task completed / handoff reached — not every keystroke) — call flush_local_project with the changed files + base_cursor from .sync.json, write any hub_wins corrections back to disk, update the cursor in .sync.json. Ceremonies still go through MCP at flush time: complete_task, submit_task_review, submit_validation_result, store_artifact. input/output/review frontmatter is READ-ONLY carriage (contract edits go through the normal tools). Never hand-edit .sync.json; context.md and README.md are regenerated snapshots. Multi-device consistency comes from the hub — newest updated_at wins conflicts, deletes propagate as tombstones, and a concurrent edit beats a delete. IMMEDIATE SYNC (optional): if the human will hand-edit .tasker/ files in an editor, or wants the web board to update live, call pull_local_project with watch:true — it returns a watch_script; save it as watch.mjs next to .tasker/ and run `node watch.mjs` in a spare terminal. It flushes edits within ~1s of a save and pulls hub changes every ~15s, using a project-scoped device token (revoke via revoke_device_token). Without the watcher, the pull-before / flush-after bracket above is the sync; the watcher just removes the manual flush.',
  'AUTONOMOUS WORK LOOP: When the user says "start looping" (or any clearly similar phrase — "start the loop", "clock in the worker", "run autonomously", "work my queue"), work Tasker\'s ready queue hands-off. Each pass: call get_ready_work, then (A) EXECUTE every CONFIRMED proposal EXACTLY as its agent_proposal text says (the human may have edited it — the proposal IS your instruction; no new scope) — verify it works, write a KB entry for anything non-obvious, then clear it via update_task(id, agent_proposal:"") and complete_task only if genuinely done; (B) fully PREPARE the top handed-over (agent_ready) task — investigate and resolve every decision so a confirmed run is pure mechanical application — record it via update_task(id, agent_proposal:"<complete plan>"), then STOP it for the human\'s ASYNC web confirmation. NEVER execute a prepared task until it returns CONFIRMED — the human\'s web confirm (and their edits) is the gate. Unattended rules: do NOT call AskUserQuestion or wait for a chat reply (instead skip the task, append a note stating the open question, and continue), stay quiet on an empty queue, skip-and-flag blockers, NEVER guess on destructive/irreversible actions, and honor stop_flow. CONTINUOUS looping needs a client-side scheduler — on Claude Code run `/loop 2m /work-loop` (or a shorter interval); on a client without a scheduler, run one on-demand pass per request. This runs on the user\'s OWN session at $0 marginal cost (their subscription, not the API) and ONLY while that session stays open; the parked cloud receiver (TDE-398) is the PC-closed alternative that costs API $ per task.',
  'When you begin working on a task, the FIRST thing to do is set its status to in_progress. Calling get_task does this automatically; if you start work without calling get_task, set it explicitly via update_task before doing anything else. When the work is genuinely and verifiably complete, mark it done with complete_task; otherwise leave it in_progress.',
  'VERIFY BEFORE COMPLETE (TDE-344): when a task\'s deliverable is a CHECKABLE artifact (a file, a live page, a pushed commit, a passing test/build/lint, a word count, an API response) and you are the executing agent, attach a deterministic verification as the task\'s gate and PROVE it before completing. (1) When you PREPARE / hand over a task (set agent_proposal), include the check in the plan so the human confirms the work AND its proof together, and freeze it: enable_task_review(task_id, bar:{rules:[{label, kind:"check", rule:"<how to check — e.g. fetch URL X and confirm text Y is present / run the test suite, expect exit 0>", severity:"blocker"}]}). (2) On EXECUTION: actually RUN the check, capture the raw observed_value (the fetched text, the exit code, the file path — never assert), and submit_task_review with it BEFORE complete_task. Completion is NEVER blocked, but a task completed without passing check evidence is durably marked DONE (UNVERIFIED). Prefer deterministic kind=check over human-judgment gates. Skip the gate only for tasks with no checkable artifact (pure discussion/decision).',
  'DEDUPE BEFORE CREATE (TDE-379): assume another session may already have made this task. create_task auto-checks similarity — it REFUSES a near-identical OPEN task (returning the matches) unless you pass allow_duplicate:true, and lists softer matches as a heads-up. When matches appear, prefer working the existing task or merge_task_as_duplicate(duplicate_task_id, canonical_task_id) to CONVERGE — do NOT reflexively set allow_duplicate; override only when the task is genuinely distinct. This keeps the shared backlog from forking into parallel copies across sessions/agents.',
  'When a request is ambiguous, default to the most obvious interpretation and proceed, briefly stating the assumption you made. Do NOT ask a clarifying question for read-only / list / display / search requests — bias toward action over questions.',
  'Only pause to ask the user to clarify or confirm when the action is destructive or outward-facing (deleting, bulk-completing, pushing to GitHub, or anything hard to reverse), OR when the request genuinely cannot be resolved from the conversation and context.',
  'NEVER be sycophantic. When you have a different or better view on a design, plan, scope, or contract, push back and argue it — challenge vague, contradictory, unrealistic, or over-scoped input. Pushback exists to improve the input and the result, not disagreement for its own sake; when the user is right, say so plainly and proceed. Applies everywhere: bootstrap_project, build_new_flow, reviews, planning.',
  'When the user wants to CREATE / SET UP A NEW PROJECT, call bootstrap_project FIRST (before create_project) and FOLLOW THE PHASES IT RETURNS — do NOT run your own multiple-choice quiz. The interview is THREE PHASES: (1) ELICIT in open PROSE — plain free-text questions about vision / why / taste / fears, NOT AskUserQuestion tiles; (2) DRAFT the Foundation brief, show it, then probe its gaps (tiles OK only for genuine expertise forks like platform/scope); (3) BLESS — show the full written brief for line-level edit, and persist via create_project ONLY after the user blesses it. Challenge weak / contradictory / over-scoped input at every phase — never sycophantic (e.g. if they pick two big features for v1, question it, don\'t just accept it). Then populate the board INCLUDING seeds for the deferred scope.',
  'FLOW vs AD-HOC — when to reach for a flow. DEFINITION: a flow is a single operation too big for one sitting — cut into steps so it holds together across its length, and gated only where one step\'s output becomes the next step\'s unexamined premise. TWO MOTIVES, either one sufficient: RUN IT RIGHT (the operation is sensitive → gate the seams) and HOLD IT TOGETHER (the operation is big → durable structure, resumability, legible progress, protection from drift and the context wall). Neither motive applies → it is plain tasks, not a flow. SCALE IS THE FLOOR and it carries the whole boundary: if the work splits fairly into about two tasks without leaving a wall of context, it is not a flow. CONNECTION IS OPTIONAL — big sequential and even homogeneous batch operations (clean 300 tasks, migrate 80 files) are flows. CONTRACTS ARE OPTIONAL — they are a property of certain joins, never the definition; a flow with no contracts anywhere is still a flow. A flow RUNS AND TERMINATES: anything that never terminates is a CONTAINER (project / section / phase), not a flow, however big — if you later want to add unrelated work to it, you built a container and mislabelled it. STEP GRANULARITY: promote a boundary to its own step only when it must do one of four things a milestone cannot — hand an artifact over, change executor, permit a gate, or permit a clean cold stop. Otherwise it is a MILESTONE inside a step. Size calibrates, it never locates. This means FEWER steps, not more: a 40-step flow rebuilds the very context wall flows exist to prevent, and milestones piling up on a step are a smell that the flow is under-resolved. THERE ARE NO FLOW TYPES — executor, gate kind and shape all vary WITHIN a single flow, so none of them is a type; do not label or branch on one. WHERE TO GATE: only at SEAMS — a handoff the receiving step will NOT re-derive (test: would the next step notice if this input were wrong?). Not every handoff is a seam. Prefer DISSOLVING a seam over gating it — make the receiver re-derive, or put the context in durable state so it is read rather than passed; the cheapest gate is no seam. Then prefer kind=check (deterministic, no validator subagent) over kind=judgment. Order gates by BLAST RADIUS: early seams in long flows and irreversible actions first. The bar is authored from what the RECEIVER needs to safely build on the input, not from what the producer intends to make. DO NOT manufacture a flow because contracts feel rigorous, and do NOT make something a flow when you need it visible on the board — flow steps leave the board entirely (TDE-320), which is a real and under-named cost. Proactively SUGGEST a flow when work fits a motive, even if the user framed it as loose tasks.',
  'When the user wants to BUILD A NEW FLOW (a multi-step process toward a goal, with quality checks between the steps), call build_new_flow to get the interview playbook + project grounding — do NOT free-form a plan. You then run the grill-me-style interview yourself (one question at a time, always recommend a path), propose the tasks and their input/output contracts, get ONE confirmation of the whole flow at the end, and only then persist via create_task + set_task_output + set_task_input.',
  'REVISION LOOP: When submit_validation_result returns action="regenerate" — redo the producing task (apply the specific gate failures as revision instructions), complete it, then call validate_output + submit_validation_result again. Continue until action="pass" or action="ask_human". When action="ask_human" — the retry limit (3) has been reached; STOP and call get_task_critique on the producer task to get the clean validator notes, then use AskUserQuestion to present those findings to the human and ask how to proceed. UPSTREAM CASCADE: if the root cause is in the input the producer received (not fixable by redoing the producer alone), you may re-run at most 2 tasks further upstream from the original failure; beyond that depth, stop and ask the human.',
  'VALIDATION INDEPENDENCE: Flows use TWO agents per handoff — executor (you) and validator (a separate subagent). When a task has output contract rules, call store_artifact with the VERBATIM produced content before complete_task. Then: (A) if all rules are kind=check AND you already know the rules, skip validate_output entirely — call submit_validation_result directly with your check results (1 call instead of 2); (B) if judgment rules exist, call validate_output to get the validator_agent_prompt, spawn an adversarial validator subagent via the Agent tool passing that prompt unmodified — the subagent starts from FAIL prior and calls submit_validation_result with validator="independent-subagent". You do NOT evaluate judgment rules yourself. MULTI-VOTE: for high-stakes flows with multiple judgment blockers, spawn 3 independent validators and only accept pass if majority (2 of 3) agree — split = fail, surface to human.',
  'FLOW IDENTITY: After persisting a new flow (after all create_task + set_task_output + set_task_input calls), call name_flow with all task IDs and a descriptive name (e.g. "Blog Post Publication Flow"). Optionally add a context string — the goal, constraints, or background that applies to all tasks. At the start of any flow run, call get_flow_context to orient yourself. Use update_flow_context to log progress or decisions that future agents in the flow should know.',
  'RUN FLOW: When the user asks you to run, execute, or start a flow — call run_flow first (with flow_id or any task_id in the flow). Read the playbook it returns. Then self-sequence through every step in order: execute → store_artifact → complete_task → validate → handle action. Do NOT prompt the user between steps unless action=ask_human. The flow runs to completion (or human intervention) in one session.',
  'NEVER ASK A HUMAN TO REVIEW OUTPUTS — SHOW THEM EXCEPTIONS (TDE-382 / Q7). When a person needs to review a flow, call get_flow_exceptions and present THAT. Do not walk them through steps, do not paste artifacts for approval, do not ask "does this look right?" per step. The reason is not brevity: human attention DEGRADES with volume — anyone shown 29 step outputs is rubber-stamping by the sixth, and a rubber-stamped output is WORSE than an ungated one, because it then carries confidence it never earned. So the only sustainable shape is review load that scales with problems found, not with flow length. What a human is shown: failed checks WITH the observed value (what was seen, never your claim that it passed), criteria that could not be reduced to a deterministic check (nothing verified those, so they are the human list by design), and the terminal output unconditionally (nothing downstream exists to catch it). What they are NOT shown: passing checks, step artifacts, progress. Corollary when AUTHORING a contract: every criterion you can turn into a kind=check is one the human never looks at again, on every seam, on every run — interrogate each one with "how would we actually check this?" and only record kind=judgment when the answer is genuinely nothing. The contract\'s job is to shrink the residue.',
  'STEP LIST OPEN — do not let a flow claim it finished when it only ran out of known steps (TDE-811). Some operations genuinely cannot know their full step list up front: research, investigation, debugging, anything whose next move depends on what the last one found. This is NOT a flow "type" (there are none) — it is a fact about what you currently know, and it changes during the run. WHEN AUTHORING: if you cannot list the steps to the end, pass step_list_open:true to name_flow. WHEN RUNNING: the moment you realise the remaining work is not yet knowable, call update_flow_context(task_id, step_list_open:true) — do not wait until the readout is already lying. While it is open, run_flow will NOT declare COMPLETE and will not stop early when the known steps are done; it tells you to decide and create the next step instead. CLOSE IT the moment the extent becomes known — update_flow_context(task_id, step_list_open:false) — because an open list permanently withholds the flow\'s ability to report itself finished. The denominator itself is always live (it counts current steps), so adding a step mid-run is expected and safe; what needs declaring is only whether more are coming.',
  'CHECK RULE EXECUTION: For kind=check rules, ACTUALLY RUN the check — do NOT assert or claim. Submit two fields: (1) observed_value — the raw datum from running it: exact word count ("1,542 words"), command output ("exit 0: All 24 tests passed"), file path ("/src/index.ts found"), pattern match ("keyword \'auth\' found at line 47"). Submitting without observed_value is REJECTED by the server. (2) note — interpretation of the observed_value against the rule (e.g. "1,542 words — exceeds the 1,000-word minimum"). How to produce observed_value: word/char count → run `echo "..." | wc -w` via Bash; command check → run it via Bash, capture stdout + exit code; file existence → Glob/Read, record the path; pattern → Grep/Read and record the match. FAIL EVIDENCE: any failing rule (kind=judgment OR kind=check) ALSO requires a note — the specific deficiency. This applies to the validator subagent too.',
  'SELF-CONTAINED TASK CONTEXT: When creating any task — via create_task, resolve_seed, or as flow tasks — write the detail field so a cold reader (no access to this chat, session memory, or external notes) can pick it up and act. Include: the goal/why of this specific task, any key decisions or open questions, and pointers to load-bearing context (relevant files, KB entries, prior decisions). Not a transcript dump — the minimum a cold reader needs to act. DETAIL vs MILESTONES — DIVIDE THE LABOR (do this AT CREATION, not as a fix-up pass): detail = the WHY, background, and key decisions; milestones = the ordered, checkable ACTION STEPS. Do NOT dump step-by-step actions as prose into detail — the moment a task has more than one action step, pass them as the create_task `milestones` array (one step per entry, never a checklist inside a note, no numbering — the app orders them). Reach for the milestones array by default whenever the work has discrete steps; writing the steps into detail instead is the wrong default. Applies to ALL creation paths: direct create_task calls, bootstrap_project populate phase, flow task creation, and resolve_seed outputs.',
  'RELAY MODE: When the user says they want to RELAY / HAND OFF / SHARE a task with someone else (a teammate, another agent), enter relay mode. (1) Announce "[Recording context for the task]" so the user knows you are now capturing hand-off context, then keep working with them to surface the WHY behind the task. (2) Pass relay_context on create_task (or update_task for an existing task) — a CURATED rationale layer, NOT a transcript dump and NOT a duplicate of detail. detail = the distilled what/how-to-act (self-contained, as always); relay_context = the hand-off layer that removes the assignee\'s need to come back and ask: who it is going to (free text, e.g. "to: Sara (backend)"), the key decision(s) and WHY, approaches considered and rejected and why-not, intent / how to treat the task, open questions, watch-outs. Distill it the same way you distill detail — capture the reasoning, drop the chatter. The recipient is free text for now (no team-member directory yet); auto-routing to real members is a deferred follow-up.',
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
    description: 'List all projects with name, slug, progress stats, and context (goal, why, scope), grouped by Environment (active one marked). Defaults to ALL projects across every Environment — pass environment_id to show only one. Call __init_tasker_session first if you have not this session.',
    inputSchema: { type: 'object', properties: { environment_id: { type: 'string', description: 'Optional: show only projects in this Environment (UUID from list_environments). Omit to see every Environment.' } }, required: [] },
  },
  {
    name: 'get_project',
    description: 'Get project details: Foundation, all sections, and all tasks with their IDs, priorities, and statuses. Per-task Notes (the detail field) are OMITTED by default to keep the map small on large projects — pass include_notes:true for them, or read one task in full with get_task.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Project prefix (e.g. TDE), slug, or UUID' },
        include_notes: { type: 'boolean', description: 'Include each task\'s Notes (detail field) inline. Default false — on a large project this can be very large. Prefer reading a specific task via get_task.' },
      },
      required: ['project_id'],
    },
  },
  {
    name: 'get_project_foundation',
    description: 'Read JUST the project Foundation (the grounding produced by bootstrap_project: why · scope · success · failure · quality bar · assumptions + extras) — without the full project/task dump. Cheap way to re-read grounding on demand.',
    inputSchema: {
      type: 'object',
      properties: { project_id: { type: 'string', description: 'Project prefix (e.g. TDE), slug, or UUID' } },
      required: ['project_id'],
    },
  },
  {
    name: 'pull_local_project',
    description: 'LOCAL MODE: hydrate/refresh the .tasker/ mirror of a Local Mode project. Returns a hydrate_script — write it as hydrate.mjs in the directory that should contain .tasker/ and run `node hydrate.mjs`. It downloads the bundle over a short-lived signed URL, writes every file (project.json, tasks/*.md, context.md, README.md, .gitignore, .sync.json), removes tombstoned task files, and prints a JSON summary (file_count, cursor, lease, next_free_ids). File contents never enter your context. Call at the START of local work. Refuses projects without Local Mode enabled.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Project prefix (e.g. TDE), slug, or UUID' },
        device_id: { type: 'string', description: 'Stable name for this machine/checkout (e.g. "desktop-repo"). Determines the ID lease block.' },
        cursor: { type: 'number', description: 'The cursor from this device\'s current .sync.json (omit on first pull). Used for the tombstone diff.' },
        inline: { type: 'boolean', description: 'If true, return the full file map in the tool response instead of the hydrate script (context-heavy fallback for environments without node).' },
        watch: { type: 'boolean', description: 'If true, also mint a scoped device token and return a watch_script (watch.mjs): `node watch.mjs` flushes edits within ~1s of a save and polls the hub every ~15s. Use when a human will hand-edit files or wants the web board to update live. Off by default.' },
      },
      required: ['project_id', 'device_id'],
    },
  },
  {
    name: 'flush_local_project',
    description: 'LOCAL MODE: push local .tasker/ edits up to the hub. Send changed task files (verbatim) and any deleted short IDs. Per-task last-write-wins by updated_at (ties → hub); edit beats delete; new tasks accepted only within this device\'s leased ID block; deletions get tombstoned. `section:` / `group:` frontmatter are writable to move a task; an unknown slug CREATES that section/group (returned as created_sections / created_groups, named as the slug). RENAME/DELETE/REORDER still go through MCP. Returns the new cursor plus hub_wins corrections — write those back, update .sync.json\'s cursor. Call after each work unit. input/output/review fields are READ-ONLY carriage.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Project prefix (e.g. TDE), slug, or UUID' },
        device_id: { type: 'string', description: 'Same device name used for pull_local_project.' },
        base_cursor: { type: 'number', description: 'The cursor from .sync.json written by your last pull/flush — the state your edits are based on.' },
        changed_files: {
          type: 'array',
          description: 'Task files you created or edited: [{ path: "tasks/TDE-52.md", content: "<verbatim file text>" }]. Only tasks/*.md entries are applied.',
          items: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
        },
        deleted_short_ids: { type: 'array', description: 'Numeric short IDs of task files you deleted locally (e.g. [52] for TDE-52).', items: { type: 'number' } },
      },
      required: ['project_id', 'device_id', 'base_cursor'],
    },
  },
  {
    name: 'set_local_mode',
    description: 'Turn Local Mode ON or OFF for a project (same toggle as the web ⇄ Local button). ON mirrors the project to .tasker/ files synced via pull_local_project / flush_local_project. OFF does not delete existing .tasker/ files — it just stops the hub treating the project as local (pull/flush refuse until re-enabled). Use to go local without opening the web app.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Project prefix (e.g. TDE), slug, or UUID.' },
        on: { type: 'boolean', description: 'true = enable Local Mode, false = disable. Defaults to true.' },
      },
      required: ['project_id'],
    },
  },
  {
    name: 'mint_device_token',
    description: 'LOCAL MODE: mint a long-lived, revocable device token so watch.mjs can auto-sync .tasker/ the instant a file changes. Scoped to ONE project on ONE device. Returns the secret ONCE plus the watch endpoints. Prefer the watch_script from pull_local_project, which mints one for you. Owner-only.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Project prefix (e.g. TDE), slug, or UUID — must be a Local Mode project.' },
        device_id: { type: 'string', description: 'Same stable device name used for pull_local_project (determines the ID lease block).' },
        label: { type: 'string', description: 'Optional human hint stored with the token (e.g. "desktop-repo watcher").' },
      },
      required: ['project_id', 'device_id'],
    },
  },
  {
    name: 'revoke_device_token',
    description: 'LOCAL MODE: revoke device watcher token(s). Pass token_id to kill one, or device_id to kill every active token for that device, or neither to list active tokens for the project. A revoked token stops working immediately (next watch poll/flush 401s).',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Project prefix (e.g. TDE), slug, or UUID.' },
        token_id: { type: 'string', description: 'UUID of a specific token to revoke (from revoke_device_token with neither field, or mint_device_token).' },
        device_id: { type: 'string', description: 'Revoke ALL active tokens for this device.' },
      },
      required: ['project_id'],
    },
  },
  {
    name: 'bootstrap_project',
    description: 'STEP 1 of a GATED interview for creating a NEW project. Call this FIRST when the user asks to create / set up a project — not create_project. Returns ONLY Phase 1 (open-prose elicitation) + a draft_id; later phases release one at a time via bootstrap_advance, so you cannot skip ahead or run a multiple-choice quiz. The project is created only from a user-BLESSED draft.',
    inputSchema: {
      type: 'object',
      properties: {
        name:   { type: 'string', description: 'Working name (optional — can be settled during the interview).' },
        intent: { type: 'string', description: 'Optional one-line of what the user said they want, to seed the draft.' },
      },
    },
  },
  {
    name: 'bootstrap_advance',
    description: 'Advance the gated bootstrap interview one phase at a time (after bootstrap_project). Each call returns ONLY the next phase, in order: "elicited" (submit the user\'s free-text answers) → "drafted" (submit the drafted+probed Foundation brief) → "blessed" (submit the final brief — THIS creates the project). Enforced; you cannot jump ahead.',
    inputSchema: {
      type: 'object',
      properties: {
        draft_id: { type: 'string', description: 'The draft id from bootstrap_project.' },
        step:     { type: 'string', enum: ['elicited', 'drafted', 'blessed'], description: 'Which phase you are completing.' },
        answers:  { type: 'string', description: 'Step "elicited": the user\'s VERBATIM free-text answers to your open Phase-1 questions.' },
        brief:    { type: 'object', description: 'Steps "drafted"/"blessed": the Foundation brief object (core + extended + flexible keys — the project context shape).' },
        name:     { type: 'string', description: 'Step "blessed": the final project name.' },
      },
      required: ['draft_id', 'step'],
    },
  },
  {
    name: 'create_project',
    description: 'Create a new project. PREFER bootstrap_project first to ground it with a Foundation distilled from the conversation; use create_project directly only for a deliberately quick/empty project. Pass the ratified Foundation as `context`. Auto-seeds a baseline Instruction Set; after creating, propose 2–4 project-specific IS additions for the user to confirm.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        context: { type: 'object', description: 'The Foundation. Core: { goal, why, scope, definition_of_done, failure, quality_bar, assumptions }. Extended: { audience, success_metrics, constraints, risks, ai_behavior }. Plus any flexible keys that fit the project type.' },
        environment_id: { type: 'string', description: 'Optional Environment (UUID) to create the project in. Defaults to the active Environment reported by __init_tasker_session; if none resolves and the user has more than one Environment, this is required.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'list_environments',
    description: 'List the user\'s Environments — the single-user context partition that sits ABOVE projects (e.g. Personal / Work / Learning) — with each one\'s project count and which is currently active.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'create_environment',
    description: 'Create a new Environment (a context partition that holds projects). Returns its id. Does NOT change the active Environment — the web app owns that pointer.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Environment name, e.g. "Work".' } },
      required: ['name'],
    },
  },
  {
    name: 'rename_environment',
    description: 'Rename an Environment. Non-destructive — its projects stay attached.',
    inputSchema: {
      type: 'object',
      properties: {
        environment_id: { type: 'string', description: 'Environment UUID (from list_environments).' },
        name: { type: 'string', description: 'New name.' },
      },
      required: ['environment_id', 'name'],
    },
  },
  {
    name: 'delete_environment',
    description: 'Delete an Environment. Its projects are first reassigned to another Environment (reassign_to_id, else one named "Default", else the next Environment) — projects are NEVER deleted. Refuses to delete the last remaining Environment. Requires confirmed: true.',
    inputSchema: {
      type: 'object',
      properties: {
        environment_id: { type: 'string', description: 'Environment UUID to delete.' },
        reassign_to_id: { type: 'string', description: 'Optional Environment UUID to move this one\'s projects into. Defaults to a "Default" Environment, else the next one.' },
        confirmed: { type: 'boolean', description: 'Must be true — deletion is permanent (projects are preserved and moved).' },
      },
      required: ['environment_id'],
    },
  },
  {
    name: 'export_project',
    description: 'Export an ENTIRE project to a portable, full-fidelity JSON bundle: Foundation/context, sections, groups, tasks (milestones, I/O edges + contracts, flow membership, custom statuses), flows (+ flow IS/KB), the project KB and IS. The returned JSON is the input to import_project — save it to back up or move a project. Ephemeral state (drafts, intake jobs) is excluded.',
    inputSchema: {
      type: 'object',
      properties: { project_id: { type: 'string', description: 'Project prefix (e.g. TDE), slug, or UUID' } },
      required: ['project_id'],
    },
  },
  {
    name: 'import_project',
    description: 'Recreate a project from a bundle produced by export_project. Always creates a NEW project (fresh slug + prefix) under the current account — never merges into an existing one. All internal references (I/O edges, flow membership, seed provenance, custom statuses) are remapped to fresh IDs; task short IDs (e.g. TDE-304) are preserved. Flow short IDs are regenerated (they are unique per account).',
    inputSchema: {
      type: 'object',
      properties: {
        bundle: { type: 'object', description: 'The export bundle object (the JSON returned by export_project, parsed).' },
        name: { type: 'string', description: 'Optional name for the imported project. Defaults to the bundle\'s project name.' },
        reset_progress: { type: 'boolean', description: 'If true, all imported tasks are set to pending (a clean template copy). Default false — statuses and completion are preserved (a true backup).' },
      },
      required: ['bundle'],
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
    description: 'List all sections in a project, each with its task counts (open / total).',
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
    name: 'rename_section',
    description: 'Rename an existing section. Non-destructive — only the name changes; tasks, groups, and ordering are untouched.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Project prefix (e.g. TDE), slug, or UUID' },
        section_id: { type: 'string', description: 'Section UUID' },
        name: { type: 'string', description: 'New section name' },
      },
      required: ['project_id', 'section_id', 'name'],
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
    name: 'list_phases',
    description: 'List a project\'s PHASES — condition-bounded stages ("Phase 1 ends when we launch"), each with task counts. Bounded by an exit condition, not a date (due_date is optional). Orthogonal to sections: sections are categorical, phases are temporal. Marks the ACTIVE phase and reports UNPHASED task count — a legitimate permanent state, not a backlog to drain.',
    inputSchema: {
      type: 'object',
      properties: { project_id: { type: 'string', description: 'Project prefix (e.g. TDE), slug, or UUID' } },
      required: ['project_id'],
    },
  },
  {
    name: 'create_phase',
    description: 'Create a phase in a project. ALWAYS set exit_condition — a phase without one is just a bucket; stating what must be TRUE to end it is what makes unrequired work fall to a later phase. due_date is optional and should stay empty unless there is a genuine deadline — a phase is bounded by achievement, not the calendar.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id:     { type: 'string', description: 'Project prefix (e.g. TDE), slug, or UUID' },
        name:           { type: 'string', description: 'Phase name (e.g. "Phase 1 — Core app")' },
        exit_condition: { type: 'string', description: 'What must be TRUE for this phase to be over (e.g. "the app is live and the MCP is documented"). Strongly recommended.' },
        due_date:       { type: 'string', description: 'OPTIONAL ISO date YYYY-MM-DD. Leave unset unless there is a real deadline.' },
      },
      required: ['project_id', 'name'],
    },
  },
  {
    name: 'update_phase',
    description: 'update a phase — rename it, revise its exit condition, set/clear its optional due date, or change its position. Non-destructive: task assignments are untouched.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id:     { type: 'string', description: 'Project prefix (e.g. TDE), slug, or UUID' },
        phase_id:       { type: 'string', description: 'Phase UUID, slug, or exact name' },
        name:           { type: 'string', description: 'New name' },
        exit_condition: { type: 'string', description: 'New exit condition. Pass an empty string to clear.' },
        due_date:       { type: 'string', description: 'New ISO date YYYY-MM-DD. Pass an empty string to clear the deadline.' },
        sort_order:     { type: 'number', description: 'New position (lower comes first)' },
      },
      required: ['project_id', 'phase_id'],
    },
  },
  {
    name: 'delete_phase',
    description: 'delete a phase. Its tasks are NOT deleted — they become UNPHASED (phase_id → null), which is a valid state. If this phase was the project\'s active phase, the pointer is cleared. Reports how many tasks were unphased.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Project prefix (e.g. TDE), slug, or UUID' },
        phase_id:   { type: 'string', description: 'Phase UUID, slug, or exact name' },
      },
      required: ['project_id', 'phase_id'],
    },
  },
  {
    name: 'set_active_phase',
    description: 'set which phase the project is CURRENTLY in — the answer to "what is in scope right now". get_ready_work uses this to scope the queue, so keeping it accurate is what makes phases useful to an agent rather than decoration. Pass phase_id: null (or omit it) to clear the pointer.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Project prefix (e.g. TDE), slug, or UUID' },
        phase_id:   { type: 'string', description: 'Phase UUID, slug, or exact name. Omit or pass null to clear.' },
      },
      required: ['project_id'],
    },
  },
  {
    name: 'set_task_phase',
    description: 'assign a task to a phase, or UNPHASE it (pass phase_id: null / omit). Unphasing is not a failure state — work that legitimately belongs to no stage (idea inventories, evergreen items) should stay unphased rather than be stamped with a phase that would then be a lie.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id:  { type: 'string', description: 'Task UUID or short ID (e.g. TDE-31)' },
        phase_id: { type: 'string', description: 'Phase UUID, slug, or exact name within the task\'s project. Omit or pass null to unphase.' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'list_tasks',
    description: 'List tasks. Each line carries the added date and, when it differs, last-edited date. For "what changed lately", pass sort: "recently_updated" — do not call get_task on candidates to compare timestamps. Flow steps are excluded (they are STEPS, listed via list_flows / get_flow_context). Done tasks are excluded by default — status: "all" includes them. With no project_id the default project is used when set; otherwise listing across ALL projects requires confirmed: true. Paginated: a result over the limit ends with a cursor line — pass it back as `cursor` for the next page.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Project prefix (e.g. TDE), slug, or UUID (optional — falls back to default project if set)' },
        section_id: { type: 'string', description: 'Section UUID (optional)' },
        status:     { type: 'string', enum: ['pending', 'in_progress', 'done', 'all'], description: 'Filter by status. Defaults to excluding done tasks. Pass "all" to include everything.' },
        confirmed:  { type: 'boolean', description: 'Set to true to list tasks across ALL projects (only needed when project_id is omitted AND no default project is set).' },
        include_flow_steps: { type: 'boolean', description: 'EXPLICIT USER OVERRIDE ONLY — set true only when the user has explicitly asked to see flow steps here as if they were normal tasks. Never set on your own initiative.' },
        phase_id: { type: 'string', description: 'show only tasks in this phase (UUID, slug, or exact name). Pass "unphased" to list only tasks belonging to NO phase. Requires project_id.' },
        sort:       { type: 'string', enum: ['sorting_order', 'recently_updated'], description: 'Ordering. Default "sorting_order" (the board order). "recently_updated" sorts by last edit, newest first — use it to see what changed most recently.' },
        updated_since: { type: 'string', description: 'Only tasks edited on/after this time. Accepts a relative duration ("7d", "2w", "1mo", or ISO 8601 "P2W") or an absolute ISO date.' },
        limit:  { type: 'number', description: `Max tasks to return. Default ${DEFAULT_PAGE_SIZE}, capped at ${MAX_PAGE_SIZE}.` },
        cursor: { type: 'string', description: 'Opaque pagination cursor from a previous call\'s result. Omit for the first page.' },
        blocking: { type: 'boolean', description: 'Only tasks whose output is an input source for at least one NOT-done task, anywhere in the project — i.e. producers something is still waiting on. A relationship filter, not a scalar one: computed across all of the project\'s I/O edges, so it disables cursor pagination for this call (the set is filtered before paging would apply).' },
        flow_id: { type: 'string', description: 'Filter by flow membership. Pass a flow UUID or short ID.' },
        gate_status: { type: 'string', enum: ['valid', 'invalid', 'unverified'], description: 'Filter by contract/gate state. A relationship filter, computed in JS, so it disables cursor pagination for this call.' },
      },
      required: [],
    },
  },
  {
    name: 'create_task',
    description: 'Create a single task. For a multi-step process toward a goal, do NOT create tasks ad hoc — use build_new_flow instead. To create a SEED (a placeholder for underspecified work or a flow worth building later), pass kind:"seed" with seed_target plus open_questions and/or milestones — a unified checklist: open_questions are answered during resolution, milestones become prerequisites that soft-gate resolution.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string' },
        section_id: { type: 'string', description: 'Optional. Task is ungrouped if omitted.' },
        text:       { type: 'string', description: 'Task title' },
        detail:     { type: 'string', description: 'Context/description. Write so a cold reader (no chat history, no session memory) can act on this task alone: goal/why, key decisions or open questions, pointers to relevant files/KB/decisions, and obvious next step. For a seed: the rough subject + why it is needed (the pre-brief).' },
        priority:   { type: 'string', enum: ['rush', 'high', 'medium', 'low'] },
        due_date:   { type: 'string', description: 'ISO date YYYY-MM-DD (optional)' },
        kind:       { type: 'string', enum: ['normal', 'seed'], description: 'Default "normal". "seed" = a placeholder resolved later into a real task or flow.' },
        seed_target:    { type: 'string', enum: ['task', 'flow'], description: 'Seeds only: what this resolves into — a concrete task (resolve_seed) or a flow (build_new_flow).' },
        open_questions: { type: 'array', items: { type: 'string' }, description: 'Seeds only: the SPECIFIC gaps blocking specification — things ANSWERED with the user during resolution. Stored as kind="question" items in the seed\'s unified checklist (they do NOT gate resolution).' },
        milestones:     { type: 'array', items: { type: 'string' }, description: 'Ordered milestone texts, added in one call. On a SEED these are PREREQUISITES — work to settle BEFORE resolving, stored as kind="prerequisite" items that soft-gate resolve_seed / build_new_flow. On a normal task, plain milestones.' },
        executor:       { type: 'string', enum: ['agent', 'user', 'external'], description: 'Who executes this step. agent (default) = AI runs it; user = human executes, AI coaches; external = third party (web admin, client, etc.). A single flow can mix executor types.' },
        human_guidance: { type: 'string', description: 'user/external steps only: human-facing instructions shown in guide mode. Distinct from detail (AI-facing). Write as an action directive — what the person must do, where, and how to verify it worked.' },
        relay_context:  { type: 'string', description: 'RELAY MODE: set only when handing this task to someone else. Curated, not a transcript dump: who it is for, key decisions and WHY, rejected approaches, intent, open questions, watch-outs. Setting it marks the task as a relay.' },
        allow_duplicate: { type: 'boolean', description: 'Creation is REFUSED if a near-identical open task exists (matches listed in the response). Pass true only when genuinely distinct — otherwise work the existing task or merge_task_as_duplicate.' },
        tags:           { type: 'array', items: { type: 'string' }, description: 'Tags used to filter which Instruction Sets are loaded into this task\'s context.' },
      },
      required: ['project_id', 'text'],
    },
  },
  {
    name: 'merge_task_as_duplicate',
    description: 'fold a duplicate task into a canonical one so agents/sessions converge on ONE task instead of spawning copies. Transfers the duplicate\'s incomplete milestones and appends its detail to the canonical task, then closes the duplicate with a DISTINCT outcome (duplicate_of → canonical, not a plain "done"). Use it when create_task\'s duplicate guard surfaces a match, or to clean up existing dups.',
    inputSchema: {
      type: 'object',
      properties: {
        duplicate_task_id: { type: 'string', description: 'The task to fold away (UUID or short ID). It gets closed as MERGED.' },
        canonical_task_id: { type: 'string', description: 'The task to keep (UUID or short ID). It receives the duplicate\'s milestones + context.' },
      },
      required: ['duplicate_task_id', 'canonical_task_id'],
    },
  },
  {
    name: 'resolve_seed',
    description: 'Resolve a CONTEXT SEED (seed_target "task") into a real, placed task — AFTER settling its checklist with the user. kind="question" items are answered in conversation; kind="prerequisite" items SOFT-GATE this call (unmet ones are surfaced; pass proceed_anyway:true to override). Atomically creates the task from task_spec, places it, marks the seed done, and links it back to the seed. PASS task_spec.section_id with the task\'s REAL home — it must not stay in the "Needs Context" staging section (omitted → Backlog, not the seed\'s section). For FLOW seeds use build_new_flow instead.',
    inputSchema: {
      type: 'object',
      properties: {
        seed_id: { type: 'string', description: 'The seed task to resolve (UUID or short ID).' },
        proceed_anyway: { type: 'boolean', description: 'Override the soft prerequisite gate. Default false — resolving with unchecked kind="prerequisite" items is refused with the list of what\'s unmet; confirm with the user, then retry true.' },
        task_spec: {
          type: 'object',
          description: 'The resolved concrete task.',
          properties: {
            text:       { type: 'string', description: 'Task title.' },
            detail:     { type: 'string', description: 'Resolved context/description. Write self-contained: goal/why, key decisions, pointers to load-bearing context, obvious next step — enough for a cold reader to act without the chat.' },
            priority:   { type: 'string', enum: ['rush', 'high', 'medium', 'low'] },
            section_id: { type: 'string', description: 'Where it belongs (UUID). Defaults to the seed\'s section if omitted.' },
            milestones: { type: 'array', items: { type: 'string' }, description: 'Optional ordered milestones.' },
          },
          required: ['text'],
        },
      },
      required: ['seed_id', 'task_spec'],
    },
  },
  {
    name: 'update_task',
    description: 'Update task fields. Only provided fields change. Pass append:true to ADD detail to the existing detail (blank-line separated) instead of replacing it. Setting status to in_progress or done is hard-blocked if the task has unmet upstream flow dependencies — finish the source task(s) first (the response explains which).',
    inputSchema: {
      type: 'object',
      properties: {
        task_id:    { type: 'string', description: 'Task UUID or short ID (e.g. TDE-31)' },
        text:       { type: 'string' },
        detail:     { type: 'string', description: 'Task context. Replaces the existing detail unless append:true is also passed.' },
        append:     { type: 'boolean', description: 'If true, appends the provided detail to the existing detail (blank-line separated) instead of replacing it. Default false.' },
        priority:   { type: 'string', enum: ['rush', 'high', 'medium', 'low'] },
        status:     { type: 'string', enum: ['pending', 'in_progress', 'done'] },
        due_date:   { type: 'string' },
        section_id:     { type: 'string', description: 'Move task to a different section (use section UUID)' },
        group_id:       { type: 'string', description: 'Move task to a different group (use group UUID), or null to remove from group' },
        pinned:         { type: 'boolean', description: 'Pin or unpin the task' },
        executor:       { type: 'string', enum: ['agent', 'user', 'external'], description: 'Who executes this step. agent = AI; user = human (AI coaches); external = third party.' },
        human_guidance: { type: 'string', description: 'Human-facing step instructions for guide mode (user/external steps). Replaces existing.' },
        relay_context:  { type: 'string', description: 'Set/replace the relay rationale layer on an EXISTING task. Same contract as create_task.relay_context — a distilled hand-off note (recipient, decision + why, rejected approaches, intent, open questions, watch-outs), NOT a transcript dump.' },
        delegated_to:   { type: 'string', description: 'Who the task is delegated to (free text — agent or teammate). The owner REMAINS responsible and still owns the quality gate; delegation is NOT reassignment. Empty string clears.' },
        agent_ready:    { type: 'boolean', description: 'Mark "ready for the agent" — enters the autonomous work queue (get_ready_work). Usually set by the human ("Hand to agent"); false pulls it back.' },
        agent_proposal: { type: 'string', description: 'Prepare→confirm→execute: the agent\'s PREPARED proposal (a concise summary of what it will do). Setting it puts the task in the web Agent Queue "Awaiting confirmation" tab. Clear it (empty string) once confirmed-and-executed, or if declined.' },
        agent_proposal_confirmed: { type: 'boolean', description: 'Usually set by the human (the "Confirm" button on the proposal). true = the human approved the (possibly edited) agent_proposal — execute it. Normally reset to false only by clearing the proposal after executing.' },
        tags:           { type: 'array', items: { type: 'string' }, description: 'Tags used to filter which Instruction Sets are loaded into this task\'s context.' },
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
    name: 'resolve_reference',
    description: 'Resolve a bare short ID or UUID to its entity type (task / flow / project) and canonical identity, when you don\'t already know which kind of thing it is — e.g. "TDE-52" (task), "TDE-F1" (flow), "TDE" (project). Read-only, no side effects (does not auto-start a task like get_task does). This is the only tool that accepts a flow\'s own displayed short_id as input. Returns a "next" hint pointing at get_task / get_project / get_flow_context for full detail.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'A short ID (task, flow, or project prefix/slug) or a UUID.' },
      },
      required: ['ref'],
    },
  },
  {
    name: 'get_task',
    description: 'Get full details for a single task: text, context, priority, status, due date, section, project, milestones, created / last-edited times. Call when about to START a task — a pending task is auto-set to in_progress (peek: true inspects without starting). Auto-start is not an edit, so reading never changes last-edited. When done, complete_task only if the work is genuinely complete; otherwise leave it in_progress.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Task UUID or short ID (e.g. TDE-31)' },
        peek: { type: 'boolean', description: 'If true, just read the task without auto-setting it to in_progress. Use when inspecting/planning rather than starting work.' },
        refresh_context: { type: 'boolean', description: 'Force the full project context (Foundation, Instruction Set, KB index) back inline. Normally sent only on the first task opened in a project each session, then omitted as a short pointer. Use after your context was compacted or cleared.' },
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
        tags:       { type: 'array', items: { type: 'string' }, description: 'Tags used to scope this instruction set to tasks with matching tags. Omit or empty array means it applies to all tasks.' },
      },
      required: ['project_id', 'title', 'content'],
    },
  },
  {
    name: 'create_default_is_entry',
    description: 'Create a PERSONAL default Instruction Set entry (account-level, not tied to a project). These reusable conventions (code style, deploy rules, tone, autonomy) are auto-seeded into EVERY new project you create, after the built-in baseline. Use for rules you want on by default everywhere. Existing projects are unaffected.',
    inputSchema: {
      type: 'object',
      properties: {
        title:     { type: 'string', description: 'Short title for the directive' },
        content:   { type: 'string', description: 'The instruction content (markdown supported)' },
        universal: { type: 'boolean', description: 'If true, seeded entries apply even inside flows with their own IS. Default false.' },
        tags:      { type: 'array', items: { type: 'string' }, description: 'Tags used to scope this instruction set to tasks with matching tags. Omit or empty array means it applies to all tasks.' },
      },
      required: ['title', 'content'],
    },
  },
  {
    name: 'list_default_is_entries',
    description: 'List your PERSONAL default Instruction Set entries (account-level) that auto-seed every new project.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'update_default_is_entry',
    description: 'Update a personal default Instruction Set entry by id. Only provided fields change. Affects only FUTURE projects — already-created projects keep the copy they were seeded with.',
    inputSchema: {
      type: 'object',
      properties: {
        entry_id:  { type: 'string', description: 'UUID of the default IS entry (from list_default_is_entries).' },
        title:     { type: 'string' },
        content:   { type: 'string' },
        universal: { type: 'boolean' },
        tags:      { type: 'array', items: { type: 'string' } },
      },
      required: ['entry_id'],
    },
  },
  {
    name: 'delete_default_is_entry',
    description: 'Delete a personal default Instruction Set entry by id. Affects only future projects.',
    inputSchema: {
      type: 'object',
      properties: { entry_id: { type: 'string', description: 'UUID of the default IS entry.' } },
      required: ['entry_id'],
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
    name: 'append_session_activity',
    description: "Append a typed, IMMUTABLE entry to a task's agent session ledger — the durable, human-inspectable record of what the agent did. Opens a session lazily if none is open. Types: progress (a step/status update), action (a concrete change), question (BLOCKED — sets the session to awaiting_input), result (an outcome/deliverable), error. Entries cannot be edited or deleted.",
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Task UUID or short ID (e.g. TDE-31)' },
        type:    { type: 'string', enum: ['progress', 'action', 'question', 'result', 'error'], description: 'The kind of entry.' },
        body:    { type: 'string', description: 'What happened / what you are asking — one concise entry.' },
        actor: { type: 'string', description: 'Optional: the agent/client acting (e.g. "Claude Code").' },
      },
      required: ['task_id', 'type', 'body'],
    },
  },
  {
    name: 'get_task_activity',
    description: "Read a task's agent session ledger: recent sessions with their DERIVED lifecycle state (active / awaiting_input / error / stale / complete) and the immutable activity thread. Use it to see what prior agents/sessions actually did on a task before you pick it up.",
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Task UUID or short ID (e.g. TDE-31)' },
        limit:   { type: 'number', description: 'Max activities per session (default 20, max 100).' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'get_task_history',
    description: "A task's DURABLE GATE HISTORY — the append-only record of contract / review bar / gate changes, with before+after state. Unlike get_flow_audit (the current snapshot), this answers what the task row cannot: what a contract said before replacement, whether a confirmation was later erased, what an earlier review attempt said. Kinds: contract_set, contract_cleared, contract_confirmed, review_bar_frozen, review_bar_cleared, review_submitted, validation_submitted, fields_changed.",
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Task UUID or short ID (e.g. TDE-31)' },
        kind:    { type: 'string', enum: ['contract_set', 'contract_cleared', 'contract_confirmed', 'review_bar_frozen', 'review_bar_cleared', 'review_submitted', 'validation_submitted', 'fields_changed'], description: 'Optional: show only this kind of event.' },
        limit:   { type: 'number', description: `Max events (default ${DEFAULT_PAGE_SIZE}, max ${MAX_PAGE_SIZE}), newest first.` },
        cursor:  { type: 'string', description: 'Opaque pagination cursor from a previous call\'s result. Omit for the first page.' },
        verbose: { type: 'boolean', description: 'Include the full before/after JSON per event. Default false (summaries + key flags only) to keep the response cheap.' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'get_my_attention',
    description: "The 'what needs me?' triage — one cross-task pull. Recommended FIRST move after __init_tasker_session. For the user's non-done work (optionally scoped to a project): tasks awaiting review verdict, pending human GUIDANCE (unconsumed), agent sessions AWAITING INPUT, STALE in-progress tasks (quiet 2+ days), and OVERDUE items. Act on the highest-priority item.",
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Optional — scope to one project (prefix/slug/UUID). Omit for all your projects.' },
      },
      required: [],
    },
  },
  {
    name: 'get_ready_work',
    description: "The agent's autonomous work queue: tasks a human marked 'ready for agent' in the web app (agent_ready + still pending), ranked by priority. The pull half of Tasker-triggers-agent-work — a looping/scheduled agent calls this, takes the TOP task (get_task to load context + start it), works it, completes it, then calls again. Returns an empty-queue message when there is nothing ready.",
    inputSchema: {
      type: 'object',
      properties: { project_id: { type: 'string', description: 'Optional — scope to one project.' } },
      required: [],
    },
  },
  {
    name: 'stop_flow',
    description: "set a durable STOP on a flow — a human-set halt agents MUST honor. While stopped, run_flow / guide_flow / advance_guide refuse to proceed and return the reason. Use when the human changes their mind mid-flow (checks INTENT — distinct from the quality gates, which check output). Identify the flow by flow_id (UUID or name) or any task_id in it.",
    inputSchema: {
      type: 'object',
      properties: {
        flow_id: { type: 'string', description: 'Flow UUID or (partial) name.' },
        task_id: { type: 'string', description: 'Or any task in the flow (short ID or UUID).' },
        reason:  { type: 'string', description: 'Why you are stopping — shown to the agent when it tries to proceed.' },
      },
      required: [],
    },
  },
  {
    name: 'resume_flow',
    description: "clear a flow's stop. It resumes exactly where it stood (guide cursor and task states untouched). Identify by flow_id (UUID or name) or any task_id in it.",
    inputSchema: {
      type: 'object',
      properties: {
        flow_id: { type: 'string', description: 'Flow UUID or (partial) name.' },
        task_id: { type: 'string', description: 'Or any task in the flow.' },
      },
      required: [],
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
    description: 'Commit a text file to a path in a connected GitHub repo — the way to persist flow/task artifacts to version control. Updates the file if it already exists (SHA fetched automatically). Path convention for flow artifacts: .tasker/artifacts/{flow-short-id}/{filename}. Requires GitHub connected via github_connect; falls back to the project\'s linked repo when task_id is supplied.',
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
    name: 'drive_upload_file',
    description: 'Create a file in the user\'s Google Drive. Defaults to a plain text file, but can create an EDITABLE native Google Doc or Sheet (target_type) via Drive\'s convert-on-import. Files are placed in Tasker/ProjectName/FlowShortId/ (or standalone/ for non-flow tasks). Pass task_id to place the file in the right project/flow subfolder and record the Drive file ID on the task. Requires Google Drive connected via Settings → Connectors.',
    inputSchema: {
      type: 'object',
      properties: {
        filename:  { type: 'string', description: 'Filename, e.g. "report.md" or "Article Draft". For docs/sheets the extension is cosmetic — Drive shows it as a native Doc/Sheet.' },
        content:   { type: 'string', description: 'Text content of the file. For target_type "doc": pass HTML or Markdown. For "sheet": pass CSV.' },
        task_id:   { type: 'string', description: 'Optional: task UUID or short ID. Places file in the right project/flow subfolder and records the Drive file ID on the task output.' },
        target_type: { type: 'string', enum: ['file', 'doc', 'sheet'], description: 'What to create. "file" (default) = raw file as-is. "doc" = editable Google Doc (converts from HTML/Markdown). "sheet" = editable Google Sheet (converts from CSV).' },
        mime_type: { type: 'string', description: 'Source content MIME — the format Drive converts FROM, not the Google-apps type. "file": default text/plain (text/markdown for .md). "doc": text/html (default) or text/markdown. "sheet": text/csv (default).' },
      },
      required: ['filename', 'content'],
    },
  },
  {
    name: 'drive_read_file',
    description: 'Read the text content of a file in the user\'s Google Drive by its file ID. Requires Google Drive connected.',
    inputSchema: {
      type: 'object',
      properties: {
        file_id: { type: 'string', description: 'Google Drive file ID (returned by drive_upload_file or drive_list_files)' },
      },
      required: ['file_id'],
    },
  },
  {
    name: 'drive_list_files',
    description: 'List files in the user\'s Tasker folder in Google Drive. Returns id, name, mimeType, size, and modifiedTime for each file. Requires Google Drive connected.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Optional: extra Drive query filter (e.g. "name contains \'report\'"). Appended to the parent-folder filter.' },
      },
      required: [],
    },
  },
  {
    name: 'list_google_task_lists',
    description: 'List the user\'s Google Task lists. Requires Google Tasks connected via Settings → Connectors.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'list_google_tasks',
    description: 'List pending tasks from a specific Google Task list. Returns title, notes, due date, and task ID.',
    inputSchema: {
      type: 'object',
      properties: {
        list_id:           { type: 'string',  description: 'Google Task list ID (from list_google_task_lists)' },
        include_completed: { type: 'boolean', description: 'Include completed tasks. Default false.' },
      },
      required: ['list_id'],
    },
  },
  {
    name: 'pull_google_task',
    description: 'Pull a Google Task into Tasker as a new pending task in the specified section.',
    inputSchema: {
      type: 'object',
      properties: {
        list_id:    { type: 'string', description: 'Google Task list ID (from list_google_task_lists)' },
        task_id:    { type: 'string', description: 'Google Task ID to pull (from list_google_tasks)' },
        section_id: { type: 'string', description: 'Tasker section ID to create the task in' },
      },
      required: ['list_id', 'task_id', 'section_id'],
    },
  },
  {
    name: 'list_kb_entries',
    description: 'List Knowledge Base entries for a project — returns id + title + source + updated_at only (no content). Use this for cheap discovery before update/delete operations. Paginated: a result over the limit ends with a cursor line — pass it back as `cursor` for the next page.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Project prefix (e.g. TDE), slug, or UUID' },
        source: { type: 'string', enum: ['user', 'agent', 'all'], description: 'Filter by who created the entry. Defaults to "all".' },
        limit:  { type: 'number', description: `Max entries to return. Default ${DEFAULT_PAGE_SIZE}, capped at ${MAX_PAGE_SIZE}.` },
        cursor: { type: 'string', description: 'Opaque pagination cursor from a previous call\'s result. Omit for the first page.' },
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
        tags:      { type: 'array', items: { type: 'string' }, description: 'New tags (optional).' },
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
        tags:       { type: 'array', items: { type: 'string' }, description: 'Tags used to scope this instruction set to tasks with matching tags. Omit or empty array means it applies to all tasks in the flow.' },
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
        tags:     { type: 'array', items: { type: 'string' }, description: 'New tags (optional).' },
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
    description: 'Save or update AI behavioral preferences. Takes any of: task_list_format, show_completed_tasks, rank_tasks_by, communication_style, multiple_tasks_handling, show_project_context, timezone. Only provided fields are changed.',
    inputSchema: {
      type: 'object',
      properties: {
        task_list_format: { type: 'string', enum: ['plain_text', 'markdown_table', 'numbered_list'] },
        show_completed_tasks: { type: 'boolean' },
        rank_tasks_by: { type: 'string', enum: ['sorting_order', 'task_priority'] },
        communication_style: { type: 'string', enum: ['terse', 'detailed', 'conversational'] },
        multiple_tasks_handling: { type: 'string', enum: ['collaborative', 'autonomous'] },
        show_project_context: { type: 'boolean' },
        timezone: { type: 'string', description: 'The zone timestamps are shown in — an IANA name ("Asia/Amman") or a fixed UTC offset ("+03:00"). Unset means times render as UTC. Set it when the user states their timezone.' },
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
    name: 'move_task',
    description: 'Move a task to a DIFFERENT project. Reassigns the short ID into the target project\'s sequence; preserves text, detail, priority, status, output contract and stored artifact. Side effects: unlinked from any flow, section/group reset, cross-project I/O edges DROPPED (its own inputs and any references to it). The response reports what was dropped. For same-project moves use update_task or move_task_to_group.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Task UUID or short ID (e.g. TDE-31) to move' },
        target_project_id: { type: 'string', description: 'Destination project: prefix (e.g. WCP), slug, or UUID' },
        target_section_id: { type: 'string', description: 'Optional: a section UUID in the TARGET project to drop the task into. If omitted (or not in the target project) the task lands with no section.' },
      },
      required: ['task_id', 'target_project_id'],
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
    name: 'add_task_link',
    description: 'Attach a URL link (e.g. a deployed webpage, PR, or reference) to a task\'s output. This powers the Links section in the Summary.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Task UUID or short ID' },
        url: { type: 'string', description: 'The URL to attach' },
        title: { type: 'string', description: 'Optional human-readable title for the link' },
      },
      required: ['task_id', 'url'],
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
    description: 'Enable the task-level output judge on a STANDALONE task. Call WITHOUT `bar` to get grounding (task text + governing IS) and instructions to author a checkable bar; call WITH `bar: { rules: [...] }` to FREEZE it and turn review on. Refuses flow tasks (flow gates govern those) and refuses to overwrite an existing frozen bar unless force:true.',
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
    name: 'disable_task_review',
    description: 'Turn OFF task-level review and clear its frozen bar + verdict — the undo counterpart of enable_task_review. Releases a task review-enabled by mistake or stuck escalated, without faking a passing review. Stamps {cleared:true, reason, cleared_at} in place of the verdict rather than silently wiping it. Removes the "NEEDS REVIEW" card. Refuses if review was never enabled.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Task UUID or short ID — the review-enabled task to release.' },
        reason:  { type: 'string', description: 'Optional short reason recorded in the cleared record (why review is being disabled). Recommended for the audit trail.' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'review_task',
    description: 'Run the task-level output judge on a review-enabled STANDALONE task. Returns the judging protocol with the frozen bar and the stored artifact (read SERVER-SIDE, not from your claims — that is the independence). Run check rules inline; spawn a fresh independent subagent for judgment rules; then call submit_task_review with the per-rule results. Refuses flow tasks.',
    inputSchema: {
      type: 'object',
      properties: { task_id: { type: 'string', description: 'The review-enabled task to judge.' } },
      required: ['task_id'],
    },
  },
  {
    name: 'submit_task_review',
    description: 'Record the task-level judge verdict. Computes overall pass/fail from per-rule results against the frozen bar, writes review_verdict, and applies the gate: a blocker failure REOPENS the task (status→in_progress) with the critique; after 3 failed attempts it escalates to the human (action=ask_human). On pass the task stays done. Returns the action: pass | regenerate | ask_human.',
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
        narrative: {
          type: 'object',
          description: 'GUIDED REVIEW: a human-facing narrative of the verdict, structured so the human gate is ~30s of judgment, not error-hunting. Provide on any fail/escalation. Verdict logic is unchanged — this is presentation.',
          properties: {
            core:      { type: 'string', description: 'The single most important thing the human must judge.' },
            sections:  { type: 'array', description: 'Consequence-ordered points.', items: { type: 'object', properties: { point: { type: 'string' }, consequence: { type: 'string' } } } },
            secondary: { type: 'string', description: 'Minor / glue notes, separated out.' },
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
        commit_to_repo:  { type: 'boolean', description: 'If true, also commit the artifact to the project\'s linked GitHub repo. Requires the project to have a linked repo (github_import_project) and a connected GitHub account.' },
        filename:        { type: 'string', description: 'Filename for the committed file (e.g. "report.md"). Required when commit_to_repo is true. The path in the repo will be .tasker/artifacts/{flow-short-id or task-short-id}/{filename}.' },
        upload_to_drive: { type: 'boolean', description: 'If true, also upload the artifact to the user\'s Tasker folder in Google Drive. Requires Google Drive connected via the app Connectors page.' },
        drive_filename:  { type: 'string', description: 'Filename for the Drive file (e.g. "report.md"). Required when upload_to_drive is true.' },
        drive_target_type: { type: 'string', enum: ['file', 'doc', 'sheet'], description: 'When upload_to_drive is true: "file" (default) keeps the raw artifact; "doc" creates an editable Google Doc (artifact should be HTML/Markdown); "sheet" creates an editable Google Sheet (artifact should be CSV).' },
      },
      required: ['task_id', 'content'],
    },
  },
  {
    name: 'validate_output',
    description: 'PHASE 1 of a handoff check. Returns the rules to evaluate — the CONSUMER\'s input contract for this edge (the gate) plus the producer\'s output contract (self-check) — plus a validator_agent_prompt when judgment rules are present. Call it to learn which rules apply, or to get that prompt. For contracts with ONLY kind=check rules whose rules you already know, skip this and call submit_validation_result directly.',
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
    description: 'Report per-rule validation results. Writes to the producer\'s feedback ledger, applies the gate (any BLOCKER rule failure → invalid, reopens producer), returns the verdict. Can skip a prior validate_output for contracts with only kind=check rules already known. Always required for judgment rules (called by the validator subagent). Warnings recorded but do not block.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Task UUID or short ID — the PRODUCER (same as validate_output)' },
        target_task_id: { type: 'string', description: 'Optional: the CONSUMER edge validated against (required only if the producer feeds more than one task)' },
        validator: { type: 'string', description: 'Who ran this validation. Required when judgment rules are present: "independent-subagent" (fresh session with the artifact), "human", or "self" (you graded your own work — discloses the conflict). Omitting it with judgment rules present flags the ledger unverified.' },
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
        limit:      { type: 'number', description: `Max flows to return. Default ${DEFAULT_PAGE_SIZE}, capped at ${MAX_PAGE_SIZE}.` },
        cursor:     { type: 'string', description: 'Opaque pagination cursor from a previous call\'s result. Omit for the first page.' },
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
    description: 'Full validation audit trail for a flow — who validated, when, which rules passed/failed, evidence notes, retry counts, contract blessing status — step by step across every task. Use for compliance review or debugging a failed run. This is the EVERYTHING view: to present a flow to a HUMAN, use get_flow_exceptions instead.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Any task in the flow (UUID or short ID). The tool finds all other tasks in the same flow automatically.' },
        limit:   { type: 'number', description: `Max tasks to return. Default ${DEFAULT_PAGE_SIZE}, capped at ${MAX_PAGE_SIZE}.` },
        cursor:  { type: 'string', description: 'Opaque pagination cursor from a previous call\'s result. Omit for the first page.' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'get_flow_exceptions',
    description: "THE HUMAN REVIEW SURFACE for a flow. Returns ONLY what needs judgment — never outputs, passing checks, or progress. Ordered by blast radius: (1) FAILED CHECKS with observed evidence; (2) JUDGMENT RESIDUE — criteria no check could cover; (3) the TERMINAL OUTPUT, always, since nothing downstream can catch it. Use when a human asks 'what needs me on this flow?' or before sign-off.",
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Any task in the flow (UUID or short ID).' },
        flow_id: { type: 'string', description: 'Alternatively, the flow UUID or name.' },
        include_history: { type: 'boolean', description: 'Also include EARLIER failed attempts, not just the current state of each gate. Default false. Useful to see what a step failed on before it eventually passed.' },
      },
      required: [],
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
    description: 'Give a flow a human name and optional shared context bag: creates the flow record and links the given tasks to it. Call after building a new flow (after create_task + set_task_output + set_task_input). CONTRACTS DO NOT BLOCK THIS — a flow with no contracts anywhere is still a flow. Returns an advisory on internal handoffs: no contract (normal), vague rules (worth sharpening), AI-QA\'d but not human-blessed (confirm_contract when you need a real gate). A short ID (e.g. BKT-F1) is auto-assigned if not given. To RENAME an already-named flow use update_flow_context(task_id, name), not this.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Project prefix, slug, or UUID' },
        name: { type: 'string', description: 'Human name for the flow (e.g. "Blog Post Publication Flow")' },
        task_ids: { type: 'array', items: { type: 'string' }, description: 'All task IDs in the flow (UUIDs or short IDs).' },
        context: { type: 'string', description: 'Optional shared context for the flow — background, goals, constraints, or instructions that apply to all tasks in this flow.' },
        short_id: { type: 'string', description: 'Optional custom short ID (e.g. "BKT-F3"). Must be unique across all your flows. Auto-generated if omitted.' },
        step_list_open: { type: 'boolean', description: 'True when the flow\'s full step list is not yet known (research, investigation — it discovers steps as it goes). Progress then says more steps are expected and never falsely reports complete. Default false. Changeable later via update_flow_context.' },
        bypass: { type: 'boolean', description: 'DEPRECATED — ignored, kept so older callers do not error. Contracts no longer block finalization.' },
        bypass_reason: { type: 'string', description: 'DEPRECATED — ignored, kept for backward compatibility.' },
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
    description: 'RENAME a flow (pass name), update its shared context bag (pass context), set/change its short ID, and/or declare whether its STEP LIST IS STILL OPEN (step_list_open) — all via any task ID in the flow. This is the canonical way to rename an existing flow: no need to re-run name_flow with the full task list.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Any task in the flow' },
        context: { type: 'string', description: 'New shared context (replaces existing)' },
        name: { type: 'string', description: 'Optional: rename the flow' },
        short_id: { type: 'string', description: 'Optional: set or change the flow short ID (e.g. "BKT-F2"). Must be unique across all your flows.' },
        step_list_open: { type: 'boolean', description: 'True = the full step list is not yet known (research/investigation discovering its next step as it goes). Progress then says "more expected" and won\'t falsely report complete. Set false once the extent is known — changeable either way mid-run.' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'guide_flow',
    description: 'Start or resume guide mode for a flow with user/external steps. Returns the current pending human step with its human_guidance text, coaching context, and what evidence is needed to advance. The agent\'s role is coach + verifier — NOT executor. Call at the start of a guide session and whenever the user asks for the current step or needs help.',
    inputSchema: {
      type: 'object',
      properties: {
        flow_id: { type: 'string', description: 'Flow UUID or flow name (partial match).' },
        task_id: { type: 'string', description: 'Any task in the flow — server finds the whole flow.' },
      },
    },
  },
  {
    name: 'advance_guide',
    description: 'Mark the current guide-mode step as done with evidence, then advance the cursor to the next human step (or signal that agent execution resumes). Requires evidence — a note, URL, or screenshot description proving the step was completed. The agent verifies the evidence before advancing.',
    inputSchema: {
      type: 'object',
      properties: {
        flow_id: { type: 'string', description: 'Flow UUID or name.' },
        task_id: { type: 'string', description: 'Any task in the flow.' },
        evidence: { type: 'string', description: 'Proof that the current step is done: a URL, confirmation message, description of what the user observed, or any verifiable artifact. Required.' },
      },
    },
  },
  {
    name: 'run_flow',
    description: 'Get the full execution playbook for an existing flow — ordered steps with contracts, current status, and the protocol to run it to completion. Call at the start of any flow run. Tells you what to produce at each step, what the gates check, and how to sequence store_artifact → complete_task → validate_output → submit_validation_result per handoff.',
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
    description: 'Start building a NEW flow — a single operation too big for one sitting, cut into steps so it holds together across its length. Call when the user wants a multi-step process from scratch, OR to resolve a FLOW seed (pass its seed_id). Builds nothing itself: returns an interview playbook plus the project\'s current tasks/sections as grounding, and with seed_id the seed\'s pre-brief + checklist (SOFT-GATED on unmet kind="prerequisite" items — surfaced, never a hard block). Run a grill-me interview, propose steps and any contracts, get ONE confirmation, then persist via create_task + set_task_output + set_task_input.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Project prefix (e.g. TDE), slug, or UUID the flow belongs to' },
        goal: { type: 'string', description: 'The end goal of the flow in the user\'s words (the final deliverable). Optional — if omitted, the playbook tells you to elicit it first.' },
        seed_id: { type: 'string', description: 'Optional. The FLOW seed this build resolves (UUID or short ID). When given, the response includes the seed pre-brief + checklist and surfaces any unmet prerequisites (soft gate). Mark the seed done after name_flow.' },
      },
      required: ['project_id'],
    },
  },
  {
    name: 'derive_output_contract',
    description: 'Derive a producing task\'s output contract FROM what its downstream consumers demand — the consumers\' input-edge rules ARE the acceptance criteria. Wire the consumer edges first (set_task_input), then call on the PRODUCER. Returns a DRAFT rule set plus an "assumptions" list (vague inherited rules, multi-consumer merges, missing criteria) to surface to the human before confirming. apply:true persists the draft — still AI-QA\'d until confirm_contract.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'The PRODUCER task whose output contract to derive (UUID or short ID).' },
        apply: { type: 'boolean', description: 'If true, persist the derived draft as this task\'s output contract. Default false — return the draft + assumptions only, for human review.' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'pull_intake_job',
    description: 'INTAKE QUEUE: claim the oldest PENDING intake job — content the user captured from the web app (e.g. a Gmail email via "+Task") for you to structure into tasks. Call on "process intake" / "process my emails". Marks the job processing and returns its payload; after structuring, call submit_intake_result. Returns {empty:true} if nothing is pending.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'submit_intake_result',
    description: 'INTAKE QUEUE: post the structured result for a job claimed via pull_intake_job. Give a short analysis of the source + the PROPOSED tasks. The human reviews, edits, and imports them in the web app (rendered live) — you are NOT creating the tasks here, only proposing. On failure, pass `error` instead of tasks.',
    inputSchema: {
      type: 'object',
      properties: {
        job_id: { type: 'string', description: 'The job id returned by pull_intake_job.' },
        analysis: { type: 'string', description: 'Short plain-language analysis of the source: what it is and what it asks for.' },
        tasks: {
          type: 'array',
          description: 'Proposed tasks for the human to review/edit/import.',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: 'Task title.' },
              context: { type: 'string', description: 'Task detail/context.' },
              section: { type: 'string', description: 'Suggested section name (optional).' },
              priority: { type: 'string', enum: ['rush', 'high', 'medium', 'low'] },
              milestones: { type: 'array', items: { type: 'string' }, description: 'Optional ordered milestone texts.' },
            },
            required: ['title'],
          },
        },
        error: { type: 'string', description: 'If the job could not be processed, the reason (instead of tasks).' },
      },
      required: ['job_id'],
    },
  },
]

// ── Section resolver helper ──────────────────────────────────
// `sections` has no user_id column — ownership is transitive (section → project → user).
// The MCP runs as service role, so RLS never backstops this: any handler taking a
// caller-supplied section_id MUST resolve it through here, never by a bare .eq('id', …).
async function resolveSection(sb: any, userId: string, sectionId: string) {
  if (!sectionId) return null
  const { data: section } = await sb.from('sections')
    .select('id, name, project_id, projects(id, user_id)')
    .eq('id', sectionId)
    .maybeSingle()
  if (!section || section.projects?.user_id !== userId) return null
  return section
}

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

// ── Project export / import (full-fidelity portable bundle) ───────────────────
// Serialize an ENTIRE project — Foundation, sections, groups, tasks (+ milestones,
// I/O edges, contracts, flow membership, custom statuses), flows (+ flow IS/KB),
// KB, IS — into a portable JSON bundle, and recreate it under a (possibly different)
// account with fresh IDs. No DB migration: pure read + insert. Rows travel VERBATIM
// (select '*') so column drift carries for free; import strips DB-managed fields and
// remaps the handful of cross-row references. Reused by the export_project /
// import_project tools (and a future web Download/Upload surface).
const EXPORT_BUNDLE_VERSION = 1

async function exportProjectBundle(sb: any, userId: string, projectId: string, logCtx?: any) {
  const project = await resolveProject(sb, userId, projectId, logCtx)
  if (!project) return null
  const pid = project.id

  const { data: full } = await sb.from('projects').select('*').eq('id', pid).single()
  const [sections, groups, tasks, flows, statuses, knowledge, instructions] = await Promise.all([
    sb.from('sections').select('*').eq('project_id', pid).order('sort_order'),
    sb.from('groups').select('*').eq('project_id', pid).order('sort_order'),
    sb.from('tasks').select('*').eq('project_id', pid).order('sort_order'),
    sb.from('flows').select('*').eq('project_id', pid),
    sb.from('project_statuses').select('*').eq('project_id', pid),
    sb.from('project_knowledge').select('*').eq('project_id', pid),
    sb.from('project_instructions').select('*').eq('project_id', pid),
  ]).then((rs: any[]) => rs.map((r: any) => r.data || []))

  const taskIds = tasks.map((t: any) => t.id)
  const flowIds = flows.map((f: any) => f.id)
  const [discussions, taskStatuses, flowIs, flowKb] = await Promise.all([
    taskIds.length ? sb.from('task_discussions').select('*').in('task_id', taskIds) : Promise.resolve({ data: [] }),
    taskIds.length ? sb.from('task_statuses').select('*').in('task_id', taskIds) : Promise.resolve({ data: [] }),
    flowIds.length ? sb.from('flow_instructions').select('*').in('flow_id', flowIds) : Promise.resolve({ data: [] }),
    flowIds.length ? sb.from('flow_knowledge').select('*').in('flow_id', flowIds) : Promise.resolve({ data: [] }),
  ]).then((rs: any[]) => rs.map((r: any) => r.data || []))

  return {
    tasker_export: {
      version: EXPORT_BUNDLE_VERSION,
      source: { name: project.name, prefix: project.prefix || null, project_id: pid },
    },
    project: { name: full?.name ?? project.name, context: full?.context ?? {} },
    sections, groups, tasks, flows,
    statuses, task_statuses: taskStatuses,
    flow_instructions: flowIs, flow_knowledge: flowKb,
    knowledge, instructions,
    task_discussions: discussions,
  }
}

// Strip DB-managed columns; everything else on the row travels verbatim.
function stripManaged(row: any, extra: string[] = []): any {
  const out = { ...row }
  for (const k of ['id', 'created_at', 'updated_at', 'user_id', 'project_id', ...extra]) delete out[k]
  return out
}

// Remap the task→task references embedded in a task's input edges (and any legacy
// output.target_task_id) to the freshly-minted task IDs.
function remapTaskRefs(input: any, output: any, taskMap: Map<string, string>) {
  const m = (id: string) => taskMap.get(id) || id
  let newInput = input
  if (input && typeof input === 'object') {
    newInput = JSON.parse(JSON.stringify(input))
    if (Array.isArray(newInput.edges)) {
      newInput.edges = newInput.edges.map((e: any) => (e && e.source_task_id) ? { ...e, source_task_id: m(e.source_task_id) } : e)
    } else if (newInput.source_task_id) {
      newInput.source_task_id = m(newInput.source_task_id)
    }
  }
  let newOutput = output
  if (output && typeof output === 'object' && output.target_task_id) {
    newOutput = { ...output, target_task_id: m(output.target_task_id) }
  }
  return { input: newInput, output: newOutput }
}

async function importProjectBundle(sb: any, userId: string, bundle: any, opts: { name?: string, reset_progress?: boolean }) {
  if (!bundle || typeof bundle !== 'object' || !bundle.project) throw new Error('Invalid bundle: missing "project". Pass the object returned by export_project.')
  const resetProgress = opts.reset_progress === true

  // 1. New project (fresh slug + prefix), carrying the Foundation context verbatim.
  const name = (opts.name && opts.name.trim()) || bundle.project.name || 'Imported Project'
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '-' + Date.now().toString(36)
  const prefix = await deriveProjectPrefix(sb, userId, name)
  const { data: proj, error: pe } = await sb.from('projects')
    .insert({ name, slug, user_id: userId, context: bundle.project.context ?? {}, ...(prefix ? { prefix } : {}) })
    .select().single()
  if (pe) throw new Error(`Failed to create project: ${pe.message}`)
  const newProjectId = proj.id

  // The projects AFTER-INSERT trigger auto-seeds a baseline Instruction Set. The bundle
  // already carries the source project's full IS (baseline included), so clear the
  // auto-seeded rows to keep the import an exact reproduction rather than a superset.
  await sb.from('project_instructions').delete().eq('project_id', newProjectId)

  // 2. Pre-mint new IDs for every FK-referenced entity so references remap in one pass.
  const sectionMap = new Map<string, string>(), groupMap = new Map<string, string>(),
        flowMap = new Map<string, string>(), statusMap = new Map<string, string>(),
        taskMap = new Map<string, string>()
  for (const s of bundle.sections || []) sectionMap.set(s.id, crypto.randomUUID())
  for (const g of bundle.groups || []) groupMap.set(g.id, crypto.randomUUID())
  for (const f of bundle.flows || []) flowMap.set(f.id, crypto.randomUUID())
  for (const s of bundle.statuses || []) statusMap.set(s.id, crypto.randomUUID())
  for (const t of bundle.tasks || []) taskMap.set(t.id, crypto.randomUUID())

  const counts: Record<string, number> = {}
  const insertRows = async (table: string, rows: any[]) => {
    if (!rows.length) return
    const { error } = await sb.from(table).insert(rows)
    if (error) throw new Error(`Insert into ${table} failed: ${error.message}`)
    counts[table] = (counts[table] || 0) + rows.length
  }

  // 3. Sections → groups (section FK) → custom statuses → flows (project FK).
  await insertRows('sections', (bundle.sections || []).map((s: any) => ({
    ...stripManaged(s), id: sectionMap.get(s.id), project_id: newProjectId,
  })))
  await insertRows('groups', (bundle.groups || []).map((g: any) => ({
    ...stripManaged(g), id: groupMap.get(g.id), project_id: newProjectId,
    section_id: g.section_id ? (sectionMap.get(g.section_id) ?? null) : null,
  })))
  await insertRows('project_statuses', (bundle.statuses || []).map((s: any) => ({
    ...stripManaged(s), id: statusMap.get(s.id), project_id: newProjectId, user_id: userId,
  })))
  // Flow short_id is unique PER ACCOUNT, so it cannot be preserved — regenerate below.
  await insertRows('flows', (bundle.flows || []).map((f: any) => ({
    ...stripManaged(f, ['short_id']), id: flowMap.get(f.id), project_id: newProjectId, user_id: userId, short_id: null,
  })))
  if ((bundle.flows || []).length) {
    let n = 1
    if (proj.prefix) {
      const { data: ex } = await sb.from('flows').select('short_id').eq('user_id', userId).like('short_id', `${proj.prefix}-F%`)
      const used = (ex || []).map((r: any) => { const mm = r.short_id?.match(/^.+-F(\d+)$/); return mm ? parseInt(mm[1], 10) : 0 })
      n = used.length ? Math.max(...used) + 1 : 1
    }
    for (const f of bundle.flows) {
      const sid = proj.prefix ? `${proj.prefix}-F${n++}` : `${name} - F${n++}`
      await sb.from('flows').update({ short_id: sid }).eq('id', flowMap.get(f.id))
    }
  }

  // 4. Tasks. Preserve short_id (new project is empty, so original numbers stay unique
  //    AND collision-free — the trigger only fires when short_id is null). Remap FKs and
  //    embedded I/O references; defer the task→task seed link to a 2nd pass.
  await insertRows('tasks', (bundle.tasks || []).map((t: any) => {
    const { input, output } = remapTaskRefs(t.input, t.output, taskMap)
    return {
      ...stripManaged(t, ['intake_job_id', 'spawned_from_seed_id', 'completed_at']),
      id: taskMap.get(t.id), project_id: newProjectId, user_id: userId,
      status: resetProgress ? 'pending' : t.status,
      completed_at: (!resetProgress && t.status === 'done') ? (t.completed_at ?? null) : null,
      section_id: t.section_id ? (sectionMap.get(t.section_id) ?? null) : null,
      group_id: t.group_id ? (groupMap.get(t.group_id) ?? null) : null,
      flow_id: t.flow_id ? (flowMap.get(t.flow_id) ?? null) : null,
      custom_status_id: t.custom_status_id ? (statusMap.get(t.custom_status_id) ?? null) : null,
      intake_job_id: null, spawned_from_seed_id: null,
      input, output,
    }
  }))
  // 5. Backfill task→task seed provenance now that every task exists.
  for (const t of (bundle.tasks || [])) {
    if (t.spawned_from_seed_id && taskMap.has(t.spawned_from_seed_id)) {
      await sb.from('tasks').update({ spawned_from_seed_id: taskMap.get(t.spawned_from_seed_id) }).eq('id', taskMap.get(t.id))
    }
  }

  // 6. Leaf rows: milestones, task↔status junction, flow IS/KB, project KB/IS.
  await insertRows('task_discussions', (bundle.task_discussions || [])
    .filter((d: any) => taskMap.has(d.task_id))
    .map((d: any) => ({ ...stripManaged(d, ['task_id']), task_id: taskMap.get(d.task_id), user_id: userId })))
  await insertRows('task_statuses', (bundle.task_statuses || [])
    .filter((ts: any) => taskMap.has(ts.task_id) && statusMap.has(ts.status_id))
    .map((ts: any) => ({ ...stripManaged(ts, ['task_id', 'status_id']), task_id: taskMap.get(ts.task_id), status_id: statusMap.get(ts.status_id) })))
  await insertRows('flow_instructions', (bundle.flow_instructions || [])
    .filter((r: any) => flowMap.has(r.flow_id))
    .map((r: any) => ({ ...stripManaged(r, ['flow_id']), flow_id: flowMap.get(r.flow_id), user_id: userId })))
  await insertRows('flow_knowledge', (bundle.flow_knowledge || [])
    .filter((r: any) => flowMap.has(r.flow_id))
    .map((r: any) => ({ ...stripManaged(r, ['flow_id']), flow_id: flowMap.get(r.flow_id), user_id: userId })))
  await insertRows('project_knowledge', (bundle.knowledge || [])
    .map((r: any) => ({ ...stripManaged(r), project_id: newProjectId, user_id: userId })))
  await insertRows('project_instructions', (bundle.instructions || [])
    .map((r: any) => ({ ...stripManaged(r), project_id: newProjectId, user_id: userId })))

  return { project: proj, counts }
}

// ── Tool handlers ─────────────────────────────────────────────
// TDE-384: resolve a flow by flow_id (UUID or partial name) or by a task_id within it.
async function resolveFlowRef(sb: any, userId: string, args: any) {
  if (args.flow_id) {
    const looksLikeUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(args.flow_id)
    if (looksLikeUuid) {
      const { data } = await sb.from('flows').select('id, name').eq('id', args.flow_id).eq('user_id', userId).maybeSingle()
      return data
    }
    const { data } = await sb.from('flows').select('id, name').eq('user_id', userId).ilike('name', `%${args.flow_id}%`).order('created_at', { ascending: false }).limit(1).maybeSingle()
    return data
  }
  if (args.task_id) {
    const anchor = await resolveTask(sb, userId, args.task_id)
    if (anchor?.flow_id) {
      const { data } = await sb.from('flows').select('id, name').eq('id', anchor.flow_id).eq('user_id', userId).maybeSingle()
      return data
    }
  }
  return null
}

async function runTool(sb: any, userId: string, name: string, args: any, rawParams?: any, tokenActor?: string | null): Promise<string> {
  const logCtx = { tool_name: name, raw_params: rawParams }
  switch (name) {

    case 'list_projects': {
      const envFilter = args.environment_id || null
      let projQuery = sb.from('projects').select('id, name, slug, prefix, context, environment_id').eq('user_id', userId).order('sort_order')
      if (envFilter) projQuery = projQuery.eq('environment_id', envFilter)
      const [{ data: projects }, { data: tasks }, { data: envRows }, { data: us }] = await Promise.all([
        projQuery,
        sb.from('tasks').select('project_id, status').eq('user_id', userId),
        sb.from('environments').select('id, name, sort_order').eq('user_id', userId).order('sort_order'),
        sb.from('user_settings').select('active_environment_id').eq('user_id', userId).maybeSingle(),
      ])
      if (!projects?.length) return envFilter ? 'No projects in that Environment.' : 'No projects found.'
      const counts: Record<string, { total: number; done: number }> = {}
      for (const t of (tasks ?? [])) {
        if (!counts[t.project_id]) counts[t.project_id] = { total: 0, done: 0 }
        counts[t.project_id].total++
        if (t.status === 'done') counts[t.project_id].done++
      }
      const activeEnvId = us?.active_environment_id ?? null
      const renderProject = (p: any) => {
        const c = counts[p.id] ?? { total: 0, done: 0 }
        const pct = c.total > 0 ? Math.round((c.done / c.total) * 100) : 0
        const ctx = p.context ?? {}
        return [
          `## ${p.name}  (prefix: ${p.prefix} | slug: ${p.slug} | id: ${p.id})`,
          `Progress: ${c.done}/${c.total} tasks · ${pct}%`,
          ctx.goal ? `Goal: ${ctx.goal}` : null,
          ctx.why  ? `Why:  ${ctx.why}`  : null,
        ].filter(Boolean).join('\n')
      }
      // Bucket projects by Environment. A project whose environment_id is null/unknown
      // falls into "(unassigned)" (the app treats that as Default). When everything sits
      // in a single Environment, render flat — no group headers — to stay uncluttered.
      const envList = envRows ?? []
      const buckets: Record<string, any[]> = {}
      for (const e of envList) buckets[e.id] = []
      const unassigned: any[] = []
      for (const p of projects) {
        if (p.environment_id && buckets[p.environment_id]) buckets[p.environment_id].push(p)
        else unassigned.push(p)
      }
      const populatedGroups = envList.filter((e: any) => buckets[e.id].length).length + (unassigned.length ? 1 : 0)
      if (populatedGroups <= 1) return projects.map(renderProject).join('\n\n')
      const blocks: string[] = []
      for (const e of envList) {
        if (!buckets[e.id].length) continue
        const active = e.id === activeEnvId ? '  ● active' : ''
        blocks.push(`# ▸ Environment: ${e.name}${active}  (id: ${e.id})\n\n` + buckets[e.id].map(renderProject).join('\n\n'))
      }
      if (unassigned.length) blocks.push(`# ▸ Environment: (unassigned)\n\n` + unassigned.map(renderProject).join('\n\n'))
      return blocks.join('\n\n')
    }

    case 'get_project': {
      const project = await resolveProject(sb, userId, args.project_id, logCtx)
      if (!project) return `Project "${args.project_id}" not found.`
      const [{ data: sections }, { data: tasks }, { data: projPhases }] = await Promise.all([
        sb.from('sections').select('*').eq('project_id', project.id).order('sort_order'),
        sb.from('tasks').select('*').eq('project_id', project.id).order('sort_order'),
        sb.from('phases').select(PHASE_COLS).eq('project_id', project.id).order('sort_order'),
      ])
      // TDE-319/371: Notes (task detail) are the bulk of a large project's payload and are the
      // known context-overflow cause. Omit them by default (the IDs/titles/badges are the map);
      // include_notes:true restores the old full dump, get_task fetches one task's detail cheaply.
      const includeNotes = !!args.include_notes
      const foundationLines = renderFoundation(project.context)
      const lines: string[] = [
        `# ${project.name}`,
        `prefix: ${project.prefix} | slug: ${project.slug} | id: ${project.id}`,
        '',
        '## Foundation',
        ...(foundationLines.length ? foundationLines : ['(no Foundation set — run bootstrap_project to ground it)']),
        '',
      ]
      if (!includeNotes) lines.push('_Task Notes omitted — pass include_notes:true, or read one task via get_task._', '')

      // TDE-804: phase roll-up, emitted only for projects that actually use phases. Flow steps
      // leave the denominator (TDE-320) so these tallies match the board and list_sections.
      if (projPhases?.length) {
        const pc: Record<string, { open: number; total: number }> = {}
        const unph = { open: 0, total: 0 }
        for (const t of ((tasks ?? []) as any[])) {
          if (t.flow_id) continue
          const b = t.phase_id ? (pc[t.phase_id] ?? (pc[t.phase_id] = { open: 0, total: 0 })) : unph
          b.total++
          if (t.status !== 'done') b.open++
        }
        lines.push('## Phases')
        for (const p of projPhases as any[]) {
          const c = pc[p.id] ?? { open: 0, total: 0 }
          const done = c.total - c.open
          const pct = c.total ? Math.round((done / c.total) * 100) : 0
          lines.push(`- ${p.name}${p.id === project.active_phase_id ? ' ● ACTIVE' : ''} — ${done}/${c.total} done (${pct}%)${p.exit_condition ? ` · ends when: ${p.exit_condition}` : ''}${p.due_date ? ` · due ${p.due_date}` : ''}`)
        }
        lines.push(`- (unphased) — ${unph.total - unph.open}/${unph.total} done`)
        lines.push('')
      }

      const renderTask = (t: any) => {
        const sid = (project.prefix && t.short_id != null) ? `${project.prefix}-${t.short_id}` : t.id
        const badges = [t.kind === 'seed' ? `SEED→${t.seed_target}` : null, t.priority, t.status, t.due_date ? `due ${t.due_date}` : null].filter(Boolean).join(', ')
        lines.push(`- [${sid}] ${t.text}  (${badges})`)
        if (includeNotes && t.detail) lines.push(`  Notes: ${t.detail}`)
      }

      for (const s of (sections ?? [])) {
        lines.push(`## Section: ${s.name}  (id: ${s.id})`)
        const sts = (tasks ?? []).filter((t: any) => t.section_id === s.id)
        if (!sts.length) { lines.push('(empty)'); lines.push(''); continue }
        for (const t of sts) renderTask(t)
        lines.push('')
      }
      const ungrouped = (tasks ?? []).filter((t: any) => !t.section_id)
      if (ungrouped.length) {
        lines.push('## Ungrouped Tasks')
        for (const t of ungrouped) renderTask(t)
      }
      return lines.join('\n')
    }

    case 'bootstrap_project': {
      const { data: draft, error } = await sb.from('project_drafts')
        .insert({ user_id: userId, name: args.name || null, intent: args.intent || null, status: 'eliciting' })
        .select('id').single()
      if (error) throw new Error(error.message)
      return JSON.stringify({
        status: 'foundation_interview_started',
        draft_id: draft.id,
        phase: 1,
        hard_rule: 'NEVER be sycophantic. Challenge vague, contradictory, unrealistic, or thin input — every time, at every phase. Pushback exists to improve the input and the result, NOT to disagree for its own sake; when the user is right, say so and move on. Accepting weak input to be agreeable is a failure of this tool.',
        do_not: 'Do NOT open with AskUserQuestion. Do NOT draft the brief yet. Do NOT call create_project (it is a quick/empty escape hatch, not this path). The later phases unlock one at a time via bootstrap_advance — you cannot skip ahead.',
        phase_1_elicit: 'PHASE 1 — ELICIT, in the user\'s OWN WORDS, in plain PROSE (just ask in chat). If they have not already described the project, ask them to. Then a few genuinely OPEN follow-ups for what ONLY they know: the real why, the vision, what a great outcome FEELS like, their ambition, what they fear / what would make it suck. Listen, reflect back, dig. Tiles cannot capture vision or taste — using AskUserQuestion for elicitation is the known failure of this tool.',
        principle: 'The user is the DECISION-MAKER and the source of what only they can know; YOU are the expert who shapes that raw input into something sharp. Free-text input is GOOD and wanted — the skill is asking WELL and PROCESSING well (synthesize + challenge), not avoiding it. People critique better than they create — so later you turn their words into a DRAFT they red-pen, never option tiles.',
        foundation_target: {
          note: 'What you are building toward across the phases — persisted as the project `context`. Fixed CORE required; EXTENDED + FLEXIBLE as they fit the project type.',
          core_required: {
            goal: 'The outcome the project achieves.',
            why: 'The real problem/need behind it (intent). ONLY the user knows this; never fabricate it.',
            scope: 'What is IN and, explicitly, what is OUT. The out-of-scope is half the value.',
            definition_of_done: 'What success looks like — a concrete end-state.',
            failure: 'What failure looks like / anti-goals. Most-skipped, high-leverage.',
            quality_bar: 'Throwaway prototype vs production-grade. Nobody states it unprompted.',
            assumptions: 'What you inferred/assumed (mark load-bearing) + open load-bearing unknowns.',
          },
          extended: 'audience, success_metrics, constraints, risks, ai_behavior — add when relevant.',
          flexible: 'Extra keys that fit the project type (content → voice/themes; SaaS → core features; research → hypotheses).',
          one_brief_many_lenses: 'ONE written brief, scaled — not a doc suite — but covering the lenses BRD (why/goal) · MRD (market/audience) · FRD/PRD (scope/done) · SRS (constraints/stack) · SOW (scope in/out).',
        },
        next: `When you have the user's free-text answers, call bootstrap_advance(draft_id:"${draft.id}", step:"elicited", answers:<their VERBATIM words>).`,
      })
    }

    case 'bootstrap_advance': {
      const { draft_id, step } = args
      if (!draft_id || !step) return 'draft_id and step are required.'
      const { data: draft } = await sb.from('project_drafts').select('*').eq('id', draft_id).eq('user_id', userId).maybeSingle()
      if (!draft) return `Draft "${draft_id}" not found — call bootstrap_project first.`
      const nowIso = new Date().toISOString()

      if (step === 'elicited') {
        if (draft.status !== 'eliciting') return `Out of order: this draft is at "${draft.status}", past elicitation. Continue from there.`
        const answers = String(args.answers || '').trim()
        if (answers.length < 40) return 'Phase 1 is not done. Submit the user\'s ACTUAL free-text answers (their verbatim words) as `answers`. If you have not asked the open prose questions yet, ask them now — do NOT use AskUserQuestion tiles for this.'
        await sb.from('project_drafts').update({ status: 'drafting', brief: { _elicited: answers }, updated_at: nowIso }).eq('id', draft.id)
        return JSON.stringify({
          status: 'phase_2_draft_and_probe',
          phase: 2,
          instruction: 'PHASE 2 — DRAFT the Foundation brief NOW from their answers (+ repo if any) and SHOW it to the user as real text. Then PROBE its gaps as interrogations of YOUR OWN draft: "I wrote X for scope — missing or wrong?", "Y and Z contradict — which wins?", "I assumed Q — confirm?". ONLY here may you use AskUserQuestion tiles, and ONLY for genuine expertise FORKS (platform, build approach, scope IN/OUT) with a (Recommended) default — never anchor the "why".',
          challenge: 'Honor the hard_rule — never sycophantic. Push back on weak/contradictory/over-scoped input before locking it (e.g. if they want two big features in v1, question whether v1 needs both). Mark what you inferred vs what only they can confirm.',
          record_decisions: 'When a probe RESOLVES into a deliberate choice (deferred scope, a contradiction settled, a road not taken), capture it in the brief as a `coherence_decisions` entry: an array of self-contained "<decision> — because <rationale>" strings (e.g. "Deferred subscriptions to Phase 2 — the core booking flow must prove out first"). This is decision provenance: it surfaces in the Foundation so future agents inherit the WHY and do not re-litigate settled calls or re-propose deferred scope. Only real decisions with a rationale — not every question asked.',
          next: 'Once the user has SEEN the drafted brief, call bootstrap_advance(draft_id, step:"drafted", brief:<Foundation object: core + extended + flexible keys, incl. coherence_decisions[] for any decisions reached>).',
        })
      }

      if (step === 'drafted') {
        if (draft.status !== 'drafting' && draft.status !== 'blessing') return `Out of order: this draft is at "${draft.status}". Complete step "elicited" (Phase 1) first.`
        const brief = args.brief
        if (!brief || typeof brief !== 'object' || Array.isArray(brief)) return 'Submit the drafted Foundation as `brief` — an object with the core fields (goal, why, scope, definition_of_done, failure, quality_bar, assumptions).'
        await sb.from('project_drafts').update({ status: 'blessing', brief, updated_at: nowIso }).eq('id', draft.id)
        return JSON.stringify({
          status: 'phase_3_bless',
          phase: 3,
          instruction: 'PHASE 3 — BLESS. Present the FULL written brief to the user for LINE-LEVEL confirm/edit — never a one-line "save it?" toggle. Make every change they ask for; revise and re-show (bound to ~1–2 passes). Do NOT create the project until they EXPLICITLY bless it.',
          next: 'When the user blesses the brief, call bootstrap_advance(draft_id, step:"blessed", brief:<final edited Foundation>, name:<the project name>).',
        })
      }

      if (step === 'blessed') {
        if (draft.status !== 'blessing') return `Out of order: this draft is at "${draft.status}". You must draft (step "drafted") and have the user review it before blessing.`
        const brief = (args.brief && typeof args.brief === 'object' && !Array.isArray(args.brief)) ? args.brief : draft.brief
        if (!brief || typeof brief !== 'object' || brief._elicited) return 'Submit the final blessed Foundation as `brief` (the full object the user blessed, not the raw elicitation).'
        const name = (args.name || draft.name || '').trim() || 'Untitled Project'
        const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '-' + Date.now().toString(36)
        const prefix = await deriveProjectPrefix(sb, userId, name)
        const { data: proj, error: perr } = await sb.from('projects')
          .insert({ name, slug, user_id: userId, context: brief, ...(prefix ? { prefix } : {}) })
          .select().single()
        if (perr) throw new Error(perr.message)
        await getOrCreateBacklog(sb, proj.id)
        await sb.from('project_drafts').update({ status: 'done', brief, updated_at: nowIso }).eq('id', draft.id)
        return JSON.stringify({
          status: 'project_created',
          project: { prefix: proj.prefix || null, slug: proj.slug, id: proj.id },
          tailor_is: 'A baseline Instruction Set was auto-seeded. Propose 2–4 project-specific IS additions (conventions, output/working style, autonomy) drawn from the brief; add confirmed ones via create_is_entry (universal:true for rules that must hold inside flows).',
          then_populate: 'After the IS, run the POPULATE phase below (opt-in — offer it, propose in ONE ratify pass).',
          population: {
            mandatory: 'Populate is NOT finished when the core/near-term work is created. You MUST ALSO seed the DEFERRED scope — fast-follows, the explicit scope_out items, and the undecided/open threads from the brief. THIS HOLDS EVEN WHEN YOU BUILD A CORE FLOW: building the flow and seeding the rest are NOT alternatives. A board where a real product reads as a handful of tasks because everything deferred is invisible is WRONG. Before finishing, re-scan scope_out + assumptions and confirm each deferred thread is a seed (or a stated, deliberate omission).',
            design_is_core: 'For any product whose value depends on look/feel/delight (consumer, UX-heavy, "make it fun"), DESIGN is core work — emit a concrete design task (or design seed), never bury it as a sub-bullet.',
            buckets: [
              'CONCRETE TASK — path clear from the brief: create_task in its real section now (use milestones:[...] inline).',
              'FLOW SEED — multi-step contract-linked process: create_task(kind:"seed", seed_target:"flow", open_questions:[...], milestones:[...]) in a "Suggested Flows" section; detail = the flow pre-brief. open_questions = answered when building; milestones = prerequisites to settle first (they soft-gate build_new_flow).',
              'CONTEXT SEED — needed but underspecified: create_task(kind:"seed", seed_target:"task", open_questions:[...], milestones:[...]) in a "Needs Context" section; resolved later via resolve_seed. Use milestones for any prerequisite that must be done before this can be specced.',
              'KB FROM DECISIONS — capture real decisions made during the interview ("chose X over Y because Z") via create_kb_entry.',
            ],
            sections: 'Provision the real HOME sections the work implies BEFORE seeding (e.g. a "Design" or "Growth" section) so resolved seeds have somewhere to land — never leave resolved work in a staging section.',
            restraint: 'Restraint is about PRECISION not coverage: don\'t fabricate milestone detail for work nobody understands yet (that is what a seed is for). Coverage of deferred scope is mandatory. "Suggested Flows"/"Needs Context" are STAGING (seeds only); Backlog = not-yet-prioritized.',
          },
        })
      }

      return `Unknown step "${step}". Use "elicited", then "drafted", then "blessed" — in order.`
    }

    case 'get_project_foundation': {
      const project = await resolveProject(sb, userId, args.project_id, logCtx)
      if (!project) return `Project "${args.project_id}" not found.`
      const foundationLines = renderFoundation(project.context)
      if (!foundationLines.length) return `"${project.name}" has no Foundation yet. Run bootstrap_project to ground it (intent, scope, success/failure, quality bar).`
      return [`# Foundation — ${project.name}`, '', ...foundationLines.map(l => `- ${l}`)].join('\n')
    }

    case 'create_project': {
      const { name, context } = args
      // Resolve the Environment: explicit arg → active pointer → the sole Environment → error.
      // The AI never silently inherits the active pointer for anything but this default (TDE-308).
      let environmentId = args.environment_id || null
      if (environmentId) {
        const { data: env } = await sb.from('environments').select('id').eq('id', environmentId).eq('user_id', userId).maybeSingle()
        if (!env) return `Environment "${environmentId}" not found. Call list_environments to see valid ids.`
      } else {
        const { data: usEnv } = await sb.from('user_settings').select('active_environment_id').eq('user_id', userId).maybeSingle()
        environmentId = usEnv?.active_environment_id ?? null
        if (!environmentId) {
          const { data: envs } = await sb.from('environments').select('id').eq('user_id', userId).order('sort_order')
          if (!envs?.length) return 'No Environment exists yet. Create one with create_environment, then retry.'
          if (envs.length === 1) environmentId = envs[0].id
          else return 'No active Environment is set and you have more than one. Pass environment_id explicitly (see list_environments).'
        }
      }
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
        + '-' + Date.now().toString(36)
      // Auto-assign a short-ID handle (prefix) so tasks get usable IDs (e.g. WMP-3)
      // from the start. Caller can rename it later via update_project.
      const prefix = await deriveProjectPrefix(sb, userId, name)
      const { data, error } = await sb.from('projects')
        .insert({ name, slug, user_id: userId, context: context ?? {}, environment_id: environmentId, ...(prefix ? { prefix } : {}) })
        .select().single()
      if (error) throw new Error(error.message)
      await getOrCreateBacklog(sb, data.id)

      const { data: envRow } = await sb.from('environments').select('name').eq('id', environmentId).maybeSingle()

      // A baseline Instruction Set (task hygiene + working preferences) is seeded
      // automatically by an AFTER INSERT trigger on `projects` (TDE-193), so it applies
      // to every creation path. Here we just nudge the assistant to tailor it.
      return `Created project "${name}"\nprefix: ${data.prefix || '(none — set one via update_project)'} | slug: ${data.slug} | id: ${data.id}${envRow ? ` | environment: ${envRow.name}` : ''}` +
        `\n\nA baseline Instruction Set (task hygiene + working preferences) was applied automatically.` +
        `\n\nNEXT — tailor it: from what you know about this project (stack, language, conventions, workflow, output/commit style), propose 2–4 specific IS additions and ask the user to confirm before adding them via create_is_entry. Set universal:true for rules that must hold even inside flows (e.g. code style, deploy rules). Don't assume — propose, then add only what's confirmed.` +
        `\n\nTHEN, to go from grounding to action, offer to build the first concrete chunk of work as a flow (build_new_flow).`
    }

    case 'list_environments': {
      const [{ data: envs }, { data: projs }, { data: us }] = await Promise.all([
        sb.from('environments').select('id, name, sort_order').eq('user_id', userId).order('sort_order'),
        sb.from('projects').select('environment_id').eq('user_id', userId),
        sb.from('user_settings').select('active_environment_id').eq('user_id', userId).maybeSingle(),
      ])
      if (!envs?.length) return 'No Environments yet. Create one with create_environment.'
      const pc: Record<string, number> = {}
      for (const p of (projs ?? [])) { if (p.environment_id) pc[p.environment_id] = (pc[p.environment_id] ?? 0) + 1 }
      const activeId = us?.active_environment_id ?? null
      return envs.map((e: any) => {
        const n = pc[e.id] ?? 0
        return `${e.id === activeId ? '● ' : '  '}${e.name}  (${n} project${n === 1 ? '' : 's'} | id: ${e.id})${e.id === activeId ? '  — active' : ''}`
      }).join('\n')
    }

    case 'create_environment': {
      if (!args.name?.trim()) return 'name is required.'
      const { data: last } = await sb.from('environments')
        .select('sort_order').eq('user_id', userId).order('sort_order', { ascending: false }).limit(1).maybeSingle()
      const sortOrder = (last?.sort_order ?? -1) + 1
      const { data, error } = await sb.from('environments')
        .insert({ user_id: userId, name: args.name.trim(), sort_order: sortOrder }).select().single()
      if (error) throw new Error(error.message)
      return `Created Environment "${data.name}"\nid: ${data.id}\n\nThe active Environment is unchanged — switch it in the web app.`
    }

    case 'rename_environment': {
      if (!args.environment_id || !args.name?.trim()) return 'environment_id and name are required.'
      const { data: env } = await sb.from('environments').select('id, name').eq('id', args.environment_id).eq('user_id', userId).maybeSingle()
      if (!env) return `Environment "${args.environment_id}" not found.`
      await sb.from('environments').update({ name: args.name.trim() }).eq('id', env.id)
      return `Renamed Environment "${env.name}" → "${args.name.trim()}".`
    }

    case 'delete_environment': {
      if (!args.environment_id) return 'environment_id is required.'
      if (!args.confirmed) return 'You must set confirmed: true to delete an Environment. Its projects are preserved and moved to another Environment.'
      const { data: env } = await sb.from('environments').select('id, name').eq('id', args.environment_id).eq('user_id', userId).maybeSingle()
      if (!env) return `Environment "${args.environment_id}" not found.`
      const { data: allEnvs } = await sb.from('environments').select('id, name').eq('user_id', userId).order('sort_order')
      if ((allEnvs?.length ?? 0) <= 1) return 'Cannot delete the last Environment — every project must live in one. Create another first, or just rename this one.'
      // Resolve the reassignment target: explicit arg → an Environment named "Default" → the next one.
      const others = (allEnvs ?? []).filter((e: any) => e.id !== env.id)
      let target: any = null
      if (args.reassign_to_id) {
        target = others.find((e: any) => e.id === args.reassign_to_id) ?? null
        if (!target) return `reassign_to_id "${args.reassign_to_id}" is not another Environment of yours.`
      } else {
        target = others.find((e: any) => e.name === 'Default') ?? others[0]
      }
      // Move projects FIRST (never orphan/delete them), then delete the Environment.
      const { data: moved } = await sb.from('projects')
        .update({ environment_id: target.id }).eq('environment_id', env.id).eq('user_id', userId).select('id')
      // If the deleted Environment was the active pointer, repoint it to the target.
      const { data: us } = await sb.from('user_settings').select('active_environment_id').eq('user_id', userId).maybeSingle()
      if (us?.active_environment_id === env.id) {
        await sb.from('user_settings').update({ active_environment_id: target.id }).eq('user_id', userId)
      }
      await sb.from('environments').delete().eq('id', env.id)
      const n = moved?.length ?? 0
      return `Deleted Environment "${env.name}". Moved ${n} project${n === 1 ? '' : 's'} to "${target.name}".`
    }

    case 'export_project': {
      const bundle = await exportProjectBundle(sb, userId, args.project_id, logCtx)
      if (!bundle) return `Project "${args.project_id}" not found.`
      // Return the raw JSON so the agent can write it straight to a file / hand it to import_project.
      return JSON.stringify(bundle, null, 2)
    }

    case 'import_project': {
      // Accept the bundle as an object, or as a JSON string (some clients stringify nested objects).
      let bundle = args.bundle
      if (typeof bundle === 'string') {
        try { bundle = JSON.parse(bundle) } catch { return 'bundle could not be parsed as JSON. Pass the object returned by export_project.' }
      }
      if (!bundle || typeof bundle !== 'object') return 'bundle is required — pass the object returned by export_project.'
      const { project, counts } = await importProjectBundle(sb, userId, bundle, { name: args.name, reset_progress: args.reset_progress })
      const summary = Object.entries(counts).map(([k, v]) => `${v} ${k.replace(/_/g, ' ')}`).join(', ') || 'no child rows'
      const srcPrefix = bundle.tasker_export?.source?.prefix
      return `Imported project "${project.name}" (prefix: ${project.prefix || '(none)'} | id: ${project.id}).\nReproduced: ${summary}.` +
        `\nTask short IDs preserved${srcPrefix ? ` (e.g. ${srcPrefix}-N → ${project.prefix}-N)` : ''}; flow short IDs regenerated for this account.` +
        (args.reset_progress ? '\nAll tasks reset to pending (template copy).' : '\nStatuses and completion preserved (backup copy).')
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
      const [{ data }, { data: tasks }] = await Promise.all([
        sb.from('sections').select('id, name').eq('project_id', project.id).order('sort_order'),
        sb.from('tasks').select('section_id, status, flow_id').eq('project_id', project.id),
      ])
      if (!data?.length) return `No sections in "${project.name}".`
      // Per-section task tallies (default behaviour): open = not done, matching the app's hide-done convention.
      // TDE-320: flow steps are not tasks — they leave the section tally (matches list_tasks + the board).
      const counts: Record<string, { open: number; total: number }> = {}
      for (const t of ((tasks ?? []) as any[])) {
        if (!t.section_id || t.flow_id) continue
        const c = counts[t.section_id] ?? (counts[t.section_id] = { open: 0, total: 0 })
        c.total++
        if (t.status !== 'done') c.open++
      }
      return data.map((s: any) => {
        const c = counts[s.id] ?? { open: 0, total: 0 }
        return `[id: ${s.id}] ${s.name} — ${c.open} open / ${c.total} total`
      }).join('\n')
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

    case 'rename_section': {
      const project = await resolveProject(sb, userId, args.project_id, logCtx)
      if (!project) return `Project "${args.project_id}" not found.`
      const { data: section } = await sb.from('sections')
        .select('id, name').eq('id', args.section_id).eq('project_id', project.id).maybeSingle()
      if (!section) return `Section not found in "${project.name}".`
      const { error } = await sb.from('sections').update({ name: args.name }).eq('id', section.id)
      if (error) throw new Error(error.message)
      return `Renamed section "${section.name}" → "${args.name}" in "${project.name}".`
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

    case 'list_phases': {
      const project = await resolveProject(sb, userId, args.project_id, logCtx)
      if (!project) return `Project "${args.project_id}" not found.`
      const [{ data: phases }, { data: tasks }] = await Promise.all([
        sb.from('phases').select(PHASE_COLS).eq('project_id', project.id).order('sort_order'),
        sb.from('tasks').select('phase_id, status, flow_id').eq('project_id', project.id),
      ])
      // TDE-320/TDE-806: flow steps leave every denominator — same rule the board and
      // list_sections use, so the phase tallies reconcile with what the human sees.
      const counts: Record<string, { open: number; total: number }> = {}
      const unphased = { open: 0, total: 0 }
      for (const t of ((tasks ?? []) as any[])) {
        if (t.flow_id) continue
        const bucket = t.phase_id ? (counts[t.phase_id] ?? (counts[t.phase_id] = { open: 0, total: 0 })) : unphased
        bucket.total++
        if (t.status !== 'done') bucket.open++
      }
      if (!phases?.length) {
        return `No phases in "${project.name}" — every task is unphased (${unphased.open} open / ${unphased.total} total).\n`
          + `Phases are optional; create one with create_phase when the project has stages worth separating.`
      }
      const lines = phases.map((p: any) => {
        const c = counts[p.id] ?? { open: 0, total: 0 }
        const active = p.id === project.active_phase_id ? ' ← ACTIVE' : ''
        const exit = p.exit_condition ? `\n    ends when: ${p.exit_condition}` : `\n    ⚠ no exit condition set — this phase is just a bucket until it has one`
        const due = p.due_date ? `\n    due: ${p.due_date} (optional)` : ''
        return `[id: ${p.id}] ${p.name} — ${c.open} open / ${c.total} total${active}${exit}${due}`
      })
      lines.push(`\nUnphased — ${unphased.open} open / ${unphased.total} total. Not a backlog to drain: work that belongs to no stage (idea inventories, evergreen items) is correctly left unphased.`)
      if (!project.active_phase_id) lines.push(`\n⚠ No active phase set — get_ready_work cannot scope to a phase. Set one with set_active_phase.`)
      return lines.join('\n')
    }

    case 'create_phase': {
      const project = await resolveProject(sb, userId, args.project_id, logCtx)
      if (!project) return `Project "${args.project_id}" not found.`
      const { data: existing } = await sb.from('phases')
        .select('sort_order').eq('project_id', project.id).order('sort_order', { ascending: false }).limit(1).maybeSingle()
      const { data, error } = await sb.from('phases').insert({
        project_id: project.id,
        name: args.name,
        sort_order: (existing?.sort_order ?? -1) + 1,
        exit_condition: args.exit_condition ?? null,
        due_date: args.due_date || null,
      }).select(PHASE_COLS).single()
      if (error) throw new Error(error.message)
      // First phase in a project becomes active — otherwise phases exist but nothing is
      // "current", and get_ready_work has nothing to scope to.
      let activated = ''
      if (!project.active_phase_id) {
        await sb.from('projects').update({ active_phase_id: data.id }).eq('id', project.id)
        activated = '\nSet as the ACTIVE phase (it was the first one).'
      }
      const warn = args.exit_condition ? '' : '\n⚠ No exit_condition. Add one with update_phase — without it there is nothing to say when this phase is over, and phases without exit conditions just re-slice the same scope.'
      return `Created phase "${data.name}" in "${project.name}"\nid: ${data.id}${activated}${warn}`
    }

    case 'update_phase': {
      const project = await resolveProject(sb, userId, args.project_id, logCtx)
      if (!project) return `Project "${args.project_id}" not found.`
      const phase = await resolvePhase(sb, project.id, args.phase_id)
      if (!phase) return `Phase "${args.phase_id}" not found in "${project.name}".`
      const patch: Record<string, any> = {}
      if (args.name !== undefined) patch.name = args.name
      if (args.exit_condition !== undefined) patch.exit_condition = args.exit_condition || null
      if (args.due_date !== undefined) patch.due_date = args.due_date || null
      if (args.sort_order !== undefined) patch.sort_order = args.sort_order
      if (!Object.keys(patch).length) return 'Nothing to update — pass at least one of name, exit_condition, due_date, sort_order.'
      const { error } = await sb.from('phases').update(patch).eq('id', phase.id)
      if (error) throw new Error(error.message)
      return `Updated phase "${phase.name}"${patch.name ? ` → "${patch.name}"` : ''} in "${project.name}".`
    }

    case 'delete_phase': {
      const project = await resolveProject(sb, userId, args.project_id, logCtx)
      if (!project) return `Project "${args.project_id}" not found.`
      const phase = await resolvePhase(sb, project.id, args.phase_id)
      if (!phase) return `Phase "${args.phase_id}" not found in "${project.name}".`
      const { data: affected } = await sb.from('tasks').select('id').eq('phase_id', phase.id)
      const n = affected?.length ?? 0
      // tasks.phase_id is ON DELETE SET NULL and projects.active_phase_id likewise, so the
      // DB unphases and clears the pointer for us — no manual cleanup, no lost tasks.
      const { error } = await sb.from('phases').delete().eq('id', phase.id)
      if (error) throw new Error(error.message)
      const wasActive = project.active_phase_id === phase.id ? ' The active-phase pointer is now clear — set another with set_active_phase.' : ''
      return `Deleted phase "${phase.name}". ${n} task${n !== 1 ? 's are' : ' is'} now unphased (nothing was deleted).${wasActive}`
    }

    case 'set_active_phase': {
      const project = await resolveProject(sb, userId, args.project_id, logCtx)
      if (!project) return `Project "${args.project_id}" not found.`
      if (!args.phase_id) {
        await sb.from('projects').update({ active_phase_id: null }).eq('id', project.id)
        return `Cleared the active phase on "${project.name}". get_ready_work will no longer scope by phase.`
      }
      const phase = await resolvePhase(sb, project.id, args.phase_id)
      if (!phase) return `Phase "${args.phase_id}" not found in "${project.name}".`
      const { error } = await sb.from('projects').update({ active_phase_id: phase.id }).eq('id', project.id)
      if (error) throw new Error(error.message)
      return `"${project.name}" is now in phase "${phase.name}".${phase.exit_condition ? `\nEnds when: ${phase.exit_condition}` : ''}`
    }

    case 'set_task_phase': {
      const task = await resolveTask(sb, userId, args.task_id)
      if (!task) return `Task "${args.task_id}" not found.`
      // phase_id is not in resolveTask's projection — fetch the prior phase so both branches
      // below can record a real before-state rather than asserting null (TDE-819).
      const { data: priorPhaseRow } = await sb.from('tasks').select('phase_id').eq('id', task.id).maybeSingle()
      const priorPhaseId = priorPhaseRow?.phase_id ?? null
      if (!args.phase_id) {
        const { error } = await sb.from('tasks').update({ phase_id: null, updated_at: new Date().toISOString() }).eq('id', task.id)
        if (error) throw new Error(error.message)
        await recordLifecycleChange(sb, userId, {
          taskId: task.id, via: 'set_task_phase', actor: tokenActor,
          summary: 'Unphased — removed from its project phase',
          before: { phase_id: priorPhaseId }, after: { phase_id: null },
        })
        return `Unphased "${task.text}". That is a valid resting state — not every task belongs to a stage.`
      }
      const phase = await resolvePhase(sb, task.project_id, args.phase_id)
      if (!phase) return `Phase "${args.phase_id}" not found in this task's project.`
      const { error } = await sb.from('tasks').update({ phase_id: phase.id, updated_at: new Date().toISOString() }).eq('id', task.id)
      if (error) throw new Error(error.message)
      await recordLifecycleChange(sb, userId, {
        taskId: task.id, via: 'set_task_phase', actor: tokenActor,
        summary: `Moved into phase "${phase.name}"`,
        before: { phase_id: priorPhaseId }, after: { phase_id: phase.id },
        extra: { phase_name: phase.name },
      })
      return `Moved "${task.text}" into phase "${phase.name}".`
    }

    case 'list_tasks': {
      const { project_id, section_id, status, confirmed, include_flow_steps } = args
      let query = sb.from('tasks').select('id, short_id, text, priority, status, due_date, detail, section_id, project_id, created_at, updated_at, sort_order, phase_id, project:projects(prefix), section:sections(name), phase:phases(name)').eq('user_id', userId)
      let resolvedProject: any = null
      if (project_id) {
        resolvedProject = await resolveProject(sb, userId, project_id)
        if (resolvedProject) query = query.eq('project_id', resolvedProject.id)
      } else if (!confirmed) {
        const def = await resolveDefaultProject(sb, userId)
        if (def) {
          resolvedProject = def
          query = query.eq('project_id', def.id)
        } else {
          return 'This will list tasks across ALL your projects. Call again with confirmed: true if that\'s what you want, or provide a project_id to scope it.'
        }
      }
      if (section_id) query = query.eq('section_id', section_id)
      // TDE-804 phase filter. "unphased" is a first-class selector, not an absence of one.
      let phaseLabel = ''
      if (args.phase_id) {
        if (!project_id) return 'phase_id requires project_id — a phase belongs to one project.'
        if (String(args.phase_id).toLowerCase() === 'unphased') {
          query = query.is('phase_id', null)
          phaseLabel = 'unphased'
        } else {
          const ph = resolvedProject ? await resolvePhase(sb, resolvedProject.id, args.phase_id) : null
          if (!ph) return `Phase "${args.phase_id}" not found in that project.`
          query = query.eq('phase_id', ph.id)
          phaseLabel = ph.name
        }
      }
      if (args.blocking && !resolvedProject) return 'blocking requires project_id (or a default project) — the I/O graph it scans is project-scoped.'
      // TDE-320: flow steps are not tasks. Exclude any task that belongs to a named
      // flow unless the user explicitly asked to see them via include_flow_steps or a flow filter.
      if (args.flow_id) {
        const flow = await resolveFlow(sb, userId, args)
        if (!flow) return `Flow "${args.flow_id}" not found.`
        query = query.eq('flow_id', flow.id)
      } else if (!include_flow_steps) {
        query = query.is('flow_id', null)
      }
      if (status === 'all')   { /* no filter */ }
      else if (status)        query = query.eq('status', status)
      else                    query = query.neq('status', 'done')
      if (args.updated_since) {
        const since = resolveSince(String(args.updated_since))
        if (!since) return `Could not parse updated_since: "${args.updated_since}". Use a relative duration ("7d", "2w", "1mo") or an ISO date.`
        query = query.gte('updated_at', since)
      }
      // "What changed lately?" is a recency question, and answering it by sorting order
      // means reading the whole list and eyeballing dates. Newest edit first instead.
      const byRecency = args.sort === 'recently_updated'
      const sortCol = byRecency ? 'updated_at' : 'sort_order'
      const tz = await userTimezone(sb, userId)

      // blocking & gate_status (TDE-556 fold-in): relationship filters across the whole project's I/O
      // edges, computed in JS (JSONB reverse-lookup, not a single indexed WHERE). It narrows
      // the candidate set unpredictably, so it disables cursor pagination for this call —
      // the full filtered set is returned at once rather than a page of it.
      let filteredIds: Set<string> | null = null
      if (args.blocking || args.gate_status) {
        const { data: allTasks } = await sb.from('tasks').select('id, input, output, status')
          .eq('project_id', resolvedProject.id).eq('user_id', userId)
        filteredIds = new Set<string>()
        const isBlocked = new Set<string>()
        if (args.blocking) {
          for (const t of (allTasks ?? [])) {
            if (t.status === 'done') continue
            for (const srcId of inputSourceIds(t.input)) isBlocked.add(srcId)
          }
        }
        for (const t of (allTasks ?? [])) {
          let keep = true
          if (args.blocking && !isBlocked.has(t.id)) keep = false
          if (args.gate_status && keep) {
            const ledgers = t.output?.validation_ledgers || {}
            let matched = false
            for (const key of Object.keys(ledgers)) {
              if ((ledgers[key].validation_status || 'unverified') === args.gate_status) matched = true
            }
            if (!Object.keys(ledgers).length && args.gate_status === 'unverified') matched = true
            if (!matched) keep = false
          }
          if (keep) filteredIds.add(t.id)
        }
      }

      let data: any[] = []
      let hasMore = false
      let nextCursor: string | null = null
      if (filteredIds) {
        const { data: rows } = await query.order(sortCol, { ascending: !byRecency }).order('id', { ascending: !byRecency })
        data = (rows ?? []).filter((t: any) => filteredIds!.has(t.id))
      } else {
        const limit = clampLimit(args.limit)
        const cursor = args.cursor ? decodeCursor(args.cursor) : null
        if (args.cursor && !cursor) return 'Invalid cursor — pass the cursor exactly as returned by a previous call, or omit it for the first page.'
        query = applyCursor(query, sortCol, cursor, !byRecency)
        const { data: rows } = await query.order(sortCol, { ascending: !byRecency }).order('id', { ascending: !byRecency }).limit(limit + 1)
        hasMore = (rows?.length ?? 0) > limit
        data = hasMore ? rows!.slice(0, limit) : (rows ?? [])
        if (hasMore && data.length) {
          const last = data[data.length - 1]
          nextCursor = encodeCursor(last[sortCol], last.id)
        }
      }

      if (!data?.length) return phaseLabel ? `No tasks found in phase "${phaseLabel}".` : 'No tasks found.'
      const body = data.map((t: any) => {
        const shortRef = t.project?.prefix && t.short_id != null ? `${t.project.prefix}-${t.short_id}` : t.id
        const sectionName = t.section?.name ?? 'no section'
        const added = t.created_at ? t.created_at.slice(0, 10) : null
        // Skipped for a task nobody has touched since creating it — it would spend a second
        // stamp repeating its first (cf. the token economy in TDE-371). The zone is stated
        // once in the header rather than repeated on every line, for the same reason.
        const neverEdited = !t.updated_at || !t.created_at
          || Math.abs(new Date(t.updated_at).getTime() - new Date(t.created_at).getTime()) < 60000
        const edited = neverEdited ? null : formatStamp(t.updated_at, tz, false)
        // Phase is omitted when the list is already scoped to one — it would repeat on every
        // line for no information (cf. the token-economy work in TDE-371).
        const phaseBadge = !phaseLabel && t.phase?.name ? t.phase.name : null
        const badges = [t.priority, t.due_date ? `due ${t.due_date}` : null, t.status !== 'pending' ? t.status : null, phaseBadge].filter(Boolean).join(', ')
        return `${shortRef} — ${t.text}${badges ? ` [${badges}]` : ''} · ${sectionName}${added ? ` · added ${added}` : ''}${edited ? ` · edited ${edited}` : ''}`
      }).join('\n')
      const anyEdited = data.some((t: any) => t.updated_at && t.created_at
        && Math.abs(new Date(t.updated_at).getTime() - new Date(t.created_at).getTime()) >= 60000)
      const header = [
        phaseLabel ? `Phase: ${phaseLabel}` : null,
        args.blocking ? 'Filtered to tasks something else is still waiting on.' : null,
        args.gate_status ? `Filtered to tasks with gate_status: ${args.gate_status}.` : null,
        args.flow_id ? `Filtered to flow: ${args.flow_id}.` : null,
        byRecency ? 'Sorted by most recently edited.' : null,
        anyEdited ? `Edit times are ${zoneLabel(tz)}.` : null,
      ].filter(Boolean).join('\n')
      const footer = hasMore ? `\n\n… ${data.length}+ shown. cursor: "${nextCursor}" for the next page.` : ''
      return (header ? `${header}\n\n${body}` : body) + footer
    }

    case 'create_task': {
      const { project_id, section_id, text, detail, priority, due_date, kind, seed_target, open_questions, milestones, executor, human_guidance, relay_context } = args
      const project = await resolveProject(sb, userId, project_id)
      if (!project) return `Project "${project_id}" not found.`
      const isSeed = kind === 'seed'
      if (isSeed && !['task', 'flow'].includes(seed_target)) return 'A seed requires seed_target: "task" or "flow".'

      // TDE-379 duplicate defense (soft-gate): refuse to create a NEAR-IDENTICAL open task unless
      // allow_duplicate. High threshold (near-dup only) so bulk paths (bootstrap/flows) don't trip;
      // a false positive is non-fatal (retry with allow_duplicate). Convergence is enforced via
      // merge_task_as_duplicate, not here — detection is advisory to the (AI) caller.
      let dupAdvisory = ''
      if (!isSeed) {
        const similar = await findSimilarTasks(sb, project.id, text, 0.55)
        const blocker = similar.find((t: any) => t.sim >= 0.82 && t.status !== 'done')
        const fmt = (t: any) => `  • ${project.prefix}-${t.short_id} [${t.status}] "${t.text}" (${Math.round(t.sim * 100)}% match)`
        if (blocker && !args.allow_duplicate) {
          return `⧉ DUPLICATE GUARD — "${text}" is near-identical to an existing OPEN task:\n${similar.slice(0, 5).map(fmt).join('\n')}\n\nConverge, don't fork: work the existing task, or merge_task_as_duplicate(duplicate_task_id, canonical_task_id) to fold copies into one. If this really is distinct, pass allow_duplicate: true to create it anyway.`
        }
        if (similar.length) {
          dupAdvisory = `\n\n⧉ Similar existing task(s) — merge_task_as_duplicate if this turns out to be a dup:\n${similar.slice(0, 3).map(fmt).join('\n')}`
        }
      }

      const resolvedSectionId = section_id ?? await getOrCreateBacklog(sb, project.id)
      const siblingQuery = sb.from('tasks').select('sort_order').eq('project_id', project.id).eq('section_id', resolvedSectionId)
      const { data: lastSibling } = await siblingQuery.order('sort_order', { ascending: false }).limit(1).maybeSingle()
      const sortOrder = (lastSibling?.sort_order ?? -1) + 1
      const resolvedExecutor = executor && ['agent', 'user', 'external'].includes(executor) ? executor : 'agent'
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
        kind: isSeed ? 'seed' : 'normal',
        seed_target: isSeed ? seed_target : null,
        // seed_open_questions is DEPRECATED (TDE-300): open questions now live in the
        // unified seed checklist as kind='question' milestones. Kept null on new seeds;
        // the column remains only so legacy seeds created before the merge still render.
        seed_open_questions: null,
        executor: resolvedExecutor,
        human_guidance: human_guidance ?? null,
        relay_context: (typeof relay_context === 'string' && relay_context.trim()) ? relay_context.trim() : null,
        tags: args.tags && Array.isArray(args.tags) ? args.tags : [],
      }).select().single()
      if (error) throw new Error(error.message)
      const clean = (xs: any) => (Array.isArray(xs) ? xs : []).map((x: any) => String(x).trim()).filter(Boolean)
      if (isSeed) {
        // MERGE (TDE-300): a seed carries ONE checklist, not two parallel lists. Both
        // open_questions and prerequisite milestones fold into task_discussions.steps as
        // typed items — kind='question' (answer during resolution) / kind='prerequisite'
        // (settle before resolving; soft-gated). WHY MERGED: the distinction only mattered
        // for differentiated downstream behaviour (answered-question→flow design vs.
        // prerequisite-output→flow input), which was deferred — so two primitives was
        // over-engineering. The kind tag is retained for that future, inert for now.
        for (const q of clean(open_questions)) {
          await sb.rpc('append_milestone_kind', { p_task_id: data.id, p_user_id: userId, p_text: q, p_kind: 'question' })
        }
        for (const m of clean(milestones)) {
          await sb.rpc('append_milestone_kind', { p_task_id: data.id, p_user_id: userId, p_text: m, p_kind: 'prerequisite' })
        }
        return `Created ${seed_target} SEED "${text}"\nid: ${data.id}\n` +
          `Its checklist: ${clean(open_questions).length} question(s) to answer during resolution, ${clean(milestones).length} prerequisite(s) to settle first.\n` +
          `Resolve it later: settle/answer the checklist with the user, then ${seed_target === 'flow' ? 'build_new_flow(seed_id) with the pre-brief' : 'resolve_seed(seed_id, task_spec)'} — open prerequisites trigger a soft gate. Do NOT work it as a normal task.`
      }
      for (const m of clean(milestones)) {
        await sb.rpc('append_milestone', { p_task_id: data.id, p_user_id: userId, p_text: m })
      }
      const relayNote = data.relay_context ? `\n[Recording context for the task] — relay context captured; the assignee will see it on get_task.` : ''
      return `Created task "${text}"\nid: ${data.id}${relayNote}${dupAdvisory}`
    }

    case 'merge_task_as_duplicate': {
      const dup = await resolveTask(sb, userId, args.duplicate_task_id)
      if (!dup) return `Duplicate task "${args.duplicate_task_id}" not found.`
      const canon = await resolveTask(sb, userId, args.canonical_task_id)
      if (!canon) return `Canonical task "${args.canonical_task_id}" not found.`
      if (dup.id === canon.id) return `A task cannot be a duplicate of itself.`
      if (isFlowTask(dup) || isFlowTask(canon)) return `Merge is for standalone tasks — flow tasks are governed by their flow.`

      // Transfer INCOMPLETE milestones dup → canonical.
      const { data: dd } = await sb.from('task_discussions').select('steps, checked_steps').eq('task_id', dup.id).maybeSingle()
      const steps: any[] = dd?.steps ?? []
      const checked: boolean[] = dd?.checked_steps ?? []
      let moved = 0
      for (let i = 0; i < steps.length; i++) {
        if (checked[i]) continue
        const label = typeof steps[i] === 'string' ? steps[i] : steps[i]?.summary
        if (!label) continue
        await sb.rpc('append_milestone', { p_task_id: canon.id, p_user_id: userId, p_text: label })
        moved++
      }

      // Preserve the dup's context on the canonical task (append as a merge note).
      const dupDetail = (dup.detail ?? '').trim()
      if (dupDetail) {
        const { data: cur } = await sb.from('tasks').select('detail').eq('id', canon.id).maybeSingle()
        const existing = (cur?.detail ?? '').trim()
        const note = `[Merged from ${dup.short_id ? '#' + dup.short_id : dup.id}] ${dup.text}:\n${dupDetail}`
        await sb.from('tasks').update({ detail: existing ? `${existing}\n\n${note}` : note }).eq('id', canon.id)
      }

      // Close the dup with a DISTINCT outcome — duplicate_of set = MERGED, not a plain "done".
      const mergedAt = new Date().toISOString()
      await sb.from('tasks').update({ status: 'done', completed_at: mergedAt, duplicate_of: canon.id }).eq('id', dup.id)
      // TDE-819: record on BOTH tasks. On the dup, so its closure is not indistinguishable from a
      // plain completion; on the canonical, so it shows it absorbed another task's scope.
      await recordLifecycleChange(sb, userId, {
        taskId: dup.id, via: 'merge_task_as_duplicate', actor: tokenActor,
        summary: `Closed as MERGED into "${canon.text}" — not a plain completion`
          + (moved ? `; ${moved} open milestone(s) transferred` : '')
          + (dupDetail ? '; context appended to the canonical task' : ''),
        before: { status: dup.status ?? null, duplicate_of: null },
        after: { status: 'done', completed_at: mergedAt, duplicate_of: canon.id },
        extra: { canonical_task_id: canon.id, canonical_text: canon.text, milestones_transferred: moved },
      })
      await recordLifecycleChange(sb, userId, {
        taskId: canon.id, via: 'merge_task_as_duplicate', actor: tokenActor,
        summary: `Absorbed duplicate "${dup.text}"`
          + (moved ? ` — ${moved} open milestone(s) added` : '')
          + (dupDetail ? ', context appended to detail' : ''),
        before: null,
        after: { absorbed_task_id: dup.id },
        extra: { duplicate_task_id: dup.id, duplicate_text: dup.text, milestones_transferred: moved },
      })

      return `⧉ Merged "${dup.text}" into "${canon.text}" — ${moved} open milestone(s) transferred${dupDetail ? ', context appended' : ''}. The duplicate is closed as MERGED (duplicate_of → canonical), not plain done.`
    }

    case 'resolve_seed': {
      const seed = await resolveTask(sb, userId, args.seed_id)
      if (!seed) return `Seed "${args.seed_id}" not found.`
      if (seed.kind !== 'seed') return `Task "${args.seed_id}" is not a seed.`
      if (seed.seed_target === 'flow') return `This is a FLOW seed — resolve it by running build_new_flow with its pre-brief, not resolve_seed.`
      const spec = args.task_spec || {}
      if (!spec.text) return 'task_spec.text is required.'
      // Soft prerequisite gate (TDE-300): a seed can carry kind='prerequisite' checklist
      // items — work that should be settled before it's resolved. Surface unmet ones and
      // ask; proceed_anyway:true overrides. Questions (kind='question') are answered
      // DURING resolution, so they never gate. Soft by design — consistent with trusting
      // the honest user; we'll tighten based on override-rate data if needed.
      if (!args.proceed_anyway) {
        const { data: sd } = await sb.from('task_discussions').select('steps, checked_steps').eq('task_id', seed.id).maybeSingle()
        const sSteps: any[] = Array.isArray(sd?.steps) ? sd.steps : []
        const sChecked: boolean[] = Array.isArray(sd?.checked_steps) ? sd.checked_steps : []
        const unmet = sSteps
          .map((s: any, i: number) => ({ summary: typeof s === 'string' ? s : s.summary, kind: typeof s === 'string' ? null : (s.kind ?? null), checked: !!sChecked[i] }))
          .filter(x => x.kind === 'prerequisite' && !x.checked)
        if (unmet.length) {
          return `⚠ This seed has ${unmet.length} unmet prerequisite${unmet.length > 1 ? 's' : ''}:\n` +
            unmet.map(x => `  ○ ${x.summary}`).join('\n') +
            `\n\nThese should usually be settled before resolving the seed. Confirm with the user. To resolve anyway, call resolve_seed again with proceed_anyway: true.`
        }
      }
      // Default to Backlog, NOT the seed's section — a resolved task must not stay in
      // the "Needs Context" staging section it was seeded in.
      const sectionId = spec.section_id || await getOrCreateBacklog(sb, seed.project_id)
      const { data: lastSibling } = await sb.from('tasks').select('sort_order')
        .eq('project_id', seed.project_id).eq('section_id', sectionId)
        .order('sort_order', { ascending: false }).limit(1).maybeSingle()
      const sortOrder = (lastSibling?.sort_order ?? -1) + 1
      const { data: newTask, error } = await sb.from('tasks').insert({
        project_id: seed.project_id,
        section_id: sectionId,
        user_id: userId,
        text: spec.text,
        detail: spec.detail ?? null,
        priority: spec.priority ?? 'medium',
        status: 'pending',
        sort_order: sortOrder,
        spawned_from_seed_id: seed.id,
      }).select().single()
      if (error) throw new Error(error.message)
      for (const m of (Array.isArray(spec.milestones) ? spec.milestones : []).map((x: string) => String(x).trim()).filter(Boolean)) {
        await sb.rpc('append_milestone', { p_task_id: newTask.id, p_user_id: userId, p_text: m })
      }
      await sb.from('tasks').update({ status: 'done' }).eq('id', seed.id)
      // TDE-819: a seed closing is a resolution, not a completion — record what it became so the
      // seed's own history explains where its scope went.
      await recordLifecycleChange(sb, userId, {
        taskId: seed.id, via: 'resolve_seed', actor: tokenActor,
        summary: `Seed RESOLVED into "${spec.text ?? newTask.text}" — closed, not completed as work`,
        before: { status: seed.status ?? null },
        after: { status: 'done', resolved_into_task_id: newTask.id },
        extra: { resolved_into_task_id: newTask.id, resolved_into_text: spec.text ?? newTask.text },
      })
      return `Resolved seed "${seed.text}" → created task "${spec.text}" (id: ${newTask.id}). Seed closed and linked (provenance).`
    }

    case 'update_task': {
      const { task_id, append, ...updates } = args
      const allowed = ['text', 'detail', 'priority', 'status', 'due_date', 'section_id', 'group_id', 'pinned', 'executor', 'human_guidance', 'relay_context', 'delegated_to', 'agent_ready', 'agent_proposal', 'agent_proposal_confirmed', 'tags']
      const patch: Record<string, any> = {}
      const nullable = (k: string) => k === 'group_id' || k === 'delegated_to' || k === 'agent_proposal'   // clearable via null/empty
      for (const k of allowed) if (nullable(k) ? updates[k] !== undefined : updates[k] !== undefined && updates[k] !== null) patch[k] = updates[k]
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

      if (patch.agent_ready === true) patch.agent_ready_at = new Date().toISOString()
      else if (patch.agent_ready === false) patch.agent_ready_at = null

      if (patch.agent_proposal !== undefined) {
        patch.agent_proposal = patch.agent_proposal || null
        patch.agent_proposal_at = patch.agent_proposal ? new Date().toISOString() : null
        if (!patch.agent_proposal) patch.agent_proposal_confirmed = false   // clearing the proposal clears confirmation
      }

      // TDE-818: resolveTask selects a FIXED column list (no priority/due_date/pinned/executor/…),
      // so the pre-update snapshot below would silently omit those fields — an audit row claiming
      // "changed priority" with no prior priority is worse than no row. Fetch the missing changed
      // columns before the write. Costs one indexed PK lookup, and only when a field outside
      // resolveTask's projection is actually being changed.
      const missingCols = Object.keys(patch).filter((k) => k !== 'completed_at' && !(k in task))
      let priorExtra: Record<string, any> = {}
      if (missingCols.length) {
        const { data: priorRow } = await sb.from('tasks')
          .select(missingCols.join(', ')).eq('id', task.id).maybeSingle()
        if (priorRow) priorExtra = priorRow
      }

      await sb.from('tasks').update(patch).eq('id', task.id)

      // TDE-377: fire an outbound task.updated event (fire-and-forget; never blocks the write).
      const changedFrom: Record<string, any> = { ...priorExtra }
      for (const k of Object.keys(patch)) if (k in task) changedFrom[k] = (task as any)[k]

      // TDE-818: until now this before-state existed ONLY to populate the webhook payload and
      // was discarded whenever no webhook matched — so field history was lost on overwrite,
      // leaving just tasks.updated_at (a timestamp with no indication of what changed).
      // Skip detail-only appends: they are additive by construction and the text is already durable.
      const changedKeys = Object.keys(patch).filter((k) => k !== 'completed_at')
      if (changedKeys.length && !(appended && changedKeys.length === 1 && changedKeys[0] === 'detail')) {
        await recordTaskEvent(sb, userId, {
          taskId: task.id, kind: 'fields_changed', entity: 'task', actor: tokenActor,
          summary: `Changed ${changedKeys.join(', ')}`
            + (patch.status ? ` — status ${(task as any).status ?? '?'} → ${patch.status}` : ''),
          before: changedFrom,
          after: patch,
          meta: { fields: changedKeys, appended_detail: appended },
        })
      }

      fireAndForget(emitWebhook(sb, userId, {
        projectId: (task as any).project_id ?? null,
        event: 'task.updated', action: 'update', type: 'Task', actor: tokenActor,
        data: { id: task.id, short_id: (task as any).short_id, text: task.text, project_id: (task as any).project_id, section_id: patch.section_id ?? (task as any).section_id, status: patch.status ?? task.status, ...patch },
        updatedFrom: changedFrom,
      }))
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

      const completedAt = new Date().toISOString()
      await sb.from('tasks').update({ status: 'done', completed_at: completedAt }).eq('id', task.id)
      // TDE-819: completion is the single most important thing that can happen to a task and it
      // was absent from the task's own history until now (this handler bypasses update_task).
      await recordLifecycleChange(sb, userId, {
        taskId: task.id, via: 'complete_task', actor: tokenActor,
        summary: `Completed — status ${task.status ?? '?'} → done`,
        // completed_at is NOT in resolveTask's projection, so it is omitted from before rather
        // than asserted as null — a wrong prior value is worse than an absent one.
        before: { status: task.status ?? null },
        after: { status: 'done', completed_at: completedAt },
        extra: { proceed_anyway: proceed_anyway === true },
      })
      // TDE-377: outbound task.completed event (fire-and-forget).
      fireAndForget(emitWebhook(sb, userId, {
        projectId: (task as any).project_id ?? null,
        event: 'task.completed', action: 'update', type: 'Task', actor: tokenActor,
        data: { id: task.id, short_id: (task as any).short_id, text: task.text, project_id: (task as any).project_id, section_id: (task as any).section_id, status: 'done' },
        updatedFrom: { status: task.status },
      }))
      // Fire-and-forget: move Drive attachments to Completed/ subfolder.
      if (task.output?.drive_files?.length) {
        loadGoogleAccessToken(sb, userId).then(t => { if (t) moveDriveFilesToFolder(sb, t, task, userId, 'Completed') }).catch(() => {})
      }
      // TDE-344 verify-before-complete: surface whether this completion carries passing check
      // evidence. Reuses the TDE-261 task-review machinery — a frozen review_bar IS the gate,
      // review_verdict IS the evidence. No hard-block (skippable by design): we make verified-ness
      // VISIBLE + durable, not mandatory. A task marked done without passing evidence is UNVERIFIED.
      const hasGate = !isFlowTask(task) && task.review_bar?.rules?.length > 0
      const verified = task.review_verdict?.overall === 'pass'
      let tail = ''
      if (hasGate && verified) {
        tail = `\n\n✓ VERIFIED — backed by passing check evidence (${task.review_bar.rules.length} rule(s)).`
      } else if (hasGate && !verified) {
        tail = `\n\n⚠ DONE (UNVERIFIED) — a verification check is attached but has no passing evidence. Run the check and submit_task_review with the raw observed_value to verify it. (Not blocked — but it stays marked unverified.)`
      } else if (task.review_enabled && !isFlowTask(task)) {
        tail = `\n\n⟳ Review is enabled but no bar is frozen — call enable_task_review to attach a check.`
      }
      return `✓ Marked "${task.text}" as done.` + tail
    }

    case 'uncomplete_task': {
      const task = await resolveTask(sb, userId, args.task_id)
      if (!task) return 'Task not found.'
      // Fetch the completion stamp we are about to discard — it is not in resolveTask's
      // projection, and "this was completed at X, then reopened" is the point of the record.
      const { data: priorDone } = await sb.from('tasks').select('completed_at').eq('id', task.id).maybeSingle()
      await sb.from('tasks').update({ status: 'pending', completed_at: null }).eq('id', task.id)
      // TDE-819: reopening is as consequential as completing — record the undo too.
      await recordLifecycleChange(sb, userId, {
        taskId: task.id, via: 'uncomplete_task', actor: tokenActor,
        summary: `Reopened — status ${task.status ?? '?'} → pending`
          + (priorDone?.completed_at ? ` (had been completed ${priorDone.completed_at})` : ''),
        before: { status: task.status ?? null, completed_at: priorDone?.completed_at ?? null },
        after: { status: 'pending', completed_at: null },
      })
      return `↩ Marked "${task.text}" as not done.`
    }

    case 'delete_task': {
      const task = await resolveTask(sb, userId, args.task_id)
      if (!task) return 'Task not found.'
      // Fire-and-forget: move Drive attachments to Archived/ before deleting.
      if (task.output?.drive_files?.length) {
        loadGoogleAccessToken(sb, userId).then(t => { if (t) moveDriveFilesToFolder(sb, t, task, userId, 'Archived') }).catch(() => {})
      }
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

    case 'resolve_reference': {
      const ref = String(args.ref || '').trim()
      if (!ref) return 'ref is required.'

      // Flow short_id (PREFIX-Fnnn) — the ONLY lookup path that accepts it; every other
      // flow_id param only matches a UUID or a name substring.
      const flowShortMatch = ref.match(/^([A-Za-z]{2,6})-F(\d+)$/)
      if (flowShortMatch) {
        const project = await resolveProject(sb, userId, flowShortMatch[1])
        if (project) {
          const { data: flow } = await sb.from('flows').select('id, name, short_id')
            .eq('project_id', project.id).eq('short_id', ref).eq('user_id', userId).maybeSingle()
          if (flow) return JSON.stringify({
            type: 'flow', id: flow.id, short_id: flow.short_id, name: flow.name,
            project: { id: project.id, prefix: project.prefix, name: project.name },
            next: 'get_flow_context or run_flow for the full playbook',
          })
        }
      }

      // Task short_id (PREFIX-NNN) or a task UUID.
      const task = await resolveTask(sb, userId, ref)
      if (task) {
        const project = await resolveProject(sb, userId, task.project_id)
        return JSON.stringify({
          type: 'task', id: task.id,
          short_id: project?.prefix ? `${project.prefix}-${task.short_id}` : task.short_id,
          text: task.text, status: task.status, flow_id: task.flow_id || null,
          project: project ? { id: project.id, prefix: project.prefix, name: project.name } : null,
          next: 'get_task for full context, milestones, and I/O',
        })
      }

      // Bare UUID that wasn't a task: try flow, then fall through to project.
      if (UUID_RE.test(ref)) {
        const { data: flow } = await sb.from('flows').select('id, name, short_id, project_id')
          .eq('id', ref).eq('user_id', userId).maybeSingle()
        if (flow) {
          const project = await resolveProject(sb, userId, flow.project_id)
          return JSON.stringify({
            type: 'flow', id: flow.id, short_id: flow.short_id, name: flow.name,
            project: project ? { id: project.id, prefix: project.prefix, name: project.name } : null,
            next: 'get_flow_context or run_flow for the full playbook',
          })
        }
      }

      // Project prefix, slug, or UUID.
      const project = await resolveProject(sb, userId, ref)
      if (project) return JSON.stringify({
        type: 'project', id: project.id, prefix: project.prefix, slug: project.slug, name: project.name,
        next: 'get_project for Foundation, sections, and stats',
      })

      return `No task, flow, or project matches "${ref}" in your account.`
    }

    case 'get_task': {
      const task = await resolveTask(sb, userId, args.task_id)
      if (!task) return 'Task not found.'
      const { data: full } = await sb.from('tasks')
        .select('*, section:sections(name), project:projects(name, prefix, active_phase_id), phase:phases(name, exit_condition)')
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
          // A pickup is not an edit. Route the flip through autostart_task so the touch
          // trigger leaves updated_at alone (migration 20260730120000) — otherwise simply
          // READING a task would overwrite the "Last edited" time reported below, and a
          // survey of N tasks would restamp all N as edited-just-now.
          const { error: autostartErr } = await sb.rpc('autostart_task', { p_task_id: full.id, p_user_id: userId })
          // The function deploy and the migration land separately. If the RPC is not there
          // yet, still perform the flip — reporting a start that never happened is a worse
          // failure than losing the updated_at preservation for one call.
          if (autostartErr) await sb.from('tasks').update({ status: 'in_progress' }).eq('id', full.id)
          full.status = 'in_progress'
          justStarted = true
          // TDE-819: get_task SILENTLY flips a pending task to in_progress. That is convenient for
          // real pickups but invisible for read-only inspection — a survey of N tasks marks all N
          // as started with no trace. Recording it makes the flip auditable (and reversible with
          // evidence). Bounded: only fires on the pending→in_progress transition, not every read.
          await recordLifecycleChange(sb, userId, {
            taskId: full.id, via: 'get_task_autostart', actor: tokenActor,
            summary: 'Auto-started on pickup — status pending → in_progress (side effect of get_task, not an explicit start)',
            before: { status: 'pending' },
            after: { status: 'in_progress' },
            extra: { auto: true },
          })
        }
      }

      const { data: disc } = await sb.from('task_discussions')
        .select('steps, checked_steps')
        .eq('task_id', task.id)
        .maybeSingle()
      const shortRef = full.project?.prefix && full.short_id != null ? `${full.project.prefix}-${full.short_id}` : full.id
      // TDE-376: canonical branch name for coding agents — check out this exact branch so a
      // future PR/commit magic word (fixes/closes TDE-N) can drive task state through the gate.
      const branchSlug = String(full.text || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50).replace(/-+$/g, '')
      const branchName = full.project?.prefix && full.short_id != null
        ? `${String(full.project.prefix).toLowerCase()}-${full.short_id}${branchSlug ? '-' + branchSlug : ''}`
        : null
      const tz = await userTimezone(sb, userId)
      const lines: string[] = [
        `# ${full.text}`,
        `ID: ${shortRef} | Project: ${full.project?.name ?? '—'} | Section: ${full.section?.name ?? 'Ungrouped'}`,
        `Priority: ${full.priority} | Status: ${full.status}${full.due_date ? ` | Due: ${full.due_date}` : ''}`,
        // Reading this line is safe: get_task's autostart no longer bumps updated_at, so
        // "Last edited" reports a real change to the task, not the last time it was read.
        `Created: ${formatStamp(full.created_at, tz)} | Last edited: ${formatStamp(full.updated_at, tz)}${agoLabel(full.updated_at) ? ` (${agoLabel(full.updated_at)})` : ''}`,
      ]
      if (branchName) lines.push(`Branch: ${branchName}`)
      // TDE-804: the phase answers "is this in scope right now" — the question an agent
      // otherwise has to be told in prose every session.
      // Stays silent for projects not using phases at all (the common case) rather than
      // spending a line on every get_task to say "no phases here".
      if (full.phase?.name) lines.push(`Phase: ${full.phase.name}${full.phase.exit_condition ? ` (ends when: ${full.phase.exit_condition})` : ''}`)
      else if (full.project?.active_phase_id) lines.push(`Phase: unphased — this project uses phases but this task is in none. Valid, but it will rank last in a phase-scoped queue.`)
      if (full.delegated_to) lines.push(`Delegated to: ${full.delegated_to} (you remain the owner and own the gate)`)
      // Relay (TDE-324): a handed-off task carries a curated rationale layer authored by the
      // person who relayed it. Surface it LOUD and FIRST — its whole point is that the assignee
      // (you) can act without a follow-up round-trip to the creator. Distinct from detail/Context.
      if (full.relay_context) {
        lines.push(`\n[Recording context for the task]`)
        lines.push(`This task was RELAYED to you. The relay context below is the creator's curated hand-off — treat it as authoritative intent; act on it without going back to ask:`)
        lines.push(full.relay_context)
      }
      // TDE-383: pending human guidance — a steering note left for the agent. Surface it LOUD and,
      // on a real (non-peek) get_task, mark it consumed so it isn't re-surfaced next session.
      const { data: pendingGuidance } = await sb.from('task_guidance')
        .select('id, body, created_at').eq('task_id', full.id).is('consumed_at', null)
        .order('created_at', { ascending: true })
      if (pendingGuidance?.length) {
        lines.push(`\n📌 PENDING GUIDANCE from the human — read and act on this before continuing:`)
        for (const g of pendingGuidance) lines.push(`  • ${g.body}`)
        if (!args.peek) {
          await sb.from('task_guidance').update({ consumed_at: new Date().toISOString() }).in('id', pendingGuidance.map((g: any) => g.id))
          lines.push(`  (marked as seen — it won't surface again)`)
        }
      }
      // Prepare→confirm→execute (TDE-377 Path A): surface the agent's prepared proposal + its confirm state.
      if (full.agent_proposal) {
        lines.push(full.agent_proposal_confirmed
          ? `\n✓ PROPOSAL CONFIRMED by the human — EXECUTE THIS NOW (it may have been edited from what you proposed):\n${full.agent_proposal}\nAfter executing + verifying, clear it: update_task(agent_proposal:"").`
          : `\n◇ PREPARED PROPOSAL — awaiting the human's confirmation in the web. Do NOT execute yet:\n${full.agent_proposal}`)
      }
      // Seeds: make it loud — this is a placeholder to RESOLVE, not work to do.
      const steps: any[] = disc?.steps ?? []
      const checked: boolean[] = disc?.checked_steps ?? []
      if (full.kind === 'seed') {
        lines.push(`\n⚑ THIS IS A SEED — it resolves into a ${full.seed_target || 'task'}. Do NOT do this work directly.`)
        lines.push(full.seed_target === 'flow'
          ? 'To resolve: settle the checklist with the user to firm up the flow, then run build_new_flow(seed_id) using the pre-brief in Context below.'
          : 'To resolve: settle the checklist with the user, then call resolve_seed(seed_id, task_spec) — it creates the real, placed task and closes this seed.')
        // Unified, typed seed checklist (TDE-300): questions (answered during resolution)
        // and prerequisites (settle first; soft-gated) both live as typed milestones.
        const items = steps.map((s: any, i: number) => ({
          summary: typeof s === 'string' ? s : s.summary,
          kind: typeof s === 'string' ? null : (s.kind ?? null),
          checked: !!checked[i], i,
        }))
        const prereqs = items.filter(x => x.kind === 'prerequisite')
        const questions = items.filter(x => x.kind === 'question')
        const other = items.filter(x => x.kind !== 'prerequisite' && x.kind !== 'question')
        if (prereqs.length) {
          lines.push('Prerequisites — settle BEFORE resolving (soft gate):')
          for (const x of prereqs) lines.push(`  ${x.checked ? '✓' : '○'} (index ${x.i}) ${x.summary}`)
          const open = prereqs.filter(x => !x.checked).length
          if (open) lines.push(`  ⚠ ${open} prerequisite${open > 1 ? 's' : ''} still open — confirm with the user before resolving, or pass proceed_anyway:true.`)
        }
        if (questions.length) {
          lines.push('Open questions — answer WITH the user during resolution:')
          for (const x of questions) lines.push(`  ${x.checked ? '✓' : '○'} (index ${x.i}) ${x.summary}`)
        }
        if (other.length) {
          lines.push('Checklist:')
          for (const x of other) lines.push(`  ${x.checked ? '✓' : '○'} (index ${x.i}) ${x.summary}`)
        }
        // Legacy fallback: seeds created before the merge stored questions in the column.
        if (!items.length && Array.isArray(full.seed_open_questions) && full.seed_open_questions.length) {
          lines.push('Open questions to resolve:')
          for (const x of full.seed_open_questions) lines.push(`  • ${x}`)
        }
      }
      if (full.detail) lines.push(`\nContext:\n${full.detail}`)
      // Generic milestones block — skipped for seeds (the checklist above already renders them).
      if (steps.length && full.kind !== 'seed') {
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
        // TDE-382: prefer the guided-review narrative (core → consequences → secondary); fall back to the flat critique.
        const n: any = v.narrative
        if (n && (n.core || n.sections?.length || n.secondary)) {
          if (n.core) lines.push(`  ▸ Core: ${n.core}`)
          for (const s of (n.sections || [])) lines.push(`    → ${s.point}${s.consequence ? ` — ${s.consequence}` : ''}`)
          if (n.secondary) lines.push(`  Secondary: ${n.secondary}`)
        } else if (v.critique) {
          lines.push(`  Critique:\n${String(v.critique).split('\n').map((l: string) => '    ' + l).join('\n')}`)
        }
      }

      // TOKEN ECONOMY (TDE-371): the heavy per-project context below — Foundation + Instruction
      // Set + KB index — is identical across every task in a project (~2k tokens). Re-shipping it
      // on every get_task is pure waste once the agent has it in context. So send it FULL on the
      // first task opened in a project each session, then a short pointer thereafter. "Session" is
      // inferred (the MCP has no session id): a (user, project) priming row, reset by
      // __init_tasker_session and expiring after a 3h safety window (covers agents that never init).
      // refresh_context:true forces full — the escape hatch after a context compaction.
      const PRIME_WINDOW_MS = 3 * 60 * 60 * 1000
      let sendFull = !!args.refresh_context
      if (!sendFull && full.project_id) {
        const { data: primed } = await sb.from('mcp_context_primed')
          .select('primed_at').eq('user_id', userId).eq('project_id', full.project_id).maybeSingle()
        sendFull = !(primed && (Date.now() - new Date(primed.primed_at).getTime()) < PRIME_WINDOW_MS)
      }
      if (sendFull && full.project_id) {
        fireAndForget(sb.from('mcp_context_primed').upsert({ user_id: userId, project_id: full.project_id, primed_at: new Date().toISOString() }))
      }

      if (sendFull) {
        // Inject the project Foundation (TDE-262): every task is anchored to intent,
        // scope, success/failure and the quality bar — not just the IS/KB. This is the
        // grounding the bootstrap_project interview produces.
        if (full.project_id) {
          const { data: proj } = await sb.from('projects').select('context').eq('id', full.project_id).maybeSingle()
          const foundationLines = renderFoundation(proj?.context)
          if (foundationLines.length) {
            lines.push('\n---')
            lines.push('# Project Foundation')
            for (const l of foundationLines) lines.push(`- ${l}`)
          }
        }

        // Inject the governing Instruction Set (TDE-233 flow-level IS).
        // - Task not in a flow → full project IS (as before).
        // - Task in a flow that has its own IS → universal project IS + flow IS
        //   (the project's non-universal IS is suppressed for this task).
        // - Task in a flow with no flow IS → full project IS (safe fallback).
        if (full.project_id) {
          const { data: projIs } = await sb.from('project_instructions')
            .select('title, content, universal, tags')
            .eq('project_id', full.project_id)
            .order('created_at')
          let flowIs: any[] = []
          if (full.flow_id) {
            const { data } = await sb.from('flow_instructions')
              .select('title, content, tags').eq('flow_id', full.flow_id).order('created_at')
            flowIs = data || []
          }
          
          // TDE-782: Filter IS entries by tags. An entry applies if it has NO tags, or if its tags intersect the task's tags.
          const taskTags = Array.isArray(full.tags) ? full.tags : []
          const applies = (entry: any) => {
            const t = entry.tags
            if (!Array.isArray(t) || t.length === 0) return true
            return t.some((tag: string) => taskTags.includes(tag))
          }
          const filteredProjIs = (projIs || []).filter(applies)
          flowIs = flowIs.filter(applies)

          if (flowIs.length) {
            const universalProj = filteredProjIs.filter((e: any) => e.universal)
            if (universalProj.length) {
              lines.push('\n---')
              lines.push('# Project Instruction Set (universal)')
              for (const entry of universalProj) lines.push(`\n## ${entry.title}\n\n${entry.content}`)
            }
            lines.push('\n---')
            lines.push('# Flow Instruction Set (governs this flow — replaces the project\'s non-universal IS)')
            for (const entry of flowIs) lines.push(`\n## ${entry.title}\n\n${entry.content}`)
          } else if (filteredProjIs.length) {
            lines.push('\n---')
            lines.push('# Project Instruction Set')
            for (const entry of filteredProjIs) lines.push(`\n## ${entry.title}\n\n${entry.content}`)
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
      } else {
        // Compact tier: the heavy context was primed earlier this session — point at it instead
        // of re-shipping it. Name the exact on-demand read tools so re-grounding is one call.
        const flowExtra = full.flow_id ? ' · flow IS/KB via get_flow_is / get_flow_kb' : ''
        lines.push('\n---')
        lines.push(`# Project context — primed earlier this session (omitted to save tokens)`)
        lines.push(`Foundation, Instruction Set, and the KB index for "${full.project?.name ?? 'this project'}" were provided on the first task you opened here this session and are still in your context. Re-read on demand: get_project_foundation · get_project_is · list_kb_entries${flowExtra}. To force the full context back inline (e.g. after a context reset), call get_task with refresh_context: true.`)
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
        .select('id, title, content, tags')
        .eq('project_id', project.id)
        .order('created_at')
      if (!entries?.length) return `No instruction set defined for "${project.name}". Add entries via the IS button in the project header.`
      return [
        `# Instruction Set — ${project.name}`,
        '',
        ...entries.map((e: any) => `## ${e.title}  (id: ${e.id})${e.tags?.length ? ` [Tags: ${e.tags.join(', ')}]` : ''}\n\n${e.content}`),
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
        .insert({ project_id: project.id, user_id: userId, title: args.title, content: args.content, universal: args.universal === true, tags: args.tags && Array.isArray(args.tags) ? args.tags : [] })
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
        .select('id, title, source, updated_at, created_at')
        .eq('project_id', project.id)
        .is('archived_at', null)
      if (args.source && args.source !== 'all') q = q.eq('source', args.source)
      const limit = clampLimit(args.limit)
      const cursor = args.cursor ? decodeCursor(args.cursor) : null
      if (args.cursor && !cursor) return 'Invalid cursor — pass the cursor exactly as returned by a previous call, or omit it for the first page.'
      q = applyCursor(q, 'created_at', cursor, true)
      const { data } = await q.order('created_at').order('id').limit(limit + 1)
      if (!data?.length) return `No knowledge base entries for "${project.name}".`
      const hasMore = data.length > limit
      const page = hasMore ? data.slice(0, limit) : data
      const body = page.map((e: any) => `[id: ${e.id}] [${e.source}] ${e.title}  (updated ${e.updated_at})`).join('\n')
      if (!hasMore) return body
      const last = page[page.length - 1]
      return `${body}\n\n… ${page.length}+ shown. cursor: "${encodeCursor(last.created_at, last.id)}" for the next page.`
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
        .select('id, title, updated_at, tags')
        .eq('project_id', project.id)
        .order('created_at')
      if (!data?.length) return `No instruction set entries for "${project.name}".`
      return data.map((e: any) => `[id: ${e.id}] ${e.title}  (updated ${e.updated_at})${e.tags?.length ? ` [Tags: ${e.tags.join(', ')}]` : ''}`).join('\n')
    }

    case 'update_is_entry': {
      const fields: any = {}
      if (args.title     !== undefined) fields.title     = args.title
      if (args.content   !== undefined) fields.content   = args.content
      if (args.universal !== undefined) fields.universal = args.universal === true
      if (args.tags      !== undefined) fields.tags      = Array.isArray(args.tags) ? args.tags : []
      if (!Object.keys(fields).length) return 'No fields to update. Provide title, content, universal, or tags.'
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

    // ── Personal default Instruction Sets (TDE-295) — account-level, auto-seed new projects ──
    case 'create_default_is_entry': {
      const { data: last } = await sb.from('default_instructions')
        .select('sort_order').eq('user_id', userId).order('sort_order', { ascending: false }).limit(1).maybeSingle()
      const sort_order = ((last?.sort_order) ?? -1) + 1
      const { data, error } = await sb.from('default_instructions')
        .insert({ user_id: userId, title: args.title, content: args.content, universal: args.universal === true, sort_order, tags: args.tags && Array.isArray(args.tags) ? args.tags : [] })
        .select().single()
      if (error) throw new Error(error.message)
      return `Created personal default IS entry "${data.title}". It will auto-seed every NEW project${data.universal ? ' (universal — applies even inside flows)' : ''}. Existing projects are unchanged.`
    }

    case 'list_default_is_entries': {
      const { data } = await sb.from('default_instructions')
        .select('id, title, universal, updated_at, tags')
        .eq('user_id', userId)
        .order('sort_order')
      if (!data?.length) return 'No personal default Instruction Set entries. Create one with create_default_is_entry to auto-seed it into every new project.'
      return data.map((e: any) => `[id: ${e.id}] ${e.title}${e.universal ? ' (universal)' : ''}${e.tags?.length ? ` [Tags: ${e.tags.join(', ')}]` : ''}`).join('\n')
    }

    case 'update_default_is_entry': {
      const fields: any = {}
      if (args.title     !== undefined) fields.title     = args.title
      if (args.content   !== undefined) fields.content   = args.content
      if (args.universal !== undefined) fields.universal = args.universal === true
      if (args.tags      !== undefined) fields.tags      = Array.isArray(args.tags) ? args.tags : []
      if (!Object.keys(fields).length) return 'No fields to update. Provide title, content, universal, or tags.'
      const { data, error } = await sb.from('default_instructions')
        .update(fields).eq('id', args.entry_id).eq('user_id', userId).select().maybeSingle()
      if (error) throw new Error(error.message)
      if (!data) return `Default IS entry "${args.entry_id}" not found.`
      return `Updated personal default IS entry "${data.title}". Applies to FUTURE projects; existing projects keep their seeded copy.`
    }

    case 'delete_default_is_entry': {
      const { data, error } = await sb.from('default_instructions')
        .delete().eq('id', args.entry_id).eq('user_id', userId).select().maybeSingle()
      if (error) throw new Error(error.message)
      if (!data) return `Default IS entry "${args.entry_id}" not found.`
      return `Deleted personal default IS entry "${data.title}". Future projects won't seed it; existing projects are unchanged.`
    }

    // ── Flow-level Instruction Set (TDE-233) ──
    case 'get_flow_is': {
      const flow = await resolveFlow(sb, userId, args)
      if (!flow) return `Flow not found. Pass flow_id (UUID or name) or a task_id that belongs to the flow.`
      const { data: entries } = await sb.from('flow_instructions').select('id, title, content, tags').eq('flow_id', flow.id).order('created_at')
      if (!entries?.length) return `No flow IS defined for "${flow.name}". Tasks in this flow fall back to the project IS.`
      return [`# Flow Instruction Set — ${flow.name}`, '', ...entries.map((e: any) => `## ${e.title}  (id: ${e.id})${e.tags?.length ? ` [Tags: ${e.tags.join(', ')}]` : ''}\n\n${e.content}`)].join('\n\n---\n\n')
    }
    case 'list_flow_is_entries': {
      const flow = await resolveFlow(sb, userId, args)
      if (!flow) return `Flow not found. Pass flow_id or a task_id in the flow.`
      const { data } = await sb.from('flow_instructions').select('id, title, updated_at, tags').eq('flow_id', flow.id).order('created_at')
      if (!data?.length) return `No flow IS entries for "${flow.name}".`
      return data.map((e: any) => `[id: ${e.id}] ${e.title}  (updated ${e.updated_at})${e.tags?.length ? ` [Tags: ${e.tags.join(', ')}]` : ''}`).join('\n')
    }
    case 'create_flow_is_entry': {
      const flow = await resolveFlow(sb, userId, args)
      if (!flow) return `Flow not found. Pass flow_id or a task_id in the flow.`
      const { data, error } = await sb.from('flow_instructions').insert({ flow_id: flow.id, user_id: userId, title: args.title, content: args.content, tags: args.tags && Array.isArray(args.tags) ? args.tags : [] }).select().single()
      if (error) throw new Error(error.message)
      return `Created flow IS entry "${data.title}" on flow "${flow.name}". Flow IS now governs this flow's tasks (replacing the project's non-universal IS).`
    }
    case 'update_flow_is_entry': {
      const fields: any = {}
      if (args.title   !== undefined) fields.title   = args.title
      if (args.content !== undefined) fields.content = args.content
      if (args.tags    !== undefined) fields.tags    = Array.isArray(args.tags) ? args.tags : []
      if (!Object.keys(fields).length) return 'No fields to update. Provide title, content, or tags.'
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

    case 'append_session_activity': {
      const task = await resolveTask(sb, userId, args.task_id)
      if (!task) return 'Task not found.'
      const allowed = ['progress', 'action', 'question', 'result', 'error']
      if (!allowed.includes(args.type)) return `Invalid type "${args.type}". Use one of: ${allowed.join(', ')}.`
      const body = (args.body ?? '').toString().trim()
      if (!body) return 'body is required — a concise note of what happened or what you are asking.'
      // Lazily reuse the task's open session (closed_at null); open one if none exists.
      const { data: openSession } = await sb.from('agent_sessions')
        .select('id').eq('task_id', task.id).eq('user_id', userId).is('closed_at', null)
        .order('opened_at', { ascending: false }).limit(1).maybeSingle()
      let sessionId = openSession?.id
      if (!sessionId) {
        const { data: created, error: sErr } = await sb.from('agent_sessions')
          .insert({ task_id: task.id, user_id: userId, actor: tokenActor ?? args.actor ?? null })
          .select('id').single()
        if (sErr) throw new Error(sErr.message)
        sessionId = created.id
      }
      const { error: aErr } = await sb.from('agent_activities')
        .insert({ session_id: sessionId, task_id: task.id, user_id: userId, type: args.type, body })
      if (aErr) throw new Error(aErr.message)
      await sb.from('agent_sessions').update({ last_activity_at: new Date().toISOString() }).eq('id', sessionId)
      const state = args.type === 'question' ? 'awaiting_input' : args.type === 'error' ? 'error' : 'active'
      return `Logged ${args.type} on "${task.text}". Session state: ${state}.`
    }

    case 'get_task_activity': {
      const task = await resolveTask(sb, userId, args.task_id)
      if (!task) return 'Task not found.'
      const limit = Math.min(Math.max(parseInt(String(args.limit ?? 20), 10) || 20, 1), 100)
      const { data: sessions } = await sb.from('agent_sessions')
        .select('id, actor, opened_at, last_activity_at, closed_at')
        .eq('task_id', task.id).order('opened_at', { ascending: false }).limit(10)
      if (!sessions || !sessions.length) return `No agent sessions on "${task.text}" yet.`
      const STALE_MS = 24 * 60 * 60 * 1000
      const lines: string[] = [`# Agent sessions — ${task.text}`]
      for (const s of sessions) {
        const { data: acts } = await sb.from('agent_activities')
          .select('type, body, created_at').eq('session_id', s.id)
          .order('created_at', { ascending: true }).limit(limit)
        const last = acts && acts.length ? acts[acts.length - 1] : null
        let state: string
        if (task.status === 'done' || s.closed_at) state = 'complete'
        else if (!last) state = 'active'
        else if (last.type === 'question') state = 'awaiting_input'
        else if (last.type === 'error') state = 'error'
        else state = (Date.now() - new Date(last.created_at).getTime()) < STALE_MS ? 'active' : 'stale'
        lines.push(`\n▸ Session${s.actor ? ` by ${s.actor}` : ''} · ${state} · opened ${s.opened_at}`)
        for (const a of (acts || [])) lines.push(`  [${a.type}] ${a.body}`)
      }
      return lines.join('\n')
    }

    case 'get_task_history': {
      const task = await resolveTask(sb, userId, args.task_id)
      if (!task) return 'Task not found.'
      const limit = clampLimit(args.limit)
      const cursor = args.cursor ? decodeCursor(args.cursor) : null
      if (args.cursor && !cursor) return 'Invalid cursor — pass the cursor exactly as returned by a previous call.'
      
      let q = sb.from('task_events')
        .select('id, kind, entity, actor, summary, before, after, meta, created_at')
        .eq('task_id', task.id)
      if (args.kind) q = q.eq('kind', args.kind)
      q = applyCursor(q, 'created_at', cursor, false)

      const { data: rows, error } = await q.order('created_at', { ascending: false }).order('id', { ascending: false }).limit(limit + 1)
      if (error) throw new Error(error.message)

      const hasMore = (rows?.length ?? 0) > limit
      const events = hasMore ? rows!.slice(0, limit) : (rows ?? [])
      let nextCursor: string | null = null
      if (hasMore && events.length) {
        const last = events[events.length - 1]
        nextCursor = encodeCursor(last.created_at, last.id)
      }

      if (!events?.length) {
        return `No gate history on "${task.text}"${args.kind ? ` for kind "${args.kind}"` : ''} yet.`
          + `\n\nNOTE: task_events records forward from TDE-818 (2026-07-28). Contract/review/gate changes made BEFORE that are not recoverable — they were overwritten in place.`
      }
      const GLYPH: Record<string, string> = {
        contract_set: '✎', contract_cleared: '⌫', contract_confirmed: '✓',
        review_bar_frozen: '❄', review_bar_cleared: '⌫', review_submitted: '⚖',
        validation_submitted: '⚖', fields_changed: '·',
      }
      const lines: string[] = [`# Gate history — ${task.text}  (${events.length} event${events.length !== 1 ? 's' : ''}, newest first)`]
      const erased = events.filter((e: any) => e.meta?.erased_confirmation === true)
      if (erased.length) {
        lines.push(``, `⚠ ${erased.length} event${erased.length !== 1 ? 's' : ''} DESTROYED A HUMAN CONFIRMATION on this task — a blessed contract was replaced or cleared. The prior contract is preserved in the before-state below.`)
      }
      for (const e of events) {
        lines.push(``, `${GLYPH[e.kind] ?? '·'} [${e.kind}] ${e.created_at}${e.actor ? ` · by ${e.actor}` : ''}`)
        lines.push(`  ${e.summary}`)
        const flags: string[] = []
        if (e.meta?.erased_confirmation) flags.push('erased_confirmation')
        if (e.meta?.overwrote_frozen_bar) flags.push('overwrote_frozen_bar')
        if (e.meta?.attempt !== undefined) flags.push(`attempt=${e.meta.attempt}`)
        if (e.meta?.edge_key) flags.push(`edge=${e.meta.edge_key}`)
        if (e.meta?.via) flags.push(`via=${e.meta.via}`)
        if (flags.length) lines.push(`  ⚑ ${flags.join(' · ')}`)
        if (args.verbose === true) {
          if (e.before) lines.push(`  before: ${JSON.stringify(e.before)}`)
          if (e.after) lines.push(`  after:  ${JSON.stringify(e.after)}`)
        }
      }
      if (hasMore) lines.push(``, `… ${events.length}+ shown. cursor: "${nextCursor}" for the next page.`)
      if (args.verbose !== true) lines.push(``, `(Pass verbose:true for full before/after state per event.)`)
      return lines.join('\n')
    }

    case 'get_my_attention': {
      let projectFilter: string | null = null
      if (args.project_id) {
        const p = await resolveProject(sb, userId, args.project_id)
        if (!p) return `Project "${args.project_id}" not found.`
        projectFilter = p.id
      }
      let tq = sb.from('tasks')
        .select('id, text, short_id, status, priority, due_date, review_verdict, agent_ready, project_id, project:projects(prefix)')
        .eq('user_id', userId).neq('status', 'done')
      if (projectFilter) tq = tq.eq('project_id', projectFilter)
      const { data: tasksData } = await tq
      const taskList = tasksData || []
      const byId = new Map<string, any>(taskList.map((t: any) => [t.id, t]))
      const taskIds = taskList.map((t: any) => t.id)
      const ref = (t: any) => t?.project?.prefix && t?.short_id != null ? `${t.project.prefix}-${t.short_id}` : (t?.id?.slice(0, 8) ?? '?')

      // Unconsumed human guidance
      let guidance: any[] = []
      if (taskIds.length) {
        const { data } = await sb.from('task_guidance').select('task_id, body').eq('user_id', userId).is('consumed_at', null).in('task_id', taskIds).order('created_at', { ascending: true })
        guidance = data || []
      }
      // Open sessions → awaiting_input + stale (from the TDE-374 ledger)
      const awaitingInput = new Set<string>()
      const stale = new Set<string>()
      if (taskIds.length) {
        const { data: sessions } = await sb.from('agent_sessions').select('id, task_id, last_activity_at').is('closed_at', null).in('task_id', taskIds)
        const openSessions = sessions || []
        if (openSessions.length) {
          const { data: acts } = await sb.from('agent_activities').select('session_id, type, created_at').in('session_id', openSessions.map((s: any) => s.id)).order('created_at', { ascending: true })
          const lastType = new Map<string, string>(), lastAt = new Map<string, string>()
          for (const a of ((acts ?? []) as any[])) { lastType.set(a.session_id, a.type); lastAt.set(a.session_id, a.created_at) }
          const STALE_MS = 2 * 24 * 60 * 60 * 1000
          for (const s of openSessions) {
            if (lastType.get(s.id) === 'question') { awaitingInput.add(s.task_id); continue }
            const at = lastAt.get(s.id) || s.last_activity_at
            if (at && Date.now() - new Date(at).getTime() > STALE_MS && byId.get(s.task_id)?.status === 'in_progress') stale.add(s.task_id)
          }
        }
      }
      const needsReview = taskList.filter((t: any) => t.review_verdict?.escalated)
      const readyForAgent = taskList.filter((t: any) => t.agent_ready && t.status === 'pending')
      const today = new Date().toISOString().slice(0, 10)
      const overdue = taskList.filter((t: any) => t.due_date && t.due_date < today)

      const lines: string[] = ['# What needs you']
      const section = (title: string, items: string[]) => { if (items.length) { lines.push(`\n${title} (${items.length}):`); items.forEach(i => lines.push(`  ${i}`)) } }
      section('▶ READY FOR AGENT — a human queued these for autonomous work (see get_ready_work)', readyForAgent.map((t: any) => `${ref(t)} — ${t.text}`))
      section('◆ AWAITING YOUR REVIEW — judge escalated', needsReview.map((t: any) => `${ref(t)} — ${t.text}`))
      section('✎ PENDING GUIDANCE — a human left a steering note', guidance.map((g: any) => `${ref(byId.get(g.task_id))} — "${g.body}"`))
      section('⏳ AWAITING INPUT — an agent asked a question and is blocked', [...awaitingInput].map((tid) => `${ref(byId.get(tid))} — ${byId.get(tid)?.text ?? ''}`))
      section('⋯ STALE IN-PROGRESS — quiet for 2+ days', [...stale].map((tid) => `${ref(byId.get(tid))} — ${byId.get(tid)?.text ?? ''}`))
      section('⚠ OVERDUE', overdue.map((t: any) => `${ref(t)} — ${t.text} (due ${t.due_date})`))
      if (lines.length === 1) return 'Nothing needs your attention right now — no ready-for-agent work, escalated reviews, pending guidance, blocked agents, stale work, or overdue tasks.'
      return lines.join('\n')
    }

    case 'get_ready_work': {
      let q = sb.from('tasks')
        .select('id, text, short_id, priority, sort_order, project_id, phase_id, project:projects(prefix, name)')
        .eq('user_id', userId).eq('agent_ready', true).eq('status', 'pending')
      let activePhase: any = null
      if (args.project_id) {
        const p = await resolveProject(sb, userId, args.project_id)
        if (!p) return `Project "${args.project_id}" not found.`
        q = q.eq('project_id', p.id)
        // TDE-804: scope the queue to the project's active phase. Partitioned in JS rather
        // than filtered in SQL so the response can REPORT what it left out — silently
        // dropping out-of-phase work would make it unreachable with no trace.
        if (p.active_phase_id) activePhase = await resolvePhase(sb, p.id, p.active_phase_id)
      }
      // ALSO fetch confirmed proposals ready to EXECUTE (human reviewed + approved in the web).
      let xq = sb.from('tasks').select('id, text, short_id, agent_proposal, project:projects(prefix)')
        .eq('user_id', userId).eq('agent_proposal_confirmed', true).not('agent_proposal', 'is', null)
      if (args.project_id) { const p2 = await resolveProject(sb, userId, args.project_id); if (p2) xq = xq.eq('project_id', p2.id) }
      const [{ data: readyData }, { data: execData }] = await Promise.all([q, xq])
      const prio: Record<string, number> = { rush: 0, high: 1, medium: 2, low: 3 }
      let readyRows = readyData || []
      // TDE-804 phase scoping. Unphased tasks are ALWAYS kept, whatever the active phase:
      // a task in no phase is in no queue otherwise, and the phase view hides it from the
      // human too — so it would become silently unreachable by both. They rank last.
      let outOfPhase = 0
      let unphasedIncluded = 0
      if (activePhase) {
        const kept: any[] = []
        for (const t of readyRows as any[]) {
          if (t.phase_id === activePhase.id) kept.push(t)
          else if (!t.phase_id) { unphasedIncluded++; kept.push(t) }
          else outOfPhase++
        }
        readyRows = kept
      }
      const prep = readyRows.sort((a: any, b: any) =>
        Number(!a.phase_id) - Number(!b.phase_id) ||
        (prio[a.priority] ?? 2) - (prio[b.priority] ?? 2) ||
        (a.sort_order ?? 0) - (b.sort_order ?? 0))
      const exec = execData || []
      const ref = (t: any) => t.project?.prefix && t.short_id != null ? `${t.project.prefix}-${t.short_id}` : t.id.slice(0, 8)
      if (!prep.length && !exec.length) {
        // Never report an empty queue when phase scoping is what emptied it — that is the
        // silent-unreachability failure the partition above exists to prevent.
        if (outOfPhase) return `Nothing to do IN THE ACTIVE PHASE "${activePhase.name}" — but ${outOfPhase} handed-over task${outOfPhase !== 1 ? 's belong' : ' belongs'} to another phase. Switch with set_active_phase, or inspect via list_tasks(phase_id:…).`
        return 'Nothing to do: no handed-over tasks to prepare and no confirmed proposals to execute. (In the web app, flip "Hand to agent" on a task to add one.)'
      }
      const lines: string[] = []
      if (exec.length) {
        lines.push(`✓ CONFIRMED — EXECUTE NOW (${exec.length}): the human reviewed + approved the proposal. get_task(id), DO exactly what agent_proposal says (it may have been human-edited), verify, then clear it — update_task(id, agent_proposal:"") — and complete_task.`)
        for (const t of exec) lines.push(`  ${ref(t)} — ${t.text}\n     proposal: ${t.agent_proposal}`)
        lines.push(``)
      }
      if (prep.length) {
        lines.push(`▶ TO PREPARE (${prep.length}): the human handed these over. get_task(id) to start + load context, prepare the work FULLY, set update_task(id, agent_proposal:"…"), then STOP and let the human confirm/edit it in the web. Do NOT execute until it comes back confirmed.`)
        for (const t of prep) lines.push(`  ${ref(t)} [${t.priority}]${!t.phase_id ? ' (unphased)' : ''} ${t.text}`)
      }
      if (activePhase) {
        lines.push(`\nPhase scope: "${activePhase.name}"${activePhase.exit_condition ? ` — ends when: ${activePhase.exit_condition}` : ''}.`)
        if (unphasedIncluded) lines.push(`Includes ${unphasedIncluded} unphased task${unphasedIncluded !== 1 ? 's' : ''} (ranked last) — unphased work stays reachable regardless of phase.`)
        if (outOfPhase) lines.push(`Hid ${outOfPhase} ready task${outOfPhase !== 1 ? 's' : ''} belonging to another phase. Use set_active_phase to switch scope, or list_tasks(phase_id:…) to see them.`)
      }
      return lines.join('\n')
    }

    case 'stop_flow': {
      const flow = await resolveFlowRef(sb, userId, args)
      if (!flow) return 'Flow not found. Pass flow_id (UUID or name) or a task_id in the flow.'
      await sb.from('flows').update({ stop_requested: true, stop_reason: args.reason ?? null, stopped_at: new Date().toISOString() }).eq('id', flow.id)
      return `⛔ Stopped flow "${flow.name}". Agents will refuse to run, guide, or advance it until you resume_flow.${args.reason ? `\nReason: ${args.reason}` : ''}`
    }

    case 'resume_flow': {
      const flow = await resolveFlowRef(sb, userId, args)
      if (!flow) return 'Flow not found. Pass flow_id (UUID or name) or a task_id in the flow.'
      await sb.from('flows').update({ stop_requested: false, stop_reason: null, stopped_at: null }).eq('id', flow.id)
      return `▶ Resumed flow "${flow.name}". It picks up exactly where it stood.`
    }

    // ── Local Mode sync engine (TDE-410) — see docs/local-first-design.md ────
    case 'pull_local_project': {
      const project = await resolveProject(sb, userId, args.project_id, logCtx)
      if (!project) return `Project "${args.project_id}" not found.`
      const deviceId = String(args.device_id || '').trim()
      if (!deviceId) return 'device_id is required — a stable name for this machine/checkout (e.g. "desktop-repo").'
      const cursor = Number(args.cursor ?? 0) || 0

      // Inline fallback: the full file map in the tool response (context-heavy —
      // only for environments without node). Default is the script transport below.
      if (args.inline === true) {
        const bundle = await buildLocalBundle(sb, userId, project, deviceId, cursor)
        if ('error' in bundle) return bundle.error
        return JSON.stringify({
          status: 'pulled', project: project.name, cursor: bundle.cursor,
          file_count: Object.keys(bundle.files).length,
          tombstoned_short_ids: bundle.tombstoned_short_ids,
          lease: bundle.lease, next_free_ids: bundle.next_free_ids,
          how_to: 'Write EVERY entry of `files` verbatim under .tasker/ in the working directory (create folders as needed, overwrite existing). Delete local tasks/<prefix>-<id>.md files for tombstoned_short_ids. Then work tasks by editing files; flush each work unit via flush_local_project.',
          files: bundle.files,
        })
      }

      // Default: script transport. Validate cheaply, then hand back a short-lived
      // signed bundle URL + hydrate script — file bytes never enter the agent context.
      const { data: proj } = await sb.from('projects').select('local_mode').eq('id', project.id).maybeSingle()
      if (!proj?.local_mode) return `"${project.name}" is not a Local Mode project. Enable Local Mode first (web app → project settings), then pull again.`
      const token = await signBundleToken(project.id, userId, deviceId, cursor)
      const bundleUrl = `${SUPABASE_URL}/functions/v1/mcp?local_bundle=${token}`
      const out: Record<string, unknown> = {
        status: 'pull_ready', project: project.name,
        how_to: 'Write hydrate_script to a file named hydrate.mjs in the directory that should contain .tasker/, run `node hydrate.mjs`, and read the JSON summary it prints (file_count, cursor, lease, next_free_ids). The bundle URL inside is single-project, short-lived (~15 min) — re-pull if it expires. Afterwards you may delete hydrate.mjs. If node is unavailable, call this tool again with inline:true to receive the full file map directly.',
        hydrate_script: hydrateScript(bundleUrl),
        expires_in_minutes: 15,
      }
      // Optional immediate-sync watcher: mint a scoped device token and embed a
      // watch.mjs so `node watch.mjs` keeps .tasker/ live-synced (flush-on-save +
      // hub polling). Off by default so plain pulls don't accrue standing tokens.
      if (args.watch === true) {
        const secret = `dt_${b64url(crypto.getRandomValues(new Uint8Array(32)))}`
        const { error: tErr } = await sb.from('local_device_tokens').insert({
          project_id: project.id, user_id: userId, device_id: deviceId,
          token_hash: await sha256Hex(secret), label: `${deviceId} watcher`,
        })
        if (tErr) { out.watch_error = `Could not mint watcher token: ${tErr.message}` }
        else {
          out.watch_script = watchScript(`${SUPABASE_URL}/functions/v1/mcp`, secret, `${project.prefix || project.name}`)
          out.watch_how_to = 'After hydrate.mjs has written .tasker/, save watch_script as watch.mjs beside it and run `node watch.mjs` in a spare terminal. It flushes edits within ~1s of a save and pulls hub changes every ~15s. The embedded token is scoped to THIS project only and is revocable via revoke_device_token. Leave it running while working; Ctrl-C to stop.'
        }
      }
      return JSON.stringify(out)
    }

    case 'flush_local_project': {
      const project = await resolveProject(sb, userId, args.project_id, logCtx)
      if (!project) return `Project "${args.project_id}" not found.`
      const deviceId = String(args.device_id || '').trim()
      if (!deviceId) return 'device_id is required (same value used for pull_local_project).'
      const baseCursor = Number(args.base_cursor ?? NaN)
      if (!Number.isFinite(baseCursor)) return 'base_cursor is required — the cursor from this device\'s .sync.json.'

      const changed = Array.isArray(args.changed_files) ? args.changed_files : []
      const deletedIds = (Array.isArray(args.deleted_short_ids) ? args.deleted_short_ids : []).map(Number).filter(Number.isFinite)
      const res = await applyFlush(sb, userId, project, deviceId, baseCursor, changed, deletedIds)
      if ('error' in res) return res.error
      return JSON.stringify({
        status: 'flushed', project: project.name, cursor: res.cursor,
        applied: res.applied, created: res.created, deleted: res.deleted,
        created_groups: res.created_groups, created_sections: res.created_sections,
        structure_changes: res.structure_changes,
        rejected: res.rejected, warnings: res.warnings, hub_wins: res.hub_wins,
        how_to: 'Write every hub_wins content back to its path under .tasker/, then update the cursor field in .sync.json to the value above. Completion ceremonies (submit_validation_result / submit_task_review / complete_task) still run via MCP.',
        ...(res.created_groups.length ? { note_created_groups: `Created ${res.created_groups.length} group(s) by reference from a task's group: field: ${res.created_groups.join(', ')}. Named exactly as the slug (rename via the web app / rename_group if you want a prettier display name). If any of these was a typo, it made a stray group — delete it via the web app.` } : {}),
        ...(res.created_sections.length ? { note_created_sections: `Created ${res.created_sections.length} section(s) by reference from a task's section: field: ${res.created_sections.join(', ')}. Named exactly as the slug. If any was a typo, it made a stray section — delete it via the web app.` } : {}),
      })
    }

    case 'set_local_mode': {
      const project = await resolveProject(sb, userId, args.project_id, logCtx)
      if (!project) return `Project "${args.project_id}" not found.`
      const on = args.on === undefined ? true : args.on === true
      const { data: cur } = await sb.from('projects').select('local_mode').eq('id', project.id).maybeSingle()
      if (cur?.local_mode === on) return `"${project.name}" already has Local Mode ${on ? 'ON' : 'OFF'} — no change.`
      const { error } = await sb.from('projects').update({ local_mode: on }).eq('id', project.id).eq('user_id', userId)
      if (error) return `Failed to set Local Mode: ${error.message}`
      return on
        ? `Local Mode is now ON for "${project.name}". Pull it to a machine with pull_local_project(project:"${project.prefix || project.name}", device_id:"<a stable name for this machine>") — add watch:true for immediate two-way sync.`
        : `Local Mode is now OFF for "${project.name}". pull_local_project / flush_local_project will refuse it until re-enabled. Any .tasker/ files already on disk are left untouched.`
    }

    case 'mint_device_token': {
      const project = await resolveProject(sb, userId, args.project_id, logCtx)
      if (!project) return `Project "${args.project_id}" not found.`
      const deviceId = String(args.device_id || '').trim()
      if (!deviceId) return 'device_id is required — the same stable name used for pull_local_project.'
      const { data: proj } = await sb.from('projects').select('local_mode').eq('id', project.id).maybeSingle()
      if (!proj?.local_mode) return `"${project.name}" is not a Local Mode project. Enable Local Mode first, then mint a watcher token.`
      const secret = `dt_${b64url(crypto.getRandomValues(new Uint8Array(32)))}`
      const { data: row, error } = await sb.from('local_device_tokens').insert({
        project_id: project.id, user_id: userId, device_id: deviceId,
        token_hash: await sha256Hex(secret), label: args.label ? String(args.label) : `${deviceId} watcher`,
      }).select('id').single()
      if (error) return `Failed to mint device token: ${error.message}`
      const base = `${SUPABASE_URL}/functions/v1/mcp`
      return JSON.stringify({
        status: 'minted', token_id: row.id, device_id: deviceId,
        token: secret,
        endpoints: {
          poll: `POST ${base}?device_poll=<token>`,
          pull: `POST ${base}?device_pull=<token>  (body: {cursor})`,
          flush: `POST ${base}?device_flush=<token>  (body: {base_cursor, changed_files, deleted_short_ids})`,
        },
        note: 'Store this token now — it is NEVER shown again. It can ONLY pull/flush this one project on this device. Revoke via revoke_device_token. To auto-sync, just run the watch_script returned by pull_local_project (it embeds a token for you).',
      })
    }

    case 'revoke_device_token': {
      const project = await resolveProject(sb, userId, args.project_id, logCtx)
      if (!project) return `Project "${args.project_id}" not found.`
      const tokenId = args.token_id ? String(args.token_id) : ''
      const deviceId = args.device_id ? String(args.device_id).trim() : ''

      if (!tokenId && !deviceId) {
        const { data: rows } = await sb.from('local_device_tokens')
          .select('id, device_id, label, created_at, last_used_at')
          .eq('project_id', project.id).eq('user_id', userId).is('revoked_at', null).order('created_at', { ascending: false })
        if (!rows?.length) return `No active device tokens for "${project.name}".`
        return JSON.stringify({
          active_tokens: rows.map((r: any) => ({ token_id: r.id, device_id: r.device_id, label: r.label, created_at: r.created_at, last_used_at: r.last_used_at })),
          how_to: 'Revoke one with revoke_device_token(project_id, token_id) or all for a device with revoke_device_token(project_id, device_id).',
        })
      }

      let q = sb.from('local_device_tokens').update({ revoked_at: new Date().toISOString() })
        .eq('project_id', project.id).eq('user_id', userId).is('revoked_at', null)
      if (tokenId) q = q.eq('id', tokenId)
      else q = q.eq('device_id', deviceId)
      const { data: killed, error } = await q.select('id')
      if (error) return `Failed to revoke: ${error.message}`
      return `Revoked ${killed?.length || 0} device token(s)${deviceId ? ` for device "${deviceId}"` : ''}. They stop working immediately.`
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

    case 'drive_upload_file': {
      const gToken = await loadGoogleAccessToken(sb, userId)
      if (!gToken) return 'Google Drive not connected. Connect it via Settings → Connectors in the app.'
      const { data: ds } = await sb.from('user_settings').select('google_drive_folder_id').eq('user_id', userId).maybeSingle()
      let taskerRootId = ds?.google_drive_folder_id
      if (!taskerRootId) {
        const folderRes = await fetch('https://www.googleapis.com/drive/v3/files', {
          method: 'POST',
          headers: { Authorization: `Bearer ${gToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Tasker', mimeType: 'application/vnd.google-apps.folder' }),
        })
        const folder = await folderRes.json()
        if (!folderRes.ok || !folder.id) return 'Failed to create Tasker Drive folder. Make sure Drive is connected.'
        await sb.from('user_settings').update({ google_drive_folder_id: folder.id }).eq('user_id', userId)
        taskerRootId = folder.id
      }

      let targetFolderId = taskerRootId
      let task: any = null
      if (args.task_id) {
        const resolved = await resolveTask(sb, userId, args.task_id)
        task = resolved
        if (task) {
          const { data: proj } = await sb.from('projects').select('name, google_drive_folder_id').eq('id', task.project_id).maybeSingle()
          if (proj) {
            let projectFolderId = proj.google_drive_folder_id
            if (!projectFolderId) {
              projectFolderId = await findOrCreateDriveFolder(gToken, taskerRootId, proj.name)
              await sb.from('projects').update({ google_drive_folder_id: projectFolderId }).eq('id', task.project_id)
            }
            let subName = 'standalone'
            if (task.flow_id) {
              const { data: flow } = await sb.from('flows').select('short_id, id').eq('id', task.flow_id).maybeSingle()
              subName = flow?.short_id || flow?.id?.slice(0, 8) || 'standalone'
            }
            targetFolderId = await findOrCreateDriveFolder(gToken, projectFolderId, subName)
          }
        }
      }

      // target_type controls the file's metadata mimeType (what Drive STORES it as);
      // mime_type is the source content type Drive CONVERTS FROM. Setting metadata.mimeType
      // to a google-apps type triggers convert-on-import → an editable native Doc/Sheet.
      const targetType = args.target_type || 'file'
      const GOOGLE_APPS = {
        doc:   { metaMime: 'application/vnd.google-apps.document',    defaultSource: 'text/html' },
        sheet: { metaMime: 'application/vnd.google-apps.spreadsheet', defaultSource: 'text/csv'  },
      }
      const native = GOOGLE_APPS[targetType as 'doc' | 'sheet']
      const contentMime = args.mime_type || native?.defaultSource || 'text/plain'
      const metaObj: Record<string, any> = { name: args.filename, parents: [targetFolderId] }
      if (native) metaObj.mimeType = native.metaMime
      const boundary = 'tasker_drive_boundary'
      const meta = JSON.stringify(metaObj)
      const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: ${contentMime}\r\n\r\n${args.content}\r\n--${boundary}--`
      const uploadRes = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
        method: 'POST',
        headers: { Authorization: `Bearer ${gToken}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
        body,
      })
      const uploaded = await uploadRes.json()
      if (!uploadRes.ok) return `Drive upload failed: ${uploaded.error?.message ?? JSON.stringify(uploaded)}`

      // Store Drive file ID on task output.drive_files
      if (task && uploaded.id) {
        const prev = (task.output && typeof task.output === 'object') ? task.output : {}
        const driveFiles = Array.isArray(prev.drive_files) ? prev.drive_files : []
        driveFiles.push({ file_id: uploaded.id, filename: args.filename, mime_type: uploaded.mimeType ?? null, uploaded_at: new Date().toISOString() })
        await sb.from('tasks').update({ output: { ...prev, drive_files: driveFiles } }).eq('id', task.id)
      }

      const location = args.task_id ? 'project/flow subfolder' : 'Tasker root folder'
      const kind = native ? (targetType === 'doc' ? 'Google Doc' : 'Google Sheet') : 'file'
      const link = uploaded.id ? ` https://drive.google.com/open?id=${uploaded.id}` : ''
      return `Created ${kind} "${args.filename}" in Drive (${location}). File ID: ${uploaded.id}.${link}`
    }

    case 'drive_read_file': {
      const gToken = await loadGoogleAccessToken(sb, userId)
      if (!gToken) return 'Google Drive not connected. Connect it via Settings → Connectors in the app.'
      // Native Google-apps files (Docs/Sheets) can't be downloaded with alt=media — they must be
      // exported. Check the mimeType first, then export-or-download accordingly.
      const metaRes = await fetch(`https://www.googleapis.com/drive/v3/files/${args.file_id}?fields=mimeType,name`, {
        headers: { Authorization: `Bearer ${gToken}` },
      })
      const fileMeta = await metaRes.json().catch(() => ({}))
      if (!metaRes.ok) return `Drive read failed: ${(fileMeta as any).error?.message ?? metaRes.statusText}`
      const fileMime: string = (fileMeta as any).mimeType ?? ''
      const EXPORT_AS: Record<string, string> = {
        'application/vnd.google-apps.document':    'text/markdown',
        'application/vnd.google-apps.spreadsheet': 'text/csv',
      }
      const exportMime = EXPORT_AS[fileMime]
      const readUrl = exportMime
        ? `https://www.googleapis.com/drive/v3/files/${args.file_id}/export?mimeType=${encodeURIComponent(exportMime)}`
        : `https://www.googleapis.com/drive/v3/files/${args.file_id}?alt=media`
      const readRes = await fetch(readUrl, { headers: { Authorization: `Bearer ${gToken}` } })
      if (!readRes.ok) {
        const err = await readRes.json().catch(() => ({}))
        return `Drive read failed: ${(err as any).error?.message ?? readRes.statusText}`
      }
      const content = await readRes.text()
      return content
    }

    case 'drive_list_files': {
      const gToken = await loadGoogleAccessToken(sb, userId)
      if (!gToken) return 'Google Drive not connected. Connect it via Settings → Connectors in the app.'
      const { data: ds } = await sb.from('user_settings').select('google_drive_folder_id').eq('user_id', userId).maybeSingle()
      let folderId = ds?.google_drive_folder_id
      if (!folderId) {
        const folderRes = await fetch('https://www.googleapis.com/drive/v3/files', {
          method: 'POST',
          headers: { Authorization: `Bearer ${gToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Tasker', mimeType: 'application/vnd.google-apps.folder' }),
        })
        const folder = await folderRes.json()
        if (!folderRes.ok || !folder.id) return 'Failed to create Tasker Drive folder. Make sure Drive is connected.'
        await sb.from('user_settings').update({ google_drive_folder_id: folder.id }).eq('user_id', userId)
        folderId = folder.id
      }
      let q = `'${folderId}' in parents and trashed=false`
      if (args.query) q += ` and ${args.query}`
      const listRes = await fetch(
        `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,mimeType,size,modifiedTime)&orderBy=modifiedTime desc&pageSize=50`,
        { headers: { Authorization: `Bearer ${gToken}` } },
      )
      const list = await listRes.json()
      if (!listRes.ok) return `Drive list failed: ${list.error?.message ?? JSON.stringify(list)}`
      const files: any[] = list.files ?? []
      if (!files.length) return 'No files found in Tasker Drive folder.'
      return files.map((f: any) => `${f.name} (id: ${f.id}, type: ${f.mimeType}, size: ${f.size ?? '?'}B, modified: ${f.modifiedTime})`).join('\n')
    }

    case 'list_google_task_lists': {
      const gToken = await loadGoogleAccessToken(sb, userId)
      if (!gToken) return 'Google Tasks not connected. Connect via Settings → Connectors in the app.'
      const res = await fetch('https://tasks.googleapis.com/tasks/v1/users/@me/lists?maxResults=100', {
        headers: { Authorization: `Bearer ${gToken}` },
      })
      const data = await res.json()
      if (!res.ok) return `Failed: ${data.error?.message ?? JSON.stringify(data)}`
      const lists: any[] = data.items ?? []
      if (!lists.length) return 'No Google Task lists found.'
      return lists.map((l: any) => `${l.title} (id: ${l.id})`).join('\n')
    }

    case 'list_google_tasks': {
      const gToken = await loadGoogleAccessToken(sb, userId)
      if (!gToken) return 'Google Tasks not connected.'
      const { list_id, include_completed = false } = args
      const params = new URLSearchParams({ maxResults: '100', showCompleted: String(include_completed), showHidden: 'false' })
      const res = await fetch(`https://tasks.googleapis.com/tasks/v1/lists/${list_id}/tasks?${params}`, {
        headers: { Authorization: `Bearer ${gToken}` },
      })
      const data = await res.json()
      if (!res.ok) return `Failed: ${data.error?.message ?? JSON.stringify(data)}`
      const tasks: any[] = data.items ?? []
      if (!tasks.length) return 'No tasks found in this list.'
      return tasks.map((t: any) =>
        `${t.title} (id: ${t.id}${t.due ? `, due: ${t.due.slice(0, 10)}` : ''}${t.status === 'completed' ? ' [done]' : ''})`
      ).join('\n')
    }

    case 'pull_google_task': {
      const gToken = await loadGoogleAccessToken(sb, userId)
      if (!gToken) return 'Google Tasks not connected.'
      const { list_id, task_id, section_id } = args
      const res = await fetch(`https://tasks.googleapis.com/tasks/v1/lists/${list_id}/tasks/${task_id}`, {
        headers: { Authorization: `Bearer ${gToken}` },
      })
      const gtask = await res.json()
      if (!res.ok) return `Failed to fetch Google Task: ${gtask.error?.message ?? JSON.stringify(gtask)}`
      const section = await resolveSection(sb, userId, section_id)
      if (!section) return 'Section not found.'
      const { data: lastTask } = await sb.from('tasks')
        .select('sort_order').eq('project_id', section.project_id).eq('section_id', section.id)
        .order('sort_order', { ascending: false }).limit(1).maybeSingle()
      const insert: any = {
        text: gtask.title || 'Untitled',
        section_id: section.id,
        project_id: section.project_id,
        user_id: userId,
        status: 'pending',
        sort_order: (lastTask?.sort_order ?? -1) + 1,
        intake_source: 'google_tasks',
      }
      if (gtask.notes) insert.detail = gtask.notes
      if (gtask.due) insert.due_date = gtask.due.slice(0, 10)
      const { data: newTask, error: insertErr } = await sb.from('tasks').insert(insert).select('id, short_id').single()
      if (insertErr) return `Failed to create task: ${insertErr.message}`
      return `Pulled "${gtask.title}" → task ${newTask.short_id ?? newTask.id}`
    }

    case '__init_tasker_session': {
      // TDE-371: a new session — forget which projects were context-primed, so the first get_task
      // in each project this session re-ships the full Foundation/IS/KB once more.
      fireAndForget(sb.from('mcp_context_primed').delete().eq('user_id', userId))
      const { data: settings } = await sb.from('user_settings').select('ai_instructions, active_environment_id').eq('user_id', userId).maybeSingle()
      const instructions = settings?.ai_instructions
      const { show_questionnaire } = args

      const { data: envRows } = await sb.from('environments').select('id, name, sort_order').eq('user_id', userId).order('sort_order')
      const environments = (envRows ?? []).map((e: any) => ({ id: e.id, name: e.name }))
      const active_environment_id = settings?.active_environment_id ?? null

      if (instructions && !show_questionnaire) {
        const settings_summary = {
          task_list_format: instructions.task_list_format === 'plain_text' ? 'plain text' :
                            instructions.task_list_format === 'markdown_table' ? 'markdown table' : 'numbered list',
          show_completed_tasks: instructions.show_completed_tasks ? 'shown' : 'hidden',
          rank_tasks_by: instructions.rank_tasks_by === 'sorting_order' ? 'sorting order' : 'task priority',
          communication_style: instructions.communication_style,
          multiple_tasks_handling: instructions.multiple_tasks_handling,
          show_project_context: instructions.show_project_context ? 'shown' : 'hidden',
          timezone: zoneLabel(instructions.timezone),
        }
        return JSON.stringify({
          status: 'ready',
          instructions,
          settings_summary,
          environments,
          active_environment_id,
          // The web app captures the browser's zone on login, but an MCP-only user may never
          // open it — and the server cannot infer a timezone from an HTTP request.
          timezone_note: instructions.timezone ? undefined
            : 'No timezone saved, so task timestamps render in UTC. If you can read this machine\'s timezone (e.g. a shell command), call update_ai_instructions(timezone: "<IANA name, e.g. Asia/Amman>") once. If you cannot, ask the user rather than guessing.',
          environment_note: environments.length
            ? 'Environments partition the user\'s projects (single-user; Personal / Work / Learning …). The active one is the DEFAULT for create_project when environment_id is omitted — you may still pass environment_id explicitly. Do NOT silently scope reads to it: list_projects shows every Environment unless the caller filters. The web app owns switching the active Environment (MCP only reads it).'
            : undefined,
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
      const allowed = ['task_list_format', 'show_completed_tasks', 'rank_tasks_by', 'communication_style', 'multiple_tasks_handling', 'show_project_context', 'timezone']
      const updates: Record<string, any> = {}
      for (const k of allowed) if (args[k] !== undefined) updates[k] = args[k]

      if (Object.keys(updates).length === 0) {
        return 'No fields to update. Provide at least one of: task_list_format, show_completed_tasks, rank_tasks_by, communication_style, multiple_tasks_handling, show_project_context, timezone.'
      }
      // Reject a zone we cannot render, rather than silently falling back to UTC later.
      if (updates.timezone !== undefined && updates.timezone !== null && String(updates.timezone).trim() !== '') {
        const raw = String(updates.timezone).trim()
        if (!/^([+-])(\d{2}):?(\d{2})$/.test(raw)) {
          try { new Intl.DateTimeFormat('en-CA', { timeZone: raw }) }
          catch { return `"${raw}" is not a timezone this server can render. Use an IANA name (e.g. "Asia/Amman") or a fixed UTC offset (e.g. "+03:00").` }
        }
        updates.timezone = raw
        // Marks this as a deliberate choice so the web app's browser detection stops
        // correcting it (see app/src/lib/timezone.js).
        updates.timezone_source = 'user'
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

      // group_id is not in resolveTask's projection — fetch it so the before-state is real.
      const { data: priorLoc } = await sb.from('tasks').select('group_id').eq('id', task.id).maybeSingle()
      const { error } = await sb.from('tasks').update(updates).eq('id', task.id)
      if (error) throw new Error(error.message)

      // TDE-819: location changes bypass update_task, so the board move left no trace.
      await recordLifecycleChange(sb, userId, {
        taskId: task.id, via: 'move_task_to_group', actor: tokenActor,
        summary: targetGroup ? `Moved into a group` : `Moved to ungrouped`
          + (args.section_id ? ' (section also changed)' : ''),
        before: { group_id: priorLoc?.group_id ?? null, ...(args.section_id ? { section_id: (task as any).section_id ?? null } : {}) },
        after: updates,
      })

      if (targetGroup) {
        const { data: group } = await sb.from('groups').select('name').eq('id', targetGroup).single()
        return `Moved task ${task.prefix ? `${task.prefix}-${task.short_id}` : task.id} to group "${group?.name ?? 'Unknown'}"`
      } else {
        return `Moved task ${task.prefix ? `${task.prefix}-${task.short_id}` : task.id} to ungrouped`
      }
    }

    case 'move_task': {
      // Cross-project move (TDE-186, Phase 1). Single task, warn-and-drop cross-boundary edges.
      const task = await resolveTask(sb, userId, args.task_id)
      if (!task) return `Task "${args.task_id}" not found.`
      const target = await resolveProject(sb, userId, args.target_project_id)
      if (!target) return `Target project "${args.target_project_id}" not found.`

      const { data: srcProj } = await sb.from('projects').select('name, prefix').eq('id', task.project_id).maybeSingle()
      const oldRef = srcProj?.prefix && task.short_id != null ? `${srcProj.prefix}-${task.short_id}` : task.id
      if (task.project_id === target.id) return `"${task.text}" (${oldRef}) is already in "${target.name}".`

      // short_id is reassigned ATOMICALLY by the task_short_id_trigger when project_id changes
      // (advisory-locked per target project — safe under concurrent/bulk moves). We do NOT
      // compute it here; we read it back from the UPDATE below.

      // Validate an optional target section actually belongs to the target project.
      let landingSection: string | null = null
      let sectionNote = ''
      if (args.target_section_id) {
        const { data: sec } = await sb.from('sections').select('id, name').eq('id', args.target_section_id).eq('project_id', target.id).maybeSingle()
        if (sec) landingSection = sec.id
        else sectionNote = ` (ignored target_section_id — not a section of "${target.name}"; landed with no section)`
      }

      // Cross-boundary edges, dropped. (a) the task's own inputs all point at old-project sources.
      const ownEdges = inputEdges(task.input)
      // (b) tasks left behind that consume this task as a source — strip the dangling reference.
      const [{ data: c1 }, { data: c2 }] = await Promise.all([
        sb.from('tasks').select('id, input').eq('user_id', userId).contains('input', { source_task_id: task.id }),
        sb.from('tasks').select('id, input').eq('user_id', userId).contains('input', { edges: [{ source_task_id: task.id }] }),
      ])
      const consumerMap = new Map<string, any>()
      ;[...(c1 || []), ...(c2 || [])].forEach((t: any) => consumerMap.set(t.id, t))
      const consumers = [...consumerMap.values()]
      for (const c of consumers) {
        const kept = inputEdges(c.input).filter((e: any) => e.source_task_id !== task.id)
        await sb.from('tasks').update({ input: { edges: kept } }).eq('id', c.id)
      }

      const wasInFlow = !!task.flow_id
      const { data: moved, error } = await sb.from('tasks').update({
        project_id: target.id,
        section_id: landingSection,
        group_id: null,
        flow_id: null,
        flow_step: null,
        input: { edges: [] },
      }).eq('id', task.id).select('short_id').single()
      if (error) throw new Error(error.message)

      const newShortId = moved?.short_id
      const newRef = target.prefix && newShortId != null ? `${target.prefix}-${newShortId}` : task.id
      // TDE-819: the most destructive non-delete operation on a task — it changes project, drops
      // every input edge, leaves any flow, and REASSIGNS the short_id. Without a record, the old
      // reference (e.g. TDE-42) becomes unresolvable with nothing explaining where it went.
      await recordLifecycleChange(sb, userId, {
        taskId: task.id, via: 'move_task', actor: tokenActor,
        summary: `Moved across projects: ${oldRef} → ${newRef}`
          + ` ("${srcProj?.name ?? task.project_id}" → "${target.name}")`
          + (ownEdges.length ? `, dropped ${ownEdges.length} input edge(s)` : '')
          + (consumers.length ? `, stripped from ${consumers.length} downstream consumer(s)` : '')
          + (wasInFlow ? ', removed from its flow' : ''),
        before: {
          project_id: task.project_id, section_id: (task as any).section_id ?? null,
          short_id: (task as any).short_id ?? null, flow_id: (task as any).flow_id ?? null,
          flow_step: (task as any).flow_step ?? null, input: task.input ?? null,
        },
        after: {
          project_id: target.id, section_id: landingSection, group_id: null,
          short_id: newShortId ?? null, flow_id: null, flow_step: null, input: { edges: [] },
        },
        extra: {
          old_ref: oldRef, new_ref: newRef,
          dropped_input_edges: ownEdges.length, stripped_consumers: consumers.length, was_in_flow: wasInFlow,
        },
      })
      const notes: string[] = []
      if (ownEdges.length) notes.push(`dropped ${ownEdges.length} input edge${ownEdges.length !== 1 ? 's' : ''} (sources stayed behind)`)
      if (consumers.length) notes.push(`removed this task as a source from ${consumers.length} downstream task${consumers.length !== 1 ? 's' : ''}`)
      if (wasInFlow) notes.push('unlinked from its flow')
      const warn = notes.length ? `\nDropped on the way: ${notes.join('; ')}.` : ''
      return `Moved "${task.text}" from "${srcProj?.name ?? 'old project'}" (${oldRef}) to "${target.name}" (${newRef})${sectionNote}.${warn}`
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

    case 'get_flow_exceptions': {
      // TDE-382, promoted to STRUCTURAL by Q7 (TDE-799). The human review surface for a flow.
      //
      // Q7's finding is the whole design: human attention DEGRADES with volume — 29 step
      // outputs means rubber-stamping by the sixth, and a rubber-stamped output is worse than
      // an ungated one because it propagates with confidence behind it. So a human is shown
      // EXCEPTIONS, never outputs, and the review load scales with problems found rather than
      // with flow length. Everything this tool deliberately omits (passing checks, artifacts,
      // progress) is omission on purpose, not missing features — get_flow_audit is the
      // everything view when you genuinely want it.
      let exFlow: any = null
      let exTasks: any[] = []
      if (args.flow_id) {
        const looksLikeUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(args.flow_id)
        const { data } = looksLikeUuid
          ? await sb.from('flows').select('id, name, short_id, step_list_open').eq('id', args.flow_id).eq('user_id', userId).maybeSingle()
          : await sb.from('flows').select('id, name, short_id, step_list_open').eq('user_id', userId).ilike('name', `%${args.flow_id}%`).order('created_at', { ascending: false }).limit(1).maybeSingle()
        exFlow = data
      } else if (args.task_id) {
        const anchor = await resolveTask(sb, userId, args.task_id)
        if (!anchor) return `Task "${args.task_id}" not found.`
        if (!anchor.flow_id) return `"${anchor.text}" is not part of a named flow. Task-level review lives on the task itself — use get_task_critique.`
        const { data } = await sb.from('flows').select('id, name, short_id, step_list_open').eq('id', anchor.flow_id).eq('user_id', userId).maybeSingle()
        exFlow = data
      } else {
        return 'Pass task_id (any task in the flow) or flow_id.'
      }
      if (!exFlow) return 'Flow not found. Pass task_id or flow_id.'

      const { data: exRows } = await sb.from('tasks')
        .select('id, text, status, short_id, flow_step, input, output, executor, project:projects(prefix)')
        .eq('flow_id', exFlow.id).eq('user_id', userId)
      exTasks = exRows || []
      if (!exTasks.length) return `Flow "${exFlow.name}" has no steps.`

      const exById = new Map(exTasks.map((t: any) => [t.id, t]))
      const exRef = (t: any) => t.project?.prefix && t.short_id != null ? `${t.project.prefix}-${t.short_id}` : `#${t.short_id ?? t.id.slice(0, 8)}`

      // BLAST RADIUS (Q7's placement rule: early seams in long flows first). Computable proxy =
      // how many steps transitively depend on this one. A bad output early in a long chain
      // contaminates everything downstream; the last step contaminates nothing but itself.
      const childrenOf = new Map<string, string[]>()
      for (const t of exTasks) {
        for (const e of inputEdges(t.input)) {
          if (!exById.has(e.source_task_id)) continue
          if (!childrenOf.has(e.source_task_id)) childrenOf.set(e.source_task_id, [])
          childrenOf.get(e.source_task_id)!.push(t.id)
        }
      }
      const blastOf = (id: string): number => {
        const seen = new Set<string>()
        const queue = [...(childrenOf.get(id) || [])]
        while (queue.length) {
          const c = queue.shift()!
          if (seen.has(c)) continue
          seen.add(c)
          for (const g of (childrenOf.get(c) || [])) if (!seen.has(g)) queue.push(g)
        }
        return seen.size
      }

      // TERMINAL steps: nothing inside the flow consumes them, so no downstream receiver can
      // catch a bad output. Q7 makes this the one unconditional gate.
      const terminalIds = new Set(exTasks.filter((t: any) => !(childrenOf.get(t.id)?.length)).map((t: any) => t.id))

      type Exc = { kind: 'failed_check' | 'judgment_residue' | 'terminal'; taskId: string; blast: number; lines: string[] }
      const excs: Exc[] = []

      for (const t of exTasks) {
        const out = (t.output && typeof t.output === 'object') ? t.output : {}
        const ledgers = (out.validation_ledgers && typeof out.validation_ledgers === 'object') ? out.validation_ledgers : {}
        const blast = blastOf(t.id)

        // (1) FAILED CHECKS — with the observed value, which is the point. A claim that
        // something failed is not reviewable; what was actually seen is.
        const seenFail = new Set<string>()
        for (const [edgeKey, entry] of Object.entries<any>(ledgers)) {
          for (const l of (entry?.ledger || [])) {
            if (l.status !== 'fail') continue
            const key = `${edgeKey}:${l.rule_id}`
            if (seenFail.has(key)) continue
            seenFail.add(key)
            const consumer = exById.get(edgeKey)
            excs.push({
              kind: 'failed_check', taskId: t.id, blast,
              lines: [
                `  ✗ ${exRef(t)} "${t.text}" — failed ${l.kind === 'check' ? 'check' : 'judgment rule'} [${l.severity || 'blocker'}]: ${l.label || l.rule_id}`,
                ...(l.observed_value ? [`      observed: ${l.observed_value}`] : ['      observed: (none recorded — the check was asserted, not run)']),
                ...(l.note ? [`      note: ${l.note}`] : []),
                `      gate into: ${consumer ? `${exRef(consumer)} "${consumer.text}"` : edgeKey}${entry.retry_count ? ` · ${entry.retry_count} retr${entry.retry_count === 1 ? 'y' : 'ies'} so far` : ''}`,
              ],
            })
          }
        }

        // (2) JUDGMENT RESIDUE — criteria no deterministic check could cover. Q7: "What cannot
        // be reduced to a check IS the human's review list." These belong here even when
        // nothing has failed, because nothing has actually VERIFIED them either.
        const oc = outputContract(out)
        const judgmentRules = (oc.rules || []).filter((r: any) => r.kind === 'judgment')
        for (const r of judgmentRules) {
          // Skip if a human or independent validator already ruled on this rule.
          const ruled = Object.values<any>(ledgers).some((entry: any) =>
            (entry?.ledger || []).some((l: any) => l.rule_id === r.id && l.status === 'pass' &&
              l.validator && l.validator !== 'self' && l.validator !== 'unverified'))
          if (ruled) continue
          excs.push({
            kind: 'judgment_residue', taskId: t.id, blast,
            lines: [
              `  ? ${exRef(t)} "${t.text}" — judgment criterion with no deterministic check: ${r.label || r.id}`,
              `      rule: ${r.rule}`,
              `      why you: this could not be reduced to a check, so no check has verified it.`,
            ],
          })
        }

        // (3) TERMINAL OUTPUT — unconditional, regardless of what the checks said.
        if (terminalIds.has(t.id)) {
          excs.push({
            kind: 'terminal', taskId: t.id, blast,
            lines: [
              `  ◆ ${exRef(t)} "${t.text}" — TERMINAL output [${t.status}]${t.executor && t.executor !== 'agent' ? ` · executor: ${t.executor}` : ''}`,
              `      why you: nothing downstream consumes this, so no later step can catch a problem in it. Q7 makes this gate unconditional.`,
            ],
          })
        }
      }

      // Optional: earlier failed attempts, recoverable only since TDE-818 gave gate history a
      // durable home. Before that, attempt N overwrote attempt N-1 and this was unanswerable.
      const historyLines: string[] = []
      if (args.include_history === true) {
        const { data: evs } = await sb.from('task_events')
          .select('task_id, summary, meta, created_at')
          .in('task_id', exTasks.map((t: any) => t.id))
          .in('kind', ['validation_submitted', 'review_submitted'])
          .order('created_at', { ascending: true })
        for (const e of (evs || [])) {
          if (e.meta?.overall === 'valid' || e.meta?.overall === 'pass') continue
          const t = exById.get(e.task_id)
          historyLines.push(`  · ${t ? exRef(t) : e.task_id} — ${e.summary}${e.meta?.attempt ? '' : ''}`)
        }
      }

      const RANK: Record<string, number> = { failed_check: 0, judgment_residue: 1, terminal: 2 }
      excs.sort((a, b) => (b.blast - a.blast) || (RANK[a.kind] - RANK[b.kind]))

      const failed = excs.filter(e => e.kind === 'failed_check')
      const residue = excs.filter(e => e.kind === 'judgment_residue')
      const terminal = excs.filter(e => e.kind === 'terminal')

      const outLines: string[] = [
        `# What needs you — "${exFlow.name}"${exFlow.short_id ? `  [${exFlow.short_id}]` : ''}`,
        `${exTasks.length} step${exTasks.length !== 1 ? 's' : ''}${exFlow.step_list_open ? ' known so far (step list OPEN)' : ''} · ${excs.length} item${excs.length !== 1 ? 's' : ''} need judgment`,
        `Ordered by blast radius — how much downstream work builds on the step. Passing checks and step outputs are deliberately NOT shown (Q7: showing everything is what causes rubber-stamping).`,
      ]
      if (!excs.length) {
        outLines.push('', 'Nothing needs you. Every declared check passed, no judgment criteria are unverified, and there is no terminal step — which is itself unusual; check the flow actually has an endpoint.')
        return outLines.join('\n')
      }
      if (failed.length) {
        outLines.push('', `── FAILED CHECKS (${failed.length}) — a gate rejected something ──`)
        failed.forEach(e => outLines.push(...e.lines))
      }
      if (residue.length) {
        outLines.push('', `── JUDGMENT RESIDUE (${residue.length}) — nothing could check these for you ──`)
        residue.forEach(e => outLines.push(...e.lines))
      }
      if (terminal.length) {
        outLines.push('', `── TERMINAL OUTPUT (${terminal.length}) — unconditional gate ──`)
        terminal.forEach(e => outLines.push(...e.lines))
      }
      if (args.include_history === true) {
        outLines.push('', `── EARLIER FAILED ATTEMPTS (from durable gate history) ──`)
        outLines.push(...(historyLines.length ? historyLines : ['  (none recorded)']))
      } else {
        outLines.push('', `(Pass include_history:true to also see earlier failed attempts a step has since passed.)`)
      }
      return outLines.join('\n')
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
        `Gate Snapshot — ${flowName ? `"${flowName}"` : `${project?.name || projectId} (unnamed flow)`}`,
        // TDE-818: this renders the CURRENT value of each task's validation ledger. It is a
        // snapshot, not a log — earlier attempts are not here (a retry_count of 3 with only the
        // latest body visible is this tool's shape, not missing data). The real per-attempt
        // history lives in task_events → get_task_history.
        `(Current state per step. For per-attempt history — what an earlier attempt failed on, or a contract that was replaced — use get_task_history.)`,
        ...(flowContext ? [`Context: ${flowContext}`] : []),
        '',
      ]

      let totalValidated = 0, totalPass = 0, totalFail = 0, totalRetries = 0, totalBlocked = 0, totalProvisional = 0

      // In-memory pagination since sorting is JS-based
      const limit = clampLimit(args.limit)
      let startIndex = 0
      if (args.cursor) {
        const decoded = decodeCursor(args.cursor)
        if (!decoded) return 'Invalid cursor — pass the cursor exactly as returned by a previous call.'
        const idx = sorted.findIndex((t: any) => t.id === decoded.id)
        if (idx >= 0) startIndex = idx + 1 // strictly after the cursor
      }
      const pageTasks = sorted.slice(startIndex, startIndex + limit)
      const hasMore = startIndex + limit < sorted.length
      let nextCursor: string | null = null
      if (hasMore && pageTasks.length) {
        const last = pageTasks[pageTasks.length - 1]
        nextCursor = encodeCursor(startIndex + limit - 1, last.id) // using array index as sortValue
      }

      pageTasks.forEach((t: any, idxInPage: number) => {
        const i = startIndex + idxInPage
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
      if (hasMore) lines.push(`\n… ${pageTasks.length}+ shown. cursor: "${nextCursor}" for the next page.`)
      return lines.join('\n')
    }

    case 'list_flows': {
      const project = await resolveProject(sb, userId, args.project_id, logCtx)
      if (!project) return `Project "${args.project_id}" not found.`
      let q = sb.from('flows')
        .select('id, name, short_id, created_at, step_list_open')
        .eq('project_id', project.id)
        .eq('user_id', userId)

      const limit = clampLimit(args.limit)
      const cursor = args.cursor ? decodeCursor(args.cursor) : null
      if (args.cursor && !cursor) return 'Invalid cursor — pass the cursor exactly as returned by a previous call.'
      q = applyCursor(q, 'created_at', cursor, false)

      const { data: rows, error } = await q.order('created_at', { ascending: false }).order('id', { ascending: false }).limit(limit + 1)
      if (error) throw new Error(error.message)

      const hasMore = (rows?.length ?? 0) > limit
      const flows = hasMore ? rows!.slice(0, limit) : (rows ?? [])
      let nextCursor: string | null = null
      if (hasMore && flows.length) {
        const last = flows[flows.length - 1]
        nextCursor = encodeCursor(last.created_at, last.id)
      }

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
        // TDE-811: an open step list must not roll up to 'done' just because every step
        // discovered so far is finished — that is a pause, not completion.
        const listOpen = flow.step_list_open === true
        const overall = done === total && total > 0 ? (listOpen ? 'in_progress' : 'done') : inProg > 0 || done > 0 ? 'in_progress' : 'pending'
        lines.push(flow.short_id ? `${flow.name}  [${flow.short_id}]` : flow.name)
        lines.push(`  id: ${flow.id}`)
        lines.push(`  steps: ${total}${listOpen ? ' known so far' : ''} · ${done}/${total} done · ${overall}${listOpen ? ' · step list OPEN (more steps expected)' : ''}`)
        if (ts.length) {
          const stepLines = ts.map((t: any) => {
            const ref = t.project?.prefix && t.short_id != null ? `${t.project.prefix}-${t.short_id}` : t.id
            return `    Step ${t.flow_step ?? '?'} · ${ref} — ${t.text} [${t.status}]`
          })
          lines.push(...stepLines)
        }
        lines.push('')
      }
      lines.push('To rename a flow (or change its context / short ID), call update_flow_context with any task_id in the flow — no need to re-run name_flow with the full task list.')
      if (hasMore) lines.push(``, `… ${flows.length}+ shown. cursor: "${nextCursor}" for the next page.`)
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
          const { data } = await sb.from('flows').select('id, name, short_id, context, project_id, step_list_open').eq('id', args.flow_id).eq('user_id', userId).maybeSingle()
          flow = data
        } else {
          // Name lookup — optionally scoped to a project
          let q = sb.from('flows').select('id, name, short_id, context, project_id, step_list_open').eq('user_id', userId).ilike('name', `%${args.flow_id}%`)
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
          .select('id, text, status, priority, short_id, flow_step, input, output, sort_order, project_id, executor, human_guidance, project:projects(name, prefix)')
          .eq('flow_id', flow.id).eq('user_id', userId)
        flowTasks = tasks || []
      } else if (args.task_id) {
        const anchor = await resolveTask(sb, userId, args.task_id)
        if (!anchor) return `Task "${args.task_id}" not found.`

        // If the anchor has a flow_id, fetch the whole named flow
        if (anchor.flow_id) {
          const { data: flow } = await sb.from('flows').select('id, name, short_id, context, project_id, step_list_open').eq('id', anchor.flow_id).eq('user_id', userId).maybeSingle()
          flowRecord = flow || null
          const { data: tasks } = await sb.from('tasks')
            .select('id, text, status, priority, short_id, flow_step, input, output, sort_order, project_id, executor, human_guidance, project:projects(name, prefix)')
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
            .select('id, text, status, priority, short_id, flow_step, input, output, sort_order, project_id, executor, human_guidance, project:projects(name, prefix)')
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

      // TDE-384: a human-set stop halts the flow. Refuse to proceed until it's cleared.
      if (flowRecord?.id) {
        const { data: fs } = await sb.from('flows').select('stop_requested, stop_reason, stopped_at').eq('id', flowRecord.id).maybeSingle()
        if (fs?.stop_requested) {
          return `⛔ FLOW STOPPED by the human${fs.stopped_at ? ` (at ${fs.stopped_at})` : ''}. You must NOT proceed with this flow — no task work, no completions, no further calls on it.\nReason: ${fs.stop_reason || '(none given)'}\nAcknowledge this to the user and wait. The flow resumes exactly where it stood once they clear the stop (resume_flow).`
        }
      }

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
      // TDE-811: "every known step is done" is NOT the same as "the flow is finished". A flow
      // whose step list is still open discovers its next step as it goes, so this condition is
      // true at every pause — declaring COMPLETE there is a false terminal verdict, and the
      // early return below made an agent stop working on it.
      const stepListOpen = flowRecord?.step_list_open === true
      const allKnownDone = completedCount === sorted.length
      const allDone = allKnownDone && !stepListOpen

      const lines: string[] = []
      lines.push(flowRecord ? `Flow: "${flowRecord.name}"${flowRecord.short_id ? `  [${flowRecord.short_id}]` : ''}` : `Flow (unnamed — call name_flow to register it)`)
      if (flowRecord?.context) lines.push(`Context: ${flowRecord.context}`)
      lines.push(`Progress: ${completedCount}/${sorted.length} steps ${stepListOpen ? 'done — step list still OPEN, more steps expected' : 'complete'}`)
      if (allKnownDone && stepListOpen) {
        lines.push(`\nStatus: ALL KNOWN STEPS DONE — but this flow's step list is still open, so it is NOT finished. Decide the next step and create it (or close the list with update_flow_context(step_list_open: false) if the operation is actually over).`)
        lines.push(`\nSteps so far:`)
        sorted.forEach((t: any, i: number) => {
          lines.push(`  ${statusIcon(t.status)}  ${stepLabel(t, i)} — ${t.text}`)
        })
        return lines.join('\n')
      }
      if (allDone) {
        lines.push(`\nStatus: COMPLETE — all ${sorted.length} steps done.`)
        lines.push(`\nSteps:`)
        sorted.forEach((t: any, i: number) => {
          lines.push(`  ${statusIcon(t.status)}  ${stepLabel(t, i)} — ${t.text}`)
        })
        return lines.join('\n')
      }
      lines.push('')

      const executorIcon = (ex: string) => ex === 'user' ? '👤' : ex === 'external' ? '🔗' : '🤖'
      const executorLabel = (ex: string) => ex === 'user' ? 'USER' : ex === 'external' ? 'EXTERNAL' : 'AGENT'
      const hasHumanSteps = sorted.some((t: any) => t.executor === 'user' || t.executor === 'external')

      // Per-step details
      lines.push('── STEPS ──────────────────────────────────────────')
      sorted.forEach((t: any, i: number) => {
        const isDone = t.status === 'done'
        const isCurrent = i === pendingFrom
        const marker = isDone ? '✓ DONE' : isCurrent ? '▶ NEXT' : '○ WAITING'
        const ex = t.executor || 'agent'
        lines.push(``)
        lines.push(`${stepLabel(t, i)}  [${marker}]  ${executorIcon(ex)} ${executorLabel(ex)}  — ${t.text}`)

        // Human guidance (user/external steps only)
        if ((ex === 'user' || ex === 'external') && t.human_guidance) {
          lines.push(`  Guide: ${t.human_guidance}`)
        }

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

      const currentTask = sorted[pendingFrom]
      const currentExecutor = currentTask?.executor || 'agent'

      lines.push('')
      lines.push('── EXECUTION PROTOCOL ─────────────────────────────')
      lines.push(`Resume at ${stepLabel(currentTask, pendingFrom)}: "${currentTask.text}"`)
      if (hasHumanSteps) {
        lines.push(`Mode: HYBRID — this flow mixes agent steps (🤖) and human steps (👤 USER / 🔗 EXTERNAL).`)
      }
      lines.push('')

      if (currentExecutor === 'user' || currentExecutor === 'external') {
        lines.push(`Current step is a ${executorLabel(currentExecutor)} step — switch to guide mode:`)
        lines.push('  1. Call guide_flow(flow_id) to get the full coaching context for this step.')
        lines.push('  2. Present the human_guidance to the user, explain the step, answer questions, troubleshoot snags.')
        lines.push('  3. When the user reports done, verify their evidence (URL, screenshot, confirmation).')
        lines.push('  4. Call advance_guide(flow_id, evidence) to record the evidence and advance the cursor.')
        lines.push('  5. If the next step is an AGENT step, self-sequence it as below; if it\'s another human step, loop guide_flow.')
      } else {
        lines.push('For each AGENT step:')
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
        if (hasHumanSteps) {
          lines.push('  7. When you reach a USER or EXTERNAL step → switch to guide mode (call guide_flow).')
        } else {
          lines.push('  7. Repeat until all steps are done.')
        }
      }
      lines.push('')
      lines.push('Rules:')
      lines.push('  • Do NOT skip a gate — every step with a gate contract MUST be validated before the next step runs.')
      lines.push('  • The validator subagent starts from a FAIL prior — it needs concrete evidence in the artifact to flip to pass.')
      lines.push('  • If a task has no output contract, complete it and move on (no validation needed).')
      if (hasHumanSteps) {
        lines.push('  • Guide mode: agent role is COACH + VERIFIER only. Do not execute human/external steps yourself.')
        lines.push('  • Evidence is required to advance a guide step — do not call advance_guide without it.')
      }

      return lines.join('\n')
    }

    case 'guide_flow':
    case 'advance_guide': {
      // Shared flow resolution for both guide tools
      let guideFlowRecord: any = null
      let guideTasks: any[] = []

      const resolveGuideFlow = async () => {
        if (args.flow_id) {
          const looksLikeUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(args.flow_id)
          if (looksLikeUuid) {
            const { data } = await sb.from('flows').select('id, name, short_id, context, guide_cursor, step_list_open').eq('id', args.flow_id).eq('user_id', userId).maybeSingle()
            guideFlowRecord = data
          } else {
            const { data } = await sb.from('flows').select('id, name, short_id, context, guide_cursor, step_list_open').eq('user_id', userId).ilike('name', `%${args.flow_id}%`).order('created_at', { ascending: false }).limit(1).maybeSingle()
            guideFlowRecord = data
          }
        } else if (args.task_id) {
          const anchor = await resolveTask(sb, userId, args.task_id)
          if (anchor?.flow_id) {
            const { data } = await sb.from('flows').select('id, name, short_id, context, guide_cursor, step_list_open').eq('id', anchor.flow_id).eq('user_id', userId).maybeSingle()
            guideFlowRecord = data
          }
        }
        if (!guideFlowRecord) return false
        const { data: tasks } = await sb.from('tasks')
          .select('id, text, status, short_id, flow_step, input, output, executor, human_guidance, sort_order, project_id, project:projects(name, prefix)')
          .eq('flow_id', guideFlowRecord.id).eq('user_id', userId)
        guideTasks = tasks || []
        return true
      }

      const found = await resolveGuideFlow()
      if (!found || !guideFlowRecord) return 'Flow not found. Pass flow_id or task_id.'
      if (!guideTasks.length) return 'No tasks found in this flow.'

      // TDE-384: honor a human-set stop before guiding/advancing.
      {
        const { data: fs } = await sb.from('flows').select('stop_requested, stop_reason, stopped_at').eq('id', guideFlowRecord.id).maybeSingle()
        if (fs?.stop_requested) {
          return `⛔ FLOW STOPPED by the human${fs.stopped_at ? ` (at ${fs.stopped_at})` : ''}. Do not advance this flow.\nReason: ${fs.stop_reason || '(none given)'}\nAcknowledge to the user; it resumes where it stood once they clear the stop (resume_flow).`
        }
      }

      // Sort by flow_step
      const guideSorted = [...guideTasks].sort((a: any, b: any) => (a.flow_step ?? 999) - (b.flow_step ?? 999))
      const guidePrefix = guideSorted[0]?.project?.prefix || ''
      const guideRef = (t: any) => guidePrefix && t.short_id != null ? `${guidePrefix}-${t.short_id}` : `#${t.short_id ?? t.id.slice(0, 8)}`
      const guideStepLabel = (t: any) => `Step ${t.flow_step ?? '?'} · ${guideRef(t)}`

      if (name === 'guide_flow') {
        // Find current pending human step (use guide_cursor hint or first non-done user/external)
        const cursor = guideFlowRecord.guide_cursor
        let currentStep: any = null
        if (cursor != null) {
          currentStep = guideSorted.find((t: any) => t.flow_step === cursor && t.status !== 'done')
        }
        if (!currentStep) {
          currentStep = guideSorted.find((t: any) =>
            t.status !== 'done' && (t.executor === 'user' || t.executor === 'external'))
        }
        if (!currentStep) {
          const allDoneOrAgent = guideSorted.every((t: any) => t.status === 'done' || t.executor === 'agent')
          if (allDoneOrAgent) return `No pending human/external steps in "${guideFlowRecord.name}". Switch to agent mode (run_flow) for any remaining agent steps.`
          return `No pending human steps found in "${guideFlowRecord.name}".`
        }

        // Update guide cursor
        await sb.from('flows').update({ guide_cursor: currentStep.flow_step }).eq('id', guideFlowRecord.id)

        const ex = currentStep.executor || 'user'
        const exLabel = ex === 'external' ? 'EXTERNAL' : 'USER'
        const lines: string[] = []
        lines.push(`Guide Mode — "${guideFlowRecord.name}"`)
        lines.push(`Cursor: ${guideStepLabel(currentStep)} [${exLabel}] — ${currentStep.text}`)
        // TDE-811: name the denominator honestly when the step list is still open.
        lines.push(`Progress: ${guideSorted.filter((t: any) => t.status === 'done').length}/${guideSorted.length} steps done${guideFlowRecord.step_list_open === true ? ' — step list OPEN, more steps expected' : ''}`)
        lines.push('')
        lines.push('── CURRENT STEP ────────────────────────────────────')
        if (currentStep.human_guidance) {
          lines.push(`What to do:`)
          lines.push(`  ${currentStep.human_guidance}`)
        } else {
          lines.push(`Task: ${currentStep.text}`)
          lines.push(`  (No human_guidance set — use the task title and context to coach the user.)`)
        }
        const stepEdges = inputEdges(currentStep.input)
        if (stepEdges.length) {
          lines.push('')
          lines.push('Depends on outputs from:')
          stepEdges.forEach((e: any) => {
            const src = guideSorted.find((t: any) => t.id === e.source_task_id)
            if (src) lines.push(`  • ${guideStepLabel(src)}: ${src.text}`)
          })
        }
        const stepOut = outputContract(currentStep.output)
        if (stepOut.rules.length) {
          lines.push('')
          lines.push('Evidence required (output contract):')
          stepOut.rules.forEach((r: any) => lines.push(`  • ${r.label}: ${r.rule}`))
        }
        lines.push('')
        lines.push('── AGENT ROLE ──────────────────────────────────────')
        lines.push('You are COACH + VERIFIER — do NOT execute this step yourself.')
        lines.push('1. Present the "What to do" instructions to the user clearly.')
        lines.push('2. Explain the why behind the step if asked.')
        lines.push('3. Help troubleshoot if they hit a snag (DNS, auth issues, confusing UIs, etc.).')
        lines.push('4. When the user says they\'re done, ask for evidence (URL, confirmation message, screenshot description).')
        lines.push('5. Verify the evidence is genuine and specific enough.')
        lines.push('6. Once satisfied, call advance_guide(flow_id, evidence) to record and advance.')
        return lines.join('\n')
      }

      // advance_guide
      if (!args.evidence || !String(args.evidence).trim()) {
        return 'Evidence is required to advance a guide step. Ask the user for a URL, confirmation, or description of what they did and observed.'
      }

      const cursor2 = guideFlowRecord.guide_cursor
      let stepToAdvance: any = cursor2 != null
        ? guideSorted.find((t: any) => t.flow_step === cursor2 && t.status !== 'done')
        : guideSorted.find((t: any) => t.status !== 'done' && (t.executor === 'user' || t.executor === 'external'))

      if (!stepToAdvance) return 'No pending guide step to advance. All human steps may already be done.'

      // Store evidence as artifact
      const existingOut = (stepToAdvance.output && typeof stepToAdvance.output === 'object') ? stepToAdvance.output : {}
      const updatedOut = {
        ...existingOut,
        artifact: args.evidence,
        artifact_format: 'text',
        artifact_stored_at: new Date().toISOString(),
      }
      const advancedAt = new Date().toISOString()
      await sb.from('tasks').update({ output: updatedOut, status: 'done', completed_at: advancedAt }).eq('id', stepToAdvance.id)
      // TDE-819: a guide step completed by a HUMAN is exactly the kind of provenance the history
      // exists for — it records that a person, not an agent, cleared this step and on what evidence.
      await recordLifecycleChange(sb, userId, {
        taskId: stepToAdvance.id, via: 'advance_guide', actor: tokenActor,
        summary: `Guide step completed by ${stepToAdvance.executor || 'user'} — status ${stepToAdvance.status ?? '?'} → done, evidence stored`,
        before: { status: stepToAdvance.status ?? null },
        after: { status: 'done', completed_at: advancedAt },
        extra: { executor: stepToAdvance.executor ?? null, flow_step: stepToAdvance.flow_step ?? null, evidence_chars: String(args.evidence ?? '').length },
      })

      // Find next pending human step
      const nextHumanStep = guideSorted.find((t: any) =>
        t.id !== stepToAdvance.id && t.status !== 'done' &&
        (t.executor === 'user' || t.executor === 'external') &&
        (t.flow_step ?? 0) > (stepToAdvance.flow_step ?? 0))

      // Find next pending agent step
      const nextAgentStep = guideSorted.find((t: any) =>
        t.id !== stepToAdvance.id && t.status !== 'done' && t.executor === 'agent' &&
        (t.flow_step ?? 0) > (stepToAdvance.flow_step ?? 0))

      const nextCursor = nextHumanStep?.flow_step ?? null
      await sb.from('flows').update({ guide_cursor: nextCursor }).eq('id', guideFlowRecord.id)

      const advLines: string[] = []
      advLines.push(`✓ Advanced: ${guideStepLabel(stepToAdvance)} "${stepToAdvance.text}" — marked done.`)
      advLines.push(`Evidence recorded: ${String(args.evidence).slice(0, 120)}`)
      advLines.push('')
      if (nextHumanStep) {
        advLines.push(`Next human step: ${guideStepLabel(nextHumanStep)} [${nextHumanStep.executor?.toUpperCase() || 'USER'}] — ${nextHumanStep.text}`)
        advLines.push('Call guide_flow to get coaching context for this step.')
      } else if (nextAgentStep) {
        advLines.push(`Next step is an AGENT step: ${guideStepLabel(nextAgentStep)} — ${nextAgentStep.text}`)
        advLines.push('Switch back to agent mode: call run_flow to get the execution playbook.')
      } else {
        const remaining = guideSorted.filter((t: any) => t.status !== 'done' && t.id !== stepToAdvance.id)
        if (remaining.length === 0) {
          // TDE-811: an open step list means this is a pause, not the end. Saying "complete"
          // here is the false terminal verdict — for discovery-shaped work it fires every time.
          if (guideFlowRecord.step_list_open === true) {
            advLines.push('All KNOWN steps are done — but this flow\'s step list is still open, so it is not finished. Decide the next step and create it, or close the list with update_flow_context(step_list_open: false) if the operation is genuinely over.')
          } else {
            advLines.push('Flow complete — all steps done.')
          }
        } else {
          advLines.push(`Remaining steps: ${remaining.map((t: any) => `${guideStepLabel(t)} (${t.executor || 'agent'})`).join(', ')}`)
        }
      }
      return advLines.join('\n')
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

      // Resolving a FLOW seed: surface its pre-brief + unified checklist as grounding, and
      // soft-gate on unmet prerequisites (TDE-300). Soft — build_new_flow only returns a
      // playbook; the agent confirms with the user before building.
      let seedBlock: any = null
      if (args.seed_id) {
        const seed = await resolveTask(sb, userId, args.seed_id)
        if (seed && seed.kind === 'seed' && seed.seed_target === 'flow') {
          const { data: sd } = await sb.from('task_discussions').select('steps, checked_steps').eq('task_id', seed.id).maybeSingle()
          const sSteps: any[] = Array.isArray(sd?.steps) ? sd.steps : []
          const sChecked: boolean[] = Array.isArray(sd?.checked_steps) ? sd.checked_steps : []
          const checklist = sSteps.map((s: any, i: number) => ({
            summary: typeof s === 'string' ? s : s.summary,
            kind: typeof s === 'string' ? null : (s.kind ?? null),
            checked: !!sChecked[i],
          }))
          const unmet = checklist.filter(x => x.kind === 'prerequisite' && !x.checked).map(x => x.summary)
          seedBlock = {
            seed_id: project.prefix && seed.short_id != null ? `${project.prefix}-${seed.short_id}` : seed.id,
            pre_brief: seed.detail || null,
            checklist,
            unresolved_prerequisites: unmet,
            gate: unmet.length
              ? `SOFT GATE: ${unmet.length} prerequisite(s) for this seed are still open — surface them to the user and confirm they want to build now before running the interview.`
              : null,
            on_finish: 'After name_flow, mark this seed done (update_task status:done) — building the flow resolves it.',
          }
        }
      }

      return JSON.stringify({
        status: 'run_flow_interview',
        mode: 'create',
        goal: args.goal || null,
        seed: seedBlock,
        instruction: 'You are building a NEW flow with the user. Run the interview below YOURSELF using your interactive question tool (AskUserQuestion / ask_question). A flow is a single operation too big for one sitting, cut into steps so it holds together across its length; contracts at the joins are OPTIONAL and belong only at seams (a handoff the receiving step will not re-derive). A flow with no contracts anywhere is still a flow — do NOT interview for handoffs and gates as if they were prerequisites. Sections/groups are just filing and do not define the flow. Do NOT create or wire any tasks until the user confirms the whole proposed flow at the end.',
        grill_me_rules: [
          'Ask ONE question at a time; each answer determines the next question.',
          'Every question carries a recommended option, prefixed "(Recommended)", based on best practice + what you can already see.',
          'Project-first (codebase-first): never ask what you can determine from the repo or the project_context below.',
          'Offer multiple-choice options with a custom write-in allowed; keep it conversational.',
        ],
        playbook: [
          '1. GROUND THE START: use project_context below and read the repo if relevant, then ask the user what they already have / where they are starting from. Do not ask about things you can already see.',
          '2. PIN THE GOAL' + (args.goal ? ` (stated: "${args.goal}")` : '') + ': confirm the end goal and treat it as the FINAL task\'s output contract.',
          '3. FORWARD-DECOMPOSE one step at a time toward the goal, recommending a path each time, building the ordered chain of tasks. GRANULARITY — promote a boundary to its own step ONLY when it must do one of four things a milestone cannot: hand an artifact over, change executor, permit a gate, or permit a clean cold stop. Everything else is a MILESTONE inside a step, however substantial the work is. Size calibrates, it never locates. Aim for FEW steps: a 40-step flow rebuilds the context wall the flow exists to prevent. FOR EACH STEP, ask: who executes this — agent (AI does it), user (human does it, AI coaches), or external (third party like a web admin or client)? A single flow can be hybrid, and executor is a per-step attribute, never a kind of flow. For user/external steps, ask for human_guidance: what the person must do, where, and how to verify it worked.',
          '4. FIND THE SEAMS, THEN GATE ONLY THOSE. Most joins need no contract at all — first ask, for each join, whether the receiving step would NOTICE if the input were wrong. If it re-derives the material anyway, the error dies there: that is a handoff, not a seam, and it gets NO gate. Prefer DISSOLVING a seam over gating it (make the receiver re-derive, or put the context in durable state so it is read rather than passed). Where a real seam remains, order by BLAST RADIUS — early seams in long flows and irreversible actions first. AUTHOR INPUTS FIRST, THEN DERIVE OUTPUTS (TDE-287): the bar states what the RECEIVER needs in order to build on the input safely, not what the producer intends to make, so pin the consumer\'s input contract first as structured, CONTEXT-FREE rules — the shape of acceptable output, never this run\'s subject — and DERIVE the producer\'s def-of-done from it (derive_output_contract once edges are wired). RULE QUALITY: every criterion you make checkable is one the human never has to look at again, so push hard toward kind=check with concrete params (word count, test command, file existence). For kind=judgment, require an objective criterion ("each sentence under 25 words" not "readable") and a stated way to verify it. Actively push back on vague rules like "good quality", "clear", "comprehensive" — ask the user what SPECIFICALLY makes it pass.',
          '5. SURFACE ASSUMPTIONS, DON\'T INTERROGATE (TDE-287): present the WHOLE proposed flow (tasks + edges + derived contracts) AND the explicit list of assumptions/uncertainties you made deriving them (vague inherited rules, multi-consumer merges, handoffs with no criteria to derive from). Ask the human to confirm or correct — ONE pass. Assumption-surfacing on a concrete draft beats a cold questionnaire.',
          '6. ON CONFIRM, PERSIST then BLESS (see persistence). The name_flow gate applies ONLY to handoffs you actually declare: every DECLARED input edge needs a non-trivial, human-blessed contract on both sides, so confirm_contract is required for each edge you wire. A flow with no declared edges has nothing to gate and finalizes cleanly — that is intended, not a loophole. Declare an edge when you want the seam gated; do not wire edges you have no intention of gating.',
        ],
        persistence: {
          when: 'ONLY after the user confirms the whole flow.',
          steps: [
            'create_task for each step (pass section_id from project_context if it belongs in an existing section). For user/external steps, pass executor:"user"/"external" and human_guidance with the human-facing action directive.',
            'set_task_input(task_id, source_task_id, contract) on each consuming task whose join is a real SEAM — call once per upstream source (fan-in supported). The input contract is the consumer\'s acceptance criteria. Author these FIRST — they are the base of the producer\'s contract. Skip this entirely for joins that are not seams; an ungated flow is a valid flow.',
            'derive_output_contract(task_id, apply:true) on each producing task to derive its def-of-done from its consumers\' input criteria (or set_task_output directly if you must). Surface the returned assumptions to the human.',
            'confirm_contract(task_id, contract_type) on each side the human has blessed — REQUIRED: name_flow blocks on unblessed contracts (TDE-287 gate).',
            'name_flow(project_id, name, task_ids, context?) — names + finalizes the flow. If the gate blocks, fix the listed violations and retry; bypass:true only on explicit human command.',
            'Finally call get_flow_order to show the user the ordered flow you built.',
          ],
        },
        project_context: { sections: sectionList, tasks: taskList },
      })
    }
    case 'add_task_link': {
      const task = await resolveTask(sb, userId, args.task_id)
      if (!task) return `Task "${args.task_id}" not found.`
      const prev = (task.output && typeof task.output === 'object') ? task.output : {}
      const links = Array.isArray(prev.links) ? prev.links : []
      links.push({ url: args.url, title: args.title || args.url, added_at: new Date().toISOString() })
      const { error } = await sb.from('tasks').update({ output: { ...prev, links } }).eq('id', task.id)
      if (error) throw new Error(error.message)
      return `Attached link to task "${task.text}": ${args.url}`
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
      const prevContract = prev.contract || {}
      const output = {
        ...prev,
        contract: { rules, confirmed: false },
        validation_status: prev.validation_status || 'pending',
      }

      const { error } = await sb.from('tasks').update({ output }).eq('id', task.id)
      if (error) throw new Error(error.message)

      // TDE-818: this overwrite silently resets confirmed:false. If a human HAD blessed the
      // prior contract, that fact is destroyed on the row — so record it here or it is gone.
      const erasedConfirmation = prevContract.confirmed === true
      await recordTaskEvent(sb, userId, {
        taskId: task.id, kind: 'contract_set', entity: 'output_contract', actor: tokenActor,
        summary: `Output contract replaced: ${prevContract.rules?.length ?? 0} → ${rules.length} rule(s)`
          + (erasedConfirmation ? ` — ERASED a human confirmation by ${prevContract.confirmed_by || 'human'}` : ''),
        before: contractSnapshot(prevContract),
        after: contractSnapshot({ rules, confirmed: false }),
        meta: {
          erased_confirmation: erasedConfirmation,
          ...(erasedConfirmation ? { prior_confirmed_by: prevContract.confirmed_by ?? null, prior_confirmed_at: prevContract.confirmed_at ?? null } : {}),
        },
      })

      const lintWarnings = rules.map((r: any) => { const w = lintRule(r); return w ? `  "${r.label}": ${w}` : null }).filter(Boolean)
      return `Set output contract on ${args.task_id}: ${rules.length} rule${rules.length !== 1 ? 's' : ''} (definition-of-done). Contract is AI-QA'd (QA is performed by AI, not a meat sack) until a human confirms it via confirm_contract. Consumers are derived from tasks that list this as a source.`
        + (erasedConfirmation ? `\n\n⚠ This replaced a HUMAN-CONFIRMED contract — the blessing is now void (confirmed reset to false). The prior contract and its confirmation are preserved in the task's gate history (get_task_history).` : '')
        + (lintWarnings.length ? `\n\n⚠ Rule quality warnings (${lintWarnings.length}):\n${lintWarnings.join('\n')}\nPrefer kind=check with concrete params. For kind=judgment, specify an objective criterion + a stated way to verify it.` : '')
    }

    case 'derive_output_contract': {
      const task = await resolveTask(sb, userId, args.task_id)
      if (!task) return `Task "${args.task_id}" not found.`
      // Every task that lists this producer as an input source is a consumer whose
      // input criteria govern this producer's output def-of-done.
      const { data: candidates } = await sb.from('tasks')
        .select('id, text, short_id, input')
        .eq('user_id', userId)
      const consumers = (candidates || []).filter((c: any) =>
        inputEdges(c.input).some((e: any) => e.source_task_id === task.id))
      const derived = deriveOutputFromConsumers(task.id, consumers)

      let applied = false
      if (args.apply && derived.rules.length) {
        const rules = derived.rules.map(normalizeRule)
        const prev = (task.output && typeof task.output === 'object') ? task.output : {}
        const prevContract = prev.contract || {}
        const { error } = await sb.from('tasks').update({
          output: { ...prev, contract: { rules, confirmed: false }, validation_status: prev.validation_status || 'pending' },
        }).eq('id', task.id)
        if (error) throw new Error(error.message)
        applied = true
        // TDE-818: same overwrite hazard as set_task_output — record before the prior blessing is gone.
        const erasedConfirmation = prevContract.confirmed === true
        await recordTaskEvent(sb, userId, {
          taskId: task.id, kind: 'contract_set', entity: 'output_contract', actor: tokenActor,
          summary: `Output contract derived from ${derived.sources.length} consumer(s): ${prevContract.rules?.length ?? 0} → ${rules.length} rule(s)`
            + (erasedConfirmation ? ` — ERASED a human confirmation by ${prevContract.confirmed_by || 'human'}` : ''),
          before: contractSnapshot(prevContract),
          after: contractSnapshot({ rules, confirmed: false }),
          meta: {
            via: 'derive_output_contract',
            erased_confirmation: erasedConfirmation,
            ...(erasedConfirmation ? { prior_confirmed_by: prevContract.confirmed_by ?? null, prior_confirmed_at: prevContract.confirmed_at ?? null } : {}),
          },
        })
      }

      return JSON.stringify({
        status: 'derived',
        producer: { id: task.short_id != null ? `#${task.short_id}` : task.id.slice(0, 8), text: task.text },
        derived_from: derived.sources.map((s: any) => s.text),
        rule_count: derived.rules.length,
        rules: derived.rules,
        assumptions: derived.assumptions,
        applied,
        next: applied
          ? 'Draft persisted as the output contract (AI-QA\'d). SURFACE the assumptions to the human, let them edit the rules, then confirm_contract to bless it — the name_flow gate blocks until it is blessed.'
          : 'Review the draft + assumptions WITH the human, then persist via set_task_output (or re-call with apply:true) and confirm_contract.',
      })
    }

    case 'pull_intake_job': {
      const { data: job } = await sb.from('intake_jobs')
        .select('id, source, payload, instructions')
        .eq('user_id', userId).eq('status', 'pending')
        .order('created_at', { ascending: true }).limit(1).maybeSingle()
      if (!job) return JSON.stringify({ empty: true, message: 'No pending intake jobs.' })
      await sb.from('intake_jobs').update({ status: 'processing', updated_at: new Date().toISOString() }).eq('id', job.id)
      return JSON.stringify({
        job_id: job.id,
        source: job.source,
        payload: job.payload,
        instructions: job.instructions || null,
        next: 'Structure this into proposed task(s), then call submit_intake_result(job_id, analysis, tasks). The human reviews + imports them in the web app — do NOT create the tasks yourself.',
      })
    }

    case 'submit_intake_result': {
      if (!args.job_id) return 'job_id is required.'
      const { data: job } = await sb.from('intake_jobs').select('id').eq('id', args.job_id).eq('user_id', userId).maybeSingle()
      if (!job) return `Intake job "${args.job_id}" not found.`
      const tasks = Array.isArray(args.tasks) ? args.tasks : []
      const result = args.error ? null : { analysis: args.analysis || '', tasks }
      await sb.from('intake_jobs').update({
        status: args.error ? 'error' : 'ready',   // 'ready' = parked in the Conductor, awaiting human placement
        result,
        error: args.error || null,
        updated_at: new Date().toISOString(),
      }).eq('id', job.id)
      return args.error
        ? `Marked intake job ${String(args.job_id).slice(0, 8)} as error.`
        : `Submitted ${tasks.length} proposed task${tasks.length !== 1 ? 's' : ''} for job ${String(args.job_id).slice(0, 8)} — now parked in the web app Conductor for the human to review + import.`
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
        // TDE-818: "frozen" means frozen-until-force. When force overwrites a prior bar, the
        // bar the work was actually judged against would otherwise vanish — keep it.
        const overwroteFrozenBar = !!existing?.rules?.length
        await recordTaskEvent(sb, userId, {
          taskId: task.id, kind: 'review_bar_frozen', entity: 'review', actor: tokenActor,
          summary: `Review bar frozen with ${rules.length} rule(s)`
            + (overwroteFrozenBar ? ` — OVERWROTE a prior frozen bar of ${existing.rules.length} rule(s) (force)` : ''),
          before: overwroteFrozenBar ? { rule_count: existing.rules.length, rules: existing.rules, frozen_at: existing.frozen_at ?? null } : null,
          after: { rule_count: rules.length, rules, frozen_at: review_bar.frozen_at },
          meta: { overwrote_frozen_bar: overwroteFrozenBar, forced: args.force === true },
        })
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
        `4. GUIDED REVIEW (TDE-382): when anything fails, ALSO pass narrative:{core, sections:[{point,consequence}], secondary} — core = the ONE thing the human must judge; sections consequence-ordered (what's wrong → what it causes); secondary = minor notes. This restructures the verdict so the human's gate is ~30s of judgment, not hunting. Presentation only — it does not change pass/fail.`,
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
      const narrative = (args.narrative && typeof args.narrative === 'object') ? args.narrative : null   // TDE-382 guided review
      const escalate = overall === 'fail' && attempt >= 3
      const review_verdict = { overall, results, critique, narrative, validated_at: new Date().toISOString(), attempt, escalated: escalate, validator: args.validator || 'self' }
      const update: any = { review_verdict }
      if (overall === 'fail') update.status = 'in_progress'   // reopen the producer
      const { error } = await sb.from('tasks').update(update).eq('id', task.id)
      if (error) throw new Error(error.message)
      // TDE-818: tasks.review_verdict is ONE SLOT — attempt 2 overwrote attempt 1's critique,
      // leaving only a counter. One immutable row PER ATTEMPT is what makes the retry
      // history actually retrievable.
      await recordTaskEvent(sb, userId, {
        taskId: task.id, kind: 'review_submitted', entity: 'review', actor: tokenActor,
        summary: `Review ${overall.toUpperCase()} (attempt ${attempt}) by ${args.validator || 'self'} — ${results.length} rule(s) graded, ${fails.length} fail(s)`
          + (escalate ? ' — ESCALATED to human' : ''),
        before: task.review_verdict ? { overall: task.review_verdict.overall ?? null, attempt: task.review_verdict.attempt ?? 0 } : null,
        after: review_verdict,
        meta: { attempt, overall, escalated: escalate, validator: args.validator || 'self', fail_count: fails.length, blocker_fail: blockerFail },
      })
      // TDE-377: outbound review.submitted event (fire-and-forget) — the "task entered/cleared the gate" trigger.
      fireAndForget(emitWebhook(sb, userId, {
        projectId: (task as any).project_id ?? null,
        event: 'review.submitted', action: 'create', type: 'Review', actor: tokenActor,
        data: { task_id: task.id, short_id: (task as any).short_id, text: task.text, project_id: (task as any).project_id, verdict: overall, attempt, escalated: escalate, rules_graded: results.length },
      }))
      if (overall === 'pass') return `✓ REVIEW PASSED — "${task.text}". ${results.length} rule(s) graded, all blockers satisfied. (action=pass)`
      if (escalate) return `⛔ REVIEW FAILED (attempt ${attempt}/3) — retry limit reached. ESCALATE TO HUMAN (action=ask_human).\nCritique:\n${critique}`
      return `↩ REVIEW FAILED (attempt ${attempt}/3) — task reopened (action=regenerate). Apply this critique and re-run:\n${critique}`
    }

    case 'disable_task_review': {
      const task = await resolveTask(sb, userId, args.task_id)
      if (!task) return `Task "${args.task_id}" not found.`
      if (!task.review_enabled && !task.review_bar?.rules?.length && !task.review_verdict) {
        return `Review is not enabled on "${task.text}" — nothing to disable.`
      }
      const wasEscalated = !!task.review_verdict?.escalated
      // Not a silent wipe: leave a superseding "cleared" record so the audit shows a clear happened + why (TDE-374 immutability spirit).
      const cleared_verdict = { cleared: true, reason: args.reason || null, cleared_at: new Date().toISOString(), prior_overall: task.review_verdict?.overall ?? null }
      const { error } = await sb.from('tasks')
        .update({ review_enabled: false, review_bar: null, review_verdict: cleared_verdict })
        .eq('id', task.id)
      if (error) throw new Error(error.message)
      // TDE-818: this handler was already written in the right spirit (it leaves a superseding
      // tombstone rather than nulling) but the tombstone still destroyed the verdict it
      // tombstoned, keeping only prior_overall. Preserve the full bar + verdict here.
      await recordTaskEvent(sb, userId, {
        taskId: task.id, kind: 'review_bar_cleared', entity: 'review', actor: tokenActor,
        summary: `Review disabled — bar (${task.review_bar?.rules?.length ?? 0} rule(s)) and verdict removed`
          + (args.reason ? ` (reason: ${args.reason})` : '')
          + (wasEscalated ? ' — cleared an ESCALATED verdict' : ''),
        before: { bar: task.review_bar ?? null, verdict: task.review_verdict ?? null },
        after: cleared_verdict,
        meta: { reason: args.reason || null, was_escalated: wasEscalated, prior_overall: task.review_verdict?.overall ?? null },
      })
      const note = wasEscalated ? ' Escalation cleared — the "NEEDS REVIEW" card will drop.' : ''
      return `Disabled review on "${task.text}". Frozen bar removed; verdict replaced with a cleared record${args.reason ? ` (reason: ${args.reason})` : ''}.${note}`
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
      // TDE-818: preserve the bar that was cleared, and whether it had been blessed.
      await recordTaskEvent(sb, userId, {
        taskId: task.id, kind: 'contract_cleared', entity: 'output_contract', actor: tokenActor,
        summary: `Output contract cleared (${prev.contract.rules.length} rule(s) removed)`
          + (prev.contract.confirmed === true ? ` — was human-confirmed by ${prev.contract.confirmed_by || 'human'}` : ''),
        before: contractSnapshot(prev.contract),
        after: contractSnapshot({ rules: [], confirmed: false }),
        meta: { erased_confirmation: prev.contract.confirmed === true },
      })
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
      let driveNote = ''
      if (args.upload_to_drive && args.drive_filename) {
        const gToken = await loadGoogleAccessToken(sb, userId)
        if (gToken) {
          const { data: ds } = await sb.from('user_settings').select('google_drive_folder_id').eq('user_id', userId).maybeSingle()
          const folderId = ds?.google_drive_folder_id
          if (folderId) {
            try {
              // Same convert-on-import split as drive_upload_file: metadata.mimeType = google-apps
              // target type triggers conversion; content Content-Type = source format to convert FROM.
              const driveTarget = args.drive_target_type || 'file'
              const NATIVE = {
                doc:   { metaMime: 'application/vnd.google-apps.document',    defaultSource: 'text/html' },
                sheet: { metaMime: 'application/vnd.google-apps.spreadsheet', defaultSource: 'text/csv'  },
              }
              const nativeArt = NATIVE[driveTarget as 'doc' | 'sheet']
              const contentMime = nativeArt?.defaultSource || (args.format === 'markdown' ? 'text/markdown' : 'text/plain')
              const boundary = 'tasker_artifact_boundary'
              const metaObj: Record<string, any> = { name: args.drive_filename, parents: [folderId] }
              if (nativeArt) metaObj.mimeType = nativeArt.metaMime
              const meta = JSON.stringify(metaObj)
              const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: ${contentMime}\r\n\r\n${args.content}\r\n--${boundary}--`
              const uploadRes = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
                method: 'POST',
                headers: { Authorization: `Bearer ${gToken}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
                body,
              })
              const uploaded = await uploadRes.json()
              if (uploadRes.ok) {
                const kind = nativeArt ? (driveTarget === 'doc' ? 'Google Doc' : 'Google Sheet') : 'file'
                driveNote = ` Also created ${kind} in Google Drive as "${args.drive_filename}" (id: ${uploaded.id}).`
                // Record Drive file ID on the task
                const driveFiles = Array.isArray(prev.drive_files) ? prev.drive_files : []
                driveFiles.push({ file_id: uploaded.id, filename: args.drive_filename, mime_type: uploaded.mimeType ?? null, uploaded_at: new Date().toISOString() })
                await sb.from('tasks').update({ output: { ...prev, artifact: args.content, artifact_format: args.format || 'text', artifact_stored_at: new Date().toISOString(), drive_files: driveFiles } }).eq('id', task.id)
              } else {
                driveNote = ` (Drive upload failed: ${uploaded.error?.message ?? 'unknown'})`
              }
            } catch (err: any) {
              driveNote = ` (Drive upload failed: ${err.message})`
            }
          } else {
            driveNote = ' (skipped Drive upload — Google Drive not connected or no Tasker folder found)'
          }
        } else {
          driveNote = ' (skipped Drive upload — Google Drive not connected)'
        }
      }
      return `Artifact stored on "${task.text}" (${wordCount} words, format: ${args.format || 'text'}).${repoNote}${driveNote} Call complete_task when ready — if the task has judgment output rules, validate_output will now embed this artifact directly in the validator prompt.`
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

      // TDE-818: validation_ledgers is keyed per EDGE, not per ATTEMPT — so attempt N replaced
      // attempt N-1 and retry_count could report 3 failures with all 3 bodies gone. This is the
      // row that gives the retry counter retrievable content behind it.
      await recordTaskEvent(sb, userId, {
        taskId: producer.id, kind: 'validation_submitted', entity: 'validation', actor: tokenActor,
        summary: `Gate ${String(validationStatus).toUpperCase()} on edge ${edgeKey} (attempt ${valid ? 1 : newRetryCount}) by ${validator || 'unverified'}`
          + ` — ${ledger.filter((l: any) => l.status === 'fail').length} fail(s) of ${ledger.length} rule(s)`
          + (action === 'ask_human' ? ' — RETRY LIMIT reached, escalated to human' : ''),
        before: Object.keys(prevEdgeLedger).length
          ? { validation_status: prevEdgeLedger.validation_status ?? null, validated_at: prevEdgeLedger.validated_at ?? null, retry_count: prevEdgeLedger.retry_count ?? 0 }
          : null,
        after: { ledger: edgeLedgerEntry, critique: critiqueEntry },
        meta: {
          edge_key: edgeKey,
          attempt: valid ? 1 : newRetryCount,
          overall: validationStatus,
          action,
          validator: validator || 'unverified',
          contract_blessed: allBlessed,
          retry_blocked: action === 'ask_human',
        },
      })

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

      // TDE-820: naming a flow NO LONGER BLOCKS on contracts. It used to require a
      // non-trivial, human-blessed contract on every internal handoff, which contradicted
      // the settled definition (contracts are optional; gate only at seams) and forced
      // legitimately-ungated flows through bypass:true — permanently mislabelling them as
      // gate-bypassed. name_flow's job is identity, not quality enforcement; the advisory
      // below informs without gatekeeping, and a missing blessing bites at validation time.
      const advisories = contractAdvisories(valid)
      const advisoryNote = renderContractAdvisory(advisories)
      // bypass/bypass_reason are retained ONLY so old callers do not error. Nothing is
      // bypassed any more, so a flow finalized today is never stamped gate_bypassed.
      const gateFields = { gate_bypassed: false, gate_bypass_reason: null, gate_bypassed_at: null }

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
      // TDE-811: only write step_list_open when the caller actually said something, so
      // re-naming an existing flow does not silently slam an open step list shut.
      const stepListField = args.step_list_open !== undefined ? { step_list_open: args.step_list_open === true } : {}
      if (existingFlowId) {
        await sb.from('flows').update({ name: args.name, context: args.context || null, short_id: shortId, ...gateFields, ...stepListField, updated_at: new Date().toISOString() }).eq('id', existingFlowId).eq('user_id', userId)
        flowId = existingFlowId
      } else {
        const { data: flow, error } = await sb.from('flows').insert({ user_id: userId, project_id: project.id, name: args.name, context: args.context || null, short_id: shortId, ...gateFields, ...stepListField }).select('id').single()
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
      // TDE-820: an advisory, not a verdict. Ungated handoffs are listed as normal, not as
      // failures, so nothing here implies the flow is weak for lacking contracts.
      const contractNote = advisoryNote ? `\n\n── Contracts on internal handoffs ──\n${advisoryNote}` : ''
      return `Flow "${args.name}" ${existingFlowId ? 'updated' : 'created'} — ${valid.length} task${valid.length !== 1 ? 's' : ''} assigned step numbers.${skipped ? ` (${skipped} task ID(s) not resolved, skipped)` : ''}\n\n${stepList}\n\nFlow ID: ${flowId.slice(0, 8)}…  Short ID: ${shortId}${contractNote}`
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
      // TDE-811: the step-list-open switch. Mutable in BOTH directions during a run — open it
      // when you realise the operation discovers its own next step, close it when the extent is
      // finally known. Not a flow type: nothing branches on it except whether the system is
      // entitled to call the flow finished.
      if (args.step_list_open !== undefined) updates.step_list_open = args.step_list_open === true

      await sb.from('flows').update(updates).eq('id', task.flow_id).eq('user_id', userId)
      const parts = []
      if (args.name) parts.push(`Renamed to "${args.name}".`)
      if (args.context !== undefined) parts.push('Context saved.')
      if (args.short_id !== undefined) parts.push(args.short_id ? `Short ID set to "${args.short_id}".` : 'Short ID cleared.')
      if (args.step_list_open !== undefined) {
        parts.push(args.step_list_open === true
          ? 'Step list OPEN — progress readouts will say more steps are expected, and the flow will not report itself complete when the known steps run out.'
          : 'Step list CLOSED — the known steps are the whole flow, so finishing them completes it.')
      }
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
        // TDE-818: the highest-trust act in the system. On the row it is three mutable fields
        // that the next set_task_output wipes; here it is a permanent record that it happened.
        await recordTaskEvent(sb, userId, {
          taskId: task.id, kind: 'contract_confirmed', entity: 'output_contract', actor: tokenActor,
          summary: `Output contract confirmed by ${confirmedBy} — ${prevContract.rules.length} rule(s) human-blessed`,
          before: contractSnapshot(prevContract),
          after: contractSnapshot({ ...prevContract, confirmed: true, confirmed_at: confirmedAt, confirmed_by: confirmedBy }),
          meta: { confirmed_by: confirmedBy, confirmed_at: confirmedAt },
        })
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
        // TDE-818: same durability gap on the input side — set_task_input replaces the whole edge.
        await recordTaskEvent(sb, userId, {
          taskId: task.id, kind: 'contract_confirmed', entity: 'input_contract', actor: tokenActor,
          summary: `Input contract (from ${targetEdge.source_task_id}) confirmed by ${confirmedBy} — ${targetEdge.contract.rules.length} rule(s) human-blessed`,
          before: contractSnapshot(targetEdge.contract),
          after: contractSnapshot({ ...targetEdge.contract, confirmed: true, confirmed_at: confirmedAt, confirmed_by: confirmedBy }),
          meta: { confirmed_by: confirmedBy, confirmed_at: confirmedAt, source_task_id: targetEdge.source_task_id },
        })
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

  // Local Mode bundle download (GET ?local_bundle=<signed token>) — the transport
  // behind pull_local_project's default script flow. The token IS the auth:
  // HMAC-signed, project+user+device scoped, ~15 min TTL.
  if (req.method === 'GET') {
    const token = new URL(req.url).searchParams.get('local_bundle')
    if (!token) {
      return new Response(JSON.stringify({ error: 'Method not allowed. Use POST.' }), {
        status: 405, headers: { ...cors, 'Content-Type': 'application/json', 'Allow': 'POST, OPTIONS' },
      })
    }
    const claim = await verifyBundleToken(token)
    if (!claim) {
      return new Response(JSON.stringify({ error: 'Invalid or expired bundle token. Call pull_local_project again for a fresh link.' }), {
        status: 401, headers: { ...cors, 'Content-Type': 'application/json' },
      })
    }
    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } })
    const { data: project } = await sb.from('projects').select('id, name, slug, prefix, context, active_phase_id')
      .eq('id', claim.p).eq('user_id', claim.u).maybeSingle()
    if (!project) {
      return new Response(JSON.stringify({ error: 'Project not found.' }), {
        status: 404, headers: { ...cors, 'Content-Type': 'application/json' },
      })
    }
    const bundle = await buildLocalBundle(sb, claim.u, project, claim.d, claim.c)
    if ('error' in bundle) {
      return new Response(JSON.stringify({ error: bundle.error }), {
        status: 409, headers: { ...cors, 'Content-Type': 'application/json' },
      })
    }
    return new Response(JSON.stringify(bundle), { headers: { ...cors, 'Content-Type': 'application/json' } })
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed. Use POST.' }), {
      status: 405,
      headers: { ...cors, 'Content-Type': 'application/json', 'Allow': 'POST, OPTIONS' },
    })
  }

  // ── Immediate-sync watcher endpoints (POST ?device_pull / device_flush / device_poll) ──
  // The watch.mjs process hits these directly with its scoped device token (query
  // string). Token IS the auth — never the API key, so a leaked device token can
  // only touch its one project. These bypass JSON-RPC entirely (plain HTTP).
  {
    const url = new URL(req.url)
    const dToken = url.searchParams.get('device_pull') || url.searchParams.get('device_flush') || url.searchParams.get('device_poll')
    if (dToken) {
      const jsonRes = (obj: unknown, status = 200) =>
        new Response(JSON.stringify(obj), { status, headers: { ...cors, 'Content-Type': 'application/json' } })
      const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } })
      const scope = await resolveDeviceToken(sb, dToken)
      if (!scope) return jsonRes({ error: 'Invalid or revoked device token. Re-pull to mint a fresh watcher token.' }, 401)
      const { data: project } = await sb.from('projects').select('id, name, slug, prefix, context, local_mode, local_revision')
        .eq('id', scope.project_id).eq('user_id', scope.user_id).maybeSingle()
      if (!project) return jsonRes({ error: 'Project not found.' }, 404)
      if (!project.local_mode) return jsonRes({ error: `"${project.name}" is not a Local Mode project.` }, 409)

      // device_poll: cheapest possible — just the hub's current cursor.
      if (url.searchParams.get('device_poll')) {
        return jsonRes({ status: 'ok', cursor: project.local_revision || 0 })
      }

      let dbody: any = {}
      try { dbody = await req.json() } catch { /* device_pull needs no body */ }

      // device_pull: full bundle (same builder as the MCP tool / 15-min link).
      if (url.searchParams.get('device_pull')) {
        const cursor = Number(dbody?.cursor ?? 0) || 0
        const bundle = await buildLocalBundle(sb, scope.user_id, project, scope.device_id, cursor)
        if ('error' in bundle) return jsonRes({ error: bundle.error }, 409)
        return jsonRes(bundle)
      }

      // device_flush: same write path as flush_local_project.
      const baseCursor = Number(dbody?.base_cursor ?? NaN)
      if (!Number.isFinite(baseCursor)) return jsonRes({ error: 'base_cursor is required.' }, 400)
      const changed = Array.isArray(dbody?.changed_files) ? dbody.changed_files : []
      const deletedIds = (Array.isArray(dbody?.deleted_short_ids) ? dbody.deleted_short_ids : []).map(Number).filter(Number.isFinite)
      const res = await applyFlush(sb, scope.user_id, project, scope.device_id, baseCursor, changed, deletedIds)
      if ('error' in res) return jsonRes({ error: res.error }, 409)
      return jsonRes({ status: 'flushed', ...res })
    }
  }

  let body: any
  try { body = await req.json() } catch { return rpcErr(-32700, 'Parse error', null) }

  const { method, params, id } = body

  // Allow discovery methods without auth so clients can verify the server is alive
  if (method === 'initialize') {
    // Version negotiation (MCP spec): echo the client's requested revision if we support it,
    // otherwise return our latest. Newest-first; SUPPORTED[0] is the fallback.
    const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']
    const requested = params?.protocolVersion
    const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : SUPPORTED_PROTOCOL_VERSIONS[0]
    return rpcOk({
      protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: 'tasker', version: '1.0.0' },
      instructions: TASKER_SERVER_INSTRUCTIONS,
    }, id)
  }
  // Notifications (any notifications/* method) carry no id and MUST NOT receive a response body.
  if (typeof method === 'string' && method.startsWith('notifications/')) {
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
    return new Response(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'Missing Bearer token' }, id: id ?? null }), {
      status: 401,
      headers: { ...cors, 'Content-Type': 'application/json', 'WWW-Authenticate': `Bearer resource_metadata="${RESOURCE_METADATA_URL}"` },
    })
  }

  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } })
  const rawToken = authHeader.slice(7).trim()
  const userId = await resolveApiKey(sb, rawToken)
  if (!userId) {
    return new Response(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'Invalid token' }, id: id ?? null }), {
      status: 401,
      headers: { ...cors, 'Content-Type': 'application/json', 'WWW-Authenticate': `Bearer error="invalid_token", resource_metadata="${RESOURCE_METADATA_URL}"` },
    })
  }

  // TDE-375: token-derived actor for provenance. Best-effort — auth already succeeded above; this
  // never blocks the request (resolveActor swallows its own errors).
  const tokenActor = await resolveActor(sb, rawToken)

  try {
    switch (method) {

      case 'tools/call': {
        const { name, arguments: toolArgs, input: toolInput } = params
        const resolvedArgs = toolArgs ?? toolInput ?? {}
        try {
          const userSb = await getScopedClient(userId)
          const text = await runTool(userSb, userId, name, resolvedArgs, params, tokenActor)
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

      default:
        return rpcErr(-32601, `Method not found: ${method}`, id)
    }
  } catch (err: any) {
    return rpcErr(-32603, err.message, id)
  }
})
