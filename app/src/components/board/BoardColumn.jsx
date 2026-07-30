import { useState } from 'react'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { useDroppable } from '@dnd-kit/core'
import { Plus } from 'lucide-react'
import clsx from 'clsx'
import ColumnHeader from './ColumnHeader'
import Swimlane from './Swimlane'
import AddTaskInline from './AddTaskInline'
import TaskItem from '../tasks/TaskItem'

function filterTask(task, filter) {
  if (filter === 'pending') return task.status !== 'done'
  if (filter === 'done')    return task.status === 'done'
  if (filter === 'rush')    return task.priority === 'rush'   && task.status !== 'done'
  if (filter === 'high')    return task.priority === 'high'   && task.status !== 'done'
  if (filter === 'medium')  return task.priority === 'medium' && task.status !== 'done'
  if (filter === 'low')     return task.priority === 'low'    && task.status !== 'done'
  return true
}

export default function BoardColumn({
  section,
  prefix,
  filter = 'all',
  onAddTask,
  onToggleDone,
  onToggleInProgress,
  onDeleteTask,
  onSelectTask,
  onFocusTask,
  onPinTask,
  onSelectSection,
  milestoneProgress = {},
}) {
  const [collapsed, setCollapsed] = useState(false)

  const {
    attributes, listeners, setNodeRef,
    transform, transition, isDragging,
  } = useSortable({ id: section.id, data: { type: 'column' } })

  const { setNodeRef: setDropRef } = useDroppable({
    id: `drop-${section.id}`,
    data: { type: 'column', sectionId: section.id },
  })

  const filteredUngrouped = section.ungroupedTasks.filter(t => filterTask(t, filter))
  const filteredGroups = section.groups.map(g => ({
    ...g,
    tasks: g.tasks.filter(t => filterTask(t, filter)),
  }))

  const taskIds = [
    ...section.ungroupedTasks.map(t => t.id),
    ...section.groups.flatMap(g => g.tasks.map(t => t.id)),
  ]

  if (collapsed) {
    return (
      <div
        ref={setNodeRef}
        style={{ transform: CSS.Translate.toString(transform), transition }}
        onClick={() => setCollapsed(false)}
        className="cursor-pointer"
      >
        <div className="flex h-full w-11 flex-col items-center gap-3 rounded-xl border border-line-2 bg-paper p-2">
          <div
            className="flex-1 cursor-grab"
            style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)' }}
            {...attributes}
            {...listeners}
            onClick={(e) => e.stopPropagation()}
          >
            <span className="text-[13px] font-semibold tracking-[0.04em] text-ink">
              {section.name}
            </span>
          </div>
          <span className="font-mono text-[10px] uppercase tracking-[0.06em] text-mute">
            {section.doneCount}/{section.totalCount}
          </span>
        </div>
      </div>
    )
  }

  const isEmpty = section.totalCount === 0

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={clsx(
        'flex h-full w-[300px] shrink-0 flex-col overflow-hidden rounded-xl border border-line-2 bg-paper',
        isDragging && '-rotate-1 -translate-y-1 shadow-drag z-10 opacity-90',
      )}
    >
      <ColumnHeader
        section={section}
        dragHandle={{ ...attributes, ...listeners }}
        onCollapse={() => setCollapsed(true)}
        onSelect={onSelectSection}
      />

      <SortableContext items={taskIds} strategy={verticalListSortingStrategy}>
        <div
          ref={setDropRef}
          className="col-body flex flex-1 flex-col overflow-y-auto overflow-x-hidden px-2 pb-1 pt-2"
        >
          {isEmpty ? (
            <div className="flex flex-1 flex-col items-center justify-center px-3 py-10 text-center">
              <div className="mb-3 flex h-9 w-9 items-center justify-center rounded-lg border border-dashed border-line text-mute-2">
                <Plus className="h-3 w-3" />
              </div>
              <p className="text-xs leading-relaxed text-mute">
                No tasks yet.<br />Add a group or task below.
              </p>
            </div>
          ) : (
            <>
              {filteredUngrouped.map(t => (
                <TaskItem
                  key={t.id}
                  task={t}
                  prefix={prefix}
                  isDraggable
                  hideWhenInProgress={false}
                  onToggleDone={onToggleDone}
                  onToggleInProgress={onToggleInProgress}
                  onDelete={onDeleteTask}
                  onSelect={onSelectTask}
                  onFocus={onFocusTask}
                  onPin={onPinTask}
                  progress={milestoneProgress[t.id] ?? 0}
                />
              ))}

              {filteredGroups.map(group => (
                <Swimlane key={group.id} group={group}>
                  {group.tasks.map(t => (
                    <TaskItem
                      key={t.id}
                      task={t}
                      isDraggable
                      hideWhenInProgress={false}
                      onToggleDone={onToggleDone}
                      onToggleInProgress={onToggleInProgress}
                      onDelete={onDeleteTask}
                      onSelect={onSelectTask}
                      onFocus={onFocusTask}
                      onPin={onPinTask}
                      progress={milestoneProgress[t.id] ?? 0}
                    />
                  ))}
                  <AddTaskInline
                    label={`Add to ${group.name.toLowerCase()}`}
                    sectionId={section.id}
                    groupId={group.id}
                    onAdd={onAddTask}
                  />
                </Swimlane>
              ))}
            </>
          )}
        </div>
      </SortableContext>

      <div className="border-t border-line-2 bg-surf-2 p-2">
        <AddTaskInline
          label="+ Add task"
          sectionId={section.id}
          groupId={null}
          onAdd={onAddTask}
        />
      </div>
    </div>
  )
}
