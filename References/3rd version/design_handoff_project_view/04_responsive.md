# 04 — Responsive

The redesign uses the same two-axis model on both desktop and mobile. The differences are in the column-width math, the affordances around the column scroller, and where the task detail / in-progress UI lives.

## Breakpoint

Single breakpoint at Tailwind's `md` (`>=768px`). Below: mobile layout. At and above: desktop.

```ts
const isDesktop = useMediaQuery('(min-width: 768px)');
```

> If Tasker already uses different breakpoints, reuse those — the design doesn't depend on the exact pixel value.

## Differences at a glance

| Aspect | Mobile (`< md`) | Desktop (`>= md`) |
|---|---|---|
| Column width | `calc(100vw - 32px)` (full viewport minus 16px each side for the peek of the next) | `300px` fixed |
| Column gap | `0` (margin handled per-column, with 16px outer padding) | `14px` (`gap-3.5`) |
| Snap | `snap-x snap-mandatory` | `snap-x snap-proximity` |
| Column dot indicator | Yes — pills/dots above the scroller showing position | No |
| Task detail | Bottom sheet, ~62vh, drag-to-dismiss | Right slide-in panel, 380px |
| In-progress UI | Floating FAB (bottom-right) → bottom sheet (~70vh) | Fixed right sidebar, 288px |
| Filter bar | Horizontal-scroll pill row, no overflow buttons | Same pills + Collapse/Expand-all + search icon |
| Project header actions | Icon-only (Focus, Briefing, More) | Labeled buttons |
| Project name area | Single-line w/ chevron-back to projects list | Full crumbs + progress bar |
| Horizontal-scroll affordance | Swipe + dot indicator | Wheel hint rail + drag |

## Mobile project header

```tsx
<header className="flex items-center gap-2 bg-paper px-3 pb-2.5 pt-2">
  <IconButton><ChevronLeftIcon /></IconButton>
  <div className="min-w-0 flex-1">
    <div className="font-mono text-[9.5px] uppercase tracking-[0.08em] text-mute">{project.parent}</div>
    <div className="truncate text-base font-semibold tracking-[-0.01em]">{project.name}</div>
  </div>
  <IconButton><ZapIcon /></IconButton>     {/* Focus shortcut */}
  <IconButton><MoreIcon /></IconButton>
</header>
<div className="flex items-center gap-2 border-b border-line-2 bg-paper px-3 pb-2.5">
  <span className="font-mono text-[10px] tracking-[0.06em] text-mute">{done}/{total}</span>
  <div className="h-[3px] flex-1 overflow-hidden rounded-sm bg-line-2">
    <div className="h-full bg-ink" style={{ width: `${pct}%` }} />
  </div>
  <span className="font-mono text-[10px] tracking-[0.06em] text-mute">{pct}%</span>
</div>
```

## Mobile filter bar

```tsx
<div className="flex gap-1.5 overflow-x-auto border-b border-line-2 bg-paper px-3 py-2.5
                [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
  {filters.map(f => <Pill key={f.id} {...f} />)}
</div>
```

Pills are slightly smaller on mobile: `px-2.5 py-1.5 text-[10px]`. The `Collapse all / Expand all` buttons are dropped on mobile (rarely needed when you swipe one column at a time).

## Column dot indicator (mobile only)

Just above the column scroller. Renders one dot per section; the active dot stretches into a pill.

```tsx
<div className="flex justify-center gap-1.5 border-b border-line-2 bg-paper px-0 pb-1.5 pt-1">
  {sections.map((s, i) => (
    <span
      key={s.id}
      className={cx(
        'h-1.5 rounded-full bg-line transition-all',
        i === activeIndex ? 'w-4 rounded-sm bg-ink' : 'w-1.5'
      )}
    />
  ))}
</div>
```

`activeIndex` is derived from `scrollLeft` of the column scroller — `Math.round(scrollLeft / columnFullWidth)`.

## Mobile column scroller

```tsx
<div className="flex flex-1 snap-x snap-mandatory overflow-x-auto py-2.5 pb-3.5
                [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
  {sections.map((s, i) => (
    <div
      key={s.id}
      className={cx(
        'flex flex-col shrink-0 snap-center bg-paper border border-line-2 rounded-xl overflow-hidden',
        'w-[calc(100vw-32px)]',
        i === 0 ? 'ml-4' : 'ml-2',
        i === sections.length - 1 ? 'mr-4' : 'mr-0'
      )}
    >
      <ColumnHeader ... />
      ...
    </div>
  ))}
</div>
```

## Mobile in-progress FAB + sheet

`InProgressFab` is rendered alongside `ProjectBoard` (so it's not clipped by anything). It's only mounted when `!isDesktop`.

The sheet, when opened, also takes `~70vh`. Drag-to-dismiss same as `TaskDetailSheet`.

```tsx
{!isDesktop && (
  <>
    <InProgressFab onClick={() => setIpSheetOpen(true)} count={inProgressCount} />
    {ipSheetOpen && <InProgressSheet tasks={ip} onClose={() => setIpSheetOpen(false)} />}
  </>
)}
```

## Mobile task detail sheet

Opens when a task row is tapped. On desktop the same tap opens the right slide-in panel. **Same hook, branched on viewport:**

```tsx
const { selectedTaskId, openTask, closeTask } = useTaskPanelState();

// In ProjectBoard JSX:
{selectedTaskId && (isDesktop
  ? <TaskDetailPanel taskId={selectedTaskId} onClose={closeTask} />
  : <TaskDetailSheet  taskId={selectedTaskId} onClose={closeTask} />
)}
```

## Touch targets

Every tappable element must be **≥44px square** on mobile. This means:

- Pills get `min-h-[36px]` and a transparent `before` extending the hit area to 44px:

```css
.pill::before {
  content: '';
  position: absolute;
  inset: -4px;
}
.pill { position: relative; }
```

- Task row entire height is already > 44px (chips + title gives ~52px).
- The drag handle on a task row is **NOT** the hit target on mobile — tap anywhere on the row to open detail. Long-press to enter reorder mode (handled by `@dnd-kit` PointerSensor with `activationConstraint: { delay: 200, tolerance: 5 }` on mobile).

## Drag-and-drop on touch

Use a different `PointerSensor` activation constraint on mobile:

```ts
const sensors = useSensors(
  useSensor(PointerSensor, {
    activationConstraint: isDesktop
      ? { distance: 6 }
      : { delay: 220, tolerance: 5 },  // long-press to start
  }),
);
```

Without long-press, a vertical swipe to scroll the column would also start a drag.

## Safe-area insets

The mobile FAB and bottom sheets must respect iOS notch/home-indicator areas:

```css
.fab { bottom: max(16px, env(safe-area-inset-bottom)); }
.sheet { padding-bottom: max(22px, env(safe-area-inset-bottom)); }
```

## Orientation

Landscape phones (`< 768 wide`, but `> 480 high` is rare here) get the mobile layout. Tablets in landscape (`>= 768`) get desktop. Acceptable.

## What stays the same across breakpoints

- Token values (colors, fonts) — exact same.
- `TaskItem` internals — exact same.
- Filter logic, search logic, focus mode, AI chat overlays — exact same.
- The two-axis mental model — exact same.
