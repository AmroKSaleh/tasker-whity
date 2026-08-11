# Case: Brand DNA Drift in Image Prompts — context placement & conformance (2026-06-14)

_KB entry · source: user · READ-ONLY mirror (edit via create_kb_entry/update_kb_entry over MCP)._

# Case Study: Brand DNA Drift in Image Prompts

A real incident during the WCP (Waqtak Article Production) Article 5 run that exposes several Tasker design questions about WHERE knowledge lives and whether it actually governs work. Captured verbatim + analyzed for product implications.

## What happened (timeline)
1. Built a 10-step contract-gated article-production flow in WCP, plus a reusable template section.
2. The user provided a detailed "Waqtak Visual Identity" image-generation guide. It was first saved as a project Instruction Set (universal). We then realized a project IS injects into EVERY task in the project (unscoped), which is noisy for non-image tasks.
3. We compared the ways to hold the guide:
   - Project IS: auto-injected, but unscoped (every task).
   - KB entry: scoped by reference, BUT the agent must remember to fetch it, AND there is no single-entry fetch — `list_kb_entries` returns titles only, `get_knowledge_base` returns ALL entries' content. So referencing one entry forces loading the entire KB.
   - Flow KB (`get_flow_kb`): auto-loaded, but flow-WIDE (every task in the flow), not task-scoped.
   - Task-embed: put the guide text directly in the relevant task's context — auto-loaded via get_task AND scoped to that task.
   We chose pure task-embed.
4. I embedded the guide into the TEMPLATE task only. Article 5's tasks had been hand-created earlier and were NOT copies of the template, so Article 5's task 4 never actually contained the brand DNA.
5. When asked to "perform task 4 again," I generated the image prompts from this conversation's memory (retrofitting my earlier, pre-guide prompts) instead of opening the task and conforming to an embedded guide.
6. Result: four brand drifts — (a) navy blazer used in a Problem-State image (navy is a Solution neutral), (b) diversity of characters omitted, (c) loose "color-coded" wording that could pull off-palette colors, (d) alert color undefined (a genuine gap in the guide).
7. The user caught it ("are you sure these follow the guide?"), prompting a rule-by-rule audit that found the drifts, then asked the key question: is it the guide's fault or something else, and am I using Tasker correctly (the brand DNA should be in the task's context).

## The diagnosis (verbatim)
"Good challenge. The honest diagnosis: it's mostly me, partly the guide, and yes — partly a Tasker-usage mistake I made. Breaking it down:

1. Three of the four drifts are my execution error, not the guide.
The guide clearly states diverse characters, the Problem palette (no navy), and teal/cyan+neutrals only. The guide is right; I just didn't write the prompts from it line by line. I retrofitted my earlier, pre-guide prompts and lightly repainted them — so my old generic "navy/charcoal blazer" and loose "color-coded" wording survived, and I never added diversity. That's sloppy generation, not a guide defect.

2. One drift is a genuine guide gap. The alert color is undefined — the guide says teal/cyan = data, bans warning colors from the palette, but never says how an alert should read. That one's on the guide and needs your decision.

3. The Tasker-usage mistake — and you've put your finger on it. The brand DNA should be in the task's context, and that's exactly the principle we set up. But:

I embedded the Visual Identity into the template task (Create image prompts in the template section), not into Article 5's own task 4. Article 5's tasks were hand-created before we embedded the guide, and they aren't copies of the template — so this article's task 4 never actually contained the brand DNA.
And when you said "perform task 4 again," I generated from this conversation's memory instead of opening the task and conforming to an embedded guide. So even the embed I did make wasn't driving the work.
So the system you designed is sound; I just didn't honor it on this run. The guide being in the task only helps if (a) it's in this task and (b) the executor actually conforms to it rule-by-rule.

The fix, properly this time:

Embed the Visual Identity into Article 5's task 4 context (so it's actually present where the work happens).
Regenerate the four prompts strictly from that guide, with an explicit rule-by-rule self-check (diversity, Problem-State palette/no-navy, teal-cyan+neutrals only, state purity).
You decide the alert-color gap so I can lock it.
Want me to do 1–2 now, and what's your call on the alert color (e.g. keep alerts within teal/cyan as an intensity/pulse cue, or allow a single warning accent in Solution State)?"

## Comprehensive analysis — why it happened

### Root cause 1: Context presence is necessary but not sufficient
Even when guidance is in the task context, the work is only correct if the executor actively conforms to it rule-by-rule. I generated from conversational memory and retrofitted prior drafts, so the guide did not actually drive the output. Lesson: "knowledge is in context" does not guarantee "output conforms to knowledge." Conformance must be enforced, not assumed.

### Root cause 2: Knowledge was embedded at the wrong scope
The guide lived in the TEMPLATE task, not the live Article 5 task. Template-embedding only propagates if tasks are instantiated FROM the template. Two failures combined:
- Flow-template instantiation is not yet available to the user, so the template can be saved but not used to spin up new article sections.
- Article 5's tasks were hand-created and predated the embed, so they never inherited it.
Result: a silent gap — the task that did the work looked set up, but lacked the governing context.

### Root cause 3: Source-of-truth drift
I treated my earlier prompts as the base and "repainted" them, rather than regenerating from the canonical guide. Old wording (navy blazer, "color-coded") survived because the canonical source was never the starting point.

## Why this reinforces Tasker's importance (product implications)
This incident is a concrete argument that Tasker's core value is making the RIGHT context and the RIGHT quality gates travel WITH the work. Specific gaps it surfaces:

1. **Task/section-scoped auto-injected Instruction Sets.** Today the choices are project IS (auto but unscoped) or KB (scoped but must be fetched). The sweet spot — auto-injected AND scoped to a task or section — does not exist natively. That sweet spot would have put the brand DNA exactly where it was needed without polluting other tasks. (See Core App: section/task-scoped IS.)

2. **Single-entry KB fetch (`get_kb_entry`).** KB content is all-or-nothing: titles via list, full dump via get_knowledge_base. Referencing one entry forces loading the whole KB, which gets worse as the KB grows and discourages the scoped-reference pattern. (See Core App: get_kb_entry.)

3. **Template inheritance / instantiation gap.** When instantiation isn't available, duplicated or hand-created tasks silently miss template context. Section duplication should carry embedded task context, and flow-template instantiation should ship.

4. **Conformance enforcement via contracts/validators.** The flow's contract + validator mechanism is precisely the antidote to "the executor didn't conform." A brand-compliance validator on the image-prompt task (checking each prompt against the embedded guide) would have caught all four drifts. But the Article 5 run used a plain working section with NO contracts, so nothing checked. This argues for: (a) running real work through contract-gated flows, and (b) validators that grade output against embedded reference material.

## Recommendations
- Build section/task-scoped Instruction Sets (auto-inject only within scope).
- Build `get_kb_entry(entry_id)` for single-entry content fetch.
- Make section duplication carry embedded task context; ship flow-template instantiation.
- Promote contract validators that check output against embedded guides (e.g. a brand-compliance gate on prompt/asset tasks).

## One-line takeaway
Putting knowledge "in the system" is worthless unless it is (a) scoped to where the work happens, (b) actually loaded by the executor, and (c) enforced by a gate. Tasker's job is to guarantee all three; this case shows what breaks when any one is missing.
