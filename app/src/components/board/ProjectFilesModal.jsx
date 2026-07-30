import { useState, useEffect, useRef } from 'react'
import { FileText, Upload, ExternalLink, Trash2, FolderOpen } from 'lucide-react'
import { uploadFileToProjectDrive, listProjectDriveFiles, getProjectDriveFolder, deleteProjectDriveFile } from '../../lib/driveFiles'

// Project files (TDE-373): everything lives in the project's Google Drive folder. Docs become
// editable Google Docs; other files upload as-is. A folder button opens the whole thing in Drive.
// Hard-depends on Drive being connected — the empty state handles the not-connected case.
function isDoc(mime) {
  return /google-apps\.(document|spreadsheet|presentation)/.test(mime || '')
}
function prettyType(mime) {
  if (!mime) return 'file'
  if (mime.includes('google-apps.document')) return 'Google Doc'
  if (mime.includes('google-apps.spreadsheet')) return 'Google Sheet'
  if (mime.includes('pdf')) return 'PDF'
  if (mime.startsWith('image/')) return mime.slice(6).toUpperCase()
  return mime.split('/').pop()
}

export default function ProjectFilesModal({ projectId, projectName, onClose }) {
  const [files, setFiles] = useState([])
  const [folderLink, setFolderLink] = useState(null)
  const [status, setStatus] = useState('loading') // loading | ready | disconnected | error
  const [err, setErr] = useState('')
  const [uploading, setUploading] = useState(false)
  const [dragActive, setDragActive] = useState(false)
  const inputRef = useRef(null)

  async function refresh() {
    try {
      const data = await listProjectDriveFiles(projectId)
      setFiles(data.files ?? [])
      setFolderLink(data.web_view_link ?? null)
      setStatus('ready')
    } catch (e) {
      if (e.message === 'DRIVE_NOT_CONNECTED') setStatus('disconnected')
      else { setErr(e.message); setStatus('error') }
    }
  }
  useEffect(() => { refresh() }, [projectId])

  async function handleFiles(fileList) {
    const picked = Array.from(fileList || [])
    if (!picked.length) return
    setUploading(true); setErr('')
    try {
      for (const f of picked) await uploadFileToProjectDrive(f, projectId)
      await refresh()
    } catch (e) {
      setErr(e.message === 'DRIVE_NOT_CONNECTED' ? 'Google Drive isn’t connected.' : e.message)
    } finally {
      setUploading(false)
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  async function handleDelete(fileId) {
    if (!window.confirm('Delete this file from the project’s Drive folder?')) return
    try { await deleteProjectDriveFile(projectId, fileId); await refresh() } catch (e) { setErr(e.message) }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-40" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="bg-paper rounded-2xl w-full max-w-[560px] mx-4 shadow-xl flex flex-col max-h-[82vh]">
        <div className="flex items-center justify-between px-6 py-4 border-b border-line-2">
          <div>
            <p className="text-[15px] font-semibold text-ink">Files</p>
            <p className="text-[11px] text-mute-2 mt-0.5">{projectName} · stored in Google Drive</p>
          </div>
          <div className="flex items-center gap-2">
            {folderLink && (
              <a href={folderLink} target="_blank" rel="noreferrer" className="btn btn-sm inline-flex items-center gap-1.5">
                <FolderOpen size={13} /> Open Drive folder
              </a>
            )}
            <button onClick={onClose} className="text-mute hover:text-ink text-lg leading-none">×</button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-5">
          {status === 'loading' && <p className="text-[13px] text-mute py-6 text-center">Loading…</p>}

          {status === 'disconnected' && (
            <div className="text-center py-10">
              <p className="text-[28px] mb-2 opacity-40">⬡</p>
              <p className="text-[14px] font-semibold text-ink mb-1">Google Drive isn’t connected</p>
              <p className="text-[12px] text-mute mb-4">Project files are stored in your Google Drive. Connect it to upload and browse files here.</p>
              <a href="/settings" className="btn btn-sm">Go to Connectors →</a>
            </div>
          )}

          {status === 'error' && <p className="text-[12px] text-red-500 py-6 text-center">{err}</p>}

          {status === 'ready' && (
            <>
              <label
                onDragEnter={e => { e.preventDefault(); setDragActive(true) }}
                onDragOver={e => { e.preventDefault(); setDragActive(true) }}
                onDragLeave={e => { e.preventDefault(); setDragActive(false) }}
                onDrop={e => { e.preventDefault(); setDragActive(false); handleFiles(e.dataTransfer.files) }}
                className={`flex flex-col items-center justify-center gap-1.5 border rounded-xl py-7 cursor-pointer transition-colors mb-4 ${
                  dragActive ? 'border-2 border-accent bg-accent/10' : 'border border-dashed border-line hover:border-ink-2 hover:bg-surf-2'
                }`}
              >
                <Upload size={18} className={dragActive ? 'text-accent' : 'text-mute-2'} />
                <span className="text-[13px] text-ink font-medium">{uploading ? 'Uploading…' : 'Drop files or click to upload'}</span>
                <span className="text-[11px] text-mute-2">Word docs (.doc/.docx/.odt/.rtf) become editable Google Docs · everything else uploads as-is</span>
                <input ref={inputRef} type="file" multiple className="hidden" disabled={uploading} onChange={e => handleFiles(e.target.files)} />
              </label>

              {err && <p className="text-[12px] text-red-500 mb-3">{err}</p>}

              {files.length === 0 ? (
                <p className="text-[12px] text-mute-2 text-center py-4">No files yet.</p>
              ) : (
                <div className="flex flex-col">
                  {files.map(f => (
                    <div key={f.id} className="group flex items-center gap-3 px-2 py-2 rounded-lg hover:bg-surf-2 transition-colors">
                      <FileText size={15} className={isDoc(f.mimeType) ? 'text-accent shrink-0' : 'text-mute-2 shrink-0'} />
                      <div className="flex-1 min-w-0">
                        <div className="text-[13px] text-ink truncate">{f.name}</div>
                        <div className="font-mono text-[10px] text-mute-2">{prettyType(f.mimeType)}</div>
                      </div>
                      {f.webViewLink && (
                        <a href={f.webViewLink} target="_blank" rel="noreferrer" title="Open in Drive"
                          className="opacity-0 group-hover:opacity-100 text-mute hover:text-ink transition-opacity"><ExternalLink size={14} /></a>
                      )}
                      <button onClick={() => handleDelete(f.id)} title="Delete from Drive"
                        className="opacity-0 group-hover:opacity-100 text-mute hover:text-red-500 transition-opacity"><Trash2 size={14} /></button>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
