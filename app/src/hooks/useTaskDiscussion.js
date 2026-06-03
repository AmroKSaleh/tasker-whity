import { useState, useEffect, useRef } from 'react'
import { supabase } from '../lib/supabase'

export function useTaskDiscussion(taskId) {
  const [messages, setMessages] = useState([])
  const [steps, setSteps] = useState(null)
  const [checkedSteps, setCheckedSteps] = useState([])
  const [reason, setReason] = useState(null)
  const [loading, setLoading] = useState(true)
  const recordId = useRef(null)

  useEffect(() => {
    if (!taskId) return
    setMessages([])
    setSteps(null)
    setCheckedSteps([])
    setReason(null)
    setLoading(true)
    recordId.current = null
    load()
  }, [taskId])

  async function load() {
    const { data: { user } } = await supabase.auth.getUser()
    const { data } = await supabase
      .from('task_discussions')
      .select('*')
      .eq('task_id', taskId)
      .maybeSingle()

    if (data) {
      recordId.current = data.id
      setMessages(data.messages ?? [])
      setSteps(data.steps ?? null)
      setCheckedSteps(data.checked_steps ?? [])
      setReason(data.reason ?? null)
    } else {
      const { data: created } = await supabase
        .from('task_discussions')
        .insert({ task_id: taskId, user_id: user.id, messages: [], steps: null, checked_steps: [], reason: null })
        .select()
        .single()
      if (created) recordId.current = created.id
    }
    setLoading(false)
  }

  async function saveMessages(updated) {
    if (!recordId.current) return
    await supabase
      .from('task_discussions')
      .update({ messages: updated, updated_at: new Date().toISOString() })
      .eq('id', recordId.current)
  }

  async function saveStepsAndReason(newSteps, newCheckedSteps, newReason) {
    if (!recordId.current) return
    await supabase
      .from('task_discussions')
      .update({ steps: newSteps, checked_steps: newCheckedSteps, reason: newReason, updated_at: new Date().toISOString() })
      .eq('id', recordId.current)
  }

  async function saveCheckedSteps(newCheckedSteps) {
    if (!recordId.current) return
    await supabase
      .from('task_discussions')
      .update({ checked_steps: newCheckedSteps, updated_at: new Date().toISOString() })
      .eq('id', recordId.current)
  }

  return {
    messages, setMessages, saveMessages,
    steps, setSteps,
    checkedSteps, setCheckedSteps,
    reason, setReason,
    saveStepsAndReason, saveCheckedSteps,
    loading,
  }
}
