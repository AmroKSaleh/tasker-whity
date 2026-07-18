// ── Local Mode: .tasker/ format loader/serializer (TDE-408) ──────────────────
// Pure functions, no I/O, no deps — importable by the Deno edge function AND
// testable under `node --experimental-strip-types` (erasable TS only: no enums,
// no namespaces, no parameter properties).
//
// Format: docs/tasker-file-format.md + the D2 deltas of docs/local-first-design.md
// (updated_at, contract-bearing input/output, review bar carriage, omit-don't-null).
// The frontmatter is a CONTROLLED YAML subset — we generate it, so the parser only
// needs to read what the serializer (or the hand-written reference example) emits:
//   key: scalar                     (plain, or JSON-quoted when it needs escaping)
//   key: {"…"} / ["…"]              (single-line JSON value — used for complex fields)
//   input:\n  from: BPW-4           (the one nested sugar form, per the format doc)
//   milestones:\n  - { text: "…", done: true }   (inline objects, one per line)

export interface TaskerSection { id: string; name: string; order: number }
export interface TaskerGroup { id: string; name: string; section: string; order: number }

export interface TaskerProjectMeta {
  version: number
  name: string
  prefix: string
  next_short_id: number
  sections: TaskerSection[]
  groups: TaskerGroup[]
  flows: Record<string, string>
}

export interface TaskerMilestone { text: string; done: boolean }

export interface TaskerTask {
  id: string
  title: string
  status: 'pending' | 'in_progress' | 'done'
  priority: 'rush' | 'high' | 'medium' | 'low'
  section: string
  group?: string
  due?: string
  order: number
  updated_at?: string
  // Simple form: { from } — one bare dependency. Full form: { edges: [...] } with contracts.
  input?: { from?: string; edges?: Array<Record<string, unknown>> }
  // Simple form: plain description string. Full form: { description?, contract }.
  output?: string | { description?: string; contract?: Record<string, unknown> }
  review?: Record<string, unknown>
  milestones?: TaskerMilestone[]
  body: string
}

export interface TaskerModel {
  meta: TaskerProjectMeta
  tasks: TaskerTask[]
}

export interface ParseWarning { path: string; message: string }

// ── scalar helpers ────────────────────────────────────────────────────────────

