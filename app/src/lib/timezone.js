import { supabase } from './supabase'

// The MCP server renders task timestamps, but an HTTP request carries no timezone — the
// browser is the only place that actually knows where the user is. Capture it once per
// session so the server can read it back out of user_settings.
export async function syncBrowserTimezone() {
  let detected
  try {
    detected = Intl.DateTimeFormat().resolvedOptions().timeZone
  } catch {
    return
  }
  if (!detected) return

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return

  const { data } = await supabase
    .from('user_settings')
    .select('ai_instructions')
    .eq('user_id', user.id)
    .maybeSingle()

  const instructions = data?.ai_instructions ?? {}
  // A zone the user chose by hand outranks detection — opening the app from a hotel in
  // another country should not silently rewrite a deliberate setting.
  if (instructions.timezone_source === 'user') return
  if (instructions.timezone === detected) return

  await supabase.from('user_settings').upsert({
    user_id: user.id,
    ai_instructions: { ...instructions, timezone: detected, timezone_source: 'auto' },
  })
}
