---
id: TDE-84
title: "Make the board section heading clickable to \"focus on the section\""
status: done
priority: low
section: core-app
order: 19
updated_at: 2026-07-14T23:09:51.590Z
---

From the redesign review (2026-05-27). On the editorial project board, the section column heading should be clickable to "focus on the section" somehow. Exact behavior is TBD — discuss before building.

Candidate interpretations to weigh:
- Section-scoped Focus mode: open the Focus overlay ranked over only this section's tasks (vs the whole project).
- Section detail / drill-in: a focused view of just this section (its groups, tasks, progress) — like a mini-board.
- Filter-to-section: clicking the heading filters the board (or Today) to that section only.
- Section context panel: open a side/bottom panel with the section's description, counts, and an "ask AI about this section" affordance (the old ProjectSidebar had "Ask about this section").

Open questions: should it be the whole heading or a dedicated affordance? What does "focus" mean here — concentration (hide other sections) or the Focus ritual (one task at a time within the section)? Does it apply on the board only, or also Today's buckets?

Context: the editorial board redesign currently has section headings as kicker + count + a "more" (⋯) button with no click behavior on the title itself. This task is to design and wire that interaction.
