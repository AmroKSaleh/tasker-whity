# parse_duration — Specification (the Output Contract given to Arms C & B)

Implement a Python function with EXACTLY this signature:

    def parse_duration(s: str) -> int

It returns the total number of **seconds** represented by a duration string.

## Grammar
A duration is a sequence of tokens. Each token is `<integer><unit>`.

Units (case-insensitive):
- `s` = 1 second
- `m` = 60 seconds
- `h` = 3600 seconds
- `d` = 86400 seconds
- `w` = 7 days = 604800 seconds
- `f` = one fortnight = 14 days = 1209600 seconds

## Rules
1. Tokens may appear in ANY order: `"30m1h"` == `"1h30m"`.
2. A unit may appear multiple times; the values SUM: `"1h1h"` == 7200.
3. Tokens may optionally be separated by `+`: `"1h+30m"` is valid.
4. Whitespace between tokens is ignored: `"1h 30m"` is valid.
5. Units are case-insensitive: `"1H30M"` is valid.
6. Integer values only. Leading zeros allowed (`"007s"` == 7). Decimals like `"1.5h"` are INVALID.
7. The value 0 is allowed (`"0s"` == 0).
8. Very large integers must be handled without crashing.

## Error handling — raise `ValueError` for:
- Empty string or whitespace-only input.
- An unknown unit (e.g. `"1x"`).
- A number with no unit (e.g. `"30"`).
- A unit with no number (e.g. `"h30m"`).
- Negative numbers (e.g. `"-1h"`).
- Any character that is not part of a valid token, unit, `+` separator, or whitespace.

## Constraints
- Pure standard-library Python. No external dependencies.
- The signature must be exactly `parse_duration(s)`.
