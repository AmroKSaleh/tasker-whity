# 02 — Components

Every new component the redesign introduces. Each entry has: purpose, props, layout, the exact Tailwind classes for key elements, and notes on state.

> Ready-to-adapt reference implementations live in `reference/` — these descriptions explain *why* each component looks the way it does.

---

## `ProjectBoard`

**The new top-level project view.** Replaces the current vertical scroll. Owns the column scroll container and renders the optional task-detail overlays.

```tsx
type Props = {
  project: Project;
  sections: Section[];          // each Section has tasks grouped by stage
  selectedTaskId: string | null;
  onSelectTask: (id: string | null) => void;
};
```

Layout:

```tsx
<div className="flex h-screen flex-col bg-surf font-sans text-ink">
  <ProjectHeader project={project} />
  <FilterBar />
  <div className="flex flex-1 min-h-0">
    <div className="relative flex-1 min-h-0">
      <div className="flex h-full gap-3.5 overflow-x-auto overflow-y-hidden px-5 py-4 snap-x snap-proximity">
        <DndContext> {/* column reorder */}
          <SortableContext items={sectionIds} strategy={horizontalListSortingStrategy}>
            {sections.map(s => <BoardColumn key={s.id} section={s} />)}
          </SortableContext>
        </DndContext>
        <NewSectionColumn />
      </div>
      <HorizontalScrollRail />
    </div>
    <InProgressSidebar className="hidden md:flex" />
  </div>

  {/* Overlays — portal'd into <body> for stacking; here for clarity */}
  <TaskDetailPanel taskId={selectedTaskId} onClose={() => onSelectTask(null)} />
  <InProgressFab className="md:hidden" />
</div>
```

Notes:
- `min-h-0` on flex parents is required for the inner columns to scroll instead of pushing the page.
- Hide the horizontal scrollbar with `scrollbar-width: none` + `::-webkit-scrollbar { display: none }` — see the global CSS snippet in `03_interactions.md`.
- The `<DndContext>` here is the **outer** one (column reordering). Each `<BoardColumn>` owns an inner one for tasks.

---

## `BoardColumn`

One column = one section. Fixed width, full-height, internal vertical scroll.

```tsx
type Props = {
  section: Section;                // { id, name, doneCount, totalCount, ungroupedTasks, stages }
  collapsed?: boolean;
  onToggleCollapse: () => void;
};
```

Container classes (normal state):

```
flex flex-col w-[300px] shrink-0 h-full snap-start
bg-paper border border-line-2 rounded-xl overflow-hidden
```

Collapsed state (44px, content rotated vertically):

```
w-11 cursor-pointer        /* w-11 = 44px */
```

Internal structure:

```tsx
<div className="flex h-full w-[300px] shrink-0 flex-col snap-start overflow-hidden rounded-xl border border-line-2 bg-paper">
  <ColumnHeader section={section} onCollapse={onToggleCollapse} />

  <div className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-2 pb-1 pt-2">
    {/* Ungrouped tasks at top — no label */}
    {section.ungroupedTasks.map(t => <TaskItem key={t.id} task={t} />)}
    {section.ungroupedTasks.length > 0 && <AddTaskInline label="Add task" />}

    {/* Stages */}
    {section.stages.map(stage => (
      <Fragment key={stage.id}>
        <Swimlane stage={stage} />
        {stage.tasks.map(t => <TaskItem key={t.id} task={t} />)}
        <AddTaskInline label={`Add to ${stage.name.toLowerCase()}`} />
      </Fragment>
    ))}

    {/* Empty state when totalCount === 0 */}
  </div>

  <div className="border-t border-line-2 bg-surf-2 p-2">
    <AddStageButton />
  </div>
</div>
```

**Scrollbar:** the body should show a 6px sliver scrollbar:

```css
.col-body::-webkit-scrollbar { width: 6px; }
.col-body::-webkit-scrollbar-thumb { background: #D4D0C8; border-radius: 3px; }
```

**Drag handle:** the **column header itself** is the drag handle (cursor `grab`). When the user drags it, `useSortable` lifts the whole column. Don't make tasks accidentally draggable as columns — use `useSortable.listeners` only on the header, not on the body.

**Empty column state:**

```tsx
<div className="flex flex-1 flex-col items-center justify-center px-3 py-6 text-center">
  <div className="mb-3 flex h-9 w-9 items-center justify-center rounded-lg border border-dashed border-line text-mute-2">
    <PlusIcon className="h-3 w-3" />
  </div>
  <p className="text-xs leading-relaxed text-mute">
    No tasks yet.<br/>Add a stage or task to start.
  </p>
</div>
```

