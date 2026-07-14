---
id: TDE-3
title: Today page redesign — Today's queue + calendar layout
status: done
priority: medium
section: core-app
order: 8
updated_at: 2026-07-14T23:09:51.590Z
---

Redesign the Today page around two purposes: (a) refocus/reorient when the user feels scattered, (b) decide what to do today with a quick glance at progress.

Layout (desktop split, mobile stacked):
- Top: date header + one-line progress glance ("3/5 done · 2 in progress")
- Left pane (Today's queue), subsections in priority order:
  - Today's meetings (inline strip from Google Calendar)
  - Carried from yesterday (tasks with focus_date=yesterday that aren't done, tagged ⟲)
  - Due today (auto)
  - In progress (auto)
  - Pinned (auto)
  - Added to today (manual via focus_date=today)
  - Today's Focus (auto-ranked suggestions from no-due-date pending tasks, renamed from "Also worth doing")
  - Daily briefing card (kept for now, likely to be removed later)
- Right pane (Calendar):
  - Month grid default, toggleable to week strip
  - Deadline dots per cell; Google Calendar events also marked
  - Click cell → popover with that day's tasks + events + "Add Task" button
  - "Add Task" opens the full Add Task modal pre-filled with that date
- Bottom (full width): Today's Activity (collapsed by default, contains "Completed today")

Data model: add a nullable focus_date column on tasks. Manual focus = set focus_date to a date. Carry-over: yesterday's focus_date tasks stay visible today (tagged), don't auto-clear.

Out of scope (lives elsewhere): detailed task editing, project-level planning, settings. The page only handles refocus + today decisions.
