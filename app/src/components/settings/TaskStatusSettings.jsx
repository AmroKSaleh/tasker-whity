import { useState, useEffect } from 'react'
import { supabase } from '../../lib/supabase'

const COLORS = [
  '#6B7280', '#3B82F6', '#10B981', '#F59E0B',
  '#EF4444', '#8B5CF6', '#F97316', '#EC4899',
]

const BASE_OPTIONS = [
  { value: 'pending',     label: 'Acts as Pending' },
  { value: 'in_progress', label: 'Acts as In Progress' },
  { value: 'done',        label: 'Acts as Done' },
]

function ColorSwatch({ color, selected, onSelect }) {
  return (
    <button
      onClick={() => onSelect(color)}
      className="w-5 h-5 rounded-full border-2 transition-transform hover:scale-110"
      style={{
        backgroundColor: color,
        borderColor: selected ? '#111' : 'transparent',
      }}
    />
  )
}

function StatusRow({ status, onUpdate, onDelete }) {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(status.name)
  const [color, setColor] = useState(status.color)
  const [base, setBase] = useState(status.base_status)
  const [saving, setSaving] = useState(false)

  async function save() {
    if (!name.trim()) return
    setSaving(true)
    await onUpdate(status.id, { name: name.trim(), color, base_status: base })
    setSaving(false)
    setEditing(false)
  }

  function cancel() {
    setName(status.name)
    setColor(status.color)
    setBase(status.base_status)
    setEditing(false)
  }

  if (editing) {
    return (
      <div className="px-3 py-3 rounded-lg border border-accent bg-surf-2 space-y-2.5">
        <input
          autoFocus
          value={name}
          onChange={e => setName(e.target.value)}
          className="w-full bg-paper border border-line rounded-lg px-3 py-1.5 text-[13px] text-ink outline-none focus:border-ink transition-colors"
          placeholder="Status name"
        />
        <div className="flex items-center gap-1.5 flex-wrap">
          {COLORS.map(c => (
            <ColorSwatch key={c} color={c} selected={color === c} onSelect={setColor} />
          ))}
        </div>
        <div className="flex gap-1.5 flex-wrap">
          {BASE_OPTIONS.map(opt => (
            <button
              key={opt.value}
              onClick={() => setBase(opt.value)}
              className={`px-2.5 py-1 rounded-lg text-[11px] font-medium border transition-colors ${
                base === opt.value
                  ? 'bg-ink text-paper border-ink'
                  : 'bg-paper text-ink-2 border-line hover:bg-surf-2'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
        <div className="flex gap-2">
          <button
            onClick={save}
            disabled={saving || !name.trim()}
            className="btn btn-sm disabled:opacity-40"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button onClick={cancel} className="text-[12px] text-mute hover:text-ink transition-colors">
            Cancel
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex items-center gap-2.5 px-3 py-2 rounded-lg border border-line bg-surf-2 group">
      <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: status.color }} />
      <span className="flex-1 text-[13px] text-ink">{status.name}</span>
      <span className="text-[10px] text-mute-2 font-mono shrink-0">
        {BASE_OPTIONS.find(o => o.value === status.base_status)?.label}
      </span>
      <div className="flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
        <button
          onClick={() => setEditing(true)}
          className="text-[11px] text-mute hover:text-ink transition-colors"
        >
          Edit
        </button>
        <button
          onClick={() => onDelete(status.id)}
          className="text-[11px] text-mute hover:text-red-500 transition-colors"
        >
          Delete
        </button>
      </div>
    </div>
  )
}

export default function TaskStatusSettings() {
  const [statuses, setStatuses] = useState([])
  const [loading, setLoading] = useState(true)
  const [adding, setAdding] = useState(false)
  const [newName, setNewName] = useState('')
  const [newColor, setNewColor] = useState(COLORS[0])
  const [newBase, setNewBase] = useState('pending')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    async function load() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return
      const { data } = await supabase
        .from('project_statuses')
        .select('*')
        .eq('user_id', user.id)
        .is('project_id', null)
        .order('sort_order')
      setStatuses(data || [])
      setLoading(false)
    }
    load()
  }, [])

  async function addStatus() {
    if (!newName.trim()) return
    setSaving(true)
    const { data: { user } } = await supabase.auth.getUser()
    const { data } = await supabase
      .from('project_statuses')
      .insert({
        user_id: user.id,
        name: newName.trim(),
        color: newColor,
        base_status: newBase,
        sort_order: statuses.length,
      })
      .select()
      .single()
    if (data) setStatuses(prev => [...prev, data])
    setNewName('')
    setNewColor(COLORS[0])
    setNewBase('pending')
    setAdding(false)
    setSaving(false)
  }

  async function updateStatus(id, updates) {
    await supabase.from('project_statuses').update(updates).eq('id', id)
    setStatuses(prev => prev.map(s => s.id === id ? { ...s, ...updates } : s))
  }

  async function deleteStatus(id) {
    await supabase.from('project_statuses').delete().eq('id', id)
    setStatuses(prev => prev.filter(s => s.id !== id))
  }

  if (loading) return <p className="text-[13px] text-mute">Loading…</p>

  return (
    <div>
      <div className="space-y-2 mb-3">
        {statuses.length === 0 && !adding && (
          <p className="text-[12px] text-mute-2 py-2">No custom labels yet. Labels apply across all your projects.</p>
        )}
        {statuses.map(s => (
          <StatusRow key={s.id} status={s} onUpdate={updateStatus} onDelete={deleteStatus} />
        ))}
      </div>

      {adding ? (
        <div className="px-3 py-3 rounded-lg border border-accent bg-surf-2 space-y-2.5">
          <input
            autoFocus
            value={newName}
            onChange={e => setNewName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && addStatus()}
            className="w-full bg-paper border border-line rounded-lg px-3 py-1.5 text-[13px] text-ink outline-none focus:border-ink transition-colors"
            placeholder="Label name (e.g. Blocked, In Review)"
          />
          <div className="flex items-center gap-1.5 flex-wrap">
            {COLORS.map(c => (
              <ColorSwatch key={c} color={c} selected={newColor === c} onSelect={setNewColor} />
            ))}
          </div>
          <div className="flex gap-1.5 flex-wrap">
            {BASE_OPTIONS.map(opt => (
              <button
                key={opt.value}
                onClick={() => setNewBase(opt.value)}
                className={`px-2.5 py-1 rounded-lg text-[11px] font-medium border transition-colors ${
                  newBase === opt.value
                    ? 'bg-ink text-paper border-ink'
                    : 'bg-paper text-ink-2 border-line hover:bg-surf-2'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <div className="flex gap-2">
            <button
              onClick={addStatus}
              disabled={saving || !newName.trim()}
              className="btn btn-sm disabled:opacity-40"
            >
              {saving ? 'Adding…' : 'Add'}
            </button>
            <button
              onClick={() => { setAdding(false); setNewName('') }}
              className="text-[12px] text-mute hover:text-ink transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setAdding(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-dashed border-line text-[12px] text-mute hover:text-ink hover:border-ink-2 transition-colors"
        >
          + Add label
        </button>
      )}
    </div>
  )
}
