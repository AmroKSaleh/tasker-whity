/**
 * Local Tasker server.
 *
 *   GET   /api/project       → parsed board data (project, sections, groups, tasks)
 *   PATCH /api/tasks/:id      → write back task fields (editable sources only)
 *   GET   /api/events         → SSE stream — fires whenever the source changes
 *   GET   *                   → serves the built React app (dist/) with
 *                               window.__TASKER_LOCAL__ injected into index.html
 *
 * Usage:
 *   import { start } from './server.js'
 *   const { port } = await start({ source, distDir, port })       // preferred
 *   const { port } = await start({ taskerDir, distDir, port })    // back-compat
 *
 * A "source" abstracts where the data comes from (.tasker/ dir, Spec Kit
 * tasks.md, …). See sources.js. A bare taskerDir is wrapped into a .tasker
 * source for backward compatibility.
 */

import express          from 'express'
import { createServer } from 'http'
import { readFileSync, watch } from 'fs'
import { join }         from 'path'
import { makeTaskerSource } from './sources.js'

const INJECT = '<script>window.__TASKER_LOCAL__=true;</script>'

// ── SSE helpers ───────────────────────────────────────────────────────────────

function sseHeaders(res) {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection',    'keep-alive')
  res.flushHeaders()
}

// ── index.html injection ──────────────────────────────────────────────────────

function serveInjected(distDir, res) {
  try {
    const raw = readFileSync(join(distDir, 'index.html'), 'utf-8')
    const html = raw.replace('<head>', `<head>${INJECT}`)
    res.setHeader('Content-Type', 'text/html')
    res.send(html)
  } catch {
    res.status(503).send(`<pre>React app not built yet.\nRun: npm run build  (inside V2/app/)</pre>`)
  }
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function start({ source, taskerDir, distDir = null, port = 2821 }) {
  // Back-compat: a bare taskerDir → a .tasker source.
  if (!source) source = makeTaskerSource(taskerDir)

  // Initial parse
  let cached = await source.load()

  const app     = express()
  const clients = new Set()   // SSE response objects

  function broadcast(data) {
    const msg = `data: ${JSON.stringify(data)}\n\n`
    for (const res of clients) {
      try { res.write(msg) } catch { clients.delete(res) }
    }
  }

  // Re-parse on any change in the watched dir and broadcast
  let debounce = null
  watch(source.watchDir, { recursive: true }, () => {
    clearTimeout(debounce)
    debounce = setTimeout(async () => {
      try {
        cached = await source.load()
        broadcast(cached)
      } catch (err) {
        console.error('[tasker] parse error:', err.message)
      }
    }, 120)   // 120ms debounce — editors write files in bursts
  })

  // ── API ────────────────────────────────────────────────────────────────────

  app.use(express.json())

  app.get('/api/project', (_req, res) => {
    res.json(cached)
  })

  app.patch('/api/tasks/:taskId', async (req, res) => {
    const { taskId } = req.params
    const updates = req.body ?? {}

    if (source.readOnly || !source.write) {
      return res.status(405).json({
        error: `This project is read-only (source: ${source.label}). ` +
               `Run "npx tasker init" to create an editable .tasker/ project.`,
      })
    }

    try {
      await source.write(taskId, updates)
      // The fs.watch handler will re-parse and broadcast via SSE automatically
      res.status(204).end()
    } catch (err) {
      if (err.code === 'ENOENT') {
        res.status(404).json({ error: `Task ${taskId} not found` })
      } else {
        console.error('[tasker] write error:', err.message)
        res.status(500).json({ error: err.message })
      }
    }
  })

  app.get('/api/events', (req, res) => {
    sseHeaders(res)
    clients.add(res)
    // Send current state immediately so the client has data on connect
    res.write(`data: ${JSON.stringify(cached)}\n\n`)
    req.on('close', () => clients.delete(res))
  })

  // ── Static (built React app) ───────────────────────────────────────────────

  if (distDir) {
    // Inject __TASKER_LOCAL__ into the root HTML
    app.get('/', (_req, res) => serveInjected(distDir, res))
    // Serve assets (JS, CSS, images) without modification
    app.use(express.static(distDir, { index: false }))
    // SPA fallback — any unknown path → index.html
    app.get('*', (_req, res) => serveInjected(distDir, res))
  } else {
    app.get('/', (_req, res) => {
      res.send('<pre>Start with distDir pointing to the built React app.</pre>')
    })
  }

  // ── Listen ────────────────────────────────────────────────────────────────

  const httpServer = createServer(app)

  await new Promise((resolve, reject) => {
    httpServer.listen(port, '127.0.0.1', resolve)
    httpServer.on('error', reject)
  })

  return { server: httpServer, port }
}
