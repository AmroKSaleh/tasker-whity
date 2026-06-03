/**
 * .tasker/ parser — zero dependencies.
 *
 * Two entry points:
 *   parseTaskerDir(dirPath)                        — local filesystem
 *   parseTaskerContent(projectJsonStr, fileMap)    — pre-loaded strings (GitHub Contents API)
 *
 * Output shape matches what the board's Zustand store expects:
 *   { project, sections[], groups[], tasks[] }
 *
 * IDs stay as slugs/short-IDs (not UUIDs) — the board just needs them consistent.
 * task.id = "LSS-3"  |  task.section_id = "build"  |  task.input.source_task_id = "LSS-2"
 */

import { readFile, readdir } from 'fs/promises'
import { join } from 'path'

// ─── Prefix derivation ────────────────────────────────────────────────────────

export function derivePrefix(name) {
  const words = name.trim().split(/\s+/).filter(w => /[a-zA-Z]/.test(w))
  if (words.length === 0) return 'TSK'

  if (words.length >= 2) {
    // Multi-word: initials, 2–4 chars
    const initials = words
      .map(w => w.replace(/[^a-zA-Z]/g, '')[0] ?? '')
      .join('')
      .toUpperCase()
    return (initials.slice(0, 4) || 'TSK')
  }

  // Single word
  const w = words[0].toUpperCase().replace(/[^A-Z]/g, '')
  if (w.length <= 3) return w.padEnd(3, w[w.length - 1]).slice(0, 3)
  // Long single word: first letter + consonants, up to 3
  const consonants = w.slice(1).replace(/[AEIOU]/g, '')
  const candidate = (w[0] + consonants).slice(0, 3)
  return candidate.length === 3 ? candidate : w.slice(0, 3)
}

// ─── Frontmatter parser ───────────────────────────────────────────────────────
// Handles the exact YAML subset used in .tasker/tasks/*.md:
//   - scalar key: value
//   - nested object (input:\n  from: ...)
//   - array of inline flow objects (milestones:\n  - { text: "...", done: true })

export function parseFrontmatter(fileContent) {
  const text = fileContent.replace(/\r\n/g, '\n').replace(/\r/g, '\n')

  const match = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  if (!match) return { data: {}, body: text.trim() }

  const data = {}
  const body = match[2].trim()
  const lines = match[1].split('\n')

  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) { i++; continue }

    const colon = line.indexOf(':')
    if (colon === -1) { i++; continue }

    const key = line.slice(0, colon).trim()
    const raw = line.slice(colon + 1).trim()

    if (raw === '') {
      // Nested block — collect indented lines that follow
      const block = []
      i++
      while (i < lines.length && (lines[i].startsWith('  ') || lines[i] === '')) {
        if (lines[i].trim()) block.push(lines[i])
        i++
      }

      if (block.length === 0) continue

      if (block[0].trimStart().startsWith('- ')) {
        // Array
        data[key] = block.map(l => parseFlowObject(l.replace(/^\s*-\s*/, '').trim()))
      } else {
        // Nested object
        const obj = {}
        for (const bl of block) {
          const bc = bl.indexOf(':')
          if (bc === -1) continue
          const bk = bl.slice(0, bc).trim()
          const bv = bl.slice(bc + 1).trim()
          obj[bk] = parseScalar(bv)
        }
        data[key] = obj
      }
    } else {
      data[key] = parseScalar(raw)
      i++
    }
  }

  return { data, body }
}

function parseScalar(raw) {
  if (raw === 'true')  return true
  if (raw === 'false') return false
  if (raw === 'null' || raw === '~') return null
  if ((raw[0] === '"' && raw[raw.length - 1] === '"') ||
      (raw[0] === "'" && raw[raw.length - 1] === "'")) {
    return raw.slice(1, -1)
  }
  if (/^\d+$/.test(raw)) return parseInt(raw, 10)
  return raw
}

// Parse inline YAML flow object: { text: "Outline reviewed", done: true }
function parseFlowObject(str) {
  if (str.startsWith('{') && str.endsWith('}')) str = str.slice(1, -1).trim()
  const out = {}
  const textM = str.match(/text:\s*"([^"]*)"/)
  const doneM = str.match(/done:\s*(true|false)/)
  if (textM) out.text    = textM[1]
  if (doneM) out.done    = doneM[1] === 'true'
  return out
}

// ─── Project.json parser ──────────────────────────────────────────────────────

