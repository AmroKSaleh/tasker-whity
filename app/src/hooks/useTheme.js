import { useEffect, useState, useCallback } from 'react'
import { supabase } from '../lib/supabase'

const STORAGE_KEY = 'tasker-theme'

function readStored() {
  try { return localStorage.getItem(STORAGE_KEY) || 'system' } catch { return 'system' }
}

function resolveTheme(pref) {
  if (pref === 'light' || pref === 'dark') return pref
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function applyTheme(pref) {
  document.documentElement.setAttribute('data-theme', resolveTheme(pref))
}

export function useTheme() {
  const [preference, setPreferenceState] = useState(readStored)

  // React to system changes when in "system" mode
  useEffect(() => {
    if (preference !== 'system') return
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const handler = () => applyTheme('system')
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [preference])

  // Load remote preference once (overrides local if newer)
  useEffect(() => {
    let cancelled = false
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (!user || cancelled) return
      supabase.from('user_settings').select('theme_preference').eq('user_id', user.id).maybeSingle().then(({ data }) => {
        if (cancelled) return
        const remote = data?.theme_preference
        if (remote && remote !== readStored()) {
          try { localStorage.setItem(STORAGE_KEY, remote) } catch {}
          applyTheme(remote)
          setPreferenceState(remote)
        }
      })
    })
    return () => { cancelled = true }
  }, [])

  const setPreference = useCallback(async (next) => {
    try { localStorage.setItem(STORAGE_KEY, next) } catch {}
    applyTheme(next)
    setPreferenceState(next)
    const { data: { user } } = await supabase.auth.getUser()
    if (user) {
      await supabase.from('user_settings').upsert({ user_id: user.id, theme_preference: next })
    }
  }, [])

  return { preference, setPreference, resolved: resolveTheme(preference) }
}