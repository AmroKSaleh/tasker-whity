import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  DndContext, PointerSensor, KeyboardSensor,
  closestCenter, useSensor, useSensors,
} from '@dnd-kit/core'
import {
  SortableContext, rectSortingStrategy, arrayMove,
} from '@dnd-kit/sortable'
import { useProjects, reorderProjects } from '../hooks/useProjects'
import { useAllProjectTasks } from '../hooks/useAllProjectTasks'
import { useDefaultProject } from '../hooks/useDefaultProject'
import { useEnvironments } from '../hooks/useEnvironments'
import ProjectCard from '../components/home/ProjectCard'
import EnvironmentSwitcher from '../components/home/EnvironmentSwitcher'
import NewProjectModal from '../components/layout/NewProjectModal'
import TransferModal from '../components/board/TransferModal'
import AppShell from '../components/editorial/AppShell'
import { Kicker } from '../components/editorial/atoms'

export default function HomePage() {
  const { projects, isLoading } = useProjects()
  const { tasksByProject } = useAllProjectTasks()
  const { defaultProjectId, setDefault } = useDefaultProject()
  const { environments, organizations, activeEnvironmentId, setActiveEnvironment } = useEnvironments()
  const [showNewProject, setShowNewProject] = useState(false)
  const [showTransfer, setShowTransfer] = useState(false)
  const navigate = useNavigate()

  // Exclusive switching: show only the active Environment's projects. Before the active
  // pointer resolves, or when the user has no Environments, show everything.
  const visibleProjects = activeEnvironmentId
    ? projects.filter(p => p.environment_id === activeEnvironmentId)
    : projects

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor)
  )

  function handleDragEnd(event) {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const oldIndex = projects.findIndex(p => p.id === active.id)
    const newIndex = projects.findIndex(p => p.id === over.id)
    if (oldIndex === -1 || newIndex === -1) return
    reorderProjects(arrayMove(projects, oldIndex, newIndex))
  }

  return (
    <>
      <AppShell active="projects">
        <div className="max-w-6xl mx-auto px-7 pt-8 pb-16">
          <header className="flex items-end justify-between mb-7">
            <div>
              <Kicker count={visibleProjects.length} className="mb-2">ALL PROJECTS</Kicker>
              <h1 className="text-h1 m-0">Projects.</h1>
            </div>
            <div className="flex items-center gap-2">
              <EnvironmentSwitcher
                environments={environments}
                organizations={organizations}
                activeEnvironmentId={activeEnvironmentId}
                onSelect={setActiveEnvironment}
              />
              <button onClick={() => setShowNewProject(true)} className="btn-primary btn-sm">Create a New Project</button>
              <button onClick={() => setShowTransfer(true)} className="btn btn-sm">Export / Import</button>
            </div>
          </header>

          {isLoading && projects.length === 0 ? (
            <div className="flex items-center justify-center py-24">
              <div className="h-6 w-6 rounded-full border-2 border-accent border-t-transparent animate-spin opacity-40" />
            </div>
          ) : projects.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-24 text-center">
              <p className="text-[40px] mb-4 opacity-30">◎</p>
              <p className="text-[17px] font-semibold text-ink mb-2">No projects yet</p>
              <p className="text-[13px] text-mute mb-6">Create your first project to get started.</p>
              <button onClick={() => setShowNewProject(true)} className="btn-primary">Create a New Project</button>
            </div>
          ) : visibleProjects.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-24 text-center">
              <p className="text-[40px] mb-4 opacity-30">◎</p>
              <p className="text-[17px] font-semibold text-ink mb-2">No projects in this Environment</p>
              <p className="text-[13px] text-mute mb-6">Create one here, or switch Environments above.</p>
              <button onClick={() => setShowNewProject(true)} className="btn-primary">Create a New Project</button>
            </div>
          ) : (
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
              <SortableContext items={visibleProjects.map(p => p.id)} strategy={rectSortingStrategy}>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                  {visibleProjects.map(project => (
                    <ProjectCard
                      key={project.id}
                      project={project}
                      tasks={tasksByProject[project.id] ?? []}
                      isDefault={defaultProjectId === project.id}
                      onToggleDefault={() => setDefault(project.id)}
                    />
                  ))}
                </div>
              </SortableContext>
            </DndContext>
          )}
        </div>
      </AppShell>

      {showNewProject && (
        <NewProjectModal
          onClose={() => setShowNewProject(false)}
          onCreated={project => {
            setShowNewProject(false)
            if (project?.slug) navigate(`/dashboard/${project.slug}`)
          }}
        />
      )}

      {showTransfer && (
        <TransferModal
          projects={projects}
          onClose={() => setShowTransfer(false)}
          onGoToProject={proj => { setShowTransfer(false); if (proj?.slug) navigate(`/dashboard/${proj.slug}`) }}
        />
      )}
    </>
  )
}
