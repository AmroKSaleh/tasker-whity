/* ⏸️ PARKED 2026-06-26 — see the full context banner in bin/tasker.js. This
 * "repo-native local lens" is dormant, not in active development. The source
 * abstraction below is the extension point: adding a format = one factory here.
 * The never-built pieces (deleted task TDE-243) were a Claude Code native source
 * + write-back for read-only imports. Revive only for a dev-acquisition funnel. */
/**
 * Board "sources" — abstract WHERE the local server gets its data.
 *
 * A source exposes a uniform shape the server consumes:
 *   { label, watchDir, readOnly, load(), write(taskId, updates) }
 *
 *   .tasker/   → editable, parsed by parseTaskerDir, writes via writeTaskFields
 *   spec-kit   → read-only mirror of an existing repo tasks.md (TDE-147)
 *
 * Adding a new format (Claude Code native tasks, plain checklists elsewhere)
 * means adding one factory here — the server doesn't change.
 */

import { dirname } from 'path'
import { parseTaskerDir }  from './parser.js'
import { parseSpecKitFile } from './specKit.js'
import { writeTaskFields }  from './writer.js'

export function makeTaskerSource(taskerDir) {
  return {
    label:    '.tasker',
    watchDir: taskerDir,
    readOnly: false,
    load:  () => parseTaskerDir(taskerDir),
    write: (taskId, updates) => writeTaskFields(taskerDir, taskId, updates),
  }
}

export function makeSpecKitSource(tasksFile) {
  return {
    label:    'spec-kit',
    watchDir: dirname(tasksFile),   // watch the spec folder; re-parse on change
    readOnly: true,                 // flat-file import is a read-only mirror for now
    load:  () => parseSpecKitFile(tasksFile),
    write: null,
  }
}
