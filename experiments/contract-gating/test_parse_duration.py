"""Hidden oracle for the contract-gating experiment.

Ground truth for `parse_duration`. NEVER shown to the producing arms — the runner
only places this alongside a candidate `solution.py` and runs it. 27 cases total.
Verify the oracle itself first: `cp solution_reference.py solution.py && pytest -q`
must report 27 passed.
"""
import pytest
from solution import parse_duration


@pytest.mark.parametrize("s,expected", [
    ("1h30m", 5400),
    ("90m", 5400),
    ("2d", 172800),
    ("1h30m15s", 5415),
    ("30m1h", 5400),          # any order
    ("1h1h", 7200),           # repeats sum
    ("007s", 7),              # leading zeros
    ("1H30M", 5400),          # case-insensitive
    ("1h 30m", 5400),         # whitespace ignored
    ("1h+30m", 5400),         # '+' separator
    ("1w", 604800),
    ("1f", 1209600),          # bespoke: fortnight = 14 days
    ("1f1d", 1296000),
    ("1d1d1d", 259200),
    ("0s", 0),
    ("1m1m1m", 180),
    ("1000000h", 3600000000),  # large, no crash
])
def test_valid(s, expected):
    assert parse_duration(s) == expected


@pytest.mark.parametrize("s", [
    "",        # empty
    "   ",     # whitespace only
    "1.5h",    # decimal
    "1x",      # unknown unit
    "h30m",    # missing number
    "30",      # missing unit
    "-1h",     # negative
    "1h-30m",  # negative in middle
    "abc",     # garbage
    "1h30",    # trailing number with no unit
])
def test_invalid(s):
    with pytest.raises(ValueError):
        parse_duration(s)
