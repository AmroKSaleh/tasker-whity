# Pre-registration — Contract-Gating Efficacy Experiment

**Tasks:** TDE-212 (flows-engine ref) · TG/GTM "Experiment: prove/disprove…" (canonical)
**Status:** DRAFT — pending red-pen. Once blessed, commit this file UNCHANGED; the commit timestamp *is* the pre-registration (it cannot be quietly edited afterward without showing in git).

## Question
Does running a task through Tasker's contract + independent-validation machinery produce **measurably better and more consistent** output than running it without?

## Design — 3-arm, within-task
Held constant: model, temperature (production default — **must be > 0** so consistency is measurable), agent, the underlying task, and the hidden-test oracle. The **only** thing that varies is the Tasker treatment.

- **Arm A — bare:** the realistic, loose prompt a dev would actually type. No contract, no validator.
- **Arm C — spec-only:** the full structured contract (complete definition-of-done) given as context. No validator / no gate.
- **Arm B — full:** same contract **+** independent validator gating the output, with a revision loop until pass (capped at 3).

Attribution: **A→C** = value of the contract-as-clarity (cheap). **C→B** = value of independent verification (the expensive moat claim).

## Task (round 1)
A **bespoke pure-function coding task**: implement `parse_duration(s: str) -> int` returning total seconds. Python, **no external libraries, fixed signature**. Grammar chosen to defeat memorization and create headroom:

1. Tokens are `<int><unit>`; units `w`=7d, `d`=86400s, `h`, `m`, `s`.
2. **Bespoke:** `f` = "fortnight" = 14 days (non-standard — only knowable from the spec).
3. Units may appear in **any order** ("30m1h" == "1h30m").
4. A unit may repeat and the values **sum** ("1h1h" == 2h).
5. Optional `+` separators ("1h+30m" valid).
6. Whitespace between tokens ignored ("1h 30m").
7. Case-insensitive units ("1H30M" ok).
8. Leading zeros allowed ("007s" == 7s).
9. Integers only — "1.5h" → `ValueError`.
10. Empty string → `ValueError` (NOT 0).
11. Unknown unit / missing number / missing unit / negative → `ValueError`.
12. Very large inputs must not crash.

**Arm-A loose prompt (realistic):** *"Write a Python function `parse_duration(s)` that parses duration strings like '1h30m' and returns total seconds."* (Naturally omits the bespoke rules — as real prompts do.)
**Contract (Arm C/B):** the full enumerated rule set above, as a Tasker output contract.
**Oracle:** ~20–25 hidden `pytest` cases — one per rule + edge cases — authored **independently** of the contract prose. **Score = % passing.**

Rationale: objective ground truth (tests, no judge needed for the headline number); bespoke (no memorization ceiling); edge-case-rich (room for arms to diverge); cheap (pure function, zero infra).

## Metrics
- **Pass-rate** (% hidden tests) per output — the headline, objective.
- **Defect count** = failing tests per output.
- **Consistency** = SD of pass-rate across trials per arm (lower = more consistent).
- **Validator value (Arm B only):** revision loops triggered + defects caught (compare B's first draft vs its post-validation output).
- **Cost:** tokens + wall-clock per arm; B's overhead vs A.
- **Secondary (blind 1–5 judge, for what tests can't see):** readability, idiomatic quality, graceful error handling.

## Procedure
- **N = 5 trials per arm** (15 runs). If any A↔B gap lands borderline vs the bar, bump to N = 10.
- Pass-rate computed by running the hidden suite (deterministic — no judge).
- Secondary dims scored by a **3-LLM blind panel** (majority vote): outputs anonymized, arm labels stripped, order randomized. **User spot-checks** a random sample of the panel's judgments.
- **Stats honesty:** at N=5 we report means, SD, and effect size as *directional* evidence — no p-value claims unless N is bumped.

## Pre-registered hypotheses
- **H1:** mean pass-rate C > A (contract clarity helps).
- **H2:** mean pass-rate B > C (independent validation adds value *beyond* the spec).
- **H3:** SD of pass-rate B < A (gating improves consistency).

## Pre-registered decision bar (committed BEFORE running)
- **MOAT CONFIRMED:** B − A ≥ **15 pp** pass-rate (or ≥50% fewer defects) **AND** B − C ≥ **10 pp** **AND** SD(B) materially < SD(A), at cost overhead **≤ 3× A** tokens.
- **"JUST CLARITY":** C ≈ B (within 5 pp), both ≫ A → the win is contract *authoring*, not validation → product: lean into authoring, make validation optional/cheap.
- **DECORATIVE:** A ≈ C ≈ B (no arm ≥10 pp better) → gating doesn't help here → reposition toward the memory / org-brain / vendor-neutral angle.
- **Permission to fail:** a "decorative" result is recorded and triggers repositioning — not goalpost-moving.

## Threats to validity (and controls)
- *More-info ≠ gating* → the A→C→B split isolates clarity from verification.
- *Contract == tests triviality* → tests authored independently; the real signal is the implementation slips C makes that B catches.
- *Determinism hides consistency* → run at production temperature > 0.
- *Validator is itself an LLM* → intentional: we test the product as-built; the validator is Tasker's actual config.
- *Single-task generalization* → round 1 is one task; round 2 adds a second coding task + a subjective content task (Waqtak) before any external/marketing claim is made.

## Execution deviation (2026-06-27, recorded BEFORE the run)
API access is unavailable (company account, no API calls), so round 1 is executed via **Claude Code subagents (a workflow)** rather than `runner.py` + the Anthropic API. Documented deviations from the locked protocol:
- **Execution path:** subagents generate the candidates; candidates are returned as text and **scored locally** against the same hidden oracle (`test_parse_duration.py`). Scoring stays deterministic and identical to the API path.
- **Model:** pinned to Sonnet 4.6 via the workflow — this MATCHES the pre-registered model `claude-sonnet-4-6`.
- **Temperature:** subagent default (not explicitly set). Variance across fresh agent instances still gives a consistency (SD) read, though less controlled than a fixed API temperature.
- **Effort:** producers `low`, validator `medium` (budget control).
- **Secondary blind-judge dimensions** (readability / idiomatic / error-handling) are **deferred** for round 1 to conserve budget; round 1 reports only the objective oracle metrics (pass-rate, SD, defects, revision counts). The objective pass-rate is the headline evidence and needs no judge.
Unchanged: the 3 arms, N=5, the task, the oracle, and the decision bar.

## Round 1 results (2026-06-27, Sonnet 4.6, N=5/arm)
| Arm | mean pass-rate | SD | revisions |
|---|---|---|---|
| A (bare) | 71.1% | 2.8 | 0 |
| C (spec-only) | 100% | 0.0 | 0 |
| B (full) | 100% | 0.0 | 2.6 |

**B−A = +28.9pp · B−C = +0.0pp → verdict: JUST CLARITY** (per the pre-registered bar).

Findings:
- The contract/definition-of-done is a large, consistent win (71→100%, zero variance). Evidence-backed.
- Independent validation added **zero** quality over spec-only, at a cost of ~2.6 revision rounds.
- The validator was **mis-calibrated**: 4/5 Arm-B trials hit the 3-revision cap, flagging "issues" on code already passing all 27 tests (false positives). Actionable validator bug.
- **Confound — ceiling effect:** Arm C already hit 100%, so the validator had no real defects to catch. This pilot did NOT fairly test validation's value. The defensible conclusion is narrow: *when a clear contract alone yields perfect output, independent validation is pure cost.*
- **Next:** Round 2 must use a HARDER task where spec-only (C) lands well below 100%, so the validator gets a fair chance to prove (or disprove) value (B vs C). Strategic stakes: if B≈C on hard tasks too, the verification moat is largely decorative.
