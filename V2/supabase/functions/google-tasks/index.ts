// google-tasks — Proxy for Google Tasks API (read-only).
// Actions: lists (task lists), tasks (tasks in a list).
// Auth via Supabase JWT.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { loadGoogleAccessToken } from '../_shared/googleToken.ts'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } })

const GTASKS = 'https://tasks.googleapis.com/tasks/v1'

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  try {
    const authClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } } },
    )
    const { data: { user } } = await authClient.auth.getUser()
    if (!user) return json({ error: 'Unauthorized' }, 401)

    const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    const token = await loadGoogleAccessToken(sb, user.id)
    if (!token) return json({ error: 'Google Tasks not connected. Connect it via Settings → Connectors.' }, 400)

    const body = await req.json().catch(() => ({}))
    const { action, list_id, include_completed = false } = body

    if (action === 'lists') {
      const res = await fetch(`${GTASKS}/users/@me/lists?maxResults=100`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json()
      if (!res.ok) return json({ error: data.error?.message ?? 'Failed to fetch task lists' }, 502)
      return json({ lists: data.items ?? [] })
    }

    if (action === 'tasks') {
      if (!list_id) return json({ error: 'list_id required' }, 400)
      const params = new URLSearchParams({
        maxResults: '100',
        showCompleted: String(include_completed),
        showHidden: 'false',
      })
      const res = await fetch(`${GTASKS}/lists/${list_id}/tasks?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json()
      if (!res.ok) return json({ error: data.error?.message ?? 'Failed to fetch tasks' }, 502)
      return json({ tasks: data.items ?? [] })
    }

    return json({ error: 'Unknown action. Use "lists" or "tasks".' }, 400)
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500)
  }
})
