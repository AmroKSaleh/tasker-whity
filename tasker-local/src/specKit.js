/**
 * Spec Kit (and plain-markdown-checklist) parser — zero dependencies.
 *
 * Reads a GitHub Spec Kit `tasks.md` (or any markdown task checklist) and
 * produces the SAME board shape parser.js emits for .tasker/ dirs:
 *   { project, sections[], groups[], tasks[], warnings[] }
 *
 * This is the "meet them where they are" path: `npx tasker` renders the board
 * over task state that ALREADY exists in the repo, with zero setup — instead of
 * forcing devs to convert to .tasker/. Flat formats can't express the relational
 * model (groups, flows, I/O dependencies), so those come out empty; that's the
 * optional .tasker/ upgrade.
 *
 * Entry points:
 *   parseSpecKitContent(markdown, opts)  — pure, testable
 *   parseSpecKitFile(filePath)           — reads file, derives a fallback name from the path
 *   findSpecKitTasksFile(rootDir)        — locates a tasks.md to import (one dir level)
 *   findSpecKitUpwards(fromDir)          — walks up parents looking for one
 */

import { readFile, readdir } from 'fs/promises'
import { existsSync } from 'fs'
import { basename, dirname, join } from 'path'
import { derivePrefix } from './parser.js'

// `- [ ] ...`, `- [x] ...`, `* [X] ...`
const TASK_RE     = /^\s*[-*]\s*\[([ xX])\]\s+(.*\S)\s*$/
const HEADING_RE  = /^\s*##\s+(.*\S)\s*$/
const TITLE_RE    = /^\s*#\s+(.*\S)\s*$/
const PHASE_RE    = /^Phase\s+[\d.]+\s*:\s*/i   // "Phase 3.1: Setup" → "Setup"
const TID_RE      = /^(T\d+)\s+(.*)$/           // Spec Kit task ids: T001, T012…
const PARALLEL_RE = /\s*\[P\]\s*/g              // [P] = parallelizable marker

function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

// ─── Core parser (pure) ───────────────────────────────────────────────────────

export function parseSpecKitContent(markdown, opts = {}) {
  const text  = String(markdown).replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const lines = text.split('\n')

  // Project name: the first `# ` heading wins; strip a leading "Tasks:" label.
  // Fall back to caller-provided name, then a generic default.
  let name = opts.projectName ?? null
  for (const line of lines) {
    const tm = line.match(TITLE_RE)
    if (tm) {
      name = tm[1].replace(/^Tasks?\s*:?\s*/i, '').trim() || tm[1].trim()
      break
    }
  }
  if (!name) name = 'Imported Tasks'

  const prefix = derivePrefix(name)
  const slug   = slugify(name) || 'imported'
  const projId = slug

  const sectionsByName = new Map()   // display name → section object
  const usedSlugs      = new Set()
  const tasks          = []
  let currentHeading   = null
  let order            = 0
  let autoNum          = 0

  // A heading only becomes a section once a task actually appears under it —
  // so prose headings like "Dependencies" / "Parallel Example" are ignored.
  function ensureSection(headingText) {
    const display = headingText.replace(PHASE_RE, '').trim() || headingText.trim()
    if (sectionsByName.has(display)) return sectionsByName.get(display)
    const base = slugify(display) || `section-${sectionsByName.size + 1}`
    let id = base, n = 2
    while (usedSlugs.has(id)) id = `${base}-${n++}`
    usedSlugs.add(id)
    const sec = { id, name: display, sort_order: sectionsByName.size, project_id: projId }
    sectionsByName.set(display, sec)
    return sec
  }

  for (const line of lines) {
    const hm = line.match(HEADING_RE)
    if (hm) { currentHeading = hm[1]; continue }

    const tm = line.match(TASK_RE)
    if (!tm) continue

    const done = tm[1].toLowerCase() === 'x'
    let desc = tm[2].replace(PARALLEL_RE, ' ').replace(/\s+/g, ' ').trim()

    let id, shortId
    const idm = desc.match(TID_RE)
    if (idm) {
      id      = idm[1]
      shortId = parseInt(idm[1].slice(1), 10)
      desc    = idm[2].trim()
    } else {
      autoNum++
      id      = `${prefix}-${autoNum}`
      shortId = autoNum
    }

    const section = currentHeading ? ensureSection(currentHeading) : null

    tasks.push({
      id,
      short_id:   shortId,
      text:       desc || id,
      status:     done ? 'done' : 'pending',
      priority:   'medium',
      section_id: section ? section.id : null,
      group_id:   null,
      sort_order: order++,
      due_date:   null,
      detail:     null,
      input:      null,    // flat formats don't carry I/O edges — that's the .tasker/ upgrade
      output:     null,
      milestones: [],
      // Board-store defaults (mirror parser.js's parseTaskContent)
      pinned:       false,
      pinned_at:    null,
      pin_snoozed:  false,
      github_issue_number: null,
    })
  }

  // Tasks that appeared before/without any heading get a default "Tasks" section
  // (handles plain markdown checklists with no `## ` structure).
  let sections = [...sectionsByName.values()]
  const orphans = tasks.filter(t => t.section_id === null)
  if (orphans.length) {
    const def = { id: 'tasks', name: 'Tasks', sort_order: -1, project_id: projId }
    sections = [def, ...sections]
    for (const t of orphans) t.section_id = 'tasks'
  }
  sections.sort((a, b) => a.sort_order - b.sort_order)

  const project = {
    id:      projId,
    name,
    prefix,
    slug,
    context: { flow_names: {} },
    _prefix:        prefix,
    _next_short_id: tasks.reduce((m, t) => Math.max(m, t.short_id || 0), 0) + 1,
    _source:        'spec-kit',
  }

  return { project, sections, groups: [], tasks, warnings: [] }
}

// ─── File entry point ─────────────────────────────────────────────────────────

export async function parseSpecKitFile(filePath) {
  const raw = await readFile(filePath, 'utf-8')
  // Fallback name from the spec folder, only used if the file has no `# ` title:
  //   specs/001-link-shortener/tasks.md → "link shortener"
  const folder = basename(dirname(filePath))
  const fallback = folder && folder !== '.'
    ? folder.replace(/^\d+[-_]?/, '').replace(/[-_]+/g, ' ').trim()
    : ''
  return parseSpecKitContent(raw, fallback ? { projectName: fallback } : {})
}

// ─── Detection ─────────────────────────────────────────────────────────────────

// Looks one directory level for a tasks.md to import. Priority:
//   1. specs/<feature>/tasks.md   (Spec Kit canonical layout — first dir, sorted)
//   2. ./tasks.md  or  ./TASKS.md
export async function findSpecKitTasksFile(rootDir) {
  const specsDir = join(rootDir, 'specs')
  if (existsSync(specsDir)) {
    try {
      const entries = await readdir(specsDir, { withFileTypes: true })
      const dirs = entries.filter(e => e.isDirectory()).map(e => e.name).sort()
      for (const d of dirs) {
        const candidate = join(specsDir, d, 'tasks.md')
        if (existsSync(candidate)) return candidate
      }
    } catch { /* unreadable — fall through */ }
  }
  for (const f of ['tasks.md', 'TASKS.md']) {
    const candidate = join(rootDir, f)
    if (existsSync(candidate)) return candidate
  }
  return null
}

// Walks up from `fromDir` to the filesystem root, returning the first match.
export async function findSpecKitUpwards(fromDir) {
  let dir = fromDir
  while (true) {
    const found = await findSpecKitTasksFile(dir)
    if (found) return found
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}
