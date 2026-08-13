import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'

export function useAvailableTags(projectId) {
  const [tags, setTags] = useState([])

  useEffect(() => {
    if (!projectId) return
    let active = true

    async function load() {
      const { data: userResp } = await supabase.auth.getUser()
      const userId = userResp?.user?.id
      if (!userId) return

      const [
        { data: projectIS },
        { data: defaultIS },
        { data: flowIS }
      ] = await Promise.all([
        supabase.from('project_instructions').select('tags').eq('project_id', projectId),
        supabase.from('default_instructions').select('tags').eq('user_id', userId).eq('universal', true),
        // Join to flows to get flow instructions in this project
        supabase.from('flow_instructions').select('tags, flows!inner(project_id)').eq('flows.project_id', projectId)
      ])
      
      if (!active) return

      const allTags = new Set()
      if (projectIS) projectIS.forEach(entry => entry.tags?.forEach(t => allTags.add(t)))
      if (defaultIS) defaultIS.forEach(entry => entry.tags?.forEach(t => allTags.add(t)))
      if (flowIS) flowIS.forEach(entry => entry.tags?.forEach(t => allTags.add(t)))

      setTags(Array.from(allTags).sort())
    }

    load()
    return () => { active = false }
  }, [projectId])

  return tags
}
