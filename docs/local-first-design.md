# Local Mode — Local-First Projects Design (TDE-406)

**Status:** Agreed — reviewed with the user 2026-07-14; the four open questions are settled (see [Settled at review](#settled-at-review-2026-07-14)). Ready to build.
**Task:** TDE-406
**Builds on:** [`tasker-file-format.md`](tasker-file-format.md) (the `.tasker/` on-disk format, drafted earlier — adopted here with deltas)
**Supersedes in part:** the format doc's "repo is master, cloud never master" authority model (see D1)

---

## What this is

Opt-in, per-project **local-first mode**. When a project is created with local mode on
(default stays fully-online), its tasks are mirrored as files in a repo checkout on the
user's device(s). An AI agent works those files **directly** — read/write, no network
round-trip — and the changes sync to the online app, which acts as the **hub** keeping
every device consistent.

Agreed direction (from the TDE-406 discussion):

- Local files are **authoritative while an agent is working them**. This is the point —
  pure one-way projection was rejected because it kills local authoring.
- The online DB is the **sync hub** all devices sync *through*. Never peer-to-peer;
  multi-device consistency is the hub's job.
- Sync runs **frequently enough that divergence windows are seconds-to-minutes**, so
  conflicts are rare and a simple newest-wins rule is acceptable.
- **Not** the TDE-404 zombie: TDE-404 died on infrequent status-triggered sync → big
  divergence windows → conflict hell. This design's risk profile is different *because*
  the sync is frequent and bracketed (D7).

```
Device A                         Hub (Supabase)                  Device B
.tasker/ files  ── flush ──▶   projects/tasks DB   ◀── flush ──  .tasker/ files
      ▲          ◀── pull ──   (revision cursor,    ── pull ──▶       ▲
      │                         LWW arbiter)                          │
   AI agent                          ▲                             AI agent
 (reads/writes                       │                           (reads/writes
  files directly)                Web app (humans)                 files directly)
```

---

## Decisions

### D1 — Authority model: local-while-working, hub arbitrates

The local `.tasker/` is authoritative **during an active work session** on that device.
The hub is authoritative **between devices and over time** — it holds the canonical
revision history and arbitrates conflicts.

This **revises** `tasker-file-format.md`'s stated purpose ("the repo holds the project…
the cloud backend, if used, becomes an optional sync target — never the master"). That
doc was written for a fully repo-native vision. TDE-406 keeps projects **born online**
(accounts, sharing, review gates, org/RBAC all live there — the positioning wedge), with
local mode as an opt-in mirror. The fully-offline, no-account, repo-native mode is
**out of scope** — explicitly conceded, same as the wedge decision.

*Rejected:* repo-as-master (breaks multi-device without N-way merge; breaks the wedge);
online-as-only-truth / one-way projection (kills local authoring — the user's core want).

### D2 — On-disk format: adopt the existing spec, with five deltas

`tasker-file-format.md` v1 stands as the base: `project.json` (structure) +
`tasks/<ID>.md` (one file per task, YAML frontmatter + markdown body), stable slug IDs,
sparse ordering, flows derived from `input.from` edges. Deltas for local-first:

1. **`updated_at`** (ISO-8601, UTC) added to task frontmatter — the LWW anchor (D4).
   Stamped by whoever edits (agent or hydration); mirrors `tasks.updated_at` in the DB.
2. **Contract-bearing edges.** The format's `input: { from: BPW-4 }` short form stays
   for bare dependencies; when an edge carries acceptance rules it takes the full DB
   shape (`edges: [{ source_task_id, contract: { rules: [...] } }]`). `output` likewise:
   plain string when it's just a description, object with `contract.rules` when a
   def-of-done bar exists. Files carry **the bar** (what the agent needs to do the work);
   the validation **ledger** (attempts, verdicts, history) stays hub-side (D5).
3. **Task-level review bars** (TDE-261/344 judge) — `review.bar.rules` in frontmatter,
   same carry-the-bar-not-the-ledger rule.
4. **`context.md`** — a **read-only** snapshot of Foundation + Instruction Set + KB
   *index* (titles only), regenerated on every pull, never synced up. This gives a local
   agent the same grounding `get_task` injects online. Read-only ⇒ zero conflict surface.
5. **`.sync.json`** (gitignored always) — device-local sync state: last-pulled hub
   revision cursor, per-task content hashes at last sync (how flush computes its delta
   without a daemon or journal), and the leased ID block (D8).

### D3 — Sync protocol: cursor-based pull/flush, device ↔ hub only

Two operations, exposed as MCP tools (working names `pull_local_project` /
`flush_local_project`):

- **Pull:** device sends its revision cursor → hub returns every change since →
  device applies them to files (LWW against any local dirt, D4), regenerates
  `context.md`, tops up its ID lease, stores the new cursor.
- **Flush:** device diffs current files against `.sync.json` hashes → sends the delta →
  hub applies per-task LWW, bumps its per-project revision counter, returns the new
  cursor + anything that lost arbitration (which the device applies back to files).

Ping-pong is structurally impossible: devices only talk to the hub, and the cursor
means a device never re-receives its own flush. No webhooks, no third replica.

Change detection is **snapshot hashing** (compare files to `.sync.json`), not file
watching and not git — so it works with zero resident processes (D7) and is immune to
mtime unreliability.

### D4 — Conflict rule: per-task LWW by `updated_at`, hub as arbiter, tombstones for deletes

- Granularity: **whole task** (one file = one unit). Field-level merge is a v2 nicety;
  per-task matches the user's stated intuition ("the newer file is usually the desired
  one") and the one-file-per-task format makes it natural.
- Rule: newer `updated_at` wins. The hub arbitrates at flush time; timestamps from the
  future are clamped to hub receipt time (clock-skew guard). Ties → hub state wins.
- **Deletes need tombstones:** a task deleted locally is recorded in the flush delta
  explicitly (not inferred from file absence alone — `.sync.json` hashes make deletion
  detection reliable); the hub keeps a tombstone so other devices delete on next pull.
  Delete vs concurrent-edit: **edit wins** (resurrect rather than silently lose work).
- Why LWW is acceptable *here*: the bracketed sync cadence (D7) keeps divergence windows
  small, so the losing side of a conflict loses seconds-to-minutes of a single field
  change, not sessions of work. This is the engineering answer to "how do we get out of
  conflict resolution": don't solve merge — shrink divergence until merge stops mattering.

### D5 — Contracts: bars travel in files; the agent validates locally; verdicts flush to the hub

Key insight from reading the code: **validation execution is already the agent's job.**
`contract_gate.ts` is 128 lines of pure functions (rule linting, derive-from-consumers,
flow-finalization gate) — trivially reusable. The server never *runs* checks or judges;
the agent runs checks via Bash and spawns judge subagents; the server stores bars,
artifacts, verdicts, and computes gate *consequences* (regenerate / ask_human, attempt
counting).

So "contracts in the local env" (the user's ask) decomposes cleanly:

- **In v1, local:** the frozen bar rides in the task file (D2.2/2.3). The agent working
  locally sees the bar and executes validation exactly as it does online — same
  protocol, same directives. Zero porting of execution logic, because the agent *is*
  the execution logic.
- **In v1, hub-side at flush:** `store_artifact`, `submit_validation_result` /
  `submit_task_review`, and `complete_task` are **ceremonies** — one-shot calls at task
  completion, not hot-path. They go to the hub (via MCP) so the ledger, attempt
  counters, and gate consequences have a single source of truth. A local "done" is
  provisional for the seconds between writing the file and the flush confirming it —
  this closes the TDE-404 "validation lag" hole by construction.
- **v2, if ever needed:** a fully-offline gate ledger. Not now; the ceremonies are rare
  and cheap, and duplicating the consequence engine is exactly the two-copies burden
  KB f2a336ba warns about.

This honors the discussion's intent — *"we'll not use the MCP for work done in the
local env"* — for the hot path (read task / write status / edit detail / tick
milestone: all files, zero round-trips), while sync and gate ceremonies remain the two
moments the MCP is the right channel anyway (they're the durable/shared/gated moments —
the wedge itself).

### D6 — GitHub is the carrier, not the transport

The repo link (`projects.github_repo`, already exists) tells Tasker **where the local
mirror lives** — `.tasker/` sits in that repo's checkout, next to the code the tasks
are about. But **sync never flows through GitHub**: it's device ↔ hub, under the
existing MCP auth and RLS. No GitHub token needed for sync, no webhook, no
GitHub-as-third-replica doubling the conflict surface.

Committing `.tasker/` to git is **allowed and harmless** (nice history/diffs for free;
a stale `.tasker/` arriving via `git pull` is just old state that the next pull/flush
LWW-reconciles — hub timestamps win). Recommended default: **commit `tasks/` +
`project.json`, always gitignore `.sync.json` and `context.md`** (machine-local state
and a regenerated snapshot respectively). The existing GitHub features
(`github_sync_issues`, `github_push_file`) are orthogonal and unchanged.

*Rejected:* GitHub-as-sync-transport (hub pushes commits, devices pull, webhooks notify
the hub). Three replicas, a token+webhook surface, echo/ping-pong prevention, and git
merge semantics fighting task semantics — all cost, no benefit over direct sync, given
the hub already exists.

### D7 — Runtime: agent-driven sync bracket in v1; no daemon

The fork we deferred, resolved by an observation: **local files only matter while an
agent session is actively working them.** Between sessions nothing edits them locally,
so staleness is harmless — the next session's opening pull re-hydrates. The conflict
window only exists *during* sessions.

Therefore v1 needs **no resident process**. The agent brackets its work:

- **Pull before work** — opening a local project (or picking up a task in it): pull.
- **Flush after write** — after each meaningful batch of file edits (completing a task,
  finishing a work unit): flush. The MCP's directives teach this cadence, the same way
  they teach the task lifecycle today.
- A crashed/abandoned session leaves unsynced files; the next session's pull LWW-merges
  them. Nothing is lost beyond arbitration (D4).

"Continuous sync" from the discussion is thus implemented as **"synced at every work
boundary"** — during active sessions that *is* near-continuous, and outside sessions
continuity is unnecessary. This is the honest answer to why the daemon can wait.

*Deferred to v2 (likely plugin-bundled, per the TDE-404 follow-up):* a file-watcher
daemon for true continuous sync — needed only if humans start editing `.tasker/` files
by hand outside agent sessions, or a localhost web lens over the files materializes.

### D8 — Short-ID allocation: leased blocks

Task creation happens locally in the hot path, so IDs can't round-trip to the hub. On
every pull the hub leases the device a block of N short-IDs (e.g. 20) recorded in
`.sync.json`; local creation consumes the lease; flush reports usage; pull tops it up.
IDs are never reused, gaps are already fine (deleted IDs retire) — so an expired or
half-used lease costs nothing but gaps.

*Rejected:* temp IDs renamed at flush (breaks the agent's own in-session references —
an agent that just created `TDE-501` must not watch it become `TDE-507`); a shared
counter in `project.json` (the format doc itself flags this as its known multi-writer
conflict).

---

## v1 / v2 cut

**v1 — the local work loop:**
- Opt-in at project creation (+ enable/disable on an existing project), repo link;
  **owner-only** (no multi-grant projects in Local Mode)
- `.tasker/` format deltas (D2), `pull` / `flush` MCP tools (D3), LWW + tombstones (D4)
- Bars-in-files, ceremonies-at-flush (D5); `context.md` hydration; ID leasing (D8)
- MCP directives + a generated `.tasker/README.md` teaching agents the local workflow
- Web app: "local-enabled" badge on the project; nothing else changes for humans

**v2 — candidates, in rough order of pull:**
- Daemon / plugin-bundled watcher (true continuous sync, human hand-edits)
- Field-level merge (only if per-task LWW demonstrably loses meaningful work)
- KB entry sync (v1: index in `context.md` is read-only; entries stay online)
- Attachments/Drive files (v1: pointers only, binaries stay online)
- Localhost web lens over `.tasker/` (the format doc's original vision)
- Offline gate ledger (only if flush-time ceremonies prove limiting)

**Does not sync in v1:** notes/activity streams, KB entry bodies, Drive binaries,
review/validation ledgers (hub-side by design), org/sharing/grants (meaningless
locally), seeds' resolution machinery (seeds sync as tasks; resolving one is an online
ceremony).

---

## Settled at review (2026-07-14)

1. **Flush cadence: per work-unit** — flush after each completed work unit (task
   completed / handoff reached), not after every file write. Web view may lag ~minutes
   during an active session; accepted.
2. **Owner-only in v1** — Local Mode is gated to projects the user owns outright; no
   multi-grant/org-member local mirrors. Context: the user has **deprioritized RBAC
   substantially** — orgs and environments remain, but reframed as *personal
   organization* tools rather than multi-user access control. Per-task LWW across one
   person's devices is safe; across people it is not, and that case is now distant.
3. **Opt-in UI: both** — a flag in the creation modal AND a settings toggle on existing
   projects. The toggle only marks the project; the first pull does the hydration.
4. **Name: "Local Mode"** — use in all UI copy, docs, and tool descriptions.

---

## Build shape (after sign-off)

Multi-step with real handoffs — qualifies for a flow: schema/migration (project flag +
revision counter + tombstones + lease table) → sync engine in the MCP (pull/flush,
LWW, lease) → format loader/serializer (shared with the existing example; reuse
`contract_gate.ts` pure fns) → directives + generated README → web badge + opt-in UI →
dogfood on this repo (Tasker Development itself becomes the first local project).
Contracts on the handoffs: the sync engine's LWW/tombstone behavior is the step with
real quality risk — deterministic check rules (scripted two-device simulation) belong
there.
