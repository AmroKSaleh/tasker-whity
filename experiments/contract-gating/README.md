# Contract-Gating Efficacy Experiment — harness

Tests whether Tasker's contract + independent-validation machinery makes agent output
measurably better/more consistent. Protocol (locked): `../../docs/experiments/contract-gating-preregistration.md`.

## Files
- `contract.md` — the full spec (the output contract) shown to Arms C & B.
- `loose_prompt.txt` — the realistic loose prompt shown to Arm A.
- `test_parse_duration.py` — the **hidden oracle** (27 cases). Never shown to the arms.
- `solution_reference.py` — a known-correct impl, used only to verify the oracle.
- `runner.py` — runs all 3 arms × N trials, scores against the oracle, prints the verdict.

## 0. Verify the oracle is sound (do this first)
```
cd V2/experiments/contract-gating
cp solution_reference.py solution.py && python -m pytest -q && rm solution.py
```
Expect **27 passed**. If not, the oracle is buggy — fix before running the experiment.

## 1. Run the experiment
```
pip install anthropic pytest
export ANTHROPIC_API_KEY=sk-...        # Windows: $env:ANTHROPIC_API_KEY="sk-..."
python runner.py
```
Writes `results.jsonl` and prints per-arm mean/SD/cost plus the pre-registered verdict.

## Notes
- The validator (Arm B) checks candidates against `contract.md`, never against the hidden tests — it is an independent LLM reviewer, mirroring Tasker's flow validation.
- `MODEL` / `TEMPERATURE` / `N_TRIALS` are frozen at the top of `runner.py` and recorded for reproducibility. Temperature is intentionally > 0 so the consistency (SD) metric is meaningful.
- Round 1 tests the **atomic gate** (one deliverable). Multi-step error-propagation across a flow is a round-2 experiment.
- This harness is standalone (not run inside a Tasker flow) so the thing being tested can't contaminate the test.
