# Tasker Local (v0.1.0)

A read-only desktop window into local `.tasker/` projects — the same files the AI agent
works on in Local Mode. All verbs (editing, completing, syncing) stay in the coding
platform + MCP; this app only looks.

## What it does
- Renders any repo's `.tasker/` folder as the familiar Tasker board (sections → cards).
- **Live**: watches the files and re-renders within ~250ms of the agent writing them —
  you see hub-unsynced working state the web app can't show. Freshly-changed cards flash.
- Task detail panel: frontmatter chips, quality-bar rules, markdown body
  (⚖ governance footer hidden — it's agent-facing carriage).
- "Synced Xm ago" stamp from `.sync.json`'s modified time — local truth is live,
  hub truth is as-of-last-pull/flush.
- Multiple projects via a folder registry (`+ Add project folder`), light/dark theme,
  Open/All filter, search.

## What it deliberately does NOT do
- No writes. No hub/cloud access. No auth. No sync — the pull/flush bracket stays
  with the agent (see the Local Mode design: V2/docs/local-first-design.md).

## Run
```
cd V2/desktop
npm install
npm start
```

## Architecture
- Electron shell (v0 choice: npm-only toolchain, no Rust needed). The renderer is
  plain HTML/CSS/JS wearing the V2 editorial design tokens — designed to be lifted
  into a Tauri shell unchanged when a tiny distributable matters.
- `main.js` — window, folder registry (userData/projects.json), `.tasker/` reads,
  debounced recursive fs.watch. `renderer/app.js` — frontmatter parser, minimal
  safe markdown renderer, board/detail rendering.
