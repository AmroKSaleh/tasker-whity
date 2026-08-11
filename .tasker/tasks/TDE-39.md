---
id: TDE-39
title: Add per-project Knowledge Base (KB) — markdown file directory that the AI references on demand
status: done
priority: medium
section: core-app
order: 11
updated_at: 2026-07-25T07:41:59.616Z
---

Per-project knowledge base. Users can upload, browse, and download .md files only (no PDFs/Word — avoids extraction complexity). AI reads KB files only when explicitly asked by the user. Requires a get_kb MCP tool that returns the requested file content. UI needed: file upload, file list, download/delete per file.
