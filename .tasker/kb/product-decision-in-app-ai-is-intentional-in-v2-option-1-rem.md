# {product} Decision: in-app AI is INTENTIONAL in V2 — Option-1 removal (TDE-123) retired

_KB entry · source: agent · READ-ONLY mirror (edit via create_kb_entry/update_kb_entry over MCP)._

DECISION (user, 2026-06-30): Keep all in-app AI in the live V2 web app. Do NOT remove it. TDE-123 ("Remove in-app AI features") is closed as OBSOLETE — it was written in the Option-1 era ("standalone app, zero in-app inference, all AI via MCP"), a stance V2 deliberately abandoned.

## Why keep it
In-app AI serves NON-MCP web users (indie hackers / solopreneurs — part of the Foundation audience) for whom it is the ONLY AI available. MCP users find it redundant, but it costs them nothing. Option-1 implicitly assumed every user is on an MCP client; that's false for the stated B2C audience.

## Where in-app AI lives (all KEPT, all live in V2/app)
- lib/gemini.js — inference lib (~750 lines); lib/aiSettings.js — provider config + BYO-key storage
- NewProjectModal.jsx — "✦ AI" project builder (discuss-to-build + generate-from-description)
- FocusOverlay.jsx — Focus mode's "why this is your focus" + AI step plan + "discuss this task" chat
- TaskDetailPanel.jsx — task discuss + synthesize-to-context
- ProjectBoard.jsx — scanProjectFlags (auto problem-surfacing on context edit)
- SettingsPage.jsx — AI-provider settings panel (provider/key/test)
- section-chat edge function — still deployed on prod (v7), intentionally left

## DO NOT re-open this as "cleanup"
A future session scanning the code will find live Gemini calls and may think TDE-123 is unfinished. It is not. The removal was a retired strategy, not pending work.

## One open cost consideration (NOT acted on)
gemini.js defaults to a built-in Gemini key (VITE_GEMINI_API_KEY). If that key is set in prod, the OWNER pays for default-path inference (focus/builder). If/when inference cost becomes real, the cheap fix is BYO-key-only (drop the built-in key) — which preserves every feature. This is the only part of the old Option-1 worry still worth a future look.
