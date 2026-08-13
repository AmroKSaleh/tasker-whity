import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { restoreOrganization } from '../lib/organizations'
import { restoreEnvironment } from '../lib/environments'
import AppShell from '../components/editorial/AppShell'
import { Kicker } from '../components/editorial/atoms'

const itemKey = item => `${item.type}-${item.id}`

export default function RecycleBinPage() {
  const [deletedItems, setDeletedItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState(() => new Set())
  const [busy, setBusy] = useState(false)

  async function fetchDeletedItems() {
    setLoading(true)
    const [{ data: tasks }, { data: projects }, { data: flows }, { data: envs }, { data: orgs }] = await Promise.all([
      supabase.from('tasks').select('*').eq('is_deleted', true),
      supabase.from('projects').select('*').eq('is_deleted', true),
      supabase.from('flows').select('*').eq('is_deleted', true),
      supabase.from('environments').select('*').eq('is_deleted', true),
      supabase.from('organizations').select('*').eq('is_deleted', true)
    ])

    // A row deleted as PART of a container's cascade is not listed separately — restoring the
    // container brings it back, and listing both invites a half-restore that leaves a project
    // pointing at an environment still in the bin (TDE-885).
    const cascadeRoots = new Set([...(envs || []), ...(orgs || [])].map(r => r.deleted_cascade_id).filter(Boolean))
    const notInCascade = row => !row.deleted_cascade_id || !cascadeRoots.has(row.deleted_cascade_id)

    const items = [
      ...(tasks || []).map(t => ({ ...t, type: 'task', label: t.text })),
      ...(projects || []).filter(notInCascade).map(p => ({ ...p, type: 'project', label: p.name })),
      ...(flows || []).map(f => ({ ...f, type: 'flow', label: f.name || f.short_id })),
      ...(envs || []).filter(e => !orgs?.some(o => o.deleted_cascade_id && o.deleted_cascade_id === e.deleted_cascade_id))
        .map(e => ({ ...e, type: 'environment', label: e.name })),
      ...(orgs || []).map(o => ({ ...o, type: 'organization', label: o.name?.trim() || 'n/a' }))
    ]

    // Sort by deleted_at descending
    items.sort((a, b) => new Date(b.deleted_at) - new Date(a.deleted_at))
    setDeletedItems(items)
    // Drop selections whose rows are gone, so a stale key cannot survive a refetch and make the
    // select-all state disagree with what is on screen.
    setSelected(prev => {
      const live = new Set(items.map(itemKey))
      const next = new Set([...prev].filter(k => live.has(k)))
      return next.size === prev.size ? prev : next
    })
    setLoading(false)
  }

  function toggleOne(item) {
    setSelected(prev => {
      const next = new Set(prev)
      const k = itemKey(item)
      next.has(k) ? next.delete(k) : next.add(k)
      return next
    })
  }

  const allSelected = deletedItems.length > 0 && selected.size === deletedItems.length
  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(deletedItems.map(itemKey)))
  }

  const selectedItems = deletedItems.filter(i => selected.has(itemKey(i)))

  async function restoreSelected() {
    setBusy(true)
    try { for (const item of selectedItems) await restoreOne(item) }
    finally { setBusy(false); setSelected(new Set()); fetchDeletedItems() }
  }

  async function hardDeleteSelected() {
    const n = selectedItems.length
    if (!window.confirm(`Permanently delete ${n} item${n === 1 ? '' : 's'}? This cannot be undone.`)) return
    setBusy(true)
    // Containers last: purging an organization cascades its environments away, which would null
    // environment_id on any project in the same selection that has not been purged yet.
    const order = { task: 0, flow: 1, project: 2, environment: 3, organization: 4 }
    const ordered = [...selectedItems].sort((a, b) => (order[a.type] ?? 9) - (order[b.type] ?? 9))
    try { for (const item of ordered) await hardDeleteOne(item) }
    finally { setBusy(false); setSelected(new Set()); fetchDeletedItems() }
  }

  useEffect(() => {
    fetchDeletedItems()
  }, [])

  // The *One helpers do the work WITHOUT refetching, so a bulk action can run many of them and
  // refresh once at the end instead of once per item.
  async function restoreOne(item) {
    // Containers restore their whole cascade AND any still-deleted ancestor, so a restored row
    // is never left pointing at an invisible parent.
    if (item.type === 'organization') return restoreOrganization(item.id)
    if (item.type === 'environment') return restoreEnvironment(item.id)

    let table = ''
    if (item.type === 'task') table = 'tasks'
    if (item.type === 'project') table = 'projects'
    if (item.type === 'flow') table = 'flows'

    await supabase.from(table).update({ is_deleted: false, deleted_at: null, ...(table === 'projects' ? { deleted_cascade_id: null } : {}) }).eq('id', item.id)

    // A project restored on its own still needs its environment back, or it lands nowhere visible.
    if (item.type === 'project' && item.environment_id) {
      await supabase.from('environments').update({ is_deleted: false, deleted_at: null, deleted_cascade_id: null })
        .eq('id', item.environment_id).eq('is_deleted', true)
    }
  }

  async function restoreItem(item) {
    await restoreOne(item)
    fetchDeletedItems()
  }

  async function hardDeleteItem(item) {
    if (!window.confirm(`Are you sure you want to permanently delete this ${item.type}? This cannot be undone.`)) {
      return
    }
    await hardDeleteOne(item)
    fetchDeletedItems()
  }

  async function hardDeleteOne(item) {
    if (item.type === 'task') {
      await Promise.all([
        supabase.from('task_discussions').delete().eq('task_id', item.id),
        supabase.from('tasks').delete().eq('id', item.id)
      ])
    } else if (item.type === 'project') {
      const { data: secs } = await supabase.from('sections').select('id').eq('project_id', item.id)
      const sectionIds = (secs || []).map(s => s.id)
      if (sectionIds.length) {
        await supabase.from('groups').delete().in('section_id', sectionIds)
      }
      const { data: taskRows } = await supabase.from('tasks').select('id').eq('project_id', item.id)
      const taskIds = (taskRows || []).map(t => t.id)
      if (taskIds.length) {
        await supabase.from('task_discussions').delete().in('task_id', taskIds)
      }
      await supabase.from('tasks').delete().eq('project_id', item.id)
      await supabase.from('sections').delete().eq('project_id', item.id)
      await supabase.from('projects').delete().eq('id', item.id)
    } else if (item.type === 'flow') {
      await supabase.from('flows').delete().eq('id', item.id)
    } else if (item.type === 'environment' || item.type === 'organization') {
      // Purge the cascade in dependency order. Organizations must go LAST: environments.org_id is
      // ON DELETE CASCADE, so removing the org first would take environments with it and null the
      // environment_id of any project not yet purged, silently returning it to the board.
      if (item.deleted_cascade_id) {
        const { data: projs } = await supabase.from('projects').select('id')
          .eq('deleted_cascade_id', item.deleted_cascade_id)
        for (const p of projs || []) await hardDeleteProject(p.id)
        await supabase.from('environments').delete().eq('deleted_cascade_id', item.deleted_cascade_id)
      }
      if (item.type === 'environment') await supabase.from('environments').delete().eq('id', item.id)
      else await supabase.from('organizations').delete().eq('id', item.id)
    }
  }

  async function hardDeleteProject(projectId) {
    const { data: secs } = await supabase.from('sections').select('id').eq('project_id', projectId)
    const sectionIds = (secs || []).map(s => s.id)
    if (sectionIds.length) await supabase.from('groups').delete().in('section_id', sectionIds)
    const { data: taskRows } = await supabase.from('tasks').select('id').eq('project_id', projectId)
    const taskIds = (taskRows || []).map(t => t.id)
    if (taskIds.length) await supabase.from('task_discussions').delete().in('task_id', taskIds)
    await supabase.from('tasks').delete().eq('project_id', projectId)
    await supabase.from('sections').delete().eq('project_id', projectId)
    await supabase.from('projects').delete().eq('id', projectId)
  }

  function getDaysRemaining(deletedAt) {
    if (!deletedAt) return 0
    const deletedDate = new Date(deletedAt)
    const expiryDate = new Date(deletedDate.getTime() + 7 * 24 * 60 * 60 * 1000)
    const now = new Date()
    const diffTime = Math.max(expiryDate - now, 0)
    return Math.ceil(diffTime / (1000 * 60 * 60 * 24))
  }

  return (
    <AppShell active="recycle-bin">
      <div className="max-w-4xl mx-auto px-7 pt-8 pb-16">
        <header className="mb-7">
          <Kicker count={deletedItems.length} className="mb-2">RECYCLE BIN</Kicker>
          <h1 className="text-h1 m-0">Recycle Bin.</h1>
          <p className="text-[13px] text-mute mt-2">Anything here is permanently deleted after 7 days. Restoring a container brings its contents back with it.</p>
        </header>

        {loading ? (
          <p className="text-[13px] text-mute">Loading deleted items…</p>
        ) : deletedItems.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 text-center">
            <p className="text-[32px] mb-3 opacity-30">🗑</p>
            <p className="text-[15px] font-semibold text-ink mb-1">The recycle bin is empty</p>
            <p className="text-[13px] text-mute">Deleted items land here and stay recoverable for 7 days.</p>
          </div>
        ) : (
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3 px-4 py-2.5 rounded-lg bg-surf-2 border border-line-2">
              <label className="flex items-center gap-2.5 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={allSelected}
                  ref={el => { if (el) el.indeterminate = selected.size > 0 && !allSelected }}
                  onChange={toggleAll}
                  className="w-4 h-4 accent-accent cursor-pointer"
                />
                <span className="text-[13px] text-ink-2">
                  {selected.size > 0 ? `${selected.size} selected` : `Select all (${deletedItems.length})`}
                </span>
              </label>

              {selected.size > 0 && (
                <div className="flex items-center gap-2 shrink-0">
                  <button onClick={restoreSelected} disabled={busy} className="btn btn-sm disabled:opacity-40">
                    {busy ? 'Working…' : `Restore ${selected.size}`}
                  </button>
                  <button onClick={hardDeleteSelected} disabled={busy} className="btn-delete btn-sm disabled:opacity-40">
                    Delete {selected.size} permanently
                  </button>
                </div>
              )}
            </div>

            {deletedItems.map((item) => (
              <div key={itemKey(item)} className={`rounded-lg p-4 flex items-center gap-4 border transition-colors ${
                selected.has(itemKey(item)) ? 'bg-accent-soft border-accent-edge' : 'bg-paper border-line-2'
              }`}>
                <input
                  type="checkbox"
                  checked={selected.has(itemKey(item))}
                  onChange={() => toggleOne(item)}
                  aria-label={`Select ${item.label}`}
                  className="w-4 h-4 shrink-0 accent-accent cursor-pointer"
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="kicker">{item.type}</span>
                    <span className="font-mono text-[9.5px] tracking-[0.1em] uppercase text-accent border border-accent-edge rounded-full px-2 py-0.5">
                      {getDaysRemaining(item.deleted_at)} days left
                    </span>
                  </div>
                  <div className="text-[13px] text-ink truncate pr-4">{item.label}</div>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <button onClick={() => restoreItem(item)} className="btn btn-sm">Restore</button>
                  <button onClick={() => hardDeleteItem(item)} className="btn-delete btn-sm">Delete Forever</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </AppShell>
  )
}
