# Day Summary button shipped — v1 of the recap idea (TDE-160/TDE-323)

_KB entry · source: agent · READ-ONLY mirror (edit via create_kb_entry/update_kb_entry over MCP)._

TDE-323 ("Day Summary Button") was a near-duplicate of TDE-160 ("Session Summary button that recaps everything done") — merged per user decision 2026-07-06: closed TDE-323, built the first slice under TDE-160.

**What shipped:** a "Day Summary" button in the Today page masthead (`pages/TodayPage.jsx`, next to Focus) opening `components/today/DaySummaryModal.jsx`. Scope is fixed to **today only** — session-scoping, "since last summary," and arbitrary date ranges (all called for in TDE-160's spec) are NOT built yet; TDE-160 stays open for those.

**Mechanical, not AI-generated** (user's explicit choice): summarizes real DB timestamps — tasks completed today (`completed_at`), tasks created today (`created_at`), and KB entries created today (`project_knowledge.created_at`) — grouped by project, with a "Copy summary" plain-text export. No LLM call, so it's free, instant, and reproducible for any day regardless of whether an AI session happened.

**Known gap:** `sections` has no `created_at` column, so "sections created today" can't be included without a migration — left out of v1 rather than adding a column for a nice-to-have.

**Next step for TDE-160:** add scope selector (today / session / date range) reusing this same modal's grouping logic; the AI-narrated prose version is explicitly deferred, not rejected.