const NEEDS_QUOTING = /(^\s)|(\s$)|(^[#>|&*!%@`"'{\[\]}:,-]?$)|(: )|(^ *$)|(")|(\n)|(#)/

function serializeScalar(v: string): string {
  if (v === '') return '""'
  if (NEEDS_QUOTING.test(v) || /^[{[]/.test(v) || v.includes(': ') || v.endsWith(':')) {
    return JSON.stringify(v)
  }
  return v
}

function parseScalar(raw: string): string {
  const t = raw.trim()
  if (t.startsWith('"') && t.endsWith('"')) {
    try { return JSON.parse(t) } catch { return t }
  }
  return t
}

// Inline `{ text: "…", done: true }` milestone objects (reference-example style),
// also accepts strict JSON.
function parseInlineObject(raw: string): Record<string, unknown> | null {
  const t = raw.trim()
  if (!t.startsWith('{') || !t.endsWith('}')) return null
  try { return JSON.parse(t) } catch { /* fall through to lenient */ }
  try {
    const jsonish = t.replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '$1"$2":')
    return JSON.parse(jsonish)
  } catch { return null }
}

// ── kb filename slug ────────────────────────────────────────────────────────
// Turn a KB entry title into a safe, stable .md filename stem. Lowercase, keep
// alphanumerics, collapse everything else to single dashes, trim, cap length.
// Collisions are disambiguated by the caller (append -2, -3…).
export function kbFileSlug(title: string): string {
  const s = title.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '')
  return s || 'untitled'
}

// ── governance footer ─────────────────────────────────────────────────────────
// FORCED IS exposure (parity with online get_task injection): every task file
// carries the governing Instruction Set below this marker, auto-injected on
// every pull. It is NOT task data: parse strips everything from the marker on,
// so it can never leak into detail or sync upward. Agents can't read a task
// without the rules arriving with it.

export const GOVERNANCE_MARKER = '<!-- ═══ GOVERNANCE — auto-injected on every pull · read before acting · NOT part of this task · stripped on flush ═══ -->'

export function withGovernance(fileText: string, governance: string): string {
  const g = (governance || '').trim()
  if (!g) return fileText
  return `${fileText.replace(/\s+$/, '')}\n\n${GOVERNANCE_MARKER}\n\n${g}\n`
}

export function stripGovernance(text: string): string {
  const i = text.indexOf(GOVERNANCE_MARKER)
  if (i === -1) return text
  return text.slice(0, i).replace(/\s+$/, '') + '\n'
}

// ── task file ─────────────────────────────────────────────────────────────────

export function parseTaskFile(rawText: string, path = 'task'): { task: TaskerTask | null; warnings: ParseWarning[] } {
  const text = stripGovernance(rawText)
  const warnings: ParseWarning[] = []
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!m) return { task: null, warnings: [{ path, message: 'missing frontmatter block' }] }
  const [, fmRaw, bodyRaw] = m

  const fields: Record<string, unknown> = {}
  const lines = fmRaw.split(/\r?\n/)
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) { i++; continue }
    const kv = line.match(/^([A-Za-z_][A-Za-z0-9_]*):(.*)$/)
    if (!kv) { warnings.push({ path, message: `unparsed frontmatter line: ${line}` }); i++; continue }
    const key = kv[1]
    const rest = kv[2]

    if (rest.trim() === '') {
      // Block form: nested `from:` sugar (input) or `- { … }` list (milestones)
      const items: Record<string, unknown>[] = []
      const nested: Record<string, string> = {}
      let j = i + 1
      while (j < lines.length && /^\s+\S/.test(lines[j])) {
        const sub = lines[j].trim()
        if (sub.startsWith('- ')) {
          const obj = parseInlineObject(sub.slice(2))
          if (obj) items.push(obj)
          else warnings.push({ path, message: `unparsed list item under ${key}: ${sub}` })
        } else {
          const skv = sub.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/)
          if (skv) nested[skv[1]] = parseScalar(skv[2])
          else warnings.push({ path, message: `unparsed nested line under ${key}: ${sub}` })
        }
        j++
      }
      fields[key] = items.length ? items : nested
      i = j
      continue
    }

    const rawVal = rest.trim()
    if (rawVal.startsWith('{') || rawVal.startsWith('[')) {
      const obj = parseInlineObject(rawVal)
      if (obj !== null) fields[key] = obj
      else {
        try { fields[key] = JSON.parse(rawVal) } catch {
          warnings.push({ path, message: `unparsed inline JSON for ${key}` }); fields[key] = rawVal
        }
      }
    } else {
      fields[key] = parseScalar(rawVal)
    }
    i++
  }

  const need = (k: string): string => {
    const v = fields[k]
    if (typeof v !== 'string' || !v) warnings.push({ path, message: `missing required field: ${k}` })
    return typeof v === 'string' ? v : ''
  }

  const task: TaskerTask = {
    id: need('id'),
    title: need('title'),
    status: (need('status') || 'pending') as TaskerTask['status'],
    priority: (need('priority') || 'medium') as TaskerTask['priority'],
    section: need('section'),
    order: Number(fields['order'] ?? 0),
    body: bodyRaw.replace(/^\r?\n/, '').replace(/\s+$/, ''),
  }
  if (typeof fields['group'] === 'string' && fields['group']) task.group = fields['group'] as string
  if (typeof fields['due'] === 'string' && fields['due']) task.due = fields['due'] as string
  if (typeof fields['updated_at'] === 'string' && fields['updated_at']) task.updated_at = fields['updated_at'] as string
  if (fields['input'] && typeof fields['input'] === 'object') task.input = fields['input'] as TaskerTask['input']
  if (fields['output'] !== undefined) task.output = fields['output'] as TaskerTask['output']
  if (fields['review'] && typeof fields['review'] === 'object') task.review = fields['review'] as Record<string, unknown>
  if (Array.isArray(fields['milestones'])) {
    task.milestones = (fields['milestones'] as Record<string, unknown>[]).map(o => ({
      text: String(o.text ?? ''), done: o.done === true,
    }))
  }
  return { task, warnings }
}

