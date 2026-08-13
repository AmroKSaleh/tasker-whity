# Flow's Messaging Angle

_KB entry · source: user · READ-ONLY mirror (edit via create_kb_entry/update_kb_entry over MCP)._

The hard truth first
A modern coding agent already does most of this. Claude Code can break work into steps, persist them (native Tasks now write to the filesystem and survive context clears), execute them, self-validate (run the linter/tests), iterate when something fails, and move on. "Do task 1, check it, fix if broken, do task 2" is native agent behavior — it's literally what happens when you say "implement X and make the tests pass." Spec Kit, Cursor's agent mode, and others do versions of this too.

So the skeptic's question is fair and sharp: if the agent already plans, executes, validates, and iterates — what is Tasker Flows actually adding? And the honesty is: a chunk of what we described (ordering, persistence, self-iteration) is getting commoditized by the platforms, fast. If Flows' pitch is "orchestrate multi-step work with checks," you're building a nicer wrapper around something Claude Code increasingly does for free — and you'd be selling it to the one audience (dev/MCP) that already owns the capable agent. That's the trap.

What's actually different — and it's narrow but real
Two things survive that honest scrutiny:

The contract is authored by the human and enforced externally — the agent isn't grading its own homework. When an agent self-validates, it decides what "good enough" means in the moment, and its famous failure mode is hallucinated completion — declaring success prematurely. A Flow lets you pre-declare the bar for each handoff ("draft must hit the brief, 3 sources, 1000 words"), and that bar is checked every run, independent of the agent's in-the-moment judgment. It's an external, persistent quality gate the agent can't quietly lower. That's a genuine guardrail agents don't give themselves.

It's a durable, visual, shareable artifact — not a transcript that scrolls away. The agent's plan lives in a terminal and evaporates. A Flow is a persistent object: you see it (Blueprint), edit it, reuse it as a template (TDE-152), watch which handoffs passed/failed, and hand it to a different agent or a teammate. The agent's native task list is locked to its own tool and run; a Flow is cross-tool, cross-session, cross-person.

So the defensible one-liner isn't "Flows orchestrate your agent" (the platform does that). It's: "Flows are the human-owned, visual, reusable contract layer over agent work — the quality bar and the map the agent doesn't give you."

The strategic implication (and it's the same lesson as before)
This is exactly the "be the lens, not the store" tension from earlier in the session, wearing new clothes. Don't bet Flows on execution/orchestration — that's the commoditized layer the platforms are racing to own, and you'd lose. Bet it on the parts they structurally don't provide: the human-authored contract, the visual persistent artifact, and reusability. The agent is the engine; Tasker is the map, the contracts, and the rearview mirror.

If we build it that way, it's differentiated (narrowly, honestly). If we build it as "Tasker runs your agent in a loop," it's redundant the day Claude Code ships the next Tasks update.

So my honest recommendation before we finalize: keep the agent-executed-via-MCP mechanics you chose, but position and design the value around the contract + visual + reuse layer, not the orchestration. The orchestration is just the plumbing that makes the contracts get checked.

Does that reframing change how you want to prioritize 137 — i.e., should the contract/validation/feedback part be the heart of it (with execution as thin glue), rather than building a big "flow runner"?

---

## Background & the reasoning that produced the angle above
(Captured 2026-06-04, during the design discussion for TDE-137 "Implement task input/output with validation & feedback loops" in the Flow Integration section.)

### The broader strategic frame this sits inside
- **Two audiences** (established earlier this session): (a) the dev who lives on GitHub and uses Tasker via the MCP; (b) the non-dev "AI-native builder" who uses the Tasker web app directly. Flows were decided to be **exclusive to the dev/MCP audience**.
- **"Be the lens, not the store"** — the recurring strategic spine: the platforms are commoditizing the underlying "store"/execution layers (free, native), so Tasker should own the human-legible, relational, visual layer *over* that work, not compete on the commoditized substrate. The Flow-messaging conclusion is a direct application of this same spine.
- **Repo-native direction** and the manual-push safety principle (agents shouldn't touch the live repo unattended) also shaped the "supervised autopilot" stance below.

### The market reality that forced the honesty
The honesty above was triggered by a concrete competitive read:
- **Claude Code native Tasks** — filesystem-based task DAGs that persist across context clears (~/.claude/tasks), Ctrl+T to view, multi-session coordination via CLAUDE_CODE_TASK_LIST_ID. Free, platform-native.
- **GitHub Spec Kit** (~90k stars) — Spec → Plan → Tasks → Implement, 30+ agent integrations, free, plaintext-in-repo.
- **Cursor agent mode** and others — autonomous multi-step execution with self-verification.
Together these commoditize the "ordering + persistence + self-iteration" that a naive "workflow engine" pitch would rest on. Hence: don't build/market Flows as orchestration.

### The design choices the user made for Flows (which the angle assumes)
1. **Agent-executed via MCP.** Tasker = the recipe + the head chef's clipboard (holds steps, order, each step's I/O contract, and state). Claude Code = the cook (reads the clipboard, does the work, reports back). Execution loop: ask MCP for flow order → read task + its contract → do the work → record output → validate → pass (advance) or fail (iterate/reopen). Validation's *semantic* judgment is done by the **dev's own Claude** (free to Tasker); Tasker does only cheap deterministic checks + holds the contract + stores feedback. Tasker makes NO paid AI calls.
2. **Dev/MCP-exclusive.** This is what makes validation free (the dev's Claude judges) and sidesteps the in-app-AI cost decision (TDE-169) for this feature. The non-dev web-app audience does not get Flows.
3. **Active reopen/flag upstream + trigger regeneration** on validation failure (a self-correcting pipeline, not a static checklist).

### The automation stance + guardrails (locked)
- **Supervised autopilot, NOT fire-and-forget.** For fully agent-doable flows it can run start→finish largely hands-off, but it pauses at: human-only steps (decisions, approvals, real-world actions), outward/risky actions (per the manual-push rule), and unresolved validation failures. The validation gates are what make multi-step automation *trustworthy* — errors are caught at handoffs instead of compounding silently.
- **Retry cap:** regenerate up to **3 times**, then pause and ask the human.
- **Reopen target:** reopen at most **2 tasks upstream**, then stop and ask for human intervention (prevents auto-cascade rewriting half the project).

### The reframe this produced for TDE-137
137 becomes **the contract layer, not the engine.** The agent is the engine (it already orchestrates + self-iterates). 137's heart = let the human author quality contracts between steps, persist them, check them at each handoff, route structured feedback back. Execution is thin glue (MCP hands the agent "next task + contract + feedback"). Position/design the value around **contract + visual + reuse**, not orchestration.

### 137 ↔ 156 boundary (decided)
- **137** = author contracts + validate a single handoff + store feedback + reopen the failed task (the foundation; shippable alone).
- **156** = the multi-step revision *loop* — the 3-tries / ≤2-upstream auto-regeneration cascade across the flow.

### Note on what already exists
The MCP tools set_task_input / set_task_output / validate_output / get_validation_feedback and the input/output data model already ship (migration 20260529120000_add_task_io.sql). The reframe means *upgrading* input/output from a thin "type" into a real human-authored contract, and having validate_output delegate semantic judgment to the agent rather than implying server-side AI.

