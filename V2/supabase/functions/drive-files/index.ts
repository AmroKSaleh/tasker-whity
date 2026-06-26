// drive-files — Browser-callable Drive file operations for task attachments.
// Upload (multipart/form-data) and list (JSON) Drive files tied to a task.
// Auth via Supabase JWT. Folder hierarchy: Tasker/ → Project/ → Flow or standalone/.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { loadGoogleAccessToken } from '../_shared/googleToken.ts'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } })

const DRIVE = 'https://www.googleapis.com/drive/v3'
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3'

async function findOrCreateFolder(token: string, parentId: string, name: string): Promise<string> {
  const q = encodeURIComponent(`name='${name}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`)
  const res = await fetch(`${DRIVE}/files?q=${q}&fields=files(id)`, { headers: { Authorization: `Bearer ${token}` } })
  const data = await res.json()
  if (data.files?.length) return data.files[0].id
  const create = await fetch(`${DRIVE}/files`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] }),
  })
  const folder = await create.json()
  if (!folder.id) throw new Error(`Failed to create Drive folder "${name}"`)
  return folder.id
}

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
    if (!token) return json({ error: 'Google Drive not connected' }, 400)

    const { data: settings } = await sb.from('user_settings').select('google_drive_folder_id').eq('user_id', user.id).maybeSingle()
    let taskerRootId = settings?.google_drive_folder_id
    if (!taskerRootId) {
      // Lazily create the Tasker root folder — happens when Drive was connected before
      // this folder-creation logic was deployed, or on re-auth without a stored folder id.
      const folderRes = await fetch('https://www.googleapis.com/drive/v3/files', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Tasker', mimeType: 'application/vnd.google-apps.folder' }),
      })
      const folder = await folderRes.json()
      if (!folderRes.ok || !folder.id) return json({ error: 'Failed to create Tasker Drive folder. Make sure Drive is connected with the right permissions.' }, 400)
      await sb.from('user_settings').update({ google_drive_folder_id: folder.id }).eq('user_id', user.id)
      taskerRootId = folder.id
    }

    const contentType = req.headers.get('content-type') ?? ''

    // ── LIST ──────────────────────────────────────────────────────
    if (!contentType.includes('multipart/form-data')) {
      const body = await req.json().catch(() => ({}))
      if (body.action === 'list') {
        const { task_id } = body
        if (!task_id) return json({ error: 'task_id required' }, 400)
        const { data: task } = await sb.from('tasks').select('output').eq('id', task_id).maybeSingle()
        return json({ files: task?.output?.drive_files ?? [] })
      }
      // ── DELETE / UNLINK ───────────────────────────────────────────
      // mode 'link'  → only remove the file from the task's drive_files (Drive untouched)
      // mode 'drive' → also delete the actual file from Google Drive
      if (body.action === 'delete') {
        const { task_id, file_id, mode } = body
        if (!task_id || !file_id) return json({ error: 'task_id and file_id required' }, 400)
        if (mode === 'drive') {
          const delRes = await fetch(`${DRIVE}/files/${file_id}`, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${token}` },
          })
          // 404 = already gone; treat as success so the link still gets cleaned up.
          if (!delRes.ok && delRes.status !== 404) {
            const err = await delRes.json().catch(() => ({}))
            return json({ error: err.error?.message ?? `Drive delete failed (${delRes.status})` }, 502)
          }
        }
        const { data: task } = await sb.from('tasks').select('output').eq('id', task_id).maybeSingle()
        const prev = (task?.output && typeof task.output === 'object') ? task.output : {}
        const remaining = (Array.isArray(prev.drive_files) ? prev.drive_files : []).filter((f: any) => f.file_id !== file_id)
        await sb.from('tasks').update({ output: { ...prev, drive_files: remaining } }).eq('id', task_id)
        return json({ ok: true, files: remaining })
      }
      return json({ error: 'Unknown action' }, 400)
    }

    // ── UPLOAD ────────────────────────────────────────────────────
    const form = await req.formData()
    const file = form.get('file') as File | null
    const taskId = form.get('task_id') as string | null
    if (!file) return json({ error: 'file is required' }, 400)

    // Resolve folder context from task
    let targetFolderId = taskerRootId
    let finalFilename = file.name

    if (taskId) {
      const { data: task } = await sb.from('tasks')
        .select('id, project_id, flow_id, short_id, project:projects(name, prefix, google_drive_folder_id)')
        .eq('id', taskId).maybeSingle()

      if (task?.project) {
        // Ensure project subfolder exists (lazy create + persist)
        let projectFolderId = task.project.google_drive_folder_id
        if (!projectFolderId) {
          projectFolderId = await findOrCreateFolder(token, taskerRootId, task.project.name)
          await sb.from('projects').update({ google_drive_folder_id: projectFolderId }).eq('id', task.project_id)
        }

        // Flow subfolder or standalone
        let subName = 'standalone'
        if (task.flow_id) {
          const { data: flow } = await sb.from('flows').select('short_id, id').eq('id', task.flow_id).maybeSingle()
          subName = flow?.short_id || flow?.id?.slice(0, 8) || 'standalone'
        }
        targetFolderId = await findOrCreateFolder(token, projectFolderId, subName)

        // Inject task ID into filename: PREFIX-SHORT_ID_originalname
        if (task.short_id != null && task.project.prefix) {
          const ext = file.name.includes('.') ? file.name.slice(file.name.lastIndexOf('.')) : ''
          const base = file.name.slice(0, file.name.length - ext.length)
          finalFilename = `${task.project.prefix}-${task.short_id}_${base}${ext}`
        }
      }
    }

    // Multipart upload to Drive
    const boundary = 'tasker_file_boundary'
    const meta = JSON.stringify({ name: finalFilename, parents: [targetFolderId] })
    const fileBytes = await file.arrayBuffer()
    const enc = new TextEncoder()
    const pre = enc.encode(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: ${file.type || 'application/octet-stream'}\r\n\r\n`)
    const post = enc.encode(`\r\n--${boundary}--`)
    const combined = new Uint8Array(pre.byteLength + fileBytes.byteLength + post.byteLength)
    combined.set(pre, 0)
    combined.set(new Uint8Array(fileBytes), pre.byteLength)
    combined.set(post, pre.byteLength + fileBytes.byteLength)

    const uploadRes = await fetch(`${DRIVE_UPLOAD}/files?uploadType=multipart`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
      body: combined,
    })
    const uploaded = await uploadRes.json()
    if (!uploadRes.ok) return json({ error: uploaded.error?.message ?? 'Upload failed' }, 502)

    // Persist Drive file ID on task output.drive_files
    if (taskId && uploaded.id) {
      const { data: task } = await sb.from('tasks').select('output').eq('id', taskId).maybeSingle()
      const prev = (task?.output && typeof task.output === 'object') ? task.output : {}
      const driveFiles = Array.isArray(prev.drive_files) ? prev.drive_files : []
      driveFiles.push({ file_id: uploaded.id, filename: finalFilename, uploaded_at: new Date().toISOString() })
      await sb.from('tasks').update({ output: { ...prev, drive_files: driveFiles } }).eq('id', taskId)
    }

    return json({ file_id: uploaded.id, filename: finalFilename })
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500)
  }
})
