---
id: TDE-86
title: Decide + wire the Focus mode session timer (or remove it)
status: done
priority: low
section: core-app
order: 21
updated_at: 2026-07-14T23:09:51.590Z
---

The Focus overlay's top-right clock + "0:00" is currently non-functional chrome. It came from the Claude Design prototype (focus-safe), which showed the timer's look without behavior. DESIGN_DECISIONS § "Decisions I deliberately did NOT make" explicitly left Focus-timer behavior open (auto vs manual start? persisted across sessions?), so it was rendered to match the design but never wired.

Decision needed first: keep it or remove it. Removing avoids a dead button (matches the no-bare/dead-buttons rule). Keeping means picking behavior.

If keeping, options (increasing effort):
- Minimal: auto-starts on Focus open, counts up (◐ MM:SS), resets each session, purely visual — no persistence. Quick.
- Pause/resume control.
- Persistence / time-on-task logging: store accumulated focus time per task (needs a column / table + write on close). Bigger; ties into any future "time spent" analytics.

Location: components/focus/FocusOverlay.jsx — the top bar button `<Clock/> 0:00`. lucide Clock already imported.

Until decided, it's a placeholder that does nothing on click.
