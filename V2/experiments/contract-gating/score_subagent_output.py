#!/usr/bin/env python3
"""Score subagent-generated candidates (no-API path) against the hidden oracle.

Usage: python score_subagent_output.py <workflow_output.json>
The workflow returns [{arm, trial, code, revisions}, ...]; this runs each candidate's
code through test_parse_duration.py and reports per-arm pass-rate, SD, and the verdict.
"""
import sys
import re
import html
import json
import shutil
import tempfile
import subprocess
import statistics
from pathlib import Path

HERE = Path(__file__).parent
TESTS = (HERE / "test_parse_duration.py").read_text(encoding="utf-8")
EXPECTED_TOTAL = 27


def load_candidates(path):
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    if isinstance(data, dict):
        data = data.get("result", data)
        if isinstance(data, str):
            data = json.loads(data)
    return data


def clean_code(code):
    code = html.unescape(code or "")
    m = re.search(r"```(?:python)?\s*(.*?)```", code, re.S)
    if m:
        code = m.group(1)
    return code.strip()


def score(code):
    d = Path(tempfile.mkdtemp())
    try:
        (d / "solution.py").write_text(code, encoding="utf-8")
        (d / "test_parse_duration.py").write_text(TESTS, encoding="utf-8")
        p = subprocess.run([sys.executable, "-m", "pytest", "-q", "--tb=no", "-p", "no:cacheprovider"],
                           cwd=d, capture_output=True, text=True, timeout=120)
        out = p.stdout + p.stderr
        return sum(int(x) for x in re.findall(r"(\d+) passed", out))
    except subprocess.TimeoutExpired:
        return 0
    finally:
        shutil.rmtree(d, ignore_errors=True)


def main(path):
    cands = load_candidates(path)
    rows = []
    for c in cands:
        passed = score(clean_code(c.get("code", "")))
        row = {"arm": c["arm"], "trial": c["trial"], "revisions": c.get("revisions", 0),
               "passed": passed, "pass_rate": round(passed / EXPECTED_TOTAL * 100, 1)}
        rows.append(row)
        print(f"  {row['arm']} t{row['trial']}: {passed:>2}/{EXPECTED_TOTAL} ({row['pass_rate']:>5.1f}%)  rev={row['revisions']}")

    print("\n=== SUMMARY  (Sonnet 4.6, N=5/arm) ===")
    print(f"{'arm':>3} {'mean%':>7} {'sd':>6} {'min':>5} {'max':>5} {'~revs':>6}")
    st = {}
    for arm in ("A", "C", "B"):
        rs = [r for r in rows if r["arm"] == arm]
        rates = [r["pass_rate"] for r in rs]
        st[arm] = (statistics.mean(rates), statistics.pstdev(rates) if len(rates) > 1 else 0.0)
        print(f"{arm:>3} {st[arm][0]:>7.1f} {st[arm][1]:>6.1f} {min(rates):>5.0f} {max(rates):>5.0f} "
              f"{statistics.mean([r['revisions'] for r in rs]):>6.1f}")

    a, c, b = st["A"][0], st["C"][0], st["B"][0]
    print(f"\nB-A = {b-a:+.1f} pp   B-C = {b-c:+.1f} pp   SD: A={st['A'][1]:.1f} C={st['C'][1]:.1f} B={st['B'][1]:.1f}")
    print("(cost gate not auto-checked: subagent path didn't capture per-arm tokens; Arm B revisions are the cost proxy)")
    if (b - a) >= 15 and (b - c) >= 10 and st["B"][1] < st["A"][1]:
        print("=> MOAT CONFIRMED")
    elif abs(b - c) <= 5 and (c - a) >= 10:
        print("=> JUST CLARITY (the win is the contract/spec; independent validation adds little here)")
    elif max(b, c) - a < 10:
        print("=> DECORATIVE (gating didn't help on this task)")
    else:
        print("=> INCONCLUSIVE / borderline -> bump N to 10")

    (HERE / "results_subagent.json").write_text(json.dumps(rows, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main(sys.argv[1])
