# Handoff — Tasker Project View Redesign

> **For Claude Code.** Implementing this redesign in the existing Tasker codebase (React 19 + Vite + Tailwind v3 + Supabase + @dnd-kit).

## What this is

A **layout and interaction redesign** of the project view inside Tasker. The existing codebase is fully functional — this is not a rebuild. The internal design of `<TaskItem>` (checkbox, in-progress toggle, text, priority chip, due date, tags, drag handle, edit/delete) **stays exactly as it is**. What changes is the container around it: sections become horizontally-scrolling columns, stages become swimlane dividers inside those columns, and task detail moves into a right slide-in panel (desktop) or bottom sheet (mobile).

## How to use this bundle

The files in `mockups/` are **design references built in HTML+JSX** — prototypes showing the intended look and behavior, not production code to copy verbatim. The job is to **recreate these designs in the existing Tasker codebase** using its established patterns: function components, Tailwind v3 utility classes, `@dnd-kit/core` + `@dnd-kit/sortable` for drag/drop, Supabase for persistence.

The files in `reference/` are **Tailwind/React reference implementations** of each new component — copy them in, rename to match your file conventions, wire up to your Supabase queries / context / hooks.

## Fidelity

**High-fidelity.** Every color, spacing value, radius, and font choice in the mockups comes from the design tokens you provided in the brief — those tokens are reproduced exactly in `01_design_tokens.md`. Implement the visual layer pixel-faithfully.

## Read in this order

1. **`README.md`** ← you are here · overall plan, scope, file structure
2. **`01_design_tokens.md`** · the exact warm-neutral palette + Tailwind config additions
3. **`02_components.md`** · every new component, props, layout, Tailwind classes
4. **`03_interactions.md`** · @dnd-kit setup, slide-in/sheet animations, horizontal scroll
5. **`04_responsive.md`** · mobile bottom sheets, snap-scroll columns, FAB
6. **`05_integration_checklist.md`** · what to keep, what to replace, what to add
7. **`reference/`** · ready-to-adapt Tailwind component code
8. **`mockups/`** · open `Project View Redesign.html` in a browser for the full visual reference

## Scope summary

### New components

| Component | File suggestion | Purpose |
|---|---|---|
| `ProjectBoard` | `src/components/project/ProjectBoard.tsx` | The new top-level project view. Replaces the current vertical scroll layout. |
| `BoardColumn` | `src/components/project/BoardColumn.tsx` | One column = one section. Header + scrollable body + footer. |
| `ColumnHeader` | `src/components/project/ColumnHeader.tsx` | Section name, done/total, progress bar, collapse, overflow menu. Drag handle for column reorder. |
| `Swimlane` | `src/components/project/Swimlane.tsx` | Stage divider inside a column. Mono uppercase label + lane count + horizontal line. |
| `AddTaskInline` | `src/components/project/AddTaskInline.tsx` | The "+ Add task" affordance at the bottom of each lane (and ungrouped section). |
| `AddStageButton` | `src/components/project/AddStageButton.tsx` | The footer affordance on every column. |
| `NewSectionColumn` | `src/components/project/NewSectionColumn.tsx` | Trailing dashed column at the end of the board. |
| `FilterBar` | `src/components/project/FilterBar.tsx` | Pill row above the columns. Same pill style as today, repositioned. |
| `ProjectHeader` | `src/components/project/ProjectHeader.tsx` | Project name, progress, Export/Focus/Briefing. Repositioned above the filter bar. |
| `TaskDetailPanel` | `src/components/project/TaskDetailPanel.tsx` | Desktop slide-in from right, ~380px. |
| `TaskDetailSheet` | `src/components/project/TaskDetailSheet.tsx` | Mobile bottom sheet, ~60vh, drag-to-dismiss. |
| `InProgressSidebar` | `src/components/project/InProgressSidebar.tsx` | Desktop right rail. Featured top task. *Keep current visual treatment if you have one — reposition only.* |
| `InProgressSheet` | `src/components/project/InProgressSheet.tsx` | Mobile bottom sheet, opened via FAB. |
| `InProgressFab` | `src/components/project/InProgressFab.tsx` | Mobile floating button (bottom-right). |
| `HorizontalScrollRail` | `src/components/project/HorizontalScrollRail.tsx` | Thin progress rail + "⇧ + scroll" hint at the bottom of the column scroller. |

### Components to keep (unchanged or near-unchanged)

