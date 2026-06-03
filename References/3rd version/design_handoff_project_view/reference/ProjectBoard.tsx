// ProjectBoard.tsx — the new top-level project view.
import { useRef } from 'react';
import {
  DndContext, PointerSensor, KeyboardSensor, closestCenter,
  useSensor, useSensors, DragOverEvent, DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext, horizontalListSortingStrategy, arrayMove,
} from '@dnd-kit/sortable';
import { ProjectHeader } from './ProjectHeader';
import { FilterBar } from './FilterBar';
import { BoardColumn } from './BoardColumn';
import { NewSectionColumn } from './NewSectionColumn';
import { InProgressSidebar } from './InProgressSidebar';
import { InProgressFab } from './InProgressFab';
import { InProgressSheet } from './InProgressSheet';
import { TaskDetailPanel } from './TaskDetailPanel';
import { TaskDetailSheet } from './TaskDetailSheet';
import { HorizontalScrollRail } from './HorizontalScrollRail';
import { useHorizontalWheelScroll, useScrollProgress } from './hooks/useHorizontalWheelScroll';
import { useIsDesktop } from './hooks/useMediaQuery';
import { useTaskPanelState } from './hooks/useTaskPanelState';
import type { Project, Section } from './types';

type Props = {
  project: Project;
  sections: Section[];
  // Wire these to your existing Supabase mutations.
  onReorderSections: (next: Section[]) => void;
  onMoveTask: (taskId: string, toSectionId: string, toStageId: string | null, toIndex: number) => void;
};

export function ProjectBoard({ project, sections, onReorderSections, onMoveTask }: Props) {
  const isDesktop = useIsDesktop();
  const { selectedTaskId, openTask, closeTask } = useTaskPanelState();

  const scrollerRef = useRef<HTMLDivElement>(null);
  useHorizontalWheelScroll(scrollerRef);
  useScrollProgress(scrollerRef);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: isDesktop ? { distance: 6 } : { delay: 220, tolerance: 5 },
    }),
    useSensor(KeyboardSensor),
  );

  function handleDragOver(e: DragOverEvent) {
    // Optimistically move a task between columns while still dragging.
    // See 03_interactions.md for the full pattern.
    const { active, over } = e;
    if (!over) return;
    const activeType = active.data.current?.type;
    if (activeType !== 'task') return;
    const fromSectionId = active.data.current?.sectionId;
    const toSectionId   = over.data.current?.sectionId ?? (over.data.current?.type === 'column' ? String(over.id) : null);
    if (!fromSectionId || !toSectionId || fromSectionId === toSectionId) return;
    onMoveTask(String(active.id), toSectionId, null, 0);
  }

  function handleDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over || active.id === over.id) return;

    if (active.data.current?.type === 'column') {
      const oldIndex = sections.findIndex(s => s.id === active.id);
      const newIndex = sections.findIndex(s => s.id === over.id);
      if (oldIndex >= 0 && newIndex >= 0) {
        onReorderSections(arrayMove(sections, oldIndex, newIndex));
      }
    }
    // Task reorder within a column is handled by the inner SortableContext (per column).
    // Cross-column moves are already in place via handleDragOver above.
  }

  return (
    <div className="flex h-screen flex-col bg-surf font-sans text-ink">
      <ProjectHeader project={project} />
      <FilterBar />

      <div className="flex min-h-0 flex-1">
        <div className="relative min-h-0 flex-1">
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragOver={handleDragOver}
            onDragEnd={handleDragEnd}
          >
            <div
              ref={scrollerRef}
              className="cols-scroll flex h-full snap-x snap-proximity gap-3.5 overflow-x-auto overflow-y-hidden px-5 py-4 md:snap-proximity"
            >
              <SortableContext items={sections.map(s => s.id)} strategy={horizontalListSortingStrategy}>
                {sections.map(s => (
                  <BoardColumn
                    key={s.id}
                    section={s}
                    isSelected={(taskId) => taskId === selectedTaskId}
                    onSelectTask={openTask}
                  />
                ))}
              </SortableContext>
              <NewSectionColumn />
            </div>
          </DndContext>

          <HorizontalScrollRail scrollerRef={scrollerRef} />
        </div>

        {isDesktop && <InProgressSidebar />}
      </div>

      {/* Overlays (rendered in-tree, but should be portaled in production for proper stacking) */}
      {selectedTaskId && (
        isDesktop
          ? <TaskDetailPanel taskId={selectedTaskId} onClose={closeTask} />
          : <TaskDetailSheet taskId={selectedTaskId} onClose={closeTask} />
      )}

      {!isDesktop && <InProgressFab />}
    </div>
  );
}
