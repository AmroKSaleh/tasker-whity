# 05 — Integration Checklist

Step-by-step plan for plugging this redesign into the existing Tasker codebase. Designed to be executed in order — each step is independently shippable behind a feature flag if you want.

## Phase 0 — preconditions

- [ ] You have `@dnd-kit/core` and `@dnd-kit/sortable` already installed (you do — the current codebase uses them for task reorder).
- [ ] You have `lucide-react` (or another icon set) — match the icons listed in `02_components.md`.
- [ ] You have a way to do portals — React's native `createPortal` is fine; no extra dep needed.
- [ ] Optional: `framer-motion` already in deps? Use it for the panel/sheet transitions. Otherwise the CSS keyframes in `03_interactions.md` are enough.
- [ ] Optional: `clsx` or `classnames` for conditional Tailwind class composition — small utility, worth adding.

## Phase 1 — tokens & global styles

- [ ] Apply the Tailwind config extension from `01_design_tokens.md` (colors, fontFamily, fontSize, boxShadow, borderRadius, transitionTimingFunction, keyframes, animation).
- [ ] Add the `Inter` and `JetBrains Mono` Google Font imports to `index.html` (or your `<head>` injection):
  ```html
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet" />
  ```
- [ ] Add the `.btn`, `.btn-primary`, `.btn-ghost` semantic classes to your global stylesheet (or `@layer components` in your main `index.css`).
- [ ] Add the keyframe animations (slide-in-right, sheet-up, fade-in, etc.) — already in the Tailwind config.
- [ ] Add the global scrollbar hide for `.cols-scroll` (only — don't remove scrollbars site-wide).

## Phase 2 — feature flag

- [ ] Add `enableBoardView` flag (Supabase `user_preferences.experimental_board_view` or local-storage). Default `false` for now; toggle to `true` per-user during dev.
- [ ] In the existing project route, branch:
  ```tsx
  return enableBoardView
    ? <ProjectBoard project={project} sections={sections} />
    : <LegacyProjectView project={project} />;
  ```

## Phase 3 — scaffold new files

In `src/components/project/`, create:

```
ProjectBoard.tsx
BoardColumn.tsx
ColumnHeader.tsx
Swimlane.tsx
AddTaskInline.tsx
AddStageButton.tsx
NewSectionColumn.tsx
FilterBar.tsx
ProjectHeader.tsx
TaskDetailPanel.tsx
TaskDetailSheet.tsx
InProgressSidebar.tsx
InProgressFab.tsx
InProgressSheet.tsx
HorizontalScrollRail.tsx
hooks/useHorizontalWheelScroll.ts
hooks/useMediaQuery.ts
hooks/useTaskPanelState.ts
hooks/useSheetDrag.ts
```

Adapt the files in `reference/` — they are working examples. Rename to match your file conventions, swap your existing types for the placeholder ones, swap your icon library, swap your existing `TaskItem` import.

## Phase 4 — wire up data

The redesign uses the same data the current app exposes — `Project`, `Section`, `Stage` (a.k.a. group), `Task`. No schema changes required.

Expected shapes (adjust to your actual types):

```ts
type Project   = { id, name, doneCount, totalCount };
type Section   = { id, name, position, collapsed, ungroupedTasks: Task[], stages: Stage[], doneCount, totalCount };
type Stage     = { id, name, position, tasks: Task[] };
type Task      = { id, title, status: 'pending'|'in_progress'|'done', priority: 'rush'|'high'|'med'|'low'|null, due_at, tags: string[], notes, ... };
```

Existing hooks you should reuse (rename as needed):

- `useProject(projectId)` → returns `project`, `sections`, loading, error
- `useTaskMutations()` → `updateTask`, `moveTask`, `deleteTask`, `toggleStatus`
- `useSectionMutations()` → `createSection`, `renameSection`, `reorderSections`, `setCollapsed`, `deleteSection`
- `useFilters()` → `active`, `setActive`, `filteredSections`
- `useFocusMode()` → `enterFocusMode`, `currentFocusedTask`, etc.

## Phase 5 — task detail panel (the trickiest part)

- [ ] Add `selectedTaskId` to project view state (or URL: `?task=<id>` so deep links work and refresh preserves panel state).
- [ ] On task row click → `setSelectedTaskId(t.id)`.
- [ ] `TaskDetailPanel` reads `task` by id from your store, hydrates fields, debounces saves on edit.
- [ ] Status segmented control swaps the three current toggles (Pending / In progress / Done). On switch: optimistic update, call `toggleStatus(id, newStatus)`.
- [ ] Priority segmented control replaces any current dropdown. Same shape.
- [ ] Date picker — use whatever you have (`react-day-picker` is a good default). Trigger from the date row.
- [ ] Tags — reuse existing tags input. Add as inline chips with a `+ tag` adder.
- [ ] Notes textarea — debounce-save on blur or every 800ms while editing.
- [ ] Discussion section — `<DiscussionPlaceholder />` for v1. No real implementation yet.
- [ ] Trap focus inside the panel. `Esc` closes. Click on scrim closes.

## Phase 6 — drag-and-drop

- [ ] **Inner sortable** (tasks): if you already have a single `SortableContext` per section, this stays — but ensure each task's `data` carries its `sectionId` so cross-section moves work.
- [ ] **Outer sortable** (columns): new `DndContext` + `SortableContext` at the board level. Strategy: `horizontalListSortingStrategy`.
- [ ] **Cross-column task moves:** handle in `onDragOver` of the outer context. See `03_interactions.md` § 1.
- [ ] **Drag handle on column header:** only attach `listeners` to the header row, not the body.
- [ ] **Drag handle on task row:** existing — keep, but reposition: it's on the **left** (replacing nothing — it just appears on hover). The current task design likely has the handle on the right; check the brief — the brief preserves the internal TaskItem design, so if the handle is on the right, keep it on the right and remove the `.grip` element from the row container in this redesign (the column-level handle is sufficient).
- [ ] **Empty column drop target:** wrap each `BoardColumn` body in `useDroppable({ id: section.id, data: { type: 'column' } })` so an empty column can receive a task.

## Phase 7 — horizontal scroll

- [ ] Mount `useHorizontalWheelScroll(scrollerRef)` on the column scroller.
- [ ] Mount `HorizontalScrollRail` inside the column wrapper (sibling to the scroll container).
- [ ] On scroll, update the rail fill — see hook reference.
- [ ] Hide the native horizontal scrollbar (CSS in `03_interactions.md` § 3).
- [ ] Add `Cmd/Ctrl + Shift + ←/→` keyboard handler to scroll one column.

## Phase 8 — mobile

- [ ] Branch on `useMediaQuery('(min-width: 768px)')`.
- [ ] Render `TaskDetailSheet` instead of `TaskDetailPanel` on mobile.
- [ ] Render `InProgressFab` + `InProgressSheet` instead of `InProgressSidebar`.
- [ ] Switch column scroller to `snap-x snap-mandatory` and full-viewport-width columns.
- [ ] Add the dot indicator above the column scroller.
- [ ] Configure `PointerSensor` with `delay: 220, tolerance: 5` on mobile so swipe-to-scroll doesn't trigger drag.
- [ ] Test safe-area insets on iOS (FAB clears the home indicator).

## Phase 9 — polish

- [ ] Skeleton state for the board (3 columns, 4 shimmer rows each) while sections load.
- [ ] Empty section state (no tasks/stages).
- [ ] Empty project state (no sections — render only `<NewSectionColumn />`).
- [ ] Toasts for save errors (you presumably already have these).
- [ ] Reduce-motion override: respect `prefers-reduced-motion: reduce`, halve durations, disable slide-in transforms (instant open/close).

## Phase 10 — kill the legacy

- [ ] Once `enableBoardView` is on for everyone, remove the flag.
- [ ] Delete `SectionCard` and any vertical-list scaffolding.
- [ ] Move the project view route's import to `ProjectBoard` directly.
- [ ] Remove unused CSS (Tailwind purges automatically; only your custom CSS matters).

## What you should NOT change

Per the brief, leave these untouched:

- `TaskItem` row internals (checkbox / play / text / chip / date / tags / drag handle / edit / delete).
- `EditTaskModal` (still triggered by the pencil icon on the task row).
- `AddStageModal` + `AIBatchModal` (still triggered by the column footer button).
- `AddTaskAIModal` (the second-row AI input). It still works the same — just the placement moves. v1 suggestion: keep it as a single shared input at the top of the column scroller (or at the project header).
- Focus mode overlay.
- The Supabase data model.
- Auth flows.

## Smoke test before shipping

- [ ] Drag a task between three different columns — order persists after reload.
- [ ] Drag a column to the end of the row — order persists.
- [ ] Open task panel, edit title, close — change persists.
- [ ] On mobile, swipe through all columns; dot indicator follows.
- [ ] Open task sheet on mobile, drag the handle down — closes; drag halfway and release — snaps back.
- [ ] Filter to Pending → only pending tasks render in each column; counts in column headers update.
- [ ] Collapse a column → state survives reload (Supabase round-trip).
- [ ] Resize browser around the 768px breakpoint with the panel open → it swaps to sheet, content unchanged.
- [ ] `Esc` closes the panel, the sheet, and the in-progress sheet.
