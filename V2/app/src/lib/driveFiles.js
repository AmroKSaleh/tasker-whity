import { supabase } from './supabase'

export async function uploadFileToDrive(file, taskId) {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) throw new Error('Not signed in')
  const form = new FormData()
  form.append('file', file)
  if (taskId) form.append('task_id', taskId)
  const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/drive-files`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${session.access_token}` },
    body: form,
  })
  const data = await res.json()
  if (!res.ok || data.error) throw new Error(data.error ?? 'Upload failed')
  return data
}

export function driveFileUrl(fileId) {
  return `https://drive.google.com/file/d/${fileId}/view`
}

// mode: 'link' removes the file from the task only; 'drive' also deletes it from Google Drive.
export async function deleteDriveFile(taskId, fileId, mode) {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) throw new Error('Not signed in')
  const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/drive-files`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'delete', task_id: taskId, file_id: fileId, mode }),
  })
  const data = await res.json()
  if (!res.ok || data.error) throw new Error(data.error ?? 'Delete failed')
  return data
}
