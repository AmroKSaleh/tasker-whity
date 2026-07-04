import { useState, useEffect } from 'react'
import { useEnvironments } from '../hooks/useEnvironments'
import { useProjects } from '../hooks/useProjects'
import { createOrganization, renameOrganization } from '../lib/organizations'
import { createEnvironment, updateEnvironment, deleteEmptyEnvironment } from '../lib/environments'
import { supabase } from '../lib/supabase'
import AppShell from '../components/editorial/AppShell'
import { Kicker } from '../components/editorial/atoms'
import OrgCard from '../components/environments/OrgCard'

export default function OrganizationsPage() {
  const { environments, organizations } = useEnvironments()
  const { projects } = useProjects()
  const [newOrg, setNewOrg] = useState('')
  const [uid, setUid] = useState(null)

  useEffect(() => { supabase.auth.getUser().then(({ data }) => setUid(data.user?.id ?? '')) }, [])

  const projectCounts = {}
  projects.forEach(p => { if (p.environment_id) projectCounts[p.environment_id] = (projectCounts[p.environment_id] || 0) + 1 })

  async function handleCreateOrg(e) {
    e.preventDefault()
    const n = newOrg.trim()
    if (!n) return
    await createOrganization(n)
    setNewOrg('')
  }

  async function handleDeleteEnv(env) {
    try { await deleteEmptyEnvironment(env.id) } catch (err) { window.alert(err.message) }
  }

  return (
    <AppShell active="projects">
      <div className="max-w-3xl mx-auto px-7 pt-8 pb-16">
        <header className="mb-7">
          <Kicker count={organizations.length} className="mb-2">ORGANIZATIONS</Kicker>
          <h1 className="text-h1 m-0">Organizations.</h1>
          <p className="text-[13px] text-mute mt-2 max-w-xl">
            An organization is a shared space. Create environments inside it and (soon) invite teammates, granting each access to specific environments.
          </p>
        </header>

        <form onSubmit={handleCreateOrg} className="flex items-center gap-2 mb-7">
          <input
            value={newOrg}
            onChange={e => setNewOrg(e.target.value)}
            placeholder="New organization name…"
            className="flex-1 bg-surf-2 rounded-lg px-3 py-2 text-[13px] text-ink outline-none border border-line focus:border-ink placeholder:text-mute-2"
          />
          <button type="submit" disabled={!newOrg.trim()} className="btn-primary btn-sm disabled:opacity-40">Create Organization</button>
        </form>

        {organizations.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <p className="text-[32px] mb-3 opacity-30">⬡</p>
            <p className="text-[15px] font-semibold text-ink mb-1">No organizations yet</p>
            <p className="text-[13px] text-mute">Create one above to start a shared space for your team.</p>
          </div>
        ) : organizations.map(org => (
          <OrgCard
            key={org.id}
            org={org}
            isOwner={org.owner_user_id === uid}
            envs={environments.filter(e => e.org_id === org.id)}
            projectCounts={projectCounts}
            onRenameOrg={renameOrganization}
            onCreateEnv={(orgId, name, color) => createEnvironment(name, color, orgId)}
            onRenameEnv={(id, name) => updateEnvironment(id, { name })}
            onRecolorEnv={(id, color) => updateEnvironment(id, { color })}
            onDeleteEnv={handleDeleteEnv}
          />
        ))}
      </div>
    </AppShell>
  )
}
