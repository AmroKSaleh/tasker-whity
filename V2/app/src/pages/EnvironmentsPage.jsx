import { useState } from 'react'
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors } from '@dnd-kit/core'
import { SortableContext, verticalListSortingStrategy, arrayMove } from '@dnd-kit/sortable'
import { useEnvironments } from '../hooks/useEnvironments'
import { useProjects } from '../hooks/useProjects'
import { createEnvironment, updateEnvironment, reorderEnvironments, deleteEnvironment, moveProjectToEnvironment } from '../lib/environments'
import { ENV_COLORS } from '../lib/envColor'
import AppShell from '../components/editorial/AppShell'
import { Kicker } from '../components/editorial/atoms'
import EnvRow from '../components/environments/EnvRow'

export default function EnvironmentsPage() {
  const { environments, activeEnvironmentId } = useEnvironments()
  const { projects } = useProjects()
  const [newName, setNewName] = useState('')
  const [newColor, setNewColor] = useState(ENV_COLORS[0])

  const projectCounts = {}
  projects.forEach(p => { if (p.environment_id) projectCounts[p.environment_id] = (projectCounts[p.environment_id] || 0) + 1 })

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))
  function handleDragEnd({ active, over }) {
    if (!over || active.id === over.id) return
    const oldIdx = environments.findIndex(e => e.id === active.id)
    const newIdx = environments.findIndex(e => e.id === over.id)
    if (oldIdx === -1 || newIdx === -1) return
    reorderEnvironments(arrayMove(environments, oldIdx, newIdx))
  }

  async function handleCreate(e) {
    e.preventDefault()
    const n = newName.trim()
    if (!n) return
    await createEnvironment(n, newColor)
    setNewName(''); setNewColor(ENV_COLORS[0])
  }

  async function handleDelete(env) {
    if (environments.length <= 1) { window.alert('Cannot delete the last Environment — every project must live in one.'); return }
    const count = projectCounts[env.id] ?? 0
    const msg = count > 0
      ? `Delete "${env.name}"? Its ${count} project${count === 1 ? '' : 's'} will move to another environment (never deleted).`
      : `Delete "${env.name}"?`
    if (!window.confirm(msg)) return
    try { await deleteEnvironment(env.id) } catch (err) { window.alert(err.message) }
  }

  return (
    <AppShell active="projects">
      <div className="max-w-3xl mx-auto px-7 pt-8 pb-16">
        <header className="mb-7">
          <Kicker count={environments.length} className="mb-2">ENVIRONMENTS</Kicker>
          <h1 className="text-h1 m-0">Environments.</h1>
          <p className="text-[13px] text-mute mt-2 max-w-xl">
            Environments partition your projects into separate contexts. Switching to one on the Projects page hides the others; Today always shows every environment, tagged by color.
          </p>
        </header>

        {/* Create */}
        <form onSubmit={handleCreate} className="flex items-center gap-2 mb-6">
          <div className="flex gap-1.5 shrink-0">
            {ENV_COLORS.map(c => (
              <button
                key={c} type="button" onClick={() => setNewColor(c)}
                className="w-5 h-5 rounded-full border-2"
                style={{ background: c, borderColor: newColor === c ? 'var(--color-ink)' : 'transparent' }}
                title={c}
              />
            ))}
          </div>
          <input
            value={newName}
            onChange={e => setNewName(e.target.value)}
            placeholder="New environment name…"
            className="flex-1 bg-surf-2 rounded-lg px-3 py-2 text-[13px] text-ink outline-none border border-line focus:border-ink transition-colors placeholder:text-mute-2"
          />
          <button type="submit" disabled={!newName.trim()} className="btn-primary btn-sm disabled:opacity-40">Add</button>
        </form>

        {/* List */}
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={environments.map(e => e.id)} strategy={verticalListSortingStrategy}>
            {environments.map(env => (
              <EnvRow
                key={env.id}
                env={env}
                projectCount={projectCounts[env.id] ?? 0}
                isActive={env.id === activeEnvironmentId}
                onRename={(id, name) => updateEnvironment(id, { name })}
                onRecolor={(id, color) => updateEnvironment(id, { color })}
                onDelete={handleDelete}
              />
            ))}
          </SortableContext>
        </DndContext>

        {/* Move projects between environments */}
        <div className="mt-10">
          <Kicker count={projects.length} className="mb-3">PROJECTS BY ENVIRONMENT</Kicker>
          <div className="border border-line-2 rounded-lg overflow-hidden">
            {projects.length === 0 ? (
              <p className="text-[13px] text-mute px-3 py-3">No projects yet.</p>
            ) : projects.map(p => (
              <div key={p.id} className="flex items-center gap-3 px-3 py-2.5 border-b border-line-2 last:border-b-0">
                <span className="flex-1 min-w-0 truncate text-[13px] text-ink">{p.name}</span>
                <select
                  value={p.environment_id ?? ''}
                  onChange={e => moveProjectToEnvironment(p.id, e.target.value)}
                  className="text-[12px] border border-line rounded-md px-2 py-1 bg-paper text-ink-2 outline-none focus:border-ink"
                >
                  {!p.environment_id && <option value="">— unassigned —</option>}
                  {environments.map(env => <option key={env.id} value={env.id}>{env.name}</option>)}
                </select>
              </div>
            ))}
          </div>
        </div>
      </div>
    </AppShell>
  )
}
