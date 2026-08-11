# Flows: contract-gating Round 2 — validation still ~0 value on a harder task; correlated blind-spot hypothesis holds (TDE-791)

_KB entry · source: agent · READ-ONLY mirror (edit via create_kb_entry/update_kb_entry over MCP)._

## Design
Task: `parse_csv(text) -> list[list[str]]`, a bespoke CSV-subset (quoted fields, `""` escapes, CRLF-as-one-separator, ragged rows, whitespace-preservation rules, no phantom trailing row). Chosen specifically to avoid Round 1's ceiling confound — designed so spec-only (arm C) would NOT hit 100%.
3 arms, N=5 each, run via Claude Code subagents (workflow wf_0b91cfa9-71e): A=bare loose prompt, C=full contract no validator, B=contract + independent validator + revision loop (cap 3). Validator recalibrated vs Round 1 (must cite a concrete traced counterexample per violation; defaults to pass if it can't).
23-case hidden oracle (deterministic, run via a Python harness script per candidate).

## Results
| Arm | mean pass-rate | SD |
|---|---|---|
| A (bare) | 86.1% | 1.74 |
| C (spec-only) | 93.9% | 2.13 |
| B (full) | 94.8% | 1.74 |

B−A = +8.7pp, B−C = +0.87pp. Per the pre-registered bar (MOAT CONFIRMED needs B−A≥15pp AND B−C≥10pp): **not confirmed**. Closest to Round 1's "JUST CLARITY" outcome (contract authoring drives the gain; validation adds ~nothing over spec) though the A→C gap here (7.8pp) is more modest than Round 1's 29pp, since this task had real (if smaller) headroom rather than a hard ceiling.

## The decisive detail: meanAttempts = 1 across all 5 B trials
The validator never once triggered a revision. Yet a real, checkable defect (`whitespace_around_quotes` — whitespace immediately outside a quoted field gets stripped/misplaced instead of preserved) survived in **all 5** B trials' final output — identical to what arm C produced unaided. The independent judge missed the exact bug the producer made, every single time it was present.

This directly answers TDE-791's sharpened question ("does an AI judge detect failures a deterministic check misses, given it shares the producer's blind spots?"): **no evidence it does, in this run.** The judge and producer are the same model family reasoning the same way about the same tricky rule (rule 6 — whitespace preservation around quotes) and made / missed the same mistake together.

## Caveat — do not overclaim
Zero fires across 5 trials is consistent with two different explanations: (a) the correlated-blind-spot hypothesis (judge structurally can't see what producer can't), or (b) the Round-1-false-positive fix overcorrected into an under-eager validator that rarely flags anything regardless of defect quality. This run cannot distinguish those — the validator never demonstrated positive catch power on ANY defect, so we don't know its true ceiling, only that it under-performed here. Future rounds should include at least one seeded, unambiguous defect to confirm the validator is minimally sensitive at all before trusting a null result as "judge lacks detection power" rather than "judge is miscalibrated toward pass."

## Consequences
- TDE-796 (Q4, narrow-seam definition): the provisional narrow-vs-broad call **survives** — this result doesn't push toward "gate everything," it reinforces that gating is expensive and should stay scoped to genuine seams.
- TDE-797 (Q5, gate mechanics): the "how much is it worth" half is answered — independent AI judgment does NOT currently earn its cost as a default gate; the ladder ordering (dissolve → check → human gate at high-blast-radius seams → producer-gate → intake read → independent judge as last resort, different model family, purpose-not-reasoning framing) is the right shape, not "validation central."
- Strategic: per TDE-791's framing, this pushes weight toward deterministic checks + human review at high-blast-radius seams, and toward the memory/org-brain/vendor-neutral positioning rather than "verification moat" as the primary sell — the verification story should lean on checks, not on independent LLM judging, unless a future run demonstrates real catch power with a validated-sensitive validator.

Full per-trial data (pass/fail lists, revision counts) in workflow journal wf_0b91cfa9-71e.
