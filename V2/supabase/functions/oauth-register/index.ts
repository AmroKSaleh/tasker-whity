import { createClient } from 'npm:@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function json(body: any, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors })
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405)

  let body: any = {}
  try { body = await req.json() } catch { /* allow empty body */ }

  const redirectUris: string[] = Array.isArray(body.redirect_uris) ? body.redirect_uris : []
  const clientName: string = body.client_name ?? 'Unknown Client'

  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } })
  const { data, error } = await sb.from('oauth_clients')
    .insert({ redirect_uris: redirectUris, client_name: clientName })
    .select()
    .single()

  if (error) return json({ error: 'server_error', error_description: error.message }, 500)

  return json({
    client_id: data.client_id,
    client_secret: '',
    redirect_uris: redirectUris,
    client_name: clientName,
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code'],
    response_types: ['code'],
  }, 201)
})
