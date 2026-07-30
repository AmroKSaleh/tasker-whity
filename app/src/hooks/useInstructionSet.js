import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'

export function useInstructionSet(projectId) {
  const [entries, setEntries] = useState([])

  useEffect(() => {
    if (!projectId) return
    try {
      const cached = JSON.parse(localStorage.getItem(`tasker-is-${projectId}`) || 'null')
      if (cached) setEntries(cached)
    } catch {}
    fetchEntries()
  }, [projectId])

  async function fetchEntries() {
    const { data } = await supabase
      .from('project_instructions')
      .select('*')
      .eq('project_id', projectId)
      .order('created_at')
    if (data) {
      setEntries(data)
      try { localStorage.setItem(`tasker-is-${projectId}`, JSON.stringify(data)) } catch {}
    }
  }

  async function createEntry(title, content) {
    const { data: { user } } = await supabase.auth.getUser()
    const { data } = await supabase
      .from('project_instructions')
      .insert({ project_id: projectId, user_id: user.id, title, content })
      .select().single()
    if (data) setEntries(prev => [...prev, data])
    return data
  }

  async function updateEntry(id, updates) {
    const { data } = await supabase
      .from('project_instructions')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select().single()
    if (data) setEntries(prev => prev.map(e => e.id === id ? data : e))
  }

  async function deleteEntry(id) {
    await supabase.from('project_instructions').delete().eq('id', id)
    setEntries(prev => prev.filter(e => e.id !== id))
  }

  return { entries, createEntry, updateEntry, deleteEntry }
}
