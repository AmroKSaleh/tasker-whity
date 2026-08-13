#!/usr/bin/env node
/* ============================================================================
 * ⏸️  PARKED — 2026-06-26 (by user decision). NOT in active development.
 * ----------------------------------------------------------------------------
 * WHAT THIS IS: the "repo-native local lens." `npx tasker` in a code repo walks
 * up to find a task source, then serves a localhost web board (the same React
 * app) that reads — and for some formats edits — tasks that live in the repo's
 * own files. Local-first, no cloud/login. The pitch was zero-friction dev
 * adoption: meet developers where they already are.
 *
 * WHY PARKED (the honest call): it's a SECOND product surface that splits a solo
 * builder's focus away from Tasker's actual wedge — the cloud + MCP side
 * (contracts, flows, KB, connectors, AI as a first-class user). It's a second
 * deployment target to maintain, there was no demand signal, and the owner
 * wasn't personally using it. Speculative adoption tooling, built ahead of need.
 *
 * WHAT WORKS TODAY (if revived as-is): detects `.tasker/project.json` (rich,
 * editable via writer.js) and Spec Kit / markdown `tasks.md` (read-only mirror,
 * TDE-147). Local API + SSE + React board. `.tasker/` file format spec:
 * V2/docs/tasker-file-format.md; worked example under V2/examples/.
 *
 * WHAT WAS NEVER BUILT (deleted task TDE-243): (1) a Claude Code native task
 * source — abandoned partly because CC's todos are ephemeral session state, not
 * a stable parseable format; (2) write-back for imported formats (spec-kit is
 * still read-only / 405 on PATCH); (3) bundling the built React app into the
 * published @tasker/local npm package (the ../client/ bin path is stubbed for this).
 *
 * REVIVE ONLY IF: you make a deliberate dev-ACQUISITION push and want a free,
 * zero-signup local tool as the top-of-funnel. That strategic question survives
 * as the GTM task "Resolve two-product strategy — cloud vs local" (TG-7). Until
 * that's an actual plan with a target audience, leave this dormant.
 * ============================================================================ */
/**
 * npx tasker
 *
 * 1. Walks up from CWD to find a task source:
 *      a) .tasker/project.json        (Tasker's own rich format — editable)
 *      b) specs/**\/tasks.md, tasks.md (Spec Kit / markdown checklist — read-only mirror)
 * 2. Starts the local server (API + SSE + React board)
 * 3. Opens the browser
 */

import { start }       from '../src/server.js'
import { makeTaskerSource, makeSpecKitSource } from '../src/sources.js'
import { findSpecKitUpwards } from '../src/specKit.js'
import { existsSync }  from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { exec }        from 'child_process'

// ── Find a source ─────────────────────────────────────────────────────────────

function findTaskerDir(from) {
  let dir = from
  while (true) {
    const candidate = join(dir, '.tasker')
    if (existsSync(join(candidate, 'project.json'))) return candidate
    const parent = dirname(dir)
    if (parent === dir) return null   // reached filesystem root
    dir = parent
  }
}

const taskerDir = findTaskerDir(process.cwd())
let source = null

if (taskerDir) {
  source = makeTaskerSource(taskerDir)
} else {
  // No .tasker/ — meet the repo where it is: detect an existing task format.
  const specFile = await findSpecKitUpwards(process.cwd())
  if (specFile) source = makeSpecKitSource(specFile)
}

if (!source) {
  console.error('\n  ✦ Tasker: no recognized task source found here or in any parent.\n')
  console.error('  Looked for:  .tasker/project.json,  specs/**/tasks.md,  tasks.md\n')
  console.error('  Run  npx tasker init  to initialize a new .tasker/ project here.\n')
  process.exit(1)
}

// ── Find the built React app ──────────────────────────────────────────────────
// In the repo: V2/tasker-local/bin/ → ../../app/dist
// When published as npm package: ../client/ (future — bundled with package)

const binDir = dirname(fileURLToPath(import.meta.url))

const distCandidates = [
  join(binDir, '..', '..', 'app', 'dist'),   // repo development path
  join(binDir, '..', 'client'),               // future npm package path
]

const distDir = distCandidates.find(d => existsSync(join(d, 'index.html'))) ?? null

if (!distDir) {
  console.warn('\n  ⚠ Built React app not found. API-only mode.')
  console.warn('  To see the board: cd V2/app && npm run build\n')
}

// ── Start server ──────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.TASKER_PORT ?? '2821', 10)

console.log(`\n  ✦ Tasker`)
console.log(`  Source:  ${source.label}`)
console.log(`  Path:    ${source.watchDir}`)
if (source.readOnly) console.log(`  Mode:    read-only (import)`)
if (distDir) console.log(`  Board:   ${distDir}`)
console.log(`  Port:    ${PORT}`)

const { port } = await start({ source, distDir, port: PORT })
const url = `http://localhost:${port}`
console.log(`\n  → ${url}\n`)

// ── Open browser ──────────────────────────────────────────────────────────────

const openCmd = process.platform === 'win32'
  ? `start "" "${url}"`
  : process.platform === 'darwin'
    ? `open "${url}"`
    : `xdg-open "${url}"`

exec(openCmd, err => {
  if (err) console.warn('  (could not open browser automatically)')
})
