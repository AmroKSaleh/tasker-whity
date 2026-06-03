#!/usr/bin/env node
/**
 * npx tasker
 *
 * 1. Walks up from CWD to find a .tasker/project.json
 * 2. Starts the local server (API + SSE + React board)
 * 3. Opens the browser
 */

import { start }       from '../src/server.js'
import { existsSync }  from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { exec }        from 'child_process'

// ── Find .tasker/ ─────────────────────────────────────────────────────────────

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
if (!taskerDir) {
  console.error('\n  ✦ Tasker: no .tasker/ found in this directory or any parent.\n')
  console.error('  Run  npx tasker init  to initialize a new project here.\n')
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
console.log(`  Project: ${taskerDir}`)
if (distDir) console.log(`  Board:   ${distDir}`)
console.log(`  Port:    ${PORT}`)

const { port } = await start({ taskerDir, distDir, port: PORT })
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
