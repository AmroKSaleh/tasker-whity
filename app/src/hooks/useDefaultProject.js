import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

export function useDefaultProject() {
  const [defaultProjectId, setDefaultProjectId] = useState(null)
  const [userId, setUserId] = useState(null)

  useEffect(() => {
    async function load() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return
      setUserId(user.id)
      const { data } = await supabase
        .from('user_settings')
        .select('default_project_id')
        .eq('user_id', user.id)
        .maybeSingle()
      if (data?.default_project_id) setDefaultProjectId(data.default_project_id)
    }
    load()
  }, [])

  async function setDefault(projectId) {
    if (!userId) return
    const newDefault = defaultProjectId === projectId ? null : projectId
    setDefaultProjectId(newDefault)
    await supabase
      .from('user_settings')
      .upsert({ user_id: userId, default_project_id: newDefault })
  }

  return { defaultProjectId, setDefault }
}