---

## `ColumnHeader`

```tsx
type Props = {
  section: Section;
  onCollapse: () => void;
  dragListeners?: SyntheticListenerMap;   // from useSortable
};
```

Visual: grip dot-grid on the left (only visible on column hover), section name + count + thin progress bar, tools cluster on the right (collapse + overflow menu, also hover-only).

```tsx
<div
  className="group/col-header relative flex cursor-grab items-start gap-2 border-b border-line-2 bg-paper px-3.5 py-3 active:cursor-grabbing"
  {...dragListeners}
>
  <div className="mt-0.5 shrink-0 opacity-0 transition-opacity group-hover/col-header:opacity-100 text-mute-2">
    <GripIcon />
  </div>

  <div className="min-w-0 flex-1">
    <div className="truncate text-sm font-semibold leading-tight tracking-[-0.01em] text-ink">
      {section.name}
    </div>
    <div className="mt-1 flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.06em] text-mute">
      <span className="text-ink-2">{section.doneCount}/{section.totalCount}</span>
      <div className="h-0.5 max-w-[60px] flex-1 overflow-hidden rounded-sm bg-line-2">
        <div className="h-full bg-ink-2" style={{ width: `${pct}%` }} />
      </div>
    </div>
  </div>

  <div className="flex gap-0.5 opacity-0 transition-opacity group-hover/col-header:opacity-100">
    <IconButton title="Collapse" onClick={onCollapse}><CollapseIcon /></IconButton>
    <IconButton title="More"><MoreIcon /></IconButton>
  </div>
</div>
```

> Use `group/col-header` (Tailwind named group) so the hover-reveal of tools doesn't accidentally trigger from child task-row hovers.

**Collapsed variant:** name rotates 90° via `writing-mode: vertical-rl` + `transform: rotate(180deg)`. Click anywhere to expand.

---

## `Swimlane`

Stage divider inside a column.

```tsx
type Props = { stage: { name: string; tasks: Task[] } };
```

```tsx
<div className="flex select-none items-center gap-2 px-1.5 pb-1.5 pt-3.5 font-mono text-[10px] font-medium uppercase tracking-[0.12em] text-mute">
  <span>{stage.name}</span>
  <span className="font-normal text-mute-2">
    {stage.tasks.filter(t => !t.done).length}/{stage.tasks.length}
  </span>
  <span className="h-px flex-1 bg-line-2" />
</div>
```

Behavior:
- Click on the label area collapses/expands the lane (optional v1.1).
- The horizontal line on the right is purely decorative — it fills remaining space so swimlanes feel like dividers, not headings.

---

## `AddTaskInline`

The "+ Add task" button at the bottom of each lane (and ungrouped section).

```tsx
type Props = {
  label?: string;                  // default "Add task"
  onAdd: (title: string) => void;
};
```

Two states:
1. **Rest** — dashed-border button with `+ Add task`.
2. **Active** — clicking turns it into an inline `<input>` that commits on Enter / blur. Esc cancels.

Rest:

```tsx
<button
  type="button"
  className="
    mx-0.5 my-1 flex items-center gap-2 rounded-md border border-dashed border-line
    bg-transparent px-2.5 py-2 text-left font-sans text-xs text-mute
    transition-colors hover:border-mute-2 hover:bg-surf-2 hover:text-ink-2
  "
>
  <span className="font-mono text-[13px] text-mute-2">+</span>
  {label || 'Add task'}
</button>
```

> Reuse this for both lane-scoped and ungrouped-scoped adds. The label changes (`Add to research`, etc.).

---

## `AddStageButton`

Footer button on every column. Opens the existing `AddStageModal` (manual + AI batch).

```tsx
<button
  type="button"
  className="
    flex w-full items-center justify-center gap-1.5 rounded-md border border-line
    bg-transparent px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-[0.08em]
    text-mute transition-colors hover:border-mute-2 hover:bg-paper hover:text-ink-2
  "
>
  <PlusIcon className="h-3 w-3" />
  Add stage
</button>
```

---

## `NewSectionColumn`

