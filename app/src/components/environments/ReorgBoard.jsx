import { DndContext, PointerSensor, useSensor, useSensors, pointerWithin } from '@dnd-kit/core'
import { ENV_COLORS, envColor } from '../../lib/envColor'
import { moveProjectToEnvironment, updateEnvironment, deleteEmptyEnvironment, moveEnvironmentToOrg, createEnvironment } from '../../lib/environments'
import { orgLabel } from '../../lib/organizations'
import ReorgColumn, { ProjectCard } from './ReorgColumn'
import { Kicker } from '../editorial/atoms'

// Kanban reorg surface for ONE owner at a time (Personal, or a single org — selected via tabs on
// EnvironmentsPage). Columns = that owner's environments; project cards drag between them (→ move
// project to that env); each column has an owner select (→ move env to another org/personal,
// clearing grants) + rename/recolor/delete-empty. Cross-owner project drag isn't possible from
// here by design — switch tabs, or use a column's owner select to move the environment itself.
export default function ReorgBoard({ ownerId, environments, organizations, projects }) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }))
  const owners = [{ id: null, name: 'Personal' }, ...organizations.map(o => ({ id: o.id, name: orgLabel(o) }))]
  const laneEnvs = environments.filter(e => (e.org_id ?? null) === ownerId)
  const envById = Object.fromEntries(laneEnvs.map(e => [e.id, e]))

  const byEnv = {}
  const knownEnvIds = new Set(laneEnvs.map(e => e.id))
  const unassigned = []
  for (const p of projects) {
    if (p.environment_id && knownEnvIds.has(p.environment_id)) (byEnv[p.environment_id] ||= []).push(p)
    else if (ownerId === null && !p.environment_id) unassigned.push(p)
  }
  // Every project belonging to this owner (any of its environments, plus unassigned under
  // Personal) — a flat reference list beneath the board, independent of which env each sits in.
  const ownerProjects = [...laneEnvs.flatMap(e => byEnv[e.id] ?? []), ...unassigned]

  function onDragEnd({ active, over }) {
    if (!over) return
    const targetEnv = over.data.current?.envId
    const projectId = active.data.current?.projectId
    const fromEnv = active.data.current?.fromEnv ?? null
    if (!targetEnv || !projectId || targetEnv === fromEnv) return
    moveProjectToEnvironment(projectId, targetEnv)
  }

  const onRename = (id, name) => updateEnvironment(id, { name })
  const onRecolor = (id, color) => updateEnvironment(id, { color })
  const onMoveOwner = (id, orgId) => moveEnvironmentToOrg(id, orgId)
  const onDelete = async (env) => { try { await deleteEmptyEnvironment(env.id) } catch (e) { window.alert(e.message) } }

  const unassignedCol = ownerId === null && unassigned.length > 0 ? (
    <div className="shrink-0 w-56 flex flex-col rounded-xl border border-dashed border-line bg-paper/50">
      <div className="p-2.5 border-b border-line-2"><span className="text-[12px] font-semibold text-mute">Unassigned</span></div>
      <div className="p-2 flex-1">
        {unassigned.map(p => <ProjectCard key={p.id} project={p} dragId={`unassigned-${p.id}`} />)}
        <p className="text-[10px] text-mute-2 px-1">Drag into an environment to assign.</p>
      </div>
    </div>
  ) : null

  const ownerName = owners.find(o => o.id === ownerId)?.name ?? 'Personal'

  return (
    <DndContext sensors={sensors} collisionDetection={pointerWithin} onDragEnd={onDragEnd}>
      <div className="flex items-center gap-2 mb-2">
        <button
          onClick={() => createEnvironment('New environment', ENV_COLORS[0], ownerId)}
          className="text-[11px] text-mute hover:text-ink transition-colors"
        >+ environment</button>
      </div>
      <div className="flex flex-wrap gap-3 pb-2">
        {laneEnvs.length === 0 && !unassignedCol
          ? <p className="text-[12px] text-mute-2 py-4">No environments here yet.</p>
          : laneEnvs.map(env => (
            <ReorgColumn key={env.id} env={env} projects={byEnv[env.id] ?? []} owners={owners}
              onRename={onRename} onRecolor={onRecolor} onMoveOwner={onMoveOwner} onDelete={onDelete} />
          ))}
        {unassignedCol}
      </div>

      <hr className="border-line-2 my-6" />

      <Kicker count={ownerProjects.length} className="mb-2">Projects in {ownerName}</Kicker>
      {ownerProjects.length === 0 ? (
        <p className="text-[12px] text-mute-2 py-2">No projects here yet.</p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {ownerProjects.map(p => (
            <ProjectCard key={p.id} project={p} dragId={`grid-${p.id}`} compact envBadge={envById[p.environment_id] && {
              name: envById[p.environment_id].name, color: envColor(envById[p.environment_id]),
            }} />
          ))}
        </div>
      )}
    </DndContext>
  )
}