- `TaskItem` (row internals) — **do not change.** Just render it inside `BoardColumn` instead of inside the old vertical card list.
- `EditTaskModal` — keep. Still triggered by the pencil icon on `TaskItem`.
- `AddStageModal`, `AIBatchModal`, `AddTaskAIModal` — keep. Reposition triggers to the new column footer / inline buttons.
- Focus mode overlay — keep. Triggered by header `Focus` button.
- The Supabase query layer / project context / task state — keep.

### Components to delete (or stop using)

- The old `SectionCard` (expandable vertical card) — superseded by `BoardColumn`.
- Any "section scroll" container that stacked sections top-to-bottom.

## Top-level layout

```
<ProjectBoard>                                                              flex-col, h-screen
├── <ProjectHeader />                                                       fixed-height, border-b
├── <FilterBar />                                                           fixed-height, border-b
└── <div className="flex flex-1 min-h-0">                                  ← the "board area"
    ├── <div className="relative flex-1 min-h-0">                          ← columns wrapper
    │   ├── <div className="flex gap-3.5 h-full overflow-x-auto px-5 py-4 snap-x snap-proximity">
    │   │   <DndContext> <SortableContext>
    │   │     <BoardColumn /> ← repeats
    │   │     <NewSectionColumn />
    │   │   </SortableContext> </DndContext>
    │   └── <HorizontalScrollRail />                                       absolutely positioned at bottom
    │
    └── <InProgressSidebar />                                              hidden md:flex, w-72, border-l

  <TaskDetailPanel />          ← portal, desktop only, slides over the right side
  <TaskDetailSheet />          ← portal, mobile only, slides up from bottom
  <InProgressFab />            ← portal, mobile only, fixed bottom-right
  <InProgressSheet />          ← portal, mobile only, opens from FAB
</ProjectBoard>
```

## Key decisions baked into the design

1. **Horizontal scroll affordance.** Variant **B** (thin progress rail + `⇧ + scroll` hint) is the recommendation. It stays out of the way and doesn't compete with column-header hover affordances. Variant A (edge arrows on hover) is shown in the mockups for comparison only.
2. **Column width.** `300px` desktop, `calc(100vw - 32px)` mobile (with 16px outer padding for the peek of the next column).
3. **Column gap.** `14px` on desktop (= `gap-3.5` in Tailwind).
4. **Task detail panel width.** `380px` desktop. Sits *between* the column area and the in-progress sidebar — the sidebar stays visible behind it. The scrim dims only the column area, not the sidebar.
5. **Mobile task detail height.** `~60vh`. Drag handle at top. Backdrop dismiss.
6. **Swimlane labels.** JetBrains Mono, 10px, uppercase, `tracking-widest`, with a thin horizontal line filling remaining space and a lane count (`3/5`) before the line.
7. **Drag-and-drop.** Two `DndContext` levels: outer for column reordering (drag the column header), inner for task reordering within and between columns. Both via `@dnd-kit/sortable`.

## File structure of this handoff

```
design_handoff_project_view/
├── README.md                          ← you are here
├── 01_design_tokens.md
├── 02_components.md
├── 03_interactions.md
├── 04_responsive.md
├── 05_integration_checklist.md
├── reference/
│   ├── tailwind.config.cjs            ← Tailwind theme extension
│   ├── ProjectBoard.tsx
│   ├── BoardColumn.tsx
│   ├── ColumnHeader.tsx
│   ├── Swimlane.tsx
│   ├── AddTaskInline.tsx
│   ├── AddStageButton.tsx
│   ├── NewSectionColumn.tsx
│   ├── FilterBar.tsx
│   ├── ProjectHeader.tsx
│   ├── TaskDetailPanel.tsx
│   ├── TaskDetailSheet.tsx
│   ├── InProgressSidebar.tsx
│   ├── InProgressSheet.tsx
│   ├── InProgressFab.tsx
│   ├── HorizontalScrollRail.tsx
│   ├── useHorizontalWheelScroll.ts
│   ├── useMediaQuery.ts
│   └── useTaskPanelState.ts
└── mockups/
    ├── Project View Redesign.html     ← open in browser to see all frames
    ├── redesign.css
    ├── redesign-*.jsx
    └── design-canvas.jsx
```

## A note on @dnd-kit

The existing codebase already uses `@dnd-kit` for task reordering within a list. You will need to:

- Wrap the columns row in a *second* `DndContext` + `SortableContext` (strategy: `horizontalListSortingStrategy`) so columns themselves are reorderable by dragging the column header.
- Inside each column body, keep your existing task-reorder `SortableContext` (strategy: `verticalListSortingStrategy`).
- Allow cross-column drops by registering all columns' droppable IDs. Use the `onDragOver` event on the outer context to move a task between columns visually before the drop is committed.

See `03_interactions.md` for the full pattern.
