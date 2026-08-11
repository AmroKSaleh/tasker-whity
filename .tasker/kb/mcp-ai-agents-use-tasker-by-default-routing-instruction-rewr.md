# {mcp} (ai) Agents-use-Tasker-by-default — routing instruction rewrite; local-first rejected (TDE-404)

_KB entry · source: agent · READ-ONLY mirror (edit via create_kb_entry/update_kb_entry over MCP)._

TDE-404 was titled "Implement Local-First Task Rapid Response Architecture" but the real goal (surfaced in discussion) was ADOPTION: make an agent that has Tasker connected reach for Tasker for DURABLE work instead of its platform-native to-do list (TodoWrite / Cursor todos).

## The decision
Fix adoption with a **words-only MCP instruction rewrite** — NOT a local-first file architecture, NOT presence files/hooks.

Two strings edited in `V2/supabase/functions/mcp/index.ts`, both pure content (no code/schema/tool changes):
1. `TASKER_SERVER_INSTRUCTIONS` "YOUR NATIVE TASK LIST vs TASKER" paragraph (~L560) — returned in the `initialize` handshake, so it loads into EVERY MCP client's context before any tool call. Rewrote PASSIVE → ACTIVE: from "don't mirror sub-steps into Tasker" to "is this DURABLE? → create_task, not your native list," with durable-vs-transient examples.
2. New `ASSISTANT_DIRECTIVES` entry "DURABLE WORK BELONGS IN TASKER" (~L576) — returned by `__init_tasker_session`, reinforcing the same rule in the full playbook.

## Why local-first was rejected (the non-obvious part)
- **Architecturally impossible here:** the original design said "the MCP server acts as a background daemon that watches the local .tasker/board.json." Our MCP is a **hosted, stateless Supabase edge function** — it cannot watch a file on the user's disk. A daemon would require shipping a persistent local process = a second product.
- **The stated pains were already solved / not real:** token bloat → already handled by MCP context tiering (a local board would RELOAD the whole schema, making it worse); latency → "basically fine"; offline → hypothetical.
- **Off-wedge:** making single-machine local files authoritative contradicts the positioning wedge ("durable, human-shared, quality-gated state"). The two "key challenges" (conflict resolution, validation-lag rollback) only exist BECAUSE the local file was made authoritative — don't make it authoritative and both evaporate.

## Why words, not presence files/hooks
CLAUDE.md snippet and SessionStart hook are STRONGER engagement signals but each needs per-repo or per-machine setup — that leaks friction onto the user and undercuts "by default." The instruction rewrite is **zero user setup** (rides the MCP server the user already configured) and **cross-client** (Claude Code + Cursor + Windsurf all read MCP serverInstructions).

## Key mental model: the A/B split
- Job A — execution scratchpad ("read file X", "run the test", "fix line 40"): transient. Native list KEEPS this; do NOT mirror into Tasker (floods the spine with noise).
- Job B — durable ledger (real tasks, bugs found in passing, assigned work, tracked decisions): Tasker OWNS this.
Tasker should own B and explicitly NOT swallow A. This is exactly the line the server instructions now draw actively.

## Honest limit
This is a strong DEFAULT, not a lock — an MCP server cannot disable a host's built-in TodoWrite. We win the default, not a hard prohibition.

## Deferred follow-up (gated on the CC plugin)
When Tasker ships as a Claude Code **plugin**, plugins can bundle hooks (`hooks/hooks.json`), so a SessionStart hook that auto-inits Tasker + surfaces the ready queue installs with the plugin — strongest CC engagement signal, zero incremental setup. Still CC-only, so the instruction rewrite stays the portable floor for Cursor/Windsurf. Do not build until the plugin exists.

## Verification pattern (reusable)
For instruction-string changes: deploy, then `POST {"method":"initialize",...}` to the live function and assert `result.instructions` contains a distinctive new phrase. Froze this as a kind=check gate on TDE-404 — PASSED (HTTP 200, phrase "ROUTE DURABLE WORK HERE, BY DEFAULT" present).
