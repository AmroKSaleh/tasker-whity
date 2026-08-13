# Flows: contract-gating experiment Round 1 — contract proven, validation not (TDE-212)

_KB entry · source: agent · READ-ONLY mirror (edit via create_kb_entry/update_kb_entry over MCP)._

Round 1 of the contract-gating efficacy experiment (TDE-212). Bespoke parse_duration task, hidden 27-case pytest oracle, 3 arms × N=5, Sonnet 4.6 (via subagents — no API). Pre-reg + harness: V2/docs/experiments/contract-gating-preregistration.md + V2/experiments/contract-gating/.

RESULTS: A (bare) 71.1% mean / SD 2.8 · C (spec-only) 100% / SD 0 · B (full) 100% / SD 0 but ~2.6 revisions. B−A=+28.9pp, B−C=+0.0pp → verdict JUST CLARITY.

WHAT IT MEANS:
- The CONTRACT/definition-of-done is a large, proven, consistent win (71→100%). Tasker's "force a complete contract" discipline is evidence-backed.
- INDEPENDENT VALIDATION added zero quality over a clear spec, at ~2.6 revisions of cost. On this task it was pure overhead.
- VALIDATOR MIS-CALIBRATION (actionable bug): 4/5 Arm-B trials hit the revision cap, flagging false-positive "issues" on code already passing all tests. An over-eager validator burns cost and risks degrading good output. Worth fixing/calibrating.
- CONFOUND — ceiling: C already hit 100%, so validation had no defects to catch. The pilot did NOT fairly test validation. Defensible conclusion is narrow: when a clear contract alone yields perfect output, validation is pure cost.

STRATEGIC: the proven half (clarity) is what free competitors (Task Master, Backlog.md) already have via "acceptance criteria"; the uncontested half (independent validation) is the one that failed to show value. Round 2 (HARDER task where spec-only < 100%) is now the pivotal test — if B≈C there too, the verification moat is largely decorative → weight shifts to the memory/org-brain/vendor-neutral positioning (per the 2026-06-27 market research).
