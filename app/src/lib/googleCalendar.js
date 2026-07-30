import { supabase } from './supabase'

const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID
// 'openid email' so we can resolve the connected account's email (shown in Settings).
const SCOPE = 'https://www.googleapis.com/auth/calendar openid email'
const API = 'https://www.googleapis.com/calendar/v3'

function loadGIS() {
  return new Promise((resolve, reject) => {
    if (window.google?.accounts?.oauth2) { resolve(); return }
    const s = document.createElement('script')
    s.src = 'https://accounts.google.com/gsi/client'
    s.async = true
    s.onload = resolve
    s.onerror = reject
    document.head.appendChild(s)
  })
}

export async function connectGoogleCalendar(userId) {
  await loadGIS()
  return new Promise((resolve, reject) => {
    const client = window.google.accounts.oauth2.initTokenClient({
      client_id: CLIENT_ID,
      scope: SCOPE,
      callback: async (res) => {
        if (res.error) { reject(new Error(res.error)); return }
        const expiry = new Date(Date.now() + res.expires_in * 1000).toISOString()
        // Resolve the connected account's email (the 'email' scope grants userinfo access).
        let email = null
        try {
          const ui = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
            headers: { Authorization: `Bearer ${res.access_token}` },
          })
          if (ui.ok) email = (await ui.json()).email ?? null
        } catch { /* email is best-effort */ }
        await supabase.from('user_settings').upsert({
          user_id: userId,
          gcal_access_token: res.access_token,
          gcal_token_expiry: expiry,
          gcal_email: email,
        })
        resolve({ token: res.access_token, expiry, email })
      },
    })
    client.requestAccessToken({ prompt: '' })
  })
}

export async function disconnectGoogleCalendar(userId) {
  const { data } = await supabase
    .from('user_settings')
    .select('gcal_access_token')
    .eq('user_id', userId)
    .single()
  if (data?.gcal_access_token) {
    await loadGIS()
    window.google?.accounts.oauth2.revoke(data.gcal_access_token)
  }
  await supabase.from('user_settings').upsert({
    user_id: userId,
    gcal_access_token: null,
    gcal_token_expiry: null,
  })
}

export async function loadCalendarConnection(userId) {
  const { data } = await supabase
    .from('user_settings')
    .select('gcal_access_token, gcal_token_expiry, gcal_email')
    .eq('user_id', userId)
    .single()
  if (!data?.gcal_access_token) return null
  return { token: data.gcal_access_token, expiry: data.gcal_token_expiry, email: data.gcal_email ?? null }
}

async function calendarFetch(token, path, options = {}) {
  const res = await fetch(`${API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers ?? {}),
    },
  })
  if (res.status === 401) {
    const err = new Error('token_expired')
    err.status = 401
    throw err
  }
  if (!res.ok) throw new Error(`Calendar API ${res.status}`)
  if (res.status === 204) return null
  return res.json()
}

export async function fetchCalendarEvents(token, timeMin, timeMax) {
  const params = new URLSearchParams({
    timeMin, timeMax,
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: '50',
  })
  const data = await calendarFetch(token, `/calendars/primary/events?${params}`)
  return data?.items ?? []
}

async function findEventForTask(token, taskId) {
  const timeMin = new Date(Date.now() - 365 * 86400000).toISOString()
  const timeMax = new Date(Date.now() + 730 * 86400000).toISOString()
  const params = new URLSearchParams({
    privateExtendedProperty: `taskerId=${taskId}`,
    timeMin, timeMax,
    singleEvents: 'true',
    maxResults: '1',
  })
  const data = await calendarFetch(token, `/calendars/primary/events?${params}`)
  return data?.items?.[0] ?? null
}

export async function pushTaskToCalendar(token, task) {
  if (!task.due_date) return
  const existing = await findEventForTask(token, task.id)
  const event = {
    summary: task.text,
    start: { date: task.due_date },
    end: { date: task.due_date },
    extendedProperties: { private: { taskerId: String(task.id) } },
  }
  if (existing) {
    await calendarFetch(token, `/calendars/primary/events/${existing.id}`, {
      method: 'PUT',
      body: JSON.stringify(event),
    })
  } else {
    await calendarFetch(token, '/calendars/primary/events', {
      method: 'POST',
      body: JSON.stringify(event),
    })
  }
}

export async function removeTaskFromCalendar(token, taskId) {
  const existing = await findEventForTask(token, String(taskId))
  if (!existing) return
  await calendarFetch(token, `/calendars/primary/events/${existing.id}`, { method: 'DELETE' })
}
