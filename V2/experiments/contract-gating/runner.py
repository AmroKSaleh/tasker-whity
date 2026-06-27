#!/usr/bin/env python3
"""3-arm contract-gating efficacy experiment runner.

See ../../docs/experiments/contract-gating-preregistration.md for the locked protocol.

Arms (only the Tasker treatment varies; model/temp/task/oracle held constant):
  A  bare       — realistic loose prompt, no contract, no validator
  C  spec-only  — full contract as context, no validator/gate
  B  full       — contract + independent validator + revision loop (the moat claim)

Headline metric = % of the hidden pytest oracle that passes (objective, no judge).
Requires: pip install anthropic pytest ; env ANTHROPIC_API_KEY.
"""
import os
import re
import json
import shutil
import time
import tempfile
import subprocess
import statistics
from pathlib import Path

import anthropic

HERE = Path(__file__).parent

# --- Frozen experiment config (recorded into results for reproducibility) ---
MODEL = "claude-sonnet-4-6"   # frozen for the run
TEMPERATURE = 1.0             # production-realistic; MUST be > 0 so consistency is measurable
N_TRIALS = 5                  # per arm; bump to 10 if a key gap is borderline
MAX_REVISIONS = 3             # Arm B revision-loop cap (matches Tasker's flow cap)
EXPECTED_TOTAL = 27           # size of the hidden suite; denominator so syntax errors score 0%

client = anthropic.Anthropic()

CONTRACT = (HERE / "contract.md").read_text(encoding="utf-8")
LOOSE = (HERE / "loose_prompt.txt").read_text(encoding="utf-8").strip()
TESTS = (HERE / "test_parse_duration.py").read_text(encoding="utf-8")

PRODUCER_SYS = ("You are a senior Python engineer. Return ONLY a single ```python code "
                "block containing the complete implementation. No prose, no explanation.")
VALIDATOR_SYS = "You are a rigorous, adversarial code reviewer. Assume the code is wrong until proven otherwise."


def call(messages, system):
    r = client.messages.create(model=MODEL, max_tokens=2000, temperature=TEMPERATURE,
                               system=system, messages=messages)
    text = "".join(b.text for b in r.content if b.type == "text")
    return text, r.usage.input_tokens, r.usage.output_tokens


def extract_code(text):
    m = re.search(r"```(?:python)?\s*(.*?)```", text, re.S)
    return (m.group(1) if m else text).strip()


def run_oracle(code):
    """Return number of hidden tests passed (0..EXPECTED_TOTAL)."""
    d = Path(tempfile.mkdtemp())
    try:
        (d / "solution.py").write_text(code, encoding="utf-8")
        (d / "test_parse_duration.py").write_text(TESTS, encoding="utf-8")
        p = subprocess.run(["python", "-m", "pytest", "-q", "--tb=no", "-p", "no:cacheprovider"],
                           cwd=d, capture_output=True, text=True, timeout=120)
        out = p.stdout + p.stderr
        passed = sum(int(x) for x in re.findall(r"(\d+) passed", out))
        return passed
    except subprocess.TimeoutExpired:
        return 0
    finally:
        shutil.rmtree(d, ignore_errors=True)


def validate(code):
    """Independent validator: checks the candidate against the CONTRACT (never the tests)."""
    prompt = (f"Find every way this implementation violates the spec.\n\nSPEC:\n{CONTRACT}\n\n"
              f"CANDIDATE:\n```python\n{code}\n```\n\n"
              "List concrete spec violations or bugs as a short bullet list. "
              "If and only if there are NONE, reply with exactly: PASS")
    text, ti, to = call([{"role": "user", "content": prompt}], VALIDATOR_SYS)
    ok = text.strip().upper().startswith("PASS")
    return ok, text, ti, to


def produce(user_prompt):
    text, ti, to = call([{"role": "user", "content": user_prompt}], PRODUCER_SYS)
    return extract_code(text), ti, to


def arm_A():
    code, ti, to = produce(LOOSE)
    return code, ti, to, 0


def arm_C():
    code, ti, to = produce(f"{LOOSE}\n\nImplement to EXACTLY this specification:\n\n{CONTRACT}")
    return code, ti, to, 0


def arm_B():
    base = f"{LOOSE}\n\nImplement to EXACTLY this specification:\n\n{CONTRACT}"
    code, ti, to = produce(base)
    revs = 0
    for _ in range(MAX_REVISIONS):
        ok, issues, vi, vo = validate(code)
        ti += vi; to += vo
        if ok:
            break
        revs += 1
        text, ri, ro = call([{"role": "user", "content":
            f"{base}\n\nA reviewer found these issues with your previous attempt:\n{issues}\n\n"
            "Return the corrected, complete implementation."}], PRODUCER_SYS)
        code = extract_code(text); ti += ri; to += ro
    return code, ti, to, revs


ARMS = {"A": arm_A, "C": arm_C, "B": arm_B}


def main():
    results = []
    for arm, fn in ARMS.items():
        for trial in range(1, N_TRIALS + 1):
            t0 = time.time()
            code, ti, to, revs = fn()
            passed = run_oracle(code)
            row = {"arm": arm, "trial": trial, "passed": passed, "total": EXPECTED_TOTAL,
                   "pass_rate": round(passed / EXPECTED_TOTAL * 100, 1),
                   "in_tokens": ti, "out_tokens": to, "revisions": revs,
                   "secs": round(time.time() - t0, 1)}
            results.append(row)
            print(f"  {arm} t{trial}: {passed}/{EXPECTED_TOTAL} ({row['pass_rate']:.0f}%)  rev={revs}  tok={ti+to}")

    (HERE / "results.jsonl").write_text("\n".join(json.dumps(r) for r in results), encoding="utf-8")
    summarize(results)


def summarize(results):
    print(f"\n=== SUMMARY  (model={MODEL}, temp={TEMPERATURE}, N={N_TRIALS}) ===")
    print(f"{'arm':>3} {'mean%':>7} {'sd':>6} {'min%':>6} {'max%':>6} {'~tokens':>9} {'~revs':>6}")
    stats = {}
    for arm in ("A", "C", "B"):
        rs = [r for r in results if r["arm"] == arm]
        rates = [r["pass_rate"] for r in rs]
        toks = [r["in_tokens"] + r["out_tokens"] for r in rs]
        mean = statistics.mean(rates)
        sd = statistics.pstdev(rates) if len(rates) > 1 else 0.0
        stats[arm] = (mean, sd, statistics.mean(toks))
        print(f"{arm:>3} {mean:>7.1f} {sd:>6.1f} {min(rates):>6.0f} {max(rates):>6.0f} "
              f"{int(statistics.mean(toks)):>9} {statistics.mean([r['revisions'] for r in rs]):>6.1f}")

    # Pre-registered decision bar
    a, c, b = stats["A"][0], stats["C"][0], stats["B"][0]
    cost_ratio = stats["B"][2] / stats["A"][2] if stats["A"][2] else float("inf")
    print("\n--- verdict vs pre-registered bar ---")
    print(f"B-A = {b-a:+.1f} pp  |  B-C = {b-c:+.1f} pp  |  SD: A={stats['A'][1]:.1f} B={stats['B'][1]:.1f}  |  cost B/A = {cost_ratio:.1f}x")
    if (b - a) >= 15 and (b - c) >= 10 and stats["B"][1] < stats["A"][1] and cost_ratio <= 3:
        print("=> MOAT CONFIRMED")
    elif abs(b - c) <= 5 and (c - a) >= 10:
        print("=> JUST CLARITY (contract authoring helps; independent validation adds little)")
    elif max(b, c) - a < 10:
        print("=> DECORATIVE (gating did not help on this task) -> reposition")
    else:
        print("=> INCONCLUSIVE / borderline -> bump N to 10 and re-run")


if __name__ == "__main__":
    if not os.environ.get("ANTHROPIC_API_KEY"):
        raise SystemExit("Set ANTHROPIC_API_KEY first.")
    main()
