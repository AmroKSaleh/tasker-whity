"""Reference (correct) implementation — used ONLY to verify the oracle is sound.
Never shown to the producing arms. If `pytest` against this is not 27/27, the
test suite is buggy and must be fixed before the experiment is trustworthy.
"""
import re

_UNITS = {"w": 604800, "d": 86400, "h": 3600, "m": 60, "s": 1, "f": 1209600}
_TOKEN = re.compile(r"(\d+)([a-z])")


def parse_duration(s: str) -> int:
    if not isinstance(s, str):
        raise ValueError("input must be a string")
    compact = s.replace("+", "").replace(" ", "").replace("\t", "").lower()
    if compact == "":
        raise ValueError("empty duration")
    total = 0
    pos = 0
    for m in _TOKEN.finditer(compact):
        if m.start() != pos:
            raise ValueError(f"unexpected character at index {pos}")
        num, unit = m.group(1), m.group(2)
        if unit not in _UNITS:
            raise ValueError(f"unknown unit {unit!r}")
        total += int(num) * _UNITS[unit]
        pos = m.end()
    if pos != len(compact):
        raise ValueError("trailing or invalid characters")
    return total
