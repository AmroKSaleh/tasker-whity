import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useEnvironmentStore } from '../store/useEnvironmentStore'

// Loads the user's Environments + resolves the active one (server pointer wins, then the
// persisted local choice, then the first env). setActiveEnvironment writes the pointer to
// user_settings (server-owned so the MCP reports it) and updates local state optimistically.
export function useEnvironments() {
  const { environments, organizations, activeEnvironmentId, setEnvironments, setOrganizations, setActiveEnvironmentId } = useEnvironmentStore()
  const [isLoading, setIsLoading] = useState(environments.length === 0)

  useEffect(() => {
    async function load() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { setIsLoading(false); return }
      // No user_id filter on environments: RLS returns the user's personal envs PLUS any org
      // envs they can access (owner/admin/granted). org_id distinguishes them.
      const [{ data: envs }, { data: orgs }, { data: settings }] = await Promise.all([
        supabase.from('environments').select('id, name, sort_order, color, org_id').eq('is_deleted', false).order('sort_order'),
        supabase.from('organizations').select('id, name, owner_user_id').eq('is_deleted', false).order('created_at'),
        supabase.from('user_settings').select('active_environment_id').eq('user_id', user.id).maybeSingle(),
      ])
      const list = envs ?? []
      setEnvironments(list)
      setOrganizations(orgs ?? [])
      const valid = id => id && list.some(e => e.id === id)
      const current = useEnvironmentStore.getState().activeEnvironmentId
      const resolved = valid(settings?.active_environment_id) ? settings.active_environment_id
        : valid(current) ? current
        : (list[0]?.id ?? null)
      setActiveEnvironmentId(resolved)
      setIsLoading(false)
    }
    load()
  }, [])

  async function setActiveEnvironment(id) {
    setActiveEnvironmentId(id)
    const { data: { user } } = await supabase.auth.getUser()
    if (user) await supabase.from('user_settings').upsert({ user_id: user.id, active_environment_id: id })
  }

  return { environments, organizations, activeEnvironmentId, setActiveEnvironment, isLoading }
}
