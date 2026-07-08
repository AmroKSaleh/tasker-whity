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

async function getFolderLink(token: string, folderId: string): Promise<string | null> {
  const res = await fetch(`${DRIVE}/files/${folderId}?fields=webViewLink`, { headers: { Authorization: `Bearer ${token}` } })
  const d = await res.json().catch(() => ({}))
  return d.webViewLink ?? null
}

// Resolve a PROJECT's Drive folder (TDE-373), enforcing access via the RLS-respecting auth client
// (the service-role client would bypass ownership). Lazily creates + persists the folder id.
// Returns null when the project isn't visible to the caller — the handler turns that into a 403.
async function resolveProjectFolder(authClient: any, token: string, taskerRootId: string, projectId: string):
  Promise<{ id: string; link: string | null } | null> {
  const { data: proj } = await authClient.from('projects')
    .select('id, name, google_drive_folder_id').eq('id', projectId).maybeSingle()
  if (!proj) return null
  let id = proj.google_drive_folder_id
  if (!id) {
    id = await findOrCreateFolder(token, taskerRootId, proj.name)
    await authClient.from('projects').update({ google_drive_folder_id: id }).eq('id', projectId)
  }
  return { id, link: await getFolderLink(token, id) }
}

// Only WORD-PROCESSOR formats convert to an editable Google Doc (Drive convert-on-import, metadata
// mimeType = google-apps.document) — you convert these because you otherwise can't easily view/edit
// them. Text, Markdown, and especially HTML upload AS-IS: they're already viewable/renderable, and
// converting HTML to a Doc destroys its styling/layout (the TDE-373 report bug). Everything not in
// this list uploads raw.
const DOC_EXTS = ['doc', 'docx', 'odt', 'rtf']
const SOURCE_MIME: Record<string, string> = {
  rtf: 'application/rtf', odt: 'application/vnd.oasis.opendocument.text',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
}
function extOf(name: string): string {
  return name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : ''
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

      // ── PROJECT-SCOPED actions (TDE-373) ──────────────────────────
      // folder_link → the project's Drive folder id + shareable link (for the "Open folder" button)
      if (body.action === 'project_folder' && body.project_id) {
        const folder = await resolveProjectFolder(authClient, token, taskerRootId, body.project_id)
        if (!folder) return json({ error: 'Project not found or not accessible' }, 403)
        return json({ folder_id: folder.id, web_view_link: folder.link })
      }
      // list → the files living directly in the project's Drive folder (live from Drive)
      if (body.action === 'project_list' && body.project_id) {
        const folder = await resolveProjectFolder(authClient, token, taskerRootId, body.project_id)
        if (!folder) return json({ error: 'Project not found or not accessible' }, 403)
        const q = encodeURIComponent(`'${folder.id}' in parents and trashed=false and mimeType!='application/vnd.google-apps.folder'`)
        const listRes = await fetch(`${DRIVE}/files?q=${q}&fields=files(id,name,mimeType,webViewLink,modifiedTime,size)&orderBy=modifiedTime desc&pageSize=100`,
          { headers: { Authorization: `Bearer ${token}` } })
        const list = await listRes.json()
        if (!listRes.ok) return json({ error: list.error?.message ?? 'Drive list failed' }, 502)
        return json({ folder_id: folder.id, web_view_link: folder.link, files: list.files ?? [] })
      }
      // delete → remove a file from the project's Drive folder (actual Drive delete)
      if (body.action === 'project_delete' && body.project_id && body.file_id) {
        const folder = await resolveProjectFolder(authClient, token, taskerRootId, body.project_id)
        if (!folder) return json({ error: 'Project not found or not accessible' }, 403)
        const delRes = await fetch(`${DRIVE}/files/${body.file_id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } })
        if (!delRes.ok && delRes.status !== 404) {
          const err = await delRes.json().catch(() => ({}))
          return json({ error: err.error?.message ?? `Drive delete failed (${delRes.status})` }, 502)
        }
        return json({ ok: true })
      }
      return json({ error: 'Unknown action' }, 400)
    }

    // ── UPLOAD ────────────────────────────────────────────────────
    const form = await req.formData()
    const file = form.get('file') as File | null
    const taskId = form.get('task_id') as string | null
    const projectId = form.get('project_id') as string | null
    if (!file) return json({ error: 'file is required' }, 400)

    // Resolve folder context from task
    let targetFolderId = taskerRootId
    let finalFilename = file.name
    // PROJECT upload (TDE-373): straight into the project's Drive folder — no flow subfolder, no
    // task-id filename prefix. Document types convert to editable Google Docs; others upload as-is.
    let asDoc = false

    if (projectId && !taskId) {
      const folder = await resolveProjectFolder(authClient, token, taskerRootId, projectId)
      if (!folder) return json({ error: 'Project not found or not accessible' }, 403)
      targetFolderId = folder.id
      asDoc = DOC_EXTS.includes(extOf(file.name))
    } else if (taskId) {
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

    // Multipart upload to Drive. For a doc-type project upload, set metadata.mimeType to the
    // google-apps Doc type so Drive converts on import (editable Google Doc); the media part keeps
    // the source content-type so Drive knows what to convert FROM.
    const boundary = 'tasker_file_boundary'
    const metaObj: Record<string, unknown> = { name: finalFilename, parents: [targetFolderId] }
    if (asDoc) metaObj.mimeType = 'application/vnd.google-apps.document'
    const sourceMime = asDoc ? (file.type || SOURCE_MIME[extOf(file.name)] || 'text/plain') : (file.type || 'application/octet-stream')
    const meta = JSON.stringify(metaObj)
    const fileBytes = await file.arrayBuffer()
    const enc = new TextEncoder()
    const pre = enc.encode(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: ${sourceMime}\r\n\r\n`)
    const post = enc.encode(`\r\n--${boundary}--`)
    const combined = new Uint8Array(pre.byteLength + fileBytes.byteLength + post.byteLength)
    combined.set(pre, 0)
    combined.set(new Uint8Array(fileBytes), pre.byteLength)
    combined.set(post, pre.byteLength + fileBytes.byteLength)

    const uploadRes = await fetch(`${DRIVE_UPLOAD}/files?uploadType=multipart&fields=id,name,mimeType,webViewLink`, {
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

    return json({ file_id: uploaded.id, filename: finalFilename, mime_type: uploaded.mimeType ?? null, web_view_link: uploaded.webViewLink ?? null })
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500)
  }
})