export function serializeTaskFile(task: TaskerTask): string {
  const out: string[] = ['---']
  out.push(`id: ${serializeScalar(task.id)}`)
  out.push(`title: ${serializeScalar(task.title)}`)
  out.push(`status: ${task.status}`)
  out.push(`priority: ${task.priority}`)
  out.push(`section: ${serializeScalar(task.section)}`)
  if (task.group) out.push(`group: ${serializeScalar(task.group)}`)
  if (task.due) out.push(`due: ${task.due}`)
  out.push(`order: ${task.order}`)
  if (task.updated_at) out.push(`updated_at: ${serializeScalar(task.updated_at)}`)
  if (task.input) {
    if (task.input.from && !task.input.edges) {
      out.push('input:')
      out.push(`  from: ${serializeScalar(task.input.from)}`)
    } else {
      out.push(`input: ${JSON.stringify(task.input)}`)
    }
  }
  if (task.output !== undefined) {
    if (typeof task.output === 'string') out.push(`output: ${serializeScalar(task.output)}`)
    else out.push(`output: ${JSON.stringify(task.output)}`)
  }
  if (task.review) out.push(`review: ${JSON.stringify(task.review)}`)
  if (task.milestones && task.milestones.length) {
    out.push('milestones:')
    for (const ms of task.milestones) {
      out.push(`  - { "text": ${JSON.stringify(ms.text)}, "done": ${ms.done} }`)
    }
  }
  out.push('---')
  out.push('')
  if (task.body) { out.push(task.body); out.push('') }
  return out.join('\n')
}

// ── project.json ──────────────────────────────────────────────────────────────

export function parseProjectJson(text: string, path = 'project.json'): { meta: TaskerProjectMeta | null; warnings: ParseWarning[] } {
  const warnings: ParseWarning[] = []
  let raw: Record<string, unknown>
  try { raw = JSON.parse(text) } catch (e) {
    return { meta: null, warnings: [{ path, message: `invalid JSON: ${(e as Error).message}` }] }
  }
  for (const k of ['version', 'name', 'prefix', 'next_short_id']) {
    if (raw[k] === undefined) warnings.push({ path, message: `missing required field: ${k}` })
  }
  const meta: TaskerProjectMeta = {
    version: Number(raw.version ?? 1),
    name: String(raw.name ?? ''),
    prefix: String(raw.prefix ?? ''),
    next_short_id: Number(raw.next_short_id ?? 1),
    sections: Array.isArray(raw.sections) ? (raw.sections as TaskerSection[]).map(s => ({ id: String(s.id), name: String(s.name), order: Number(s.order ?? 0) })) : [],
    groups: Array.isArray(raw.groups) ? (raw.groups as TaskerGroup[]).map(g => ({ id: String(g.id), name: String(g.name), section: String(g.section), order: Number(g.order ?? 0) })) : [],
    flows: (raw.flows && typeof raw.flows === 'object') ? raw.flows as Record<string, string> : {},
  }
  return { meta, warnings }
}

export function serializeProjectJson(meta: TaskerProjectMeta): string {
  return JSON.stringify({
    version: meta.version,
    name: meta.name,
    prefix: meta.prefix,
    next_short_id: meta.next_short_id,
    sections: meta.sections,
    groups: meta.groups,
    flows: meta.flows,
  }, null, 2) + '\n'
}

// ── whole-directory model ─────────────────────────────────────────────────────

export function parseTasker(files: Record<string, string>): { model: TaskerModel | null; warnings: ParseWarning[] } {
  const warnings: ParseWarning[] = []
  const pj = files['project.json']
  if (pj === undefined) return { model: null, warnings: [{ path: 'project.json', message: 'file missing' }] }
  const { meta, warnings: pw } = parseProjectJson(pj)
  warnings.push(...pw)
  if (!meta) return { model: null, warnings }
  const tasks: TaskerTask[] = []
  for (const [path, content] of Object.entries(files)) {
    const tm = path.match(/^tasks\/(.+)\.md$/)
    if (!tm) continue
    const { task, warnings: tw } = parseTaskFile(content, path)
    warnings.push(...tw)
    if (!task) continue
    if (task.id !== tm[1]) warnings.push({ path, message: `id "${task.id}" does not match filename` })
    tasks.push(task)
  }
  tasks.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }))
  return { model: { meta, tasks }, warnings }
}

export function serializeTasker(model: TaskerModel): Record<string, string> {
  const files: Record<string, string> = {}
  files['project.json'] = serializeProjectJson(model.meta)
  for (const task of model.tasks) files[`tasks/${task.id}.md`] = serializeTaskFile(task)
  return files
}

// ── content hash (for .sync.json bookkeeping) ────────────────────────────────
// FNV-1a 32-bit, hex — deterministic across runtimes, no crypto dependency.

export function contentHash(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}
