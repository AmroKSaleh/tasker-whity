import { useState, useRef, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTasks, updateGroupName } from '../../hooks/useTasks'
import { updateProject, deleteProject } from '../../hooks/useProjects'
import { generateStageWithTasks } from '../../lib/gemini'
import ProgressBar from './ProgressBar'
import ProjectSummary from './ProjectSummary'
import TaskItem from '../tasks/TaskItem'
import AddTaskInput from '../tasks/AddTaskInput'
import AIInput from '../tasks/AIInput'
import InProgressSidebar from '../tasks/InProgressSidebar'
import FocusOverlay from '../focus/FocusOverlay'

const FILTERS = ['All', 'Pending', 'Done', 'Rush', 'High', 'Medium', 'Low']

function filterTask(task, filter) {
  if (filter === 'Pending') return !task.done
  if (filter === 'Done')    return task.done
  if (filter === 'Rush')    return task.priority === 'rush'   && !task.done
  if (filter === 'High')    return task.priority === 'high'   && !task.done
  if (filter === 'Medium')  return task.priority === 'medium' && !task.done
  if (filter === 'Low')     return task.priority === 'low'    && !task.done
  return true
}

function InlineInput({ placeholder, onConfirm, onCancel }) {
  const [value, setValue] = useState('')
  const inputRef = useRef(null)

  useEffect(() => { inputRef.current?.focus() }, [])

  function handleKeyDown(e) {
    if (e.key === 'Escape') onCancel()
  }

  async function handleSubmit(e) {
    e.preventDefault()
    const trimmed = value.trim()
    if (!trimmed) return
    await onConfirm(trimmed)
  }

  return (
    <form onSubmit={handleSubmit} className="flex items-center gap-2 px-4 py-2">
      <input
        ref={inputRef}
        value={value}
        onChange={e => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        className="flex-1 bg-surface-container-high rounded-lg px-3 py-1.5 text-body-medium text-on-surface outline-none border border-outline-variant focus:border-primary transition-colors"
      />
      <button type="submit" disabled={!value.trim()}
        className="px-3 py-1.5 rounded-lg bg-primary text-on-primary text-label-medium disabled:opacity-40">
        Create
      </button>
      <button type="button" onClick={onCancel}
        className="px-3 py-1.5 text-label-medium text-on-surface-variant hover:text-on-surface transition-colors">
        Cancel
      </button>
    </form>
  )
}

function GroupPanel({ group, tasks, filter, collapseAll, onToggleDone, onToggleInProgress, onAddTask, onDeleteGroup, onDeleteTask }) {
  const [collapsed, setCollapsed] = useState(false)

  useEffect(() => {
    if (collapseAll === null || collapseAll === undefined) return
    setCollapsed(collapseAll)
  }, [collapseAll])
  const [renamingGroup, setRenamingGroup] = useState(false)
  const [groupNameDraft, setGroupNameDraft] = useState(group.name)
  const groupTasks = tasks.filter(t => t.group_id === group.id)
  const visible = groupTasks.filter(t => filterTask(t, filter))
  const pendingCount = groupTasks.filter(t => !t.done).length

  async function handleRenameGroup(e) {
    e.preventDefault()
    const trimmed = groupNameDraft.trim()
    if (!trimmed || trimmed === group.name) { setRenamingGroup(false); return }
    await updateGroupName(group.id, trimmed)
    setRenamingGroup(false)
  }

  async function handleDeleteGroup(e) {
    e.stopPropagation()
    if (!window.confirm(`Delete stage "${group.name}" and all its tasks?`)) return
    await onDeleteGroup(group.id)
  }

  return (
    <div style={{ borderBottom: '1px solid #e6e6e6' }} className="last:border-b-0">
      <div className="flex items-center gap-2 px-3 py-2 hover:bg-surf transition-colors group/stage">
        <button onClick={() => setCollapsed(c => !c)} className="flex items-center gap-2 flex-1 text-left min-w-0">
          <span className="text-mute text-[10px] shrink-0">{collapsed ? '▸' : '▾'}</span>
          {renamingGroup ? (
            <form onSubmit={handleRenameGroup} onClick={e => e.stopPropagation()} className="flex-1">
              <input
                autoFocus
                value={groupNameDraft}
                onChange={e => setGroupNameDraft(e.target.value)}
                onBlur={handleRenameGroup}
                onKeyDown={e => e.key === 'Escape' && setRenamingGroup(false)}
                className="w-full bg-transparent outline-none font-mono text-[9.5px] font-bold text-ink uppercase border-b border-ink"
                style={{ letterSpacing: '1px' }}
              />
            </form>
          ) : (
            <span className="font-mono text-[9.5px] font-bold text-ink uppercase" style={{ letterSpacing: '1px' }}>
              {group.name}
            </span>
          )}
          <div className="flex-1 border-t border-dashed border-line mx-2" />
          <span className="font-mono text-[9px] text-mute-2 shrink-0">{pendingCount}</span>
        </button>
        {!renamingGroup && (
          <div className="flex items-center gap-0.5 opacity-0 group-hover/stage:opacity-100 transition-opacity">
            <button
              onClick={() => { setGroupNameDraft(group.name); setRenamingGroup(true) }}
              className="text-mute hover:text-ink text-xs px-1 shrink-0"
              title="Rename stage"
            >
              ✎
            </button>
            <button
              onClick={handleDeleteGroup}
              className="btn-delete"
              title="Delete stage"
            >
              ×
            </button>
          </div>
        )}
      </div>

      {!collapsed && (
        <>
          {visible.length === 0 && filter !== 'All' ? (
            <p className="px-5 py-2 text-body-small text-on-surface-variant">No {filter.toLowerCase()} tasks.</p>
          ) : (
            visible.map(task => (
              <TaskItem key={task.id} task={task} onToggleDone={onToggleDone} onToggleInProgress={onToggleInProgress} onDelete={onDeleteTask} />
            ))
          )}
          <AddTaskInput onAdd={text => onAddTask(group.section_id, text, group.id)} placeholder="Add task…" />
        </>
      )}
    </div>
  )
}

function SectionPanel({ section, tasks, groups, filter, collapseAll, onToggleDone, onToggleInProgress, onAddTask, onAddGroup, onAddGroupWithTasks, onDeleteSection, onDeleteGroup, onDeleteTask, projectName }) {
  const [collapsed, setCollapsed] = useState(false)
  const [addingGroup, setAddingGroup] = useState(false)
  const [aiMode, setAiMode] = useState(false)
  const [groupDesc, setGroupDesc] = useState('')
  const [groupLoading, setGroupLoading] = useState(false)
  const [groupPreview, setGroupPreview] = useState(null)
  const [groupError, setGroupError] = useState(null)

  function cancelGroup() {
    setAddingGroup(false)
    setAiMode(false)
    setGroupDesc('')
    setGroupPreview(null)
    setGroupLoading(false)
    setGroupError(null)
  }

  async function handleGenerateGroup() {
    if (!groupDesc.trim()) return
    setGroupLoading(true)
    setGroupError(null)
    try {
      const result = await generateStageWithTasks(groupDesc.trim(), {
        sectionTitle: section.title,
        projectName,
      })
      setGroupPreview(result)
    } catch {
      setGroupError('Could not generate stage. Try again.')
    } finally {
      setGroupLoading(false)
    }
  }

  async function handleConfirmGroup() {
    await onAddGroupWithTasks(section.id, groupPreview.name, groupPreview.tasks)
    cancelGroup()
  }

  async function handleDeleteSection(e) {
    e.stopPropagation()
    if (!window.confirm(`Delete task list "${section.title}" and all its tasks?`)) return
    await onDeleteSection(section.id)
  }

  const sectionTasks = tasks.filter(t => t.section_id === section.id)
  const sectionGroups = groups.filter(g => g.section_id === section.id)
  const ungroupedTasks = sectionTasks.filter(t => !t.group_id)
  const visibleUngrouped = ungroupedTasks.filter(t => filterTask(t, filter))
  const doneCount = sectionTasks.filter(t => t.done).length
  const totalCount = sectionTasks.filter(t => !t.tags?.includes('reference')).length

  return (
    <div className="mb-2 bg-surface-container-low border border-outline-variant rounded-xl overflow-hidden">
      <button
        onClick={() => setCollapsed(c => !c)}
        className="w-full flex items-center gap-3 px-5 py-3 bg-surface-container hover:bg-surface-container-high transition-colors border-b border-outline-variant text-left group/sec"
      >
        <span className={`text-on-surface-variant text-xs transition-transform duration-200 ${collapsed ? '' : 'rotate-90'}`}>▶</span>
        <span className="text-title-small font-medium text-on-surface flex-1">{section.title}</span>
        <span className="text-label-small text-on-surface-variant bg-surface-container-highest px-2 py-0.5 rounded-pill">
          {doneCount}/{totalCount}
        </span>
        <span
          role="button"
          onClick={handleDeleteSection}
          title="Delete task list"
          className="btn-delete opacity-0 group-hover/sec:opacity-100 transition-opacity"
        >
          ×
        </span>
      </button>

      {!collapsed && (
        <>
          {sectionGroups.length > 0 && ungroupedTasks.length > 0 && (
            <div className="px-5 pt-2 pb-0.5">
              <span className="text-label-small text-on-surface-variant uppercase tracking-wide opacity-60">Ungrouped</span>
            </div>
          )}
          {visibleUngrouped.map(task => (
            <TaskItem key={task.id} task={task} onToggleDone={onToggleDone} onToggleInProgress={onToggleInProgress} onDelete={onDeleteTask} />
          ))}

          {sectionGroups.length === 0 && (
            aiMode
              ? <AIInput
                  sectionId={section.id}
                  onAdd={onAddTask}
                  onCancel={() => setAiMode(false)}
                />
              : <div className="flex items-center border-t border-outline-variant">
                  <div className="flex-1">
                    <AddTaskInput onAdd={text => onAddTask(section.id, text)} />
                  </div>
                  <button
                    onClick={() => setAiMode(true)}
                    title="Add task with AI"
                    className="shrink-0 px-3 py-2.5 text-label-small text-on-surface-variant hover:text-primary transition-colors border-l border-outline-variant"
                  >
                    ✦ AI
                  </button>
                </div>
          )}

          <div>
            {sectionGroups.map(group => (
              <GroupPanel
                key={group.id}
                group={group}
                tasks={sectionTasks}
                filter={filter}
                collapseAll={collapseAll}
                onToggleDone={onToggleDone}
                onToggleInProgress={onToggleInProgress}
                onAddTask={onAddTask}
                onDeleteGroup={onDeleteGroup}
                onDeleteTask={onDeleteTask}
              />
            ))}
          </div>

          {addingGroup ? (
            groupPreview ? (
              <div className="px-4 py-3 border-t border-outline-variant bg-surface-container-low">
                <div className="bg-surface-container border border-outline-variant rounded-lg p-3 mb-3">
                  <p className="text-label-medium font-semibold text-primary uppercase tracking-wide mb-2">
                    {groupPreview.name}
                  </p>
                  {(groupPreview.tasks ?? []).map((t, i) => (
                    <p key={i} className="text-body-small text-on-surface-variant ml-1">
                      • {typeof t === 'string' ? t : t.text}
                    </p>
                  ))}
                </div>
                <div className="flex gap-2">
                  <button onClick={handleConfirmGroup}
                    className="px-3 py-1.5 rounded-lg bg-primary text-on-primary text-label-medium">
                    Create Stage
                  </button>
                  <button onClick={() => setGroupPreview(null)}
                    className="px-3 py-1.5 text-label-medium text-on-surface-variant hover:text-on-surface transition-colors">
                    Edit
                  </button>
                  <button onClick={cancelGroup}
                    className="px-3 py-1.5 text-label-medium text-on-surface-variant hover:text-on-surface transition-colors ml-auto">
                    Cancel
                  </button>
                </div>
              </div>
            ) : aiMode ? (
              <div className="px-4 py-3 border-t border-outline-variant">
                <div className="flex items-start gap-2 mb-2">
                  <span className="text-primary text-sm mt-2 shrink-0">✦</span>
                  <textarea
                    value={groupDesc}
                    onChange={e => setGroupDesc(e.target.value)}
                    placeholder="Describe this stage…"
                    rows={2}
                    disabled={groupLoading}
                    className="flex-1 bg-surface-container-high rounded-lg px-3 py-2 text-body-medium text-on-surface outline-none border border-outline-variant focus:border-primary transition-colors resize-none"
                  />
                </div>
                {groupError && <p className="text-label-small text-error mb-2">{groupError}</p>}
                <div className="flex gap-2">
                  {groupLoading ? (
                    <span className="text-label-small text-primary animate-pulse">Generating…</span>
                  ) : (
                    <>
                      <button onClick={handleGenerateGroup} disabled={!groupDesc.trim()}
                        className="px-3 py-1.5 rounded-lg bg-primary text-on-primary text-label-medium disabled:opacity-40">
                        Generate
                      </button>
                      <button onClick={() => setAiMode(false)}
                        className="px-3 py-1.5 text-label-medium text-on-surface-variant hover:text-on-surface transition-colors">
                        Manual
                      </button>
                      <button onClick={cancelGroup}
                        className="px-3 py-1.5 text-label-medium text-on-surface-variant hover:text-on-surface transition-colors ml-auto">
                        Cancel
                      </button>
                    </>
                  )}
                </div>
              </div>
            ) : (
              <div className="flex items-center border-t border-outline-variant">
                <div className="flex-1">
                  <InlineInput
                    placeholder="Stage name…"
                    onConfirm={async name => { await onAddGroup(section.id, name); cancelGroup() }}
                    onCancel={cancelGroup}
                  />
                </div>
                <button
                  onClick={() => setAiMode(true)}
                  className="shrink-0 px-3 py-2.5 text-label-small text-on-surface-variant hover:text-primary transition-colors border-l border-outline-variant"
                >
                  ✦ AI
                </button>
              </div>
            )
          ) : (
            <button
              onClick={() => setAddingGroup(true)}
              className="flex items-center gap-1.5 px-5 py-2.5 w-full text-left text-label-medium text-on-surface-variant hover:text-primary transition-colors border-t border-outline-variant"
            >
              <span className="text-sm">+</span> Add stage
            </button>
          )}
        </>
      )}
    </div>
  )
}

export default function ProjectPanel({ project }) {
  const navigate = useNavigate()
  const [filter, setFilter] = useState('All')
  const [collapseAll, setCollapseAll] = useState(null)
  const [addingSection, setAddingSection] = useState(false)
  const [renamingProject, setRenamingProject] = useState(false)
  const [projectNameDraft, setProjectNameDraft] = useState(project.description || project.name)
  const [showFocus, setShowFocus] = useState(false)
  const { tasks, sections, groups, toggleDone, toggleInProgress, createTask, createSection, createGroup, createGroupWithTasks, deleteTask, deleteGroup, deleteSection } = useTasks(project.id)

  async function handleRenameProject(e) {
    e?.preventDefault()
    const trimmed = projectNameDraft.trim()
    if (!trimmed) { setRenamingProject(false); return }
    await updateProject(project.id, trimmed)
    setRenamingProject(false)
  }

  async function handleDeleteProject() {
    const label = project.description || project.name
    if (!window.confirm(`Delete project "${label}" and ALL its tasks? This cannot be undone.`)) return
    navigate('/dashboard')
    await deleteProject(project.id)
  }

  return (
    <>
      <div className="flex w-full min-h-0">
        <div className="flex-1 min-w-0 p-5 overflow-y-auto">

          {/* Project header */}
          <div className="mb-4 group/title flex items-center gap-2 flex-wrap">
            {renamingProject ? (
              <form onSubmit={handleRenameProject} className="flex-1">
                <input
                  autoFocus
                  value={projectNameDraft}
                  onChange={e => setProjectNameDraft(e.target.value)}
                  onBlur={handleRenameProject}
                  onKeyDown={e => e.key === 'Escape' && setRenamingProject(false)}
                  className="text-headline-small font-medium text-on-surface bg-transparent outline-none border-b-2 border-primary w-full"
                />
              </form>
            ) : (
              <>
                <h1 className="text-headline-small font-medium text-on-surface">
                  {project.description || project.name.replace(/-/g, ' ')}
                </h1>
                <button
                  onClick={() => { setProjectNameDraft(project.description || project.name); setRenamingProject(true) }}
                  className="opacity-0 group-hover/title:opacity-100 transition-opacity text-on-surface-variant hover:text-primary text-sm"
                  title="Rename project"
                >
                  ✎
                </button>
                <button
                  onClick={handleDeleteProject}
                  className="btn-delete opacity-0 group-hover/title:opacity-100 transition-opacity"
                  title="Delete project"
                >
                  ×
                </button>
              </>
            )}

            {/* Focus button */}
            <div className="ml-auto">
              <button
                onClick={() => setShowFocus(true)}
                style={{
                  padding: '5px 13px',
                  background: '#111',
                  color: '#fff',
                  border: 'none',
                  borderRadius: 6,
                  fontSize: 11,
                  fontWeight: 700,
                  cursor: 'pointer',
                  letterSpacing: '0.4px',
                }}
              >
                ◉ Focus
              </button>
            </div>
          </div>

          <ProgressBar tasks={tasks} />
          <ProjectSummary tasks={tasks} />

          <div className="flex gap-1.5 flex-wrap mb-4 items-center">
            {FILTERS.map(f => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                style={{
                  padding: '4px 10px',
                  borderRadius: 14,
                  fontFamily: 'inherit',
                  fontSize: 11,
                  fontWeight: 600,
                  background: filter === f ? '#111' : '#fff',
                  color: filter === f ? '#fff' : '#111',
                  border: filter === f ? '1px solid #111' : '1px solid #cfcfcf',
                  cursor: 'pointer',
                  transition: 'all 0.15s',
                  letterSpacing: '0.3px',
                }}
              >
                {f}
              </button>
            ))}
            <div style={{ width: 1, height: 16, background: '#e6e6e6', margin: '0 2px' }} />
            {['Collapse All', 'Expand All'].map(label => (
              <button
                key={label}
                onClick={() => setCollapseAll(label === 'Collapse All')}
                style={{
                  padding: '4px 10px',
                  borderRadius: 14,
                  fontFamily: 'inherit',
                  fontSize: 11,
                  fontWeight: 600,
                  background: '#fff',
                  color: '#6b6b6b',
                  border: '1px solid #cfcfcf',
                  cursor: 'pointer',
                  transition: 'all 0.15s',
                  letterSpacing: '0.3px',
                }}
              >
                {label}
              </button>
            ))}
          </div>

          {sections.map(section => (
            <SectionPanel
              key={section.id}
              section={section}
              tasks={tasks}
              groups={groups}
              filter={filter}
              collapseAll={collapseAll}
              onToggleDone={toggleDone}
              onToggleInProgress={toggleInProgress}
              onAddTask={createTask}
              onAddGroup={createGroup}
              onAddGroupWithTasks={createGroupWithTasks}
              onDeleteSection={deleteSection}
              onDeleteGroup={deleteGroup}
              onDeleteTask={deleteTask}
              projectName={project.description || project.name}
            />
          ))}

          {addingSection ? (
            <div className="mt-2 bg-surface-container-low border border-outline-variant rounded-xl overflow-hidden">
              <InlineInput
                placeholder="Task list name…"
                onConfirm={async title => { await createSection(title); setAddingSection(false) }}
                onCancel={() => setAddingSection(false)}
              />
            </div>
          ) : (
            <button
              onClick={() => setAddingSection(true)}
              className="mt-2 flex items-center gap-2 w-full px-5 py-3 bg-surface-container-low border border-dashed border-outline-variant rounded-xl text-label-large text-on-surface-variant hover:text-on-surface hover:bg-surface-container transition-colors duration-150"
            >
              <span>+</span> New task list
            </button>
          )}
        </div>

        <div className="hidden lg:block w-72 shrink-0 border-l border-line-2 p-4">
          <InProgressSidebar tasks={tasks} onRemove={toggleInProgress} onDone={toggleDone} />
        </div>
      </div>

      {showFocus && (
        <FocusOverlay
          tasks={tasks}
          project={project}
          onClose={() => setShowFocus(false)}
          onToggleDone={toggleDone}
          onToggleInProgress={toggleInProgress}
        />
      )}
    </>
  )
}
