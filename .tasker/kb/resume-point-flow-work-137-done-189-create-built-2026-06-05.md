# ▶ RESUME POINT — Flow work (137 done, 189 CREATE built) — 2026-06-05

_KB entry · source: user · READ-ONLY mirror (edit via create_kb_entry/update_kb_entry over MCP)._

# ▶ RESUME POINT — Flow Integration work (2026-06-05)

Read this FIRST on a new device to resume with no delays. Full design rationale: KB "137 Contract Layer — Design Decisions" and "Flow's Messaging Angle". Per-task detail: TDE-137/156/152/189.

## TL;DR — where we are right now
- **TDE-137 (contract layer): DONE.** Built, deployed live, committed (`4fa7655`), pushed, marked done.
- **TDE-189 (flow-authoring interview): CREATE mode BUILT** via the `build_new_flow` tool (deployed + verified live). Instantiate/templatize modes remain, blocked on 152. Task still in_progress.
- **Immediate next options:** (a) test-drive `build_new_flow` by actually building a real flow with the user (needs the MCP client reconnected to see the tool); (b) commit the build_new_flow changes; (c) move to TDE-156 (revision loop).

## 137 — AS BUILT
File: `V2/supabase/functions/mcp/index.ts`. No DB migration (input/output are jsonb; reshape is code + read-normalization, backward-compatible).
Data shapes:
- `input` = `{ edges: [ { source_task_id, expected_type?, contract: { rules: Rule[] } } ] }` (LIST of edges → fan-in; edges authoritative on input side).
- `output` = `{ contract: { rules: Rule[] }, validation_status, ledger?, validated_against?, validated_at? }`.
- `Rule` = `{ id, label, rule, description?, kind: 'check'|'judgment', severity: 'blocker'|'warning' }`.
Tools (changed/new in 137):
- `set_task_input(task_id, source_task_id, contract?, expected_type?, replace?)` — upserts ONE input edge; fan-in = one call per source.
- `set_task_output(task_id, contract)` — output contract; consumers derived.
- `validate_output(task_id, target_task_id?)` — PHASE 1, returns gate_rules (consumer input) + self_check_rules (producer output) + instruction; NO verdict (agent runs checks).
- `submit_validation_result(task_id, target_task_id?, results)` — PHASE 2; writes ledger, blocker gate → reopens producer; returns verdict.
- `get_validation_feedback`, `get_flow_order` (topo sort, multi-parent; flow = connected component), `get_task_connections` (all sources), flow-block checks in get_task/update_task/complete_task.

## 189 — AS BUILT (CREATE mode)
NEW tool `build_new_flow(project_id, goal?)` — a thin protocol dispenser. Returns: `instruction`, `grill_me_rules`, a 6-step CREATE `playbook` (ground → pin goal as final output contract → forward-decompose one Q at a time → author a contract per handoff → present whole flow → persist on confirm), `persistence` steps (create_task + set_task_output + set_task_input per source, then get_flow_order), and `project_context` (existing sections + up to 80 tasks for grounding). The agent runs the interview itself via AskUserQuestion; Tasker stays stateless about the interview. A pointer was added to ASSISTANT_DIRECTIVES (injected via __init_tasker_session) so the agent reaches for it.
DECIDED: forward decomposition default; contract = unit of task grain; ONE confirm at the END (137 contract-confirm + 189 flow-confirm collapse into it for CREATE); MCP-only.

## Repo & deploy state
- Repo: `github.com/Xardoxis/tasker`, branch `main`. **`4fa7655`** (137) is pushed.
- ⚠️ `build_new_flow` + the directive pointer are **deployed live but NOT yet committed** — `index.ts` has uncommitted changes on top of `4fa7655`. Commit before switching devices if you want them in git.
- MCP live: ref `rzjhmipbamyvpwlkfvxx`, endpoint `https://rzjhmipbamyvpwlkfvxx.supabase.co/functions/v1/mcp`. Deploy: `npx supabase functions deploy mcp --no-verify-jwt` from `V2/`.
- ⚠️ Also local-only/uncommitted (earlier, non-flow work): `V2/app/src/hooks/useTasks.js`, `V2/app/src/pages/SettingsPage.jsx`, migrations `20260604120000_enable_realtime.sql`, `20260604130000_add_api_key_plaintext.sql`.
- ⚠️ `.env.local` gitignored — recreate on a new device to run the frontend locally.

## New-device setup checklist
1. `git clone github.com/Xardoxis/tasker`. (NOTE: build_new_flow + earlier changes are uncommitted on the original PC — they live on the deployed MCP but not in git until committed.)
2. Register the Tasker MCP in `~/.claude.json` (key from Tasker Settings; endpoint above; `Authorization: Bearer <tsk_...>`).
3. **Reconnect/restart the MCP client** to pick up `build_new_flow`, `submit_validation_result`, and the new `contract` params.
4. (Frontend editing only) recreate `.env.local`; `npm install` in `V2/app`.

## Other open threads (not started)
- **TDE-156** — multi-step revision LOOP + AND-join (137 = single handoff; 156 cascades feedback ≤2 upstream, retry cap 3).
- **TDE-152** — Flow Templates (unblocks 189 instantiate/templatize modes).
- Deferred — "Decide: do flows/contracts surface in a UI…".
- Backlog — "Per-flow context…"; "Test: forward vs backward decomposition".

## Pointers
- KB: "137 Contract Layer — Design Decisions", "Flow's Messaging Angle".
- Tasks: TDE-137 (done), TDE-189 (active, CREATE built), TDE-156, TDE-152.
- Code: `V2/supabase/functions/mcp/index.ts`.

