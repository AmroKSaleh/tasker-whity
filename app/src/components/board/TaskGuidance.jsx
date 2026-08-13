import { useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'

// TDE-383: the human leaves a steering note on a task; the agent picks it up on its next
// get_task — even in a later session. Attention that persists while the agent is away.
export default function TaskGuidance({ taskId }) {
  const [notes, setNotes] = useState([])
  const [body, setBody] = useState('')
  const [saving, setSaving] = useState(false)

  async function load() {
    const { data } = await supabase
      .from('task_guidance')
      .select('id, body, consumed_at, created_at')
      .eq('task_id', taskId)
      .order('created_at', { ascending: false })
      .limit(6)
    setNotes(data || [])
  }
  useEffect(() => { load() }, [taskId])

  async function add() {
    const text = body.trim()
    if (!text || saving) return
    setSaving(true)
    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return
      await supabase.from('task_guidance').insert({ task_id: taskId, user_id: user.id, body: text })
      setBody('')
      await load()
    } finally {
      setSaving(false)
    }
  }

  const unconsumed = notes.filter(n => !n.consumed_at)
  return (
    <div className="flex flex-col gap-2">
      {unconsumed.map(n => (
        <div key={n.id} className="rounded-md border border-accent/30 bg-accent/[0.05] px-3 py-2 text-[12px] leading-snug text-ink-2">
          <span className="mr-1.5 font-mono text-[8.5px] uppercase tracking-wider text-accent">waiting</span>{n.body}
        </div>
      ))}
      <form onSubmit={e => { e.preventDefault(); add() }} className="flex items-center gap-2">
        <input
          value={body}
          onChange={e => setBody(e.target.value)}
          placeholder="Leave a steering note for the agent…"
          className="flex-1 rounded-md border border-line-2 bg-surf-2 px-3 py-2 text-[12px] text-ink-2 placeholder:text-mute-2 outline-none focus:border-accent focus:bg-paper"
        />
        {body.trim() && (
          <button type="submit" disabled={saving} className="shrink-0 text-[11px] font-semibold text-accent disabled:opacity-40">
            {saving ? '…' : 'Leave'}
          </button>
        )}
      </form>
      <p className="text-[10px] leading-snug text-mute-2">The agent picks this up on its next <span className="font-mono">get_task</span> — even in a later session.</p>
    </div>
  )
}
