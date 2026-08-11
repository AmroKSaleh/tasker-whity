# Linear deep-dive → Linear Stuff build map (TDE-368 follow-through, 2026-07-10)

_KB entry · source: agent · READ-ONLY mirror (edit via create_kb_entry/update_kb_entry over MCP)._

Four parallel research sweeps of Linear (agents platform, MCP server + developer API, core product docs, Method/positioning — all fetched live 2026-07-10) distilled into the **Linear Stuff** section: 23 build tasks, each a Linear mechanism translated to Tasker's wedge (durable, human-shared, quality-gated state; solo/AI-native audience; pull-based MCP). Extends KB "Competitive: Linear is now 'for teams and agents'" (TDE-368).

## The build map (TDE-374–396)
**Agent legibility:** TDE-374 session ledger (typed activity log, derived lifecycle state — their AgentSession/AgentActivity, pull-shaped; overlaps TDE-362), TDE-375 identity & delegation (actor provenance on writes, delegated_to, human stays owner — feeds TDE-363), TDE-383 attention pull (pending guidance + get_my_attention; MCP-only, no inbox UI), TDE-384 flow stop signal, TDE-382 guided review narrative (their Guided Reviews thesis "review is the bottleneck" = our positioning; feeds TDE-261/348).
**State ↔ real work:** TDE-376 magic words + branch names (commits/PRs drive task state; review gate intercepts auto-close — we verify where Linear just closes), TDE-377 outbound webhooks (pull→push; copy their payload/HMAC anatomy), TDE-387 URL-idempotent labeled links + reverse lookup (data layer for TDE-313).
**MCP hardening:** TDE-378 tool-surface diet (they get flamed at 42 tools/~12.8k tokens; we carry ~150 — most exposed flank; extends TDE-371/372), TDE-389 scoped tokens (read-only keys, env-grant enforcement — the pending MCP piece of TDE-359/360; OAuth 2.1+DCR later), TDE-379 duplicate defense (similar-task at create + merge-as-duplicate; live disease: the ~11 Waqtak dupes).
**Durable-state hygiene:** TDE-385 auto-archive/undelete/stale flags, TDE-386 @-references with backlinks (advisory only — flows stay the sole dependency mechanism), TDE-390 task templates, TDE-391 milestone upgrades (in_progress state, checklist→milestones, gated auto-complete), TDE-395 Conductor triage verbs (per-connector stays locked; steal accept/decline-with-reason/snooze-until-time-OR-activity/merge).
**Human surfaces:** TDE-381 project updates (health enum + server-computed delta since last update — the sleeper feature; extends TDE-160), TDE-392 Today attention ramp, TDE-396 slim Cmd+K, TDE-394 tasker.new prefilled deep link.
**Public positioning:** TDE-380 Tasker Method essays (doctrine layer; opinions pre-sold as philosophy), TDE-388 public changelog + docs-as-.md, TDE-393 Tasker AIG (publish the __init directive playbook as a named contract).

## Validated — already have it, market it, don't rebuild
Their promptContext bundle = our get_task context injection (incl. tiering); their 3-level agent guidance = our IS hierarchy (default/project/flow; TDE-63 adds section); their session Plans = our milestones; their My-Issues "Focus" mode = our Today page (they ship as a mode what we made the landing page); their AIG = our directive playbook, unpublished.

## Deliberate skips (with reasons)
Hosted coding sessions/agent compute (competes with Claude Code; inverts execution-layer positioning), first-party do-everything agent (destination-product move; in-app AI stays scoped to non-MCP users), agent SDK + integrations directory (ecosystem play, team scale), GraphQL API + complexity budgets (MCP is our API), local-first sync engine + native apps (months of infra; buy the feeling via MCP response discipline), estimates/cycles/SLAs/insights/customer requests (team sprint arithmetic), full diff/code-review surface (duplicates GitHub), the "Linear Look" aesthetic (named, commoditized trend — editorial identity is the lane), app-wide triage inbox (locked: Conductor is per-connector).

## Pricing principles (for whenever Tasker prices — no task yet)
Agents NEVER seat-priced (Linear: "agents incur no billable seat costs" — charging per agent punishes the behavior we want); meter durable OBJECTS (projects/flows/validated artifacts), not humans; isolate genuinely expensive compute (judge/validation runs) into credits rather than raising base price; free tier gates objects-not-collaborators = durable-state lock-in mechanic (their 250-issue/unlimited-members free tier).

## Strategic frame
Linear's whole agent stack is PUSH (webhooks into hosted remote agents, team workspaces); Tasker's is PULL (MCP inside the user's own agent session, solo). Every mechanism above was translated push→pull, not copied. Their momentum ("Issue tracking is dead," 75% enterprise agent adoption, agents authoring 25% of issues) validates the category shift while leaving the solo, cross-tool, verification-enforcing lane open — quality-gated remains the load-bearing wedge leg they don't have: they attribute accountability; we enforce it.
