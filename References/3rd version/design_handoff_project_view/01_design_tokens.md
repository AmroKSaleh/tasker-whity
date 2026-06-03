# 01 — Design Tokens

All tokens from the brief are preserved exactly. Below they're mapped into Tailwind v3 theme extensions plus a small set of semantic Tailwind utility class aliases.

## Color tokens (canonical)

```
ink     #1A1916    primary text
ink-2   #3D3B36    secondary text, button text
mute    #6B6867    tertiary text, mono labels
mute-2  #9A9896    icon-only, disabled, drag handles at rest
line    #D4D0C8    primary border (buttons, inputs)
line-2  #ECE9E1    soft dividers, swimlane line, empty bars
surf    #F0EDE5    board background (behind columns)
surf-2  #F5F3ED    hover background, status segmented bg, notes input bg
paper   #FBFAF6    column background, sidebar background, panel background
accent  #D97757    in-progress accent + focus button + AI surfaces
```

## Priority hues (derived)

These are needed for priority chips. Keep them muted/warm so they don't fight the neutral palette.

```
priority-rush  #C0432D   text on rgba(192,67,45,0.12) bg
priority-high  #D97757   text on rgba(217,119,87,0.10) bg (== accent / accent-soft)
priority-med   #8C8055   text on rgba(140,128,85,0.14) bg
priority-low   #6B6867   text on rgba(107,104,103,0.14) bg (== mute)
status-done    #5C7A5F   sage — for the "done" status dot in the panel
```

## Tailwind config (drop-in)

Add to `tailwind.config.cjs`:

```js
/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./index.html", "./src/**/*.{js,jsx,ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink:    { DEFAULT: '#1A1916', 2: '#3D3B36' },
        mute:   { DEFAULT: '#6B6867', 2: '#9A9896' },
        line:   { DEFAULT: '#D4D0C8', 2: '#ECE9E1' },
        surf:   { DEFAULT: '#F0EDE5', 2: '#F5F3ED' },
        paper:  '#FBFAF6',
        accent: { DEFAULT: '#D97757', soft: 'rgba(217,119,87,0.10)', edge: 'rgba(217,119,87,0.35)' },
        priority: {
          rush: '#C0432D',
          high: '#D97757',
          med:  '#8C8055',
          low:  '#6B6867',
          done: '#5C7A5F',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
      },
      fontSize: {
        // Optimized for chip/label use
        '2xs': ['10px', { lineHeight: '14px', letterSpacing: '0.08em' }],
        '3xs': ['9.5px', { lineHeight: '13px', letterSpacing: '0.1em' }],
      },
      boxShadow: {
        panel: '-12px 0 32px rgba(26,25,22,0.08)',
        sheet: '0 -8px 24px rgba(26,25,22,0.18)',
        fab:   '0 4px 16px rgba(26,25,22,0.25)',
        drag:  '0 18px 40px rgba(26,25,22,0.18), 0 0 0 1.5px #D97757',
      },
      borderRadius: {
        sheet: '14px',
      },
      transitionTimingFunction: {
        'panel': 'cubic-bezier(0.2, 0.7, 0.3, 1)',
      },
      width: {
        col: '300px',                      // BoardColumn
        'col-collapsed': '44px',
        'col-mobile': 'calc(100vw - 32px)',
        panel: '380px',                    // TaskDetailPanel
        sidebar: '288px',                  // InProgressSidebar (preserved)
      },
    },
  },
  plugins: [
    require('@tailwindcss/forms')({ strategy: 'class' }),  // optional
  ],
};
```

If you don't want to add `width: { col }` etc., the literal pixel values `w-[300px]`, `w-[380px]`, `w-72` (288px) are referenced throughout the reference components.

## Typography

| Use | Family | Size | Weight | Tracking | Case |
|---|---|---|---|---|---|
| Project name (desktop) | Inter | 24px | 600 | -0.015em | — |
| Project name (mobile) | Inter | 16px | 600 | -0.01em | — |
| Section / column name | Inter | 14px | 600 | -0.01em | — |
| Task title | Inter | 13px | 400 | 0 | — |
| Body / panel notes | Inter | 13px | 400 | 0 | — |
| Panel title | Inter | 19px | 600 | -0.01em | — |
| Swimlane label | JetBrains Mono | 10px | 500 | 0.12em | UPPERCASE |
| Filter pill | JetBrains Mono | 11px | 400 | 0.06em | UPPERCASE |
| Priority chip | JetBrains Mono | 9.5px | 400 | 0.08em | UPPERCASE |
| Tag chip | JetBrains Mono | 10px | 400 | 0.02em | lowercase |
| Due date chip | JetBrains Mono | 9.5px | 400 | 0.04em | — |
| Date in panel | JetBrains Mono | 12px | 400 | 0 | — |
| Mono label (lbl above field) | JetBrains Mono | 10px | 400 | 0.1em | UPPERCASE |
| Crumbs | JetBrains Mono | 10–11px | 400 | 0.06–0.08em | UPPERCASE |
| Progress text | JetBrains Mono | 11px | 400 | 0.04em | — |

## Spacing

| Token | Value | Used for |
|---|---|---|
| column gap | 14px | between columns in the scroller |
| column padding | 14px header, 8px body | |
| column body row gap | 2px | between task rows |
| board area padding | 18px 22px 22px | around the columns scroller |
| filter bar padding | 14px 32px | |
| project header padding | 22px 32px 18px | |
| panel padding | 18px | content padding |
| sheet body padding | 12px 16px 22px | mobile bottom sheet |
| task row padding | 9px 8px 9px 6px | inside row |
| pill padding | 6px 11px | filter pills |
| chip padding | 2px 6px | priority/tag chips |

## Border radii

| Token | Value | Used for |
|---|---|---|
| `rounded-md` | 6px | buttons, inputs, task rows, pills (small) |
| `rounded-lg` | 8px | cards, panels, segmented controls |
| `rounded-xl` | 10px | columns, in-progress cards |
| `rounded-sheet` | 14px | bottom sheet top corners (mobile) |
| `rounded-full` | 999px | filter pills, FAB, dots |
| `rounded-sm` | 3px | chips, mono badges |

## Shadows

```css
/* Task detail panel (desktop, slides from right) */
shadow-panel: -12px 0 32px rgba(26,25,22,0.08);

/* Bottom sheets (mobile) */
shadow-sheet: 0 -8px 24px rgba(26,25,22,0.18);

/* Floating action button (mobile in-progress) */
shadow-fab: 0 4px 16px rgba(26,25,22,0.25);

/* Dragging column / task (lifted state) */
shadow-drag: 0 18px 40px rgba(26,25,22,0.18), 0 0 0 1.5px #D97757;

/* Cards in in-progress sidebar — no shadow, just border */
/* Filter pills — no shadow */
```

## Motion

| Element | Duration | Easing | Property |
|---|---|---|---|
| Task panel slide-in (desktop) | 240ms | `cubic-bezier(0.2, 0.7, 0.3, 1)` | `transform: translateX()` |
| Task panel scrim fade | 180ms | linear | `opacity` |
| Bottom sheet slide-up (mobile) | 280ms | `cubic-bezier(0.2, 0.7, 0.3, 1)` | `transform: translateY()` |
| Sheet scrim fade | 200ms | linear | `opacity` |
| Column collapse / expand | 220ms | ease-out | `width` |
| Task row hover bg | 100ms | linear | `background-color` |
| Column reorder | (handled by dnd-kit / framer-motion via dnd-kit's `useSortable`) | | |
| Filter pill | 120ms | linear | bg + border |

Use `prefers-reduced-motion: reduce` to halve durations / disable transforms.
