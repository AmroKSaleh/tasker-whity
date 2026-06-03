/**
 * Writes frontmatter field updates to a .tasker/tasks/<id>.md file in-place.
 * Only touches the frontmatter — the markdown body is preserved verbatim.
 */

import { readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import { parseFrontmatter } from './parser.js'

// Board field names (Zustand store) → frontmatter keys (.md file)
const FIELD_MAP = {
  status:     'status',
  priority:   'priority',
  text:       'title',
  due_date:   'due',
  section_id: 'section',
  group_id:   'group',
  sort_order: 'order',
  milestones: 'milestones',
  output:     'output',
}

function serializeScalar(val) {
  if (val === null || val === undefined) return 'null'
  if (typeof val === 'boolean') return String(val)
  if (typeof val === 'number') return String(val)
  const s = String(val)
  // Quote strings that YAML would misinterpret
  if (/^(true|false|null|~)$/.test(s) || /^\d+$/.test(s) || s.includes(':') || s.includes('#') || s.startsWith('-')) {
    return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
  }
  return s
}

function serializeFlowObject(obj) {
  const parts = []
  if ('text' in obj) parts.push(`text: "${String(obj.text).replace(/"/g, '\\"')}"`)
  if ('done' in obj) parts.push(`done: ${Boolean(obj.done)}`)
  return `{ ${parts.join(', ')} }`
}

function serializeFrontmatter(data) {
  const lines = []
  for (const [key, val] of Object.entries(data)) {
    if (val === null || val === undefined) {
      lines.push(`${key}: null`)
    } else if (Array.isArray(val)) {
      if (val.length === 0) {
        lines.push(`${key}: []`)
      } else {
        lines.push(`${key}:`)
        for (const item of val) {
          lines.push(`  - ${serializeFlowObject(item)}`)
        }
      }
    } else if (typeof val === 'object') {
      lines.push(`${key}:`)
      for (const [k2, v2] of Object.entries(val)) {
        lines.push(`  ${k2}: ${serializeScalar(v2)}`)
      }
    } else {
      lines.push(`${key}: ${serializeScalar(val)}`)
    }
  }
  return lines.join('\n')
}

/**
 * Apply `updates` (using board field names) to the frontmatter of `taskId`.md.
 * Unknown fields (completed_at, pinned, etc.) are silently skipped.
 * The markdown body is preserved unchanged.
 */
export async function writeTaskFields(taskerDir, taskId, updates) {
  const filePath = join(taskerDir, 'tasks', `${taskId}.md`)
  const content  = await readFile(filePath, 'utf-8')
  const { data, body } = parseFrontmatter(content)

  for (const [boardKey, val] of Object.entries(updates)) {
    const fmKey = FIELD_MAP[boardKey]
    if (!fmKey) continue   // non-persisted field (completed_at, pinned, etc.) — skip
    data[fmKey] = val
  }

  const frontmatter = serializeFrontmatter(data)
  await writeFile(filePath, `---\n${frontmatter}\n---\n\n${body}`, 'utf-8')
}
