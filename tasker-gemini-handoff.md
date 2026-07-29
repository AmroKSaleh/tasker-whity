# Tasker — handoff for Antigravity / Gemini

**Written 2026-07-29 by the outgoing Claude Code session.** The user is switching agents for a few days (token budget), so this is written for *you*, an agent picking up cold. Everything here is verified, not remembered — but verify anything load-bearing before you rely on it, because you are reading a snapshot.

---

## 1. Read these first, in this order

1. `mcp__tasker__` → call **`__init_tasker_session`**. It returns the user's preferences and the full directive playbook. Follow those directives; they are not advisory.
2. Then **`get_my_attention`** (project `TDE`) — the "what needs me" triage.
3. Then the KB entry **"Session roll-up 2026-07-28/29"** in project TDE (`list_kb_entries` → `get_kb_entries`). It is the map of what just happened.

Tasker is the user's own product **and** their task tracker — you will use the MCP to manage work on the app the MCP belongs to. That is intentional (dogfooding), not confusion.

---

## 2. State of the world right now

**Everything described below is LIVE.** The MCP edge function and the Netlify frontend are both deployed with all of it.

| Thing | State |
|---|---|
| `main` | `c8aa903`, pushed, clean |
| `tde-811-honest-flow-progress` | pushed, **1 commit ahead of main, NOT merged** |
| `tde-382-flow-exceptions` | pushed, **2 commits ahead** (stacked on TDE-811), NOT merged |
| Working tree | clean |
| Migrations applied remotely | `20260728120000_task_events.sql`, `20260729120000_flow_step_list_open.sql` |

### ⚠ THE DEPLOY HAZARD — read before you deploy anything

`main` does **not** contain TDE-811 or TDE-382, but the **live MCP does**. If you deploy the edge function from `main`, you silently revert two shipped features. Deploy from `tde-382-flow-exceptions` (it contains both), or get the branches merged first.

This is a recurring shape in this repo: branches stack, and live state runs ahead of `main`.

---

## 3. What shipped in the last session (six tasks)

The theme: **the system stopped asserting things it could not support.**

- **TDE-818** — `task_events`, an append-only gate-history log + `get_task_history`. Contract/review/validation changes used to be in-place overwrites, so a human's contract confirmation could be silently erased and review attempt 1's critique was gone by attempt 2.
- **TDE-819** — nine handlers that bypass `update_task` (complete_task, uncomplete_task, move_task, move_task_to_group, set_task_phase, merge_task_as_duplicate, resolve_seed, get_task autostart, advance_guide) now record lifecycle changes with `meta.via`.
- **TDE-820** — `name_flow` no longer blocks on contracts. `contractAdvisories()` separates *ungated / vague / unblessed* and blocks on none.
- **TDE-813** — Flows UI: ungated flows were invisible on every surface at once. Closed.
- **TDE-811** — `flows.step_list_open`. `run_flow` used to print "COMPLETE" and return early whenever the *known* steps ran out, which for discovery-shaped work happens at every pause.
- **TDE-382** — `get_flow_exceptions`, the human review surface: failed checks + evidence, judgment residue, terminal output, ordered by blast radius.

**Two new MCP tools exist that your client may not have loaded yet: `get_task_history` and `get_flow_exceptions`.** If they are missing from your tool list, restart your client.

---

## 4. Non-obvious traps — these cost real time last session

1. **`resolveTask` selects a FIXED column list.** It does *not* include `priority`, `due_date`, `pinned`, `executor`, `group_id`, `agent_ready`, `completed_at`, `phase_id`. Deriving a "before" state from a `resolveTask` result silently omits those, and writing `?? null` records a **false** prior value. This bit four separate times. If the value is not cheaply available, omit the field rather than assert null.

2. **`get_task` mutates.** It flips a `pending` task to `in_progress` as a side effect. A read-only survey of N tasks marks all N as started. **Use `peek: true` to inspect without mutating.** (Last session this flipped 8 tasks and they had to be reverted by hand — which is *why* TDE-819 now records `get_task_autostart`.)

3. **Short IDs are reused.** When a task leaves a project, its number is handed out again. An old reference like `TDE-820` may now resolve to a *different* task.

4. **`create_task` returns only a UUID, not the short ID.** Do not infer the short ID from sequence — read it back with `list_tasks`. Inferring it produced a real, propagated error last session (see §7).

5. **Contract-gate logic is MIRRORED in two places** and drifts: `V2/supabase/functions/mcp/contract_gate.ts` (server, authoritative) and `V2/app/src/lib/flowGraph.js` (client). Last session the *client* was the more current of the two — do not assume the server is ahead.

6. **`deno check index.ts` reports 32 errors, and that is the clean baseline.** The project transpiles rather than strict-checks. Compare your error count to 32; if it is 32 and none of them name your new identifiers, you introduced none. Do not try to fix the 32.

7. **Edge-function deploys propagate with a lag** (~30–60s). Re-verify before concluding you have a bug.

---

## 5. How to work here (the user's standing rules)

These come from the user's persistent preferences. They are not negotiable defaults — breaking them caused visible friction last session.

