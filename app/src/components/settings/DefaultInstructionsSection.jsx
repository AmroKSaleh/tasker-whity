import { useState, useEffect } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { supabase } from '../../lib/supabase'

// Personal default Instruction Sets (TDE-295): account-level IS entries that auto-seed
// every NEW project (after the built-in baseline). Editing here affects only future
// projects — already-created projects keep the copy they were seeded with.
export default function DefaultInstructionsSection() {
  const [userId, setUserId] = useState(null)
  const [entries, setEntries] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    supabase.auth.getUser().then(async ({ data: { user } }) => {
      if (!user) { setLoading(false); return }
      setUserId(user.id)
      const { data } = await supabase.from('default_instructions')
        .select('id, title, content, universal, sort_order, tags').order('sort_order')
      setEntries(data ?? [])
      setLoading(false)
    })
  }, [])

  async function addEntry() {
    const sort_order = (entries[entries.length - 1]?.sort_order ?? -1) + 1
    const { data } = await supabase.from('default_instructions')
      .insert({ user_id: userId, title: 'New default', content: '', universal: false, sort_order, tags: [] })
      .select('id, title, content, universal, sort_order, tags').single()
    if (data) setEntries(e => [...e, data])
  }

  function patchLocal(id, patch) {
    setEntries(e => e.map(x => x.id === id ? { ...x, ...patch } : x))
  }

  async function persist(id, patch) {
    patchLocal(id, patch)
    await supabase.from('default_instructions').update(patch).eq('id', id)
  }

  async function deleteEntry(id) {
    setEntries(e => e.filter(x => x.id !== id))
    await supabase.from('default_instructions').delete().eq('id', id)
  }

  return (
    <section className="mb-7">
      <label className="block font-mono text-[9px] font-bold tracking-widest text-mute-2 uppercase mb-1">
        Default Instruction Set
      </label>
      <p className="text-[11px] text-mute-2 mb-4 leading-relaxed">
        Reusable conventions (code style, deploy rules, tone, autonomy) auto-seeded into every <span className="text-ink-2 font-medium">new</span> project, after the built-in baseline. Editing affects future projects only — existing projects keep what they were seeded with.
      </p>

      {loading ? (
        <p className="text-[12px] text-mute">Loading…</p>
      ) : (
        <div className="flex flex-col gap-2.5">
          {entries.map(entry => (
            <div key={entry.id} className="rounded-xl border border-line bg-surf-2 px-3.5 py-3 flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <input
                  value={entry.title}
                  onChange={e => patchLocal(entry.id, { title: e.target.value })}
                  onBlur={e => persist(entry.id, { title: e.target.value.trim() || 'Untitled' })}
                  placeholder="Title"
                  className="flex-1 min-w-0 bg-paper border border-line rounded-lg px-2.5 py-1.5 text-[13px] font-medium text-ink outline-none focus:border-ink"
                />
                <button
                  onClick={() => deleteEntry(entry.id)}
                  title="Delete default"
                  className="shrink-0 rounded p-1.5 text-mute hover:text-red-500 hover:bg-red-500/10 transition-colors"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
              <textarea
                value={entry.content}
                onChange={e => patchLocal(entry.id, { content: e.target.value })}
                onBlur={e => persist(entry.id, { content: e.target.value })}
                placeholder="The instruction content (markdown supported)…"
                rows={3}
                className="bg-paper border border-line rounded-lg px-2.5 py-1.5 text-[12px] text-ink-2 outline-none focus:border-ink resize-y leading-relaxed"
              />
              <input
                value={entry.tags ? entry.tags.join(', ') : ''}
                onChange={e => patchLocal(entry.id, { tags: e.target.value.split(',').map(t => t.trim()).filter(Boolean) })}
                onBlur={e => persist(entry.id, { tags: e.target.value.split(',').map(t => t.trim()).filter(Boolean) })}
                placeholder="Tags (comma separated)…"
                className="bg-paper border border-line rounded-lg px-2.5 py-1.5 text-[12px] font-mono text-ink outline-none focus:border-ink"
              />
              <label className="flex items-center gap-1.5 text-[11px] text-mute-2 cursor-pointer self-start">
                <input
                  type="checkbox"
                  checked={entry.universal}
                  onChange={e => persist(entry.id, { universal: e.target.checked })}
                  className="accent-ink"
                />
                Universal — applies even inside flows that have their own Instruction Set
              </label>
            </div>
          ))}
          {entries.length === 0 && (
            <p className="text-[12px] text-mute-2">No personal defaults yet. New projects get just the built-in baseline.</p>
          )}
          <button
            onClick={addEntry}
            disabled={!userId}
            className="self-start flex items-center gap-1.5 rounded-lg border border-line bg-paper px-3 py-1.5 text-[12px] text-ink hover:bg-surf-2 transition-colors disabled:opacity-40"
          >
            <Plus className="h-3.5 w-3.5" /> Add default
          </button>
        </div>
      )}
    </section>
  )
}
