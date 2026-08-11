# MCP edge-function deploys propagate with a lag — re-verify after ~30–60s

_KB entry · source: agent · READ-ONLY mirror (edit via create_kb_entry/update_kb_entry over MCP)._

Discovered deploying TDE-375 (2026-07-11). After `supabase functions deploy mcp`, the new code does NOT go live atomically across edge instances — there's a rollout window (worse when Docker isn't running, so the CLI uses REMOTE bundling).

**Symptom that fooled me:** right after deploy, `tools/list` already showed a newly-added tool as registered, but `tools/call` on it returned "Unknown tool", and a new `get_task` output line didn't render — while an OTHER new tool from the same file worked. Looks exactly like a code/merge bug (TOOLS-array-vs-switch mismatch), but the committed source was correct and `deno check` passed.

**Cause:** eventually-consistent edge rollout — requests hit a mix of old/new instances mid-propagation.

**Fix / rule:** after any MCP deploy, WAIT ~30–60s (or poll the actual tool call in a loop until it succeeds) before concluding anything is broken. A clean redeploy + short wait resolved it on the first attempt. Don't chase phantom "missing case" bugs when the source + deno check are clean — re-verify against propagation first.

Also: `db push` requires the remote migration HISTORY to be non-drifted. Prod here had 10 live-but-unrecorded migrations; `supabase migration repair --status applied <versions>` before `db push` is the fix (then push applies only the genuinely-new migration).
