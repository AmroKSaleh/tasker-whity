import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'

// Per-connector count of PARKED intake jobs (status 'ready' / legacy 'done') — i.e.
// structured-but-not-yet-placed captures. Drives the badge on connector rail icons
// so parked items aren't invisible when you're off that connector's page.
export function useParkedCounts() {
  const [counts, setCounts] = useState({})   // { gmail: 3, ... }
  useEffect(() => {
    let cancelled = false
    const load = async () => {
      const { data } = await supabase.from('intake_jobs').select('source, status').in('status', ['ready', 'done'])
      if (cancelled) return
      const next = {}
      for (const r of data || []) next[r.source] = (next[r.source] || 0) + 1
      setCounts(next)
    }
    load()
    const channel = supabase.channel('parked-counts')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'intake_jobs' }, load)
      .subscribe()
    return () => { cancelled = true; supabase.removeChannel(channel) }
  }, [])
  return counts
}
