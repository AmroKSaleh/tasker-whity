---
id: TDE-3
title: Today page redesign — Today's queue + calendar layout
status: done
priority: medium
section: core-app
order: 12
updated_at: 2026-07-25T07:41:59.616Z
milestones:
  - { "text": "Add focus_date column to tasks (nullable date) + carry-over rule (yesterday's focus_date tasks remain visible today, tagged)", "done": true }
  - { "text": "Page shell: split layout (desktop) / stacked (mobile), top bar, date header with one-line progress glance", "done": true }
  - { "text": "Today's queue subsections: meetings strip, carried-from-yesterday (tagged), due today, in progress, pinned, added to today, Today's Focus (renamed suggestions), briefing card at bottom", "done": true }
  - { "text": "\"Add to today\" / \"Remove from today\" actions on tasks (writes focus_date), available everywhere a task is shown", "done": true }
  - { "text": "Calendar pane: month grid (default) + week strip toggle, deadline dots per cell, Google Calendar event markers", "done": true }
  - { "text": "Calendar cell popover: lists tasks + events for that day; \"Add Task\" button opens the full Add Task modal pre-filled with that date", "done": true }
  - { "text": "Today's Activity section (collapsed by default): Completed today bucket — already partially built, just move and collapse", "done": true }
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
