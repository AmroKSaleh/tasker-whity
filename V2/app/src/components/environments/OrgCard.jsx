import { useState } from 'react'
import { ENV_COLORS } from '../../lib/envColor'
import OrgEnvRow from './OrgEnvRow'

// One organization's card: rename the org, and manage its environments (create/rename/recolor/
// delete-empty). Members + grants land in slice 2 (shown as a placeholder for now).
export default function OrgCard({ org, envs, projectCounts, isOwner, onRenameOrg, onCreateEnv, onRenameEnv, onRecolorEnv, onDeleteEnv }) {
  const [orgName, setOrgName] = useState(org.name)
  const [envName, setEnvName] = useState('')
  const [envColorSel, setEnvColorSel] = useState(ENV_COLORS[0])

  function submitEnv(e) {
    e.preventDefault()
    const n = envName.trim()
    if (!n) return
    onCreateEnv(org.id, n, envColorSel)
    setEnvName(''); setEnvColorSel(ENV_COLORS[0])
  }

  return (
    <div className="border border-line rounded-xl bg-paper p-5 mb-5">
      <div className="flex items-center justify-between mb-3">
        <input
          value={orgName}
          onChange={e => setOrgName(e.target.value)}
          onBlur={() => { const t = orgName.trim(); if (t && t !== org.name) onRenameOrg(org.id, t); else setOrgName(org.name) }}
          disabled={!isOwner}
          className="text-[16px] font-semibold text-ink bg-transparent border-b border-transparent focus:border-line outline-none disabled:opacity-100"
        />
        <span className="font-mono text-[9px] uppercase tracking-widest text-mute-2">{isOwner ? 'Owner' : 'Member'}</span>
      </div>

      <div className="font-mono text-[9px] font-bold tracking-widest text-mute-2 uppercase mb-1.5">Environments</div>
      <div className="border border-line-2 rounded-lg overflow-hidden mb-3">
        {envs.length === 0 ? (
          <p className="text-[12px] text-mute px-3 py-2.5">No environments yet.</p>
        ) : envs.map(env => (
          <OrgEnvRow
            key={env.id}
            env={env}
            projectCount={projectCounts[env.id] ?? 0}
            onRename={onRenameEnv}
            onRecolor={onRecolorEnv}
            onDelete={onDeleteEnv}
          />
        ))}
      </div>

      <form onSubmit={submitEnv} className="flex items-center gap-2 mb-2">
        <div className="flex gap-1 shrink-0">
          {ENV_COLORS.map(c => (
            <button key={c} type="button" onClick={() => setEnvColorSel(c)}
              className="w-4 h-4 rounded-full border-2"
              style={{ background: c, borderColor: envColorSel === c ? 'var(--color-ink)' : 'transparent' }} />
          ))}
        </div>
        <input
          value={envName}
          onChange={e => setEnvName(e.target.value)}
          placeholder="New environment…"
          className="flex-1 bg-surf-2 rounded-lg px-3 py-1.5 text-[12px] text-ink outline-none border border-line focus:border-ink placeholder:text-mute-2"
        />
        <button type="submit" disabled={!envName.trim()} className="btn btn-sm disabled:opacity-40">Add</button>
      </form>

      <p className="text-[11px] text-mute-2 mt-3 pt-3 border-t border-line-2">
        Members &amp; access grants — coming next.
      </p>
    </div>
  )
}
