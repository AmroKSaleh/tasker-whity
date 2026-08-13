import { useState, useEffect } from 'react'
import { createInvitation, listInvitations, revokeInvitation, listOrgMembers, removeMember, inviteUrl } from '../../lib/invitations'
import { listGrantsForEnvIds, grantEnvironmentAccess, revokeEnvironmentAccess } from '../../lib/grants'

// Members + invitations for one org (TDE-361), plus per-environment grant toggles (TDE-359
// follow-up). Only admins/owner see the manage controls, but the server (RLS + RPCs) is the real
// gate — the UI just hides what a plain member can't do.
//
// Grants only matter for role="member": an org admin already has full access to every org
// environment via is_org_admin (see can_access_environment), so admins get no toggle row —
// there's nothing a grant could add for them.
export default function OrgMembers({ orgId, envs, canManage, currentUid }) {
  const [members, setMembers] = useState([])
  const [invites, setInvites] = useState([])
  const [grants, setGrants] = useState([]) // [{environment_id, user_id, role}]
  const [email, setEmail] = useState('')
  const [role, setRole] = useState('member')
  const [copied, setCopied] = useState(null)
  const [err, setErr] = useState('')

  const envIds = envs.map(e => e.id)

  async function refresh() {
    try {
      const [m, i, g] = await Promise.all([
        listOrgMembers(orgId),
        canManage ? listInvitations(orgId) : [],
        canManage ? listGrantsForEnvIds(envIds) : [],
      ])
      setMembers(m); setInvites(i); setGrants(g)
    } catch (e) { setErr(e.message) }
  }
  useEffect(() => { refresh() }, [orgId, envs.length])

  function hasGrant(envId, userId) {
    return grants.some(g => g.environment_id === envId && g.user_id === userId)
  }

  async function toggleGrant(envId, userId) {
    setErr('')
    try {
      if (hasGrant(envId, userId)) await revokeEnvironmentAccess(envId, userId)
      else await grantEnvironmentAccess(envId, userId)
      await refresh()
    } catch (e) { setErr(e.message) }
  }

  async function submitInvite(e) {
    e.preventDefault()
    const addr = email.trim()
    if (!addr) return
    setErr('')
    try {
      const inv = await createInvitation(orgId, addr, role)
      setEmail(''); setRole('member')
      await refresh()
      copyLink(inv.token, inv.id)
    } catch (e) { setErr(e.message) }
  }

  async function copyLink(token, id) {
    try { await navigator.clipboard.writeText(inviteUrl(token)) } catch { /* clipboard blocked */ }
    setCopied(id); setTimeout(() => setCopied(c => (c === id ? null : c)), 2000)
  }

  async function handleRevoke(id) {
    try { await revokeInvitation(id); await refresh() } catch (e) { setErr(e.message) }
  }

  async function handleRemove(userId) {
    if (!window.confirm('Remove this member from the organization?')) return
    try { await removeMember(orgId, userId); await refresh() } catch (e) { setErr(e.message) }
  }

  return (
    <div className="mt-3 pt-3 border-t border-line-2">
      <div className="font-mono text-[9px] font-bold tracking-widest text-mute-2 uppercase mb-1.5">Members</div>
      {canManage && members.some(m => !m.is_owner && m.role === 'member') && envs.length > 0 && (
        <p className="text-[11px] text-mute-2 mb-1.5">Tap an environment to grant or revoke that member's access to it.</p>
      )}
      <div className="border border-line-2 rounded-lg overflow-hidden mb-3">
        {members.length === 0 ? (
          <p className="text-[12px] text-mute px-3 py-2.5">No members yet.</p>
        ) : members.map(m => {
          const showGrants = canManage && !m.is_owner && m.role === 'member' && envs.length > 0
          return (
            <div key={m.user_id} className="px-3 py-2 border-b border-line-2 last:border-b-0">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-[12px] text-ink truncate">{m.email}</span>
                  <span className="font-mono text-[9px] uppercase tracking-widest text-mute-2 shrink-0">
                    {m.is_owner ? 'Owner' : m.role}
                  </span>
                </div>
                {canManage && !m.is_owner && m.user_id !== currentUid && (
                  <button onClick={() => handleRemove(m.user_id)} className="text-[11px] text-mute hover:text-red-500 shrink-0">Remove</button>
                )}
              </div>
              {showGrants && (
                <div className="flex flex-wrap gap-1.5 mt-1.5">
                  {envs.map(env => {
                    const on = hasGrant(env.id, m.user_id)
                    return (
                      <button
                        key={env.id}
                        onClick={() => toggleGrant(env.id, m.user_id)}
                        className={`text-[11px] px-2 py-0.5 rounded-full border transition-colors ${
                          on ? 'bg-ink text-paper border-ink' : 'bg-surf-2 text-mute border-line hover:border-ink-2'
                        }`}
                      >
                        {env.name}
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })}
      </div>

      {canManage && (
        <>
          {invites.length > 0 && (
            <>
              <div className="font-mono text-[9px] font-bold tracking-widest text-mute-2 uppercase mb-1.5">Pending invitations</div>
              <div className="border border-line-2 rounded-lg overflow-hidden mb-3">
                {invites.map(inv => (
                  <div key={inv.id} className="flex items-center justify-between px-3 py-2 border-b border-line-2 last:border-b-0">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-[12px] text-ink truncate">{inv.email}</span>
                      <span className="font-mono text-[9px] uppercase tracking-widest text-mute-2 shrink-0">{inv.role}</span>
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                      <button onClick={() => copyLink(inv.token, inv.id)} className="text-[11px] text-mute hover:text-ink">
                        {copied === inv.id ? 'Copied!' : 'Copy link'}
                      </button>
                      <button onClick={() => handleRevoke(inv.id)} className="text-[11px] text-mute hover:text-red-500">Revoke</button>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}

          <form onSubmit={submitInvite} className="flex items-center gap-2">
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="Invite by email…"
              className="flex-1 bg-surf-2 rounded-lg px-3 py-1.5 text-[12px] text-ink outline-none border border-line focus:border-ink placeholder:text-mute-2"
            />
            <select value={role} onChange={e => setRole(e.target.value)}
              className="bg-surf-2 rounded-lg px-2 py-1.5 text-[12px] text-ink outline-none border border-line focus:border-ink">
              <option value="member">Member</option>
              <option value="admin">Admin</option>
            </select>
            <button type="submit" disabled={!email.trim()} className="btn btn-sm disabled:opacity-40">Invite</button>
          </form>
          <p className="text-[11px] text-mute-2 mt-2">
            Creating an invite copies a shareable link to your clipboard — send it to them however you like. They join after opening it and signing in.
          </p>
        </>
      )}

      {err && <p className="text-[11px] text-red-500 mt-2">{err}</p>}
    </div>
  )
}
