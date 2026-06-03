# 03 — Interactions

Everything that's not a static layout: drag-and-drop, the slide-in/sheet animations, horizontal scroll, keyboard shortcuts, focus management.

---

## 1. Drag-and-drop (@dnd-kit)

Two levels of sortable contexts, nested. The outer reorders **columns**; the inner reorders **tasks** within (and between) columns.

### Outer context — column reorder

```tsx
import {
  DndContext, closestCenter, KeyboardSensor, PointerSensor,
  useSensor, useSensors,
} from '@dnd-kit/core';
import {
  SortableContext, horizontalListSortingStrategy, arrayMove,
} from '@dnd-kit/sortable';

function ProjectBoard({ sections, onReorderSections, onMoveTask }) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor)
  );

  function handleDragEnd(e) {
    const { active, over } = e;
    if (!over) return;

    // Column reorder
    if (active.data.current?.type === 'column' && active.id !== over.id) {
      const oldIndex = sections.findIndex(s => s.id === active.id);
      const newIndex = sections.findIndex(s => s.id === over.id);
      onReorderSections(arrayMove(sections, oldIndex, newIndex));
    }

    // Task move/reorder is handled by the inner context (below)
  }

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <SortableContext items={sections.map(s => s.id)} strategy={horizontalListSortingStrategy}>
        {sections.map(s => (
          <BoardColumn key={s.id} section={s} onMoveTask={onMoveTask} />
        ))}
      </SortableContext>
    </DndContext>
  );
}
```

`BoardColumn` uses `useSortable({ id: section.id, data: { type: 'column' } })` and **attaches its `listeners`/`attributes` only to the column header**, not to the body — otherwise dragging a task triggers a column drag too.

### Inner context — task reorder, cross-column moves

The trickiest part. We want users to drag a task from any column to any other column. There are two ways:

**Option A (recommended): one flat context with droppable columns.**

Put a single `DndContext` at the board level, but maintain *two* lists of sortable IDs:

```tsx
<DndContext onDragEnd={handleDragEnd} onDragOver={handleDragOver}>
  <SortableContext items={columnIds} strategy={horizontalListSortingStrategy}>
    {sections.map(s => (
      <BoardColumn key={s.id} section={s}>
        <SortableContext items={s.taskIds} strategy={verticalListSortingStrategy}>
          {s.tasks.map(t => <TaskItem key={t.id} task={t} />)}
        </SortableContext>
      </BoardColumn>
    ))}
  </SortableContext>
</DndContext>
```

In `handleDragOver`, detect when the dragged task crosses into a new column and call `onMoveTask(taskId, fromSectionId, toSectionId, toIndex)` to optimistically update local state. The `handleDragEnd` then commits the move to Supabase.

The shape of the move:

```ts
function handleDragOver(e) {
  const { active, over } = e;
  if (!over || active.data.current?.type !== 'task') return;

  const activeSectionId = active.data.current.sectionId;
  const overSectionId   = over.data.current?.sectionId ?? over.id; // dropped on column itself

  if (activeSectionId !== overSectionId) {
    moveTaskBetweenColumns(active.id, activeSectionId, overSectionId);
  }
}
```

Each column also needs to be a **droppable** (so empty columns can receive tasks). Add `useDroppable({ id: section.id, data: { type: 'column', accepts: ['task'] } })` to the column body.

**Option B:** one `DndContext` per column. Simpler, but cross-column moves require manual hand-off via portals — not recommended.

### Dragging visuals

The current `useSortable({ transform, transition, isDragging })` already drives the lifted appearance. Apply this to the task row when `isDragging`:

```tsx
<div
  ref={setNodeRef}
  style={{ transform: CSS.Translate.toString(transform), transition, opacity: isDragging ? 0.35 : 1 }}
  className={isDragging ? 'border border-dashed border-mute-2 bg-paper' : 'task-row'}
  {...attributes}
  {...listeners}
>
```

For the column itself (dragged via header), apply `shadow-drag` + `rotate-[-2deg] -translate-y-1` to the column wrapper while `isDragging`:

```
isDragging && 'rotate-[-2deg] -translate-y-1 shadow-drag z-10'
```

### Drop placeholder

Show an accent-tinted dashed bar at the drop target. `@dnd-kit` doesn't render this for you — render it yourself based on `useSortable.isOver` and `isSorting`:

```tsx
{isOver && isSorting && (
  <div className="my-0.5 h-[38px] rounded-md border border-dashed border-accent bg-accent-soft" />
)}
```

---

## 2. Slide-in / bottom-sheet animations

### Desktop panel — slide from right

Two clean approaches.

**A. CSS keyframes (no dep):**

```css
@keyframes slide-in-right {
  from { transform: translateX(100%); }
  to   { transform: translateX(0); }
}
@keyframes slide-out-right {
  from { transform: translateX(0); }
  to   { transform: translateX(100%); }
}
@keyframes fade-in  { from { opacity: 0 } to { opacity: 1 } }
@keyframes fade-out { from { opacity: 1 } to { opacity: 0 } }

.animate-slide-in-right { animation: slide-in-right 240ms cubic-bezier(0.2,0.7,0.3,1) both; }
.animate-fade-in        { animation: fade-in 180ms linear both; }
```

In Tailwind config:

```js
extend: {
  keyframes: {
    'slide-in-right':  { '0%': { transform: 'translateX(100%)' }, '100%': { transform: 'translateX(0)' } },
    'slide-out-right': { '0%': { transform: 'translateX(0)' },   '100%': { transform: 'translateX(100%)' } },
    'fade-in':  { '0%': { opacity: 0 }, '100%': { opacity: 1 } },
    'fade-out': { '0%': { opacity: 1 }, '100%': { opacity: 0 } },
    'sheet-up':   { '0%': { transform: 'translateY(100%)' }, '100%': { transform: 'translateY(0)' } },
    'sheet-down': { '0%': { transform: 'translateY(0)' },    '100%': { transform: 'translateY(100%)' } },
  },
  animation: {
    'slide-in-right':  'slide-in-right 240ms cubic-bezier(0.2,0.7,0.3,1) both',
    'slide-out-right': 'slide-out-right 220ms cubic-bezier(0.2,0.7,0.3,1) both',
    'fade-in':  'fade-in 180ms linear both',
    'fade-out': 'fade-out 180ms linear both',
    'sheet-up':   'sheet-up 280ms cubic-bezier(0.2,0.7,0.3,1) both',
    'sheet-down': 'sheet-down 260ms cubic-bezier(0.2,0.7,0.3,1) both',
  },
},
```

**B. framer-motion:** if it's already in the codebase, prefer this — its `AnimatePresence` handles unmount animations cleanly without manual exit-state bookkeeping.

```tsx
<AnimatePresence>
  {open && (
    <motion.aside
      key="panel"
      initial={{ x: '100%' }} animate={{ x: 0 }} exit={{ x: '100%' }}
      transition={{ duration: 0.24, ease: [0.2, 0.7, 0.3, 1] }}
      className="..."
    />
  )}
</AnimatePresence>
```

### Mobile sheet — slide from bottom

Same shapes, just `translateY` instead of `translateX`. The drag handle needs gesture support:

```tsx
function useSheetDrag(onDismiss) {
  const [dy, setDy] = useState(0);
  const start = useRef(0);
  function onPointerDown(e) { start.current = e.clientY; e.currentTarget.setPointerCapture(e.pointerId); }
  function onPointerMove(e) { setDy(Math.max(0, e.clientY - start.current)); }
  function onPointerUp() {
    if (dy > 80) { setDy(window.innerHeight); requestAnimationFrame(onDismiss); }
    else setDy(0);
  }
  return { handlers: { onPointerDown, onPointerMove, onPointerUp }, dy };
}
```

Apply `style={{ transform: `translateY(${dy}px)`, transition: dy ? 'none' : '...' }}` on the sheet. Only the handle (the 9px-wide pill at the top) consumes the gesture — the sheet body should still scroll normally.