function parseProjectJson(json) {
  const prefix  = json.prefix || derivePrefix(json.name)
  const slug    = json.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  const projId  = slug

  const sections = (json.sections ?? []).map(s => ({
    id:         s.id,
    name:       s.name,
    sort_order: s.order ?? 0,
    project_id: projId,
  }))

  const groups = (json.groups ?? []).map(g => ({
    id:         g.id,
    name:       g.name,
    sort_order: g.order ?? 0,
    section_id: g.section,
    project_id: projId,
  }))

  const project = {
    id:      projId,
    name:    json.name,
    prefix,
    slug,
    context: {
      flow_names: json.flows ?? {},
    },
    _prefix:         prefix,
    _next_short_id:  json.next_short_id ?? 1,
  }

  return { project, sections, groups }
}

// ─── Task file parser ─────────────────────────────────────────────────────────

function parseTaskContent(content) {
  const { data, body } = parseFrontmatter(content)
  if (!data.id || !data.title) return null   // malformed — skip

  const shortIdMatch = String(data.id).match(/(\d+)$/)
  const shortId = shortIdMatch ? parseInt(shortIdMatch[1], 10) : null

  return {
    id:         String(data.id),
    short_id:   shortId,
    text:       String(data.title),
    status:     data.status   ?? 'pending',
    priority:   data.priority ?? 'medium',
    section_id: data.section  ?? null,
    group_id:   data.group    ?? null,
    sort_order: data.order    ?? 0,
    due_date:   data.due      ?? null,
    detail:     body          || null,
    input:      data.input?.from ? { source_task_id: String(data.input.from) } : null,
    output:     data.output   ? String(data.output) : null,
    milestones: data.milestones ?? [],
    // Fields the board store expects but aren't in .tasker/ — safe defaults
    pinned:       false,
    pinned_at:    null,
    pin_snoozed:  false,
    github_issue_number: null,
  }
}

// ─── Validation ───────────────────────────────────────────────────────────────

function validate(project, sections, groups, tasks) {
  const warnings = []
  const sectionIds = new Set(sections.map(s => s.id))
  const groupIds   = new Set(groups.map(g => g.id))
  const taskIds    = new Set(tasks.map(t => t.id))

  for (const task of tasks) {
    if (task.section_id && !sectionIds.has(task.section_id)) {
      warnings.push(`${task.id}: unknown section "${task.section_id}"`)
    }
    if (task.group_id && !groupIds.has(task.group_id)) {
      warnings.push(`${task.id}: unknown group "${task.group_id}"`)
    }
    if (task.input?.source_task_id && !taskIds.has(task.input.source_task_id)) {
      warnings.push(`${task.id}: input.from "${task.input.source_task_id}" does not resolve to a task`)
    }
  }

  // Cycle detection: DFS over input.from edges
  const adj = new Map(tasks.map(t => [t.id, t.input?.source_task_id ? [t.input.source_task_id] : []]))
  const visited = new Set()
  const inStack = new Set()

  function dfs(id) {
    if (inStack.has(id)) { warnings.push(`cycle detected involving ${id}`); return }
    if (visited.has(id)) return
    visited.add(id); inStack.add(id)
    for (const dep of (adj.get(id) ?? [])) dfs(dep)
    inStack.delete(id)
  }
  for (const id of adj.keys()) dfs(id)

  return warnings
}

// ─── Core build (shared between both entry points) ────────────────────────────

function build(projectJson, taskContents) {
  const { project, sections, groups } = parseProjectJson(projectJson)

  const tasks = taskContents
    .map(parseTaskContent)
    .filter(Boolean)
    .sort((a, b) => a.sort_order - b.sort_order)

  const warnings = validate(project, sections, groups, tasks)

  return { project, sections, groups, tasks, warnings }
}

// ─── Entry point 1: local filesystem ─────────────────────────────────────────

export async function parseTaskerDir(taskerDirPath) {
  const projectRaw  = await readFile(join(taskerDirPath, 'project.json'), 'utf-8')
  const projectJson = JSON.parse(projectRaw)

  let taskFiles = []
  try {
    taskFiles = await readdir(join(taskerDirPath, 'tasks'))
  } catch {
    // tasks/ doesn't exist — empty project, not an error
  }

  const taskContents = await Promise.all(
    taskFiles
      .filter(f => f.endsWith('.md'))
      .map(f => readFile(join(taskerDirPath, 'tasks', f), 'utf-8'))
  )

  return build(projectJson, taskContents)
}

// ─── Entry point 2: pre-loaded strings (GitHub Contents API) ─────────────────

export function parseTaskerContent(projectJsonStr, fileMap) {
  // fileMap: { 'LSS-1.md': '<content>', 'LSS-2.md': '<content>', ... }
  const projectJson = JSON.parse(projectJsonStr)
  const taskContents = Object.values(fileMap).filter(c => typeof c === 'string')
  return build(projectJson, taskContents)
}
