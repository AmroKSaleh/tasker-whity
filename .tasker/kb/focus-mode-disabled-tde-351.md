# Focus Mode Disabled (TDE-351)

_KB entry · source: agent · READ-ONLY mirror (edit via create_kb_entry/update_kb_entry over MCP)._

## Focus Mode Disabled — 2026-07-02

**Status**: DISABLED pending redesign. Full-screen "one thing" work surface removed from UI. Code preserved in git history.

### What Was Removed
- **FocusOverlay.jsx** → now a null stub
- **ProjectBoard.jsx UI paths**:
  - Focus button from board header
  - FOCUS button from individual task cards (hover)
  - "Resume in Focus" action from Now Band chips
  - All `showFocus` / `focusTaskId` state

### The Core Tension (Why It's Disabled)
Focus Mode was built around **humans executing tasks** (step plans via AI, session timer, motivational rationale). It predates the "Tasker is the agent execution layer" architecture, where the AI does most work and humans steer.

**The conflict**: The Now Band now routes in-flight (AI-worked, `in_progress`) tasks into Focus via Resume-in-Focus buttons. But Focus's task ranker **deliberately excludes** `in_progress` tasks — it only surfaces pending work. So the surface has a split identity:
- Is it a deep-work cockpit for humans? (implies: show me work I should do)
- Or is it a steering view for AI-executed work? (implies: let me guide what's in flight)

These are incompatible design goals. **TDE-351 will resolve this fork before rebuilding.**

### How to Recover
1. Check git log for the original FocusOverlay.jsx (commit before 2026-07-02)
2. When TDE-351 is ready, re-read the full code context via `git show <commit>:V2/app/src/components/focus/FocusOverlay.jsx`
3. Redesign from first principles answering: Is Focus for human deep work, AI steering, or a hybrid? How does that change the UI, the ranker, the Now Band integration?

### Related
- **TDE-351**: Rethink the focus mode (redesign task)
- **In-app AI decision (2026-06-30)**: kept intentional in V2/app; Focus relied on Gemini layer (`generateFocusReason`, `generateFocusSteps`, `chatAboutTask`)
- **Now Band redesign (2026-07-02)**: Resume-in-Focus is currently disabled along with the surface
- **Execution Layer decision (2026-06-19)**: Tasker IS the agent execution layer; web app is inspector pattern