---

## 3. Horizontal scroll

### Wheel handling

Desktop mice scroll vertically; the column row needs to convert that to horizontal scroll only under modifier or when the horizontal scroll is more dominant.

```ts
function useHorizontalWheelScroll(ref) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    function onWheel(e) {
      // shift+wheel always pans
      if (e.shiftKey) {
        e.preventDefault();
        el.scrollLeft += e.deltaY;
        return;
      }
      // trackpad horizontal swipes (deltaX) — already work natively, no need to intercept
      // plain mouse-wheel — leave alone, let it scroll vertically inside the focused column
    }
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [ref]);
}
```

### Hide the scrollbar

```css
.cols-scroll {
  scrollbar-width: none;        /* Firefox */
}
.cols-scroll::-webkit-scrollbar { height: 0; }   /* Safari/Chrome */
```

### Snap behavior

```
snap-x snap-proximity            /* on the scroller */
snap-start                       /* on each <BoardColumn> */
```

On mobile use `snap-mandatory` instead (each swipe locks to one column):

```
snap-x snap-mandatory            /* mobile */
snap-x snap-proximity            /* desktop — looser */
```

---

## 4. Column collapse / expand

Trigger: `IconButton` in the column header, OR click anywhere on a collapsed column.

State is **persisted to Supabase** alongside section metadata (`section.collapsed: boolean`). It's per-user-per-section.

Animate the width change with a CSS transition:

```css
.col { transition: width 220ms ease-out; }
.col.collapsed { width: 44px; }
```

The body has `overflow: hidden` so contents simply disappear when the width shrinks. When you swap the markup for the vertical-label, do it on `transitionend` to avoid jank.

**Collapse all / Expand all** in the filter bar = `sections.map(s => setCollapsed(s.id, true|false))`.

---

## 5. Keyboard shortcuts

| Key | Action |
|---|---|
| `Esc` | Close task panel/sheet · close in-progress sheet · cancel inline add-task |
| `Cmd/Ctrl + K` | Open search (future, but stub the shortcut now) |
| `Cmd/Ctrl + Shift + →/←` | Scroll one column forward/back |
| `Enter` (on task row) | Open task panel |
| `Space` (on task row) | Toggle checkbox |
| `J / K` (on row) | Move selection down / up (vim — optional power user) |

Wire `Esc` via a single document-level handler that pops the topmost overlay.

---

## 6. Focus management

When the task panel/sheet opens:

```tsx
useEffect(() => {
  if (!open) return;
  const previous = document.activeElement;
  panelRef.current?.querySelector('h2')?.focus();
  return () => previous?.focus();
}, [open]);
```

Also trap Tab inside the panel — `focus-trap-react` works, or roll your own with a sentinel `<div tabIndex={0}>` at start and end.

---

## 7. Optimistic state + Supabase

The redesign doesn't change the data model. The flow stays:

```
user gesture → setLocalState (optimistic) → supabase upsert → on error, revert + toast
```

For task moves across columns, the relevant fields to update are `section_id` and `position` (and `stage_id` if you drop into a specific lane). Send all three in one upsert.

For column reorder, update `section.position` on every reorder. Use `arrayMove` from `@dnd-kit/sortable` to compute the new ordering, then upsert the affected sections in one batch.

Use a debounced batch (200ms) so a rapid sequence of drops doesn't N+1 Supabase.

---

## 8. Empty / loading / error states

| State | Where | Treatment |
|---|---|---|
| No sections yet | Whole board | Render only `<NewSectionColumn />` centered. |
| Section has no tasks/stages | `BoardColumn` body | Dashed plus glyph + "No tasks yet" + "Add a stage or task to start." |
| Loading project | Whole board | Skeleton: 3 columns with 4 shimmer rows each. |
| Failed to save | Toast | "Couldn't save change. Retrying..." (you presumably already have this) |
| Offline | Top of board | A thin banner using `bg-priority-rush/10 text-priority-rush`. |
