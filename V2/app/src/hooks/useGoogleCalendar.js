import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import {
  connectGoogleCalendar,
  disconnectGoogleCalendar,
  loadCalendarConnection,
  fetchCalendarEvents,
  pushTaskToCalendar,
  removeTaskFromCalendar,
} from '../lib/googleCalendar'

export function useGoogleCalendar() {
  const [connection, setConnection] = useState(null) // { token, expiry } | null
  const [loading, setLoading] = useState(true)
  const [userId, setUserId] = useState(null)

  useEffect(() => {
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (!user) { setLoading(false); return }
      setUserId(user.id)
      loadCalendarConnection(user.id).then(conn => {
        setConnection(conn)
        setLoading(false)
      })
    })
  }, [])

  const isExpired = connection ? new Date(connection.expiry) <= new Date() : false
  const isConnected = !!connection && !isExpired

  const connect = useCallback(async () => {
    if (!userId) return
    const conn = await connectGoogleCalendar(userId)
    setConnection(conn)
  }, [userId])

  const disconnect = useCallback(async () => {
    if (!userId) return
    await disconnectGoogleCalendar(userId)
    setConnection(null)
  }, [userId])

  function handleExpired() { setConnection(c => c ? { ...c, _expired: true } : null) }

  const pushTask = useCallback(async (task) => {
    if (!isConnected || !task.due_date) return
    try {
      await pushTaskToCalendar(connection.token, task)
    } catch (err) {
      if (err.status === 401) handleExpired()
    }
  }, [connection, isConnected])

  const removeTask = useCallback(async (taskId) => {
    if (!isConnected) return
    try {
      await removeTaskFromCalendar(connection.token, taskId)
    } catch (err) {
      if (err.status === 401) handleExpired()
    }
  }, [connection, isConnected])

  const fetchEvents = useCallback(async (timeMin, timeMax) => {
    if (!isConnected) return []
    try {
      return await fetchCalendarEvents(connection.token, timeMin, timeMax)
    } catch (err) {
      if (err.status === 401) handleExpired()
      return []
    }
  }, [connection, isConnected])

  return { isConnected, isExpired, loading, connect, disconnect, pushTask, removeTask, fetchEvents }
}
