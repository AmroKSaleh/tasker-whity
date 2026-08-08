import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { restoreOrganization } from '../lib/organizations'
import { restoreEnvironment } from '../lib/environments'
import AppShell from '../components/editorial/AppShell'

export default function RecycleBinPage() {
  const [deletedItems, setDeletedItems] = useState([])
  const [loading, setLoading] = useState(true)

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
    setLoading(false)
  }

  useEffect(() => {
    fetchDeletedItems()
  }, [])

  async function restoreItem(item) {
    // Containers restore their whole cascade AND any still-deleted ancestor, so a restored row
    // is never left pointing at an invisible parent.
    if (item.type === 'organization') { await restoreOrganization(item.id); fetchDeletedItems(); return }
    if (item.type === 'environment') { await restoreEnvironment(item.id); fetchDeletedItems(); return }

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
    fetchDeletedItems()
  }

  async function hardDeleteItem(item) {
    if (!window.confirm(`Are you sure you want to permanently delete this ${item.type}? This cannot be undone.`)) {
      return
    }
    
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

    fetchDeletedItems()
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
      <div className="flex-1 min-h-0 flex flex-col p-8 overflow-y-auto">
        <div className="max-w-4xl w-full mx-auto">
          <h1 className="text-3xl font-light text-slate-100 tracking-tight mb-2">Recycle Bin</h1>
          <p className="text-slate-400 mb-8 font-light">Items here will be permanently deleted after 7 days.</p>

          {loading ? (
            <div className="text-slate-400 font-light">Loading deleted items...</div>
          ) : deletedItems.length === 0 ? (
            <div className="text-slate-400 font-light">The recycle bin is empty.</div>
          ) : (
            <div className="space-y-2">
              {deletedItems.map((item) => (
                <div key={`${item.type}-${item.id}`} className="bg-slate-800/40 rounded-lg p-4 flex items-center justify-between border border-slate-700/50">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-xs font-medium text-slate-500 uppercase tracking-wider">{item.type}</span>
                      <span className="text-xs text-orange-400/80 bg-orange-400/10 px-2 py-0.5 rounded-full">
                        {getDaysRemaining(item.deleted_at)} days left
                      </span>
                    </div>
                    <div className="text-slate-200 truncate pr-4">{item.label}</div>
                  </div>
                  
                  <div className="flex items-center gap-3 shrink-0">
                    <button 
                      onClick={() => restoreItem(item)}
                      className="text-sm font-medium text-blue-400 hover:text-blue-300 transition-colors"
                    >
                      Restore
                    </button>
                    <button 
                      onClick={() => hardDeleteItem(item)}
                      className="text-sm font-medium text-red-400 hover:text-red-300 transition-colors"
                    >
                      Delete Forever
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </AppShell>
  )
}
