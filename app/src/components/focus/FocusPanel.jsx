import { useState } from 'react'
import { useAllTasks } from '../../hooks/useAllTasks'
import { rankTasks } from '../../lib/scoring'
import { FocusPrimaryCard, FocusQueueCard } from './FocusCard'
import DailyBriefing from './DailyBriefing'
import InProgressSidebar from '../tasks/InProgressSidebar'

function DoThisNow({ ranked, tasks, onToggleDone, onToggleInProgress, skippedIds, onSkip }) {
  const visible = ranked.filter(t => !skippedIds.has(t.id))

  if (visible.length === 0) {
    return (
      <>
        <DailyBriefing tasks={tasks} />
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <p className="text-[32px] font-extrabold text-ink mb-2">✓</p>
          <p className="text-[22px] font-extrabold text-ink mb-1 tracking-tight">All clear</p>
          <p className="text-[13px] text-mute">No actionable tasks. Add priorities to surface them here.</p>
        </div>
      </>
    )
  }

  const [primary, ...queue] = visible

  return (
    <>
      <DailyBriefing tasks={tasks} />

      <p className="font-mono text-[9px] font-bold uppercase tracking-widest text-mute mb-2" style={{ letterSpacing: '1px' }}>
        Do This Now
      </p>
      <FocusPrimaryCard
        task={primary}
        onToggleDone={onToggleDone}
        onToggleInProgress={onToggleInProgress}
        onSkip={onSkip}
      />

      {queue.length > 0 && (
        <>
          <div className="flex items-center justify-between mb-2 mt-5">
            <p className="font-mono text-[9px] font-bold uppercase tracking-widest text-mute" style={{ letterSpacing: '1px' }}>
              Up Next · Queue
            </p>
            <span className="font-mono text-[9px] text-mute-2">{queue.length} left</span>
          </div>
          <div style={{ border: '1px solid #e6e6e6', borderRadius: 10, background: '#fff', overflow: 'hidden' }}>
            {queue.slice(0, 6).map(task => (
              <FocusQueueCard
                key={task.id}
                task={task}
                onToggleDone={onToggleDone}
                onToggleInProgress={onToggleInProgress}
              />
            ))}
          </div>
        </>
      )}
    </>
  )
}

export default function FocusPanel() {
  const [skippedIds, setSkippedIds] = useState(new Set())
  const { tasks, toggleDone, toggleInProgress } = useAllTasks()
  const ranked = rankTasks(tasks)

  function handleSkip(task) {
    setSkippedIds(s => new Set([...s, task.id]))
  }

  return (
    <div className="flex-1 flex min-h-0 overflow-hidden">
      {/* Main content */}
      <div className="flex-1 overflow-y-auto p-5">
        <div className="max-w-2xl mx-auto">
          <DoThisNow
            ranked={ranked}
            tasks={tasks}
            onToggleDone={toggleDone}
            onToggleInProgress={toggleInProgress}
            skippedIds={skippedIds}
            onSkip={handleSkip}
          />
        </div>
      </div>

      {/* In-progress sidebar */}
      <div className="hidden lg:block w-72 shrink-0 p-4 overflow-y-auto border-l border-line-2">
        <InProgressSidebar tasks={tasks} onRemove={toggleInProgress} onDone={toggleDone} />
      </div>
    </div>
  )
}
