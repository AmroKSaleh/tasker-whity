import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { CONNECTORS } from '../lib/connectors'

// Which connectors are currently connected (by registry id). Used to show sidebar
// icons only for connected providers. One light query against user_settings.
export function useConnectedProviders() {
  const [ids, setIds] = useState([])
  useEffect(() => {
    let cancelled = false
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (!user) return
      supabase.from('user_settings')
        .select('github_access_token, gcal_access_token, gcal_token_expiry, google_connected_scopes')
        .eq('user_id', user.id).maybeSingle()
        .then(({ data }) => {
          if (cancelled || !data) return
          const connected = new Set()
          if (data.github_access_token) connected.add('github')
          const calOk = data.gcal_access_token && (!data.gcal_token_expiry || new Date(data.gcal_token_expiry) > new Date())
          if (calOk) connected.add('google_calendar')
          const gscopes = (data.google_connected_scopes ?? '').split(' ').filter(Boolean)
          CONNECTORS.forEach(c => { if (c.kind === 'google' && c.scope && gscopes.includes(c.scope)) connected.add(c.id) })
          setIds([...connected])
        })
    })
    return () => { cancelled = true }
  }, [])
  return ids
}
