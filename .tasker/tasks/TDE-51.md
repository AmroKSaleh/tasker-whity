---
id: TDE-51
title: Add per-project Instruction Set (IS) — structured directives the AI follows when working within a project
status: done
priority: medium
section: core-app
order: 0
updated_at: 2026-07-25T07:41:59.616Z
---

Per-project Instruction Set (IS). Markdown files only, same upload/browse/download UI as the KB. Automatic — not user-triggered. On MCP level, IS is fetched and injected into context automatically before any project work begins. Requires a get_project_is MCP tool. The IS governs how the AI works within the project: coding style, commit style, PR workflow, output format, etc. User defines it once and the AI follows it without being reminded.
