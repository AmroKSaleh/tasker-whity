import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useEnvironments } from '../hooks/useEnvironments'
import { useProjects } from '../hooks/useProjects'
import { orgLabel, NO_ORG_LABEL } from '../lib/organizations'
import AppShell from '../components/editorial/AppShell'
import { Kicker, Pill } from '../components/editorial/atoms'
import ReorgBoard from '../components/environments/ReorgBoard'

export default function EnvironmentsPage() {
  const { environments, organizations } = useEnvironments()
  const { projects } = useProjects()
  const [ownerId, setOwnerId] = useState(null) // null = Personal

  const owners = [{ id: null, name: NO_ORG_LABEL }, ...organizations.map(o => ({ id: o.id, name: orgLabel(o) }))]
  // If the active org tab was deleted (or an org's own list changes), fall back to no-org
  // rather than showing a stale, now-nonexistent tab as selected.
  const activeOwner = owners.some(o => o.id === ownerId) ? ownerId : null

  return (
    <AppShell active="environments">
      <div className="max-w-6xl mx-auto px-7 pt-8 pb-16">
        <header className="mb-6">
          <Kicker count={environments.length} className="mb-2">ORGANIZE</Kicker>
          <h1 className="text-h1 m-0">Environments.</h1>
          <p className="text-[13px] text-mute mt-2 max-w-2xl">
            Drag a project card between environments to move it. Use an environment's owner dropdown to move the whole environment between “{NO_ORG_LABEL}” and your organizations — its access grants reset on move. Create organizations on the{' '}
            <Link to="/organizations" className="underline hover:text-ink">Organizations</Link> page.
          </p>
        </header>

        <div className="flex items-center gap-2 mb-5">
          {owners.map(o => (
            <Pill key={o.id ?? 'personal'} active={activeOwner === o.id} onClick={() => setOwnerId(o.id)}>
              {o.name}
            </Pill>
          ))}
        </div>

        <ReorgBoard ownerId={activeOwner} environments={environments} organizations={organizations} projects={projects} />
      </div>
    </AppShell>
  )
}