Trailing column at the end of the row. Same width footprint as a regular column (a touch narrower, 240px, so it doesn't dominate). Dashed border, vertically centered call-to-action.

```tsx
<div className="flex h-full w-60 shrink-0 items-center justify-center rounded-xl border-[1.5px] border-dashed border-line bg-transparent">
  <button
    type="button"
    onClick={openNewSectionModal}
    className="flex flex-col items-center gap-2 p-6 text-mute transition-colors hover:text-ink-2"
  >
    <span className="font-mono text-2xl text-mute-2">+</span>
    <span className="text-sm">New section</span>
  </button>
</div>
```

---

## `FilterBar`

```tsx
type Props = {
  active: FilterId;                                  // 'all' | 'pending' | 'done' | 'rush' | 'high' | 'med' | 'low'
  onChange: (f: FilterId) => void;
  onCollapseAll: () => void;
  onExpandAll: () => void;
};
```

Pinned above the column scroller. Horizontal pill row + a divider + "Collapse all / Expand all" buttons + a search icon button (`Cmd-K`, future).

Container:

```
flex items-center gap-3.5 border-b border-line-2 bg-paper px-8 py-3.5
```

Pill (resting):

```
inline-flex items-center gap-1.5 whitespace-nowrap rounded-full
border border-line bg-paper px-2.5 py-1.5
font-mono text-[11px] uppercase leading-none tracking-[0.06em] text-ink-2
transition-colors hover:bg-surf-2
```

Pill (active):

```
border-ink bg-ink text-paper
```

Each pill has a small `<span>` count after the label with `text-[10px] text-mute` (or `text-paper/55` when active).

Priority pills have a colored dot before the label:

```tsx
<span className="h-1.5 w-1.5 rounded-full bg-priority-rush" />
```

**Mobile:** the pill row scrolls horizontally; hide the scrollbar.

---

## `ProjectHeader`

Sits **above** the filter bar. Project name (editable on click), progress bar, and action buttons.

```tsx
<header className="flex items-center justify-between gap-6 border-b border-line-2 bg-paper px-8 py-4">
  <div className="min-w-0">
    <div className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.06em] text-mute">
      <span>Workspace</span><span className="text-mute-2">/</span><span>Projects</span>
    </div>
    <h1
      contentEditable
      suppressContentEditableWarning
      className="mt-1.5 text-2xl font-semibold leading-tight tracking-[-0.015em] outline-none focus:underline focus:decoration-accent focus:decoration-1 focus:underline-offset-4"
    >
      {project.name}
    </h1>
    <div className="mt-2 flex items-center gap-3.5">
      <div className="h-1 w-[200px] overflow-hidden rounded-sm bg-line-2">
        <div className="h-full rounded-sm bg-ink" style={{ width: `${pct}%` }} />
      </div>
      <span className="font-mono text-[11px] tracking-[0.04em] text-mute">
        {done} of {total} · {pct}%
      </span>
    </div>
  </div>

  <div className="flex shrink-0 items-center gap-2">
    <button className="btn">⚡ Briefing</button>
    <button className="btn">Export</button>
    <button className="btn-primary">⚡ Focus</button>
  </div>
</header>
```

Button classes (semantic, define once globally):

```css
.btn {
  @apply inline-flex items-center gap-1.5 rounded-md border border-line bg-paper
         px-3.5 py-2 text-sm font-medium leading-none text-ink-2
         transition-colors hover:border-mute-2 hover:bg-surf-2;
}
.btn-primary {
  @apply inline-flex items-center gap-1.5 rounded-md border border-ink bg-ink
         px-3.5 py-2 text-sm font-medium leading-none text-paper
         transition-colors hover:bg-ink-2;
}
.btn-ghost {
  @apply inline-flex items-center gap-1.5 rounded-md bg-transparent
         px-3.5 py-2 text-sm font-medium leading-none text-ink-2
         transition-colors hover:bg-line-2;
}
```

---

## `TaskDetailPanel` (desktop)

```tsx
type Props = {
  taskId: string | null;            // null = closed
  onClose: () => void;
};
```

Mounted at the body root (via portal). Renders nothing when closed. When open:

```tsx
<>
  {/* Scrim — only over the columns, not the in-progress sidebar */}
  <div
    className="
      fixed inset-y-0 left-0 z-40 bg-ink/[0.18]
      transition-opacity duration-200
      animate-fade-in
    "
    style={{ right: '380px + 288px' /* panel + sidebar */ }}
    onClick={onClose}
  />

  <aside
    role="dialog"
    aria-label="Task detail"
    className="
      fixed inset-y-0 z-50 flex w-[380px] flex-col
      border-l border-line bg-paper shadow-panel
      transition-transform duration-[240ms] ease-panel
      animate-slide-in-right
    "
    style={{ right: '288px' /* sit beside the in-progress sidebar */ }}
  >
    <header className="flex items-center justify-between gap-3 border-b border-line-2 px-4.5 pb-3 pt-4">
      <div className="font-mono text-[10px] uppercase tracking-[0.08em] text-mute">
        <span className="font-medium text-ink-2">{task.section.name}</span> · {task.stage?.name ?? 'Ungrouped'}
      </div>
      <div className="flex items-center gap-1.5">
        <IconButton title="More"><MoreIcon /></IconButton>
        <IconButton title="Close" onClick={onClose}><CloseIcon /></IconButton>
      </div>
    </header>

    <div className="flex flex-1 flex-col gap-5.5 overflow-y-auto p-4.5">
      <h2 className="m-0 text-[19px] font-semibold leading-tight tracking-[-0.01em]">
        {task.title}
      </h2>

      <Field label="Status">
        <StatusSegmented value={task.status} onChange={…} />     {/* Pending · In progress · Done */}
      </Field>

      <Field label="Priority">
        <PrioritySegmented value={task.priority} onChange={…} /> {/* Rush · High · Med · Low */}
      </Field>

      <Field label="Due">
        <DatePicker value={task.due} />                          {/* "Tue, May 19" — "in 5 days" */}
      </Field>

      <Field label="Notes">
        <textarea className="tp-notes" defaultValue={task.notes} />
      </Field>

      <Field label="Tags">
        <TagsRow tags={task.tags} onAdd={…} />
      </Field>

      <Field label="Discussion">
        <DiscussionPlaceholder />                                {/* future */}
      </Field>
    </div>
  </aside>
</>
```

**Field wrapper:**

```tsx
function Field({ label, children }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="font-mono text-[10px] uppercase tracking-[0.1em] text-mute">{label}</div>
      {children}
    </div>
  );
}
```

**Notes textarea classes:**

```
w-full min-h-[96px] rounded-md border border-line-2 bg-surf-2 p-3
font-sans text-[13px] leading-[1.55] text-ink-2 resize-y
focus:outline-none focus:border-accent focus:bg-paper
```

**Status segmented (3 options):**

```tsx
<div className="grid grid-cols-3 gap-1.5 rounded-lg bg-surf-2 p-1">
  {options.map(o => (
    <button
      key={o.id}
      className={cx(
        'flex flex-col items-center gap-1 rounded-md px-1 py-2 text-xs font-medium transition-colors',
        value === o.id
          ? 'bg-paper text-ink shadow-[0_1px_2px_rgba(26,25,22,0.05)]'
          : 'bg-transparent text-mute'
      )}
    >
      <span className={cx('h-1.5 w-1.5 rounded-full', value === o.id ? 'bg-accent' : 'bg-mute-2')} />
      {o.label}
    </button>
  ))}
</div>
```

**Priority segmented (4 options):** same structure, 4-col grid; the **active** button uses the priority color as bg (`bg-priority-rush`, `bg-priority-high`, `bg-priority-med`, `bg-ink` for low).

**Slide-in animation:** apply on mount. See `03_interactions.md` for the keyframes (use `framer-motion` or raw CSS keyframes — both fine).

---

## `TaskDetailSheet` (mobile)

Same fields as `TaskDetailPanel`, presented as a bottom sheet. Drag handle, ~60vh height, backdrop dismiss.

```tsx
<>
  <div className="fixed inset-0 z-40 bg-ink/30" onClick={onClose} />
  <div
    role="dialog"
    className="
      fixed inset-x-0 bottom-0 z-50 flex max-h-[85vh] flex-col
      rounded-t-sheet bg-paper shadow-sheet
      transition-transform duration-[280ms] ease-panel
      animate-sheet-up
    "
    style={{ height: '62vh' }}
  >
    {/* drag handle */}
    <div className="mx-auto mt-2 h-1 w-9 rounded-sm bg-line" />

    <div className="flex flex-col gap-4 overflow-y-auto px-4 pb-6 pt-3">
      {/* same Fields as TaskDetailPanel */}
    </div>
  </div>
</>
```

Use `react-modal-sheet` or roll your own. The drag-to-dismiss interaction:
- `pointerdown` on the handle starts tracking
- `pointermove` updates `translateY` with a clamp at 0
- `pointerup` snaps back to 0 if `< 80px` dragged, else animates out and calls `onClose()`

See the working reference in `reference/TaskDetailSheet.tsx`.

---

## `InProgressSidebar` (desktop)

Right rail, 288px (`w-72`), full-height, scroll on overflow. Pinned next to the column area.

```
hidden md:flex flex-col gap-3 w-72 shrink-0 h-full
border-l border-line-2 bg-paper px-4 py-4.5 overflow-y-auto
```

Featured top card (the *one* highest-priority in-progress task):

```
bg-ink text-paper border-ink rounded-lg p-3.5 flex flex-col gap-2
```

Other cards:

```
bg-paper border border-line rounded-lg p-3.5 flex flex-col gap-2
```

Card internals (`InProgressCard`):

```tsx
<div className={featured ? 'feature' : ''}>
  <span className="font-mono text-[9.5px] uppercase tracking-[0.1em] text-mute">  {/* paper/55 when featured */}
    {task.sectionName}
  </span>
  <p className="text-sm font-medium leading-snug">{task.title}</p>             {/* text-[15px] when featured */}
  <div className="flex items-center gap-2 font-mono text-[10px] tracking-[0.04em] text-mute">
    <span className="text-accent">● {task.dueLabel}</span>
    <span>·</span>
    <span>{task.startedAgo}</span>
  </div>
  {featured && (
    <div className="mt-1 flex gap-1.5">
      <button className="mini-btn-go">Focus →</button>
      <button className="mini-btn">Complete</button>
    </div>
  )}
</div>
```

> Keep the existing visual treatment of the in-progress sidebar if it's already shipped — this redesign **only repositions** it. If you don't have one yet, the spec above is the new design.

---

## `InProgressFab` (mobile)

Floating pill, bottom-right, opens `InProgressSheet`.

```
fixed right-3.5 bottom-4 z-30
flex items-center gap-1.5
rounded-full bg-ink text-paper
px-3.5 py-2.5
font-mono text-[11px] uppercase tracking-[0.06em]
shadow-fab
```

Internal:

```tsx
<button className="...">
  <PlayIcon className="h-3 w-3" />
  In progress
  <span className="rounded-full bg-accent px-1.5 py-px text-[10px] font-semibold text-white">
    {count}
  </span>
</button>
```

---

## `InProgressSheet` (mobile)

Same sheet shell as `TaskDetailSheet`, but content is the list of in-progress cards (featured + others) and a "View all" footer.

Height: `~70vh`.

---

## `HorizontalScrollRail`

Bottom-of-board scroll affordance. Variant B (recommended).

```tsx
type Props = {
  scrollerRef: RefObject<HTMLDivElement>;
};
```

Position: `absolute bottom-2 left-[22px] right-[22px]` (matches the scroller padding so it aligns to the column edges).

```tsx
<>
  <div className="pointer-events-none absolute bottom-2 left-[22px] right-[22px] h-[3px] overflow-hidden rounded-sm bg-line-2">
    <div
      ref={fillRef}
      className="h-full rounded-sm bg-mute-2"
      style={{ /* updated on scroll: width %, marginLeft % */ }}
    />
  </div>

  <div className="pointer-events-none absolute bottom-4 right-6 flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.06em] text-mute">
    <Kbd>⇧</Kbd><span>+</span><Kbd>scroll</Kbd>
    <span>to pan</span>
  </div>
</>
```

`Kbd`:

```tsx
function Kbd({ children }) {
  return (
    <kbd className="rounded-sm border border-line bg-paper px-1.5 py-0.5 font-mono text-[10px] text-ink-2">
      {children}
    </kbd>
  );
}
```

Update logic on scroll (in `useHorizontalWheelScroll` or the parent):

```ts
const w = scroller.clientWidth / scroller.scrollWidth;
const x = scroller.scrollLeft / (scroller.scrollWidth - scroller.clientWidth);
fillRef.current.style.width = `${w * 100}%`;
fillRef.current.style.marginLeft = `${x * (1 - w) * 100}%`;
```

Hide the rail entirely if `scrollWidth <= clientWidth` (fits without scroll).

---

## Icons

Use **lucide-react** (or whatever icon set Tasker already imports). The mapping:

| In mockup | lucide name |
|---|---|
| grip dots | `GripVertical` (or `MoreVertical`) |
| play (in-progress toggle) | `Play` |
| pause | `Pause` |
| more / overflow | `MoreHorizontal` |
| edit | `Pencil` |
| trash | `Trash2` |
| collapse arrow | `ChevronsLeft` |
| calendar | `Calendar` |
| chevron L/R | `ChevronLeft`, `ChevronRight` |
| close | `X` |
| plus | `Plus` |
| AI / focus | `Sparkles` or `Zap` |
| search | `Search` |

All icons at `h-3.5 w-3.5` (14px) inside `IconButton`, `h-3 w-3` (12px) inside chips/buttons-sm.
