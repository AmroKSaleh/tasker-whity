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

// ── Project-scoped Drive files (TDE-373) ──────────────────────────────
// All files live in the project's Google Drive folder. Documents (txt/md/html/doc(x)/odt/rtf)
// convert to editable Google Docs; other types upload as-is. Callers surface DRIVE_NOT_CONNECTED
// so the UI can show a connect prompt instead of a raw error.
const DRIVE_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/drive-files`

async function driveJson(payload) {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) throw new Error('Not signed in')
  const res = await fetch(DRIVE_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const data = await res.json()
  if (res.status === 400 && /not connected/i.test(data.error ?? '')) throw new Error('DRIVE_NOT_CONNECTED')
  if (!res.ok || data.error) throw new Error(data.error ?? 'Request failed')
  return data
}

export async function uploadFileToProjectDrive(file, projectId) {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) throw new Error('Not signed in')
  const form = new FormData()
  form.append('file', file)
  form.append('project_id', projectId)
  const res = await fetch(DRIVE_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${session.access_token}` },
    body: form,
  })
  const data = await res.json()
  if (res.status === 400 && /not connected/i.test(data.error ?? '')) throw new Error('DRIVE_NOT_CONNECTED')
  if (!res.ok || data.error) throw new Error(data.error ?? 'Upload failed')
  return data
}

export const listProjectDriveFiles = (projectId) => driveJson({ action: 'project_list', project_id: projectId })
export const getProjectDriveFolder = (projectId) => driveJson({ action: 'project_folder', project_id: projectId })
export const deleteProjectDriveFile = (projectId, fileId) => driveJson({ action: 'project_delete', project_id: projectId, file_id: fileId })
