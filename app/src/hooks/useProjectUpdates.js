import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

export function useProjectUpdates(projectId) {
  const [updates, setUpdates] = useState([])
  const [loading, setLoading] = useState(true)

  async function fetchUpdates() {
    if (!projectId) {
      setUpdates([])
      setLoading(false)
      return
    }

    const { data, error } = await supabase
      .from('project_updates')
      .select('*')
      .eq('project_id', projectId)
      .order('created_at', { ascending: false })

    if (error) {
      console.error('Failed to fetch project updates', error)
      return
    }

    setUpdates(data || [])
    setLoading(false)
  }

  useEffect(() => {
    fetchUpdates()
  }, [projectId])

  async function publishUpdate(updateId) {
    const { error } = await supabase
      .from('project_updates')
      .update({ status: 'published' })
      .eq('id', updateId)

    if (error) throw error
    await fetchUpdates()
  }

  async function discardUpdate(updateId) {
    const { error } = await supabase
      .from('project_updates')
      .delete()
      .eq('id', updateId)
      
    if (error) throw error
    await fetchUpdates()
  }

  return { updates, loading, refresh: fetchUpdates, publishUpdate, discardUpdate }
}
