---
id: TDE-63
title: Add section-level Instruction Set (IS) that overrides the project-level IS for tasks in that section
status: in_progress
priority: low
section: mcp-integrations
order: 0
updated_at: 2026-07-14T23:09:51.590Z
---

Extension of the project-level IS feature. Some projects have workstreams with fundamentally different working styles (e.g. backend API vs. marketing copy) where a single project IS is too broad and introduces noise. Section-level IS would override the project IS for tasks within that section. If a section has no IS, falls back to the project IS. Lookup in get_task would check section first, then project. UI would need an IS panel at the section level in addition to the project level. Start simple with project-level only — add this when "one IS is too broad" becomes a real user complaint.
