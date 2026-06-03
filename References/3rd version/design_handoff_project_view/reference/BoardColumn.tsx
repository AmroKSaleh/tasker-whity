// BoardColumn.tsx — one section, rendered as a column.
import { Fragment } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { useDroppable } from '@dnd-kit/core';
import { ColumnHeader } from './ColumnHeader';
import { Swimlane } from './Swimlane';
import { AddTaskInline } from './AddTaskInline';
import { AddStageButton } from './AddStageButton';
import { TaskItem } from './TaskItem.placeholder';  // swap for your real TaskItem
import { Plus } from 'lucide-react';
import clsx from 'clsx';
import type { Section } from './types';

type Props = {
  section: Section;
  isSelected: (taskId: string) => boolean;
  onSelectTask: (taskId: string) => void;
};

export function BoardColumn({ section, isSelected, onSelectTask }: Props) {
  const sortable = useSortable({
    id: section.id,
    data: { type: 'column' },
  });
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = sortable;

  // Drop target for cross-column task moves
  const droppable = useDroppable({
    id: `drop-${section.id}`,
    data: { type: 'column', sectionId: section.id, accepts: ['task'] },
  });

  if (section.collapsed) {
    return (
      <div
        ref={setNodeRef}
        style={{ transform: CSS.Translate.toString(transform), transition }}
        className="snap-start"
      >
        <CollapsedColumn section={section} dragHandle={{ ...attributes, ...listeners }} />
      </div>
    );
  }

  const isEmpty = section.totalCount === 0;
  const taskIds = [
    ...section.ungroupedTasks.map(t => t.id),
    ...section.stages.flatMap(s => s.tasks.map(t => t.id)),
  ];

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={clsx(
        'flex h-full w-[300px] shrink-0 snap-start flex-col overflow-hidden rounded-xl border border-line-2 bg-paper',
        isDragging && 'rotate-[-2deg] -translate-y-1 shadow-drag z-10',
      )}
    >
      <ColumnHeader
        section={section}
        dragHandle={{ ...attributes, ...listeners }}
      />

      <SortableContext items={taskIds} strategy={verticalListSortingStrategy}>
        <div
          ref={droppable.setNodeRef}
          className="col-body flex flex-1 flex-col gap-0.5 overflow-y-auto px-2 pb-1 pt-2"
        >
          {isEmpty ? (
            <EmptyColumn />
          ) : (
            <>
              {/* Ungrouped tasks at top — no swimlane label */}
              {section.ungroupedTasks.map(t => (
                <TaskItem
                  key={t.id}
                  task={t}
                  selected={isSelected(t.id)}
                  onClick={() => onSelectTask(t.id)}
                />
              ))}
              {section.ungroupedTasks.length > 0 && (
                <AddTaskInline label="Add task" sectionId={section.id} stageId={null} />
              )}

              {section.stages.map(stage => (
                <Fragment key={stage.id}>
                  <Swimlane stage={stage} />
                  {stage.tasks.map(t => (
                    <TaskItem
                      key={t.id}
                      task={t}
                      selected={isSelected(t.id)}
                      onClick={() => onSelectTask(t.id)}
                    />
                  ))}
                  <AddTaskInline
                    label={`Add to ${stage.name.toLowerCase()}`}
                    sectionId={section.id}
                    stageId={stage.id}
                  />
                </Fragment>
              ))}
            </>
          )}
        </div>
      </SortableContext>

      <div className="border-t border-line-2 bg-surf-2 p-2">
        <AddStageButton sectionId={section.id} />
      </div>
    </div>
  );
}

function EmptyColumn() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-3 py-6 text-center">
      <div className="mb-3 flex h-9 w-9 items-center justify-center rounded-lg border border-dashed border-line text-mute-2">
        <Plus className="h-3 w-3" />
      </div>
      <p className="text-xs leading-relaxed text-mute">
        No tasks yet.<br />Add a stage or task to start.
      </p>
    </div>
  );
}

function CollapsedColumn({ section, dragHandle }: { section: Section; dragHandle: any }) {
  return (
    <div
      className="flex h-full w-11 cursor-pointer flex-col items-center gap-3 rounded-xl border border-line-2 bg-paper p-2"
      title={`Expand ${section.name}`}
      // Click-to-expand handled by parent via section.collapsed toggle
    >
      <div
        className="flex-1 [writing-mode:vertical-rl] [transform:rotate(180deg)] cursor-grab"
        {...dragHandle}
      >
        <span className="text-[13px] font-semibold tracking-[0.04em] text-ink">{section.name}</span>
      </div>
      <span className="font-mono text-[10px] uppercase tracking-[0.06em] text-mute">
        {section.doneCount}/{section.totalCount}
      </span>
    </div>
  );
}
