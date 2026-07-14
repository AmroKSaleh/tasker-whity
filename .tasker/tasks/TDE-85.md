---
id: TDE-85
title: Re-add drag-and-drop reorder to the editorial board
status: done
priority: medium
section: core-app
order: 20
updated_at: 2026-07-14T23:09:51.590Z
---

Drag-and-drop was dropped when the project board was rebuilt into the editorial 2D layout (2026-05-27 redesign). Re-wire @dnd-kit into the new structure.

Scope:
- Reorder task cards within a column and within a group (sort_order).
- Move a task between sections/groups by dragging (was handled by moveTask + reorderTasks).
- Reorder sections (columns) themselves (reorderSections).
- Use the existing design-system drag visuals: the `shadow-drag` token (18px shadow + accent ring) and a grip that fades in on the card's left edge on hover (per DESIGN_DECISIONS § 3.5).

The data ops still exist in useTasks (moveTask, reorderTasks, reorderSections) — they were used by the old BoardColumn/SortableContext wiring before the rewrite. This is purely re-attaching DnD interaction to the editorial board components (SectionColumn, BoardCard). Sensors/accessibility (keyboard drag) should be preserved.