- **Explain before building.** When the user names a task (`TDE-X`), first explain in plain terms what it *is*, then give an honest read, *then* proceed. Do not jump straight to executing. (I broke this once and was pulled up on it.)
- **Never merge to `main` without the user explicitly saying so** — including clean fast-forwards. Branch per feature, commit, push, and wait. (I fast-forwarded once by reflex and had to undo it.)
- **Deploys:** frontend → Netlify (`npx netlify-cli deploy --prod --dir=dist` from `V2/app`, after `npm run build`). MCP → `npx supabase functions deploy mcp --no-verify-jwt` from `V2`. Never build an APK unless asked. **You run the deploys** — do not ask the user to.
- **Destructive live tests use a dedicated throwaway task/flow.** Create → test → **delete**. The board should end at zero throwaways. Watch out: last session I deleted a fixture that a task had deliberately left in place for verification — read the task before cleaning up something that looks like junk.
- **Push back.** The user explicitly wants real disagreement, not validation. No sycophancy, no "great question". Lead with substance.
- **Write a KB entry before completing a task** if the work surfaced anything non-obvious (`create_kb_entry`).
- **Attach deterministic verification before completing.** `enable_task_review` with `kind: "check"` rules, actually run them, then `submit_task_review` with the raw `observed_value`. Completion is never blocked, but an unverified completion is durably marked `DONE (UNVERIFIED)`.
- Short IDs (`TDE-502`) in conversation, never UUIDs. No markdown tables for task lists. No numbering. Don't show done tasks unless asked.
- **Never run backup/copy/recursive-delete on the project directory** — junctions make recursive delete catastrophic. The user zips manually.

### Calling the MCP directly (useful escape hatch)
If a newly deployed tool is not yet in your tool list, you can POST JSON-RPC straight to the deployed function instead of waiting for a client restart. The endpoint and bearer token live in the user's `~/.claude.json` under `mcpServers.tasker` (`url` + `headers.Authorization`). Shape:

```json
{"jsonrpc":"2.0","id":1,"method":"tools/call",
 "params":{"name":"<tool>","arguments":{...}}}
```

Read the token from that file at runtime; **do not print it to a terminal or paste it anywhere.**

---

## 6. Where to go next — with the reasoning, so you can disagree

The Flows definition (TDE-792) is settled and now propagated to the directive, the UI, and the MCP gate. The user's own framing: *"Flows themselves have been rebuilt already — the Flows PAGES still need to be built."*

**Option A — TDE-816: rework the Flows page.** The biggest remaining Flows work. Its own text says it is BLOCKED on the "rebuild-or-refine decision" — but the user's statement above may have resolved that. **Ask them directly before starting.** Note two of its four problems are already handled: TDE-811 fixed the dishonest progress denominator at the data layer (the page just needs to read `step_list_open`), and TDE-382 built the exception surface it calls its own biggest gap. **TDE-816 should RENDER `get_flow_exceptions`, not reinvent it.**

**Option B — TDE-791: contract-gating experiment Round 2.** Highest leverage on the board. It is the single blocker on **three** items: TDE-796 and TDE-797 are deliberately held open waiting on it, and TDE-784's analytics are gated on it. The question (sharpened by Q7): not "does independent validation add value" but *"does an AI judge detect what a deterministic check misses, given correlated blind spots?"* Round 1 returned: contract proven, validation not. This is an experiment needing a genuinely hard subject task and the user's involvement — a session of its own, not a build.

**Option C — the small durable one.** `V2/app/src/hooks/useFlows.js` derives status as `doneCount === steps.length ? 'done'`, which ignores `step_list_open` and will roll an open flow up to "done" in the UI. One line. Left deliberately for the page rebuild, but harmless to fix now.

**Do NOT pick up TDE-812** (public docs). The user parked it on purpose — the docs get rewritten once, after things settle. Its scoping is already complete on the task.

---

## 7. Two errors from last session you will trip over

**The TDE-819 / TDE-821 mix-up.** The merge commit on `main` reads *"Merge TDE-821: lifecycle changes now recorded in gate history"* and its branch is `tde-821-lifecycle-history`. **The task is actually TDE-819.** The short ID was inferred rather than read, and TDE-821 was later consumed by a throwaway task. Code comments and KB entries were corrected; the pushed commit and branch name could not be. If you are tracing history: **`tde-821-*` == task TDE-819.**

**Four tasks are `in_progress` ON PURPOSE — do not tidy them up.** TDE-796 and TDE-797 are held open pending TDE-791 and say so explicitly in their own text. TDE-351 is an unstarted rethink. Closing them destroys real information. I recommended closing them once, was wrong, and checked before acting — do the same.

---

## 8. Unverified / open threads

- The append-only UPDATE trigger on `task_events` was never empirically fired (nothing can reach it: no tool updates the table, and RLS blocks the user path before the trigger). Creation is confirmed by the applied migration.
- The **Local Mode flush path** (`index.ts` ~1121) writes task fields directly from `.tasker/` files, so file-driven edits still leave **no** gate history. Deliberately deferred — different semantics (bulk reconciliation, LWW, `hub_wins`), needs its own decision.
- `tde-713-structure-manifest` is the one branch that exists **only locally** (never pushed). Unrelated parked work; left alone.
- Re-calling `name_flow` on an existing flow mints a **new** flow short ID (observed TDE-F4 → TDE-F5 on the same UUID). Documented wrong usage — use `update_flow_context` to rename — but it churns silently instead of erroring.
- The user's Tasker API key was printed to a terminal during last session. They assessed it as a non-issue and declined rotation. Mentioned only so you do not re-raise it.

---

## 9. One-paragraph orientation for the product itself

Tasker is an AI-native task manager whose positioning line is **"durable, human-shared, quality-gated state that persists across sessions, agents, and people."** The MCP is the primary interface, not an add-on; the web app is an inspector and a human gate. Flows are the moat: *a single operation too big for one sitting, cut into steps so it holds together across its length, and gated only where one step's output becomes the next step's unexamined premise.* Contracts are **optional** and belong only at seams. The human spends attention exactly three times — authoring the bar, reviewing exceptions (never outputs), and gating the terminal output unconditionally. Every feature should be judged by whether it makes that tighter.
