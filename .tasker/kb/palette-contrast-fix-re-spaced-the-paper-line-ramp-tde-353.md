# Palette contrast fix — re-spaced the paper→line ramp (TDE-353)

_KB entry · source: agent · READ-ONLY mirror (edit via create_kb_entry/update_kb_entry over MCP)._

Diagnosed with actual WCAG contrast math (not eyeballing) before touching anything, since a global palette change is high blast-radius. Root cause: `--color-paper/surf-2/surf/line-2/line` were clustered within 1.05–1.5:1 contrast of each other in BOTH themes — `border-line-2` (the most-used divider) was 1.16:1 against the page background in light mode; `surf` vs `surf-2` (two "distinct" panel backgrounds) were 1.05:1, visually identical. Separately, `--color-mute-2` (every timestamp/kicker/mono label app-wide) was 2.75:1 (light) / 3.28:1 (dark) against its background — both fail WCAG's text floor (4.5:1 normal, 3:1 large). Body text tokens (ink/ink-2/mute) were already fine (5.3–15.8:1) — this was a structure/label problem, not a body-text-readability problem.

Fix is entirely in `index.css`'s CSS custom properties (`:root` and `[data-theme="dark"]`) — every component consumes these via Tailwind `bg-surf-2`/`border-line-2`/`text-mute-2` etc., none hardcode hex, so re-spacing the ~9 tokens propagates everywhere with zero component edits. Also switched `--scroll-thumb`/`--scroll-thumb-hover` from hardcoded hex duplicates to `var(--color-line)`/`var(--color-mute-2)` so they can't drift out of sync again.

New values keep the same warm off-white/ink hue family (no identity change) — just wider spacing. Verified deltas: line-2 1.16→1.43:1, line 1.47→2.04:1, surf 1.05→1.22:1, mute-2 2.75→3.86:1 (light theme; dark mirrored). Deliberately did NOT chase full 3:1/4.5:1 on every structural token — pushing further would fight the intentionally light "editorial paper" identity (see [[project_branding_discussion]]); this is a proportionate re-space, not a redesign.

`[data-focus="true"]`'s separate always-dark palette was left untouched — Focus Mode is currently a disabled stub (TDE-351), so that CSS is unreachable in the live UI.
