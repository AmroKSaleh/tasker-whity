import { useState, useRef } from 'react'
import clsx from 'clsx'
import { Download, Upload, CheckCircle2 } from 'lucide-react'
import { exportProjectBundle, downloadBundle, importProjectBundle } from '../../lib/projectTransfer'

function ProgressChoice({ reset, setReset }) {
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-[11px] uppercase tracking-[0.08em] text-mute font-semibold">Progress</p>
      {[
        { val: false, label: 'Copy everything as-is', hint: 'Keeps task statuses and completion.' },
        { val: true, label: 'Clear progress', hint: 'Resets all tasks to pending.' },
      ].map(opt => (
        <button
          key={String(opt.val)}
          onClick={() => setReset(opt.val)}
          className={clsx(
            'flex items-start gap-2.5 text-left px-3 py-2 rounded-lg border transition-colors',
            reset === opt.val ? 'border-accent bg-surf-2' : 'border-line hover:border-line-2'
          )}
        >
          <span className={clsx('mt-0.5 w-3.5 h-3.5 rounded-full border shrink-0', reset === opt.val ? 'border-accent bg-accent' : 'border-mute')} />
          <span>
            <span className="block text-[13px] text-ink font-medium">{opt.label}</span>
            <span className="block text-[12px] text-mute">{opt.hint}</span>
          </span>
        </button>
      ))}
    </div>
  )
}

export default function TransferModal({ projects = [], onClose, onGoToProject }) {
  const [mode, setMode] = useState('export')
  const [reset, setReset] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState(null)
  const [nameOverride, setNameOverride] = useState('')
  const [selectedId, setSelectedId] = useState(projects[0]?.id ?? '')
  const [file, setFile] = useState(null)
  const [imported, setImported] = useState(null) // { proj, total } → success popup
  const fileInputRef = useRef(null)

  async function handleExport() {
    const project = projects.find(p => p.id === selectedId)
    if (!project) { setMessage({ type: 'err', text: 'Pick a project to export.' }); return }
    setBusy(true); setMessage(null)
    try {
      const bundle = await exportProjectBundle(project.id, { resetProgress: reset })
      downloadBundle(bundle, project.name)
      setMessage({ type: 'ok', text: `Exported "${project.name}"${reset ? ' (progress cleared)' : ''}.` })
    } catch (err) {
      setMessage({ type: 'err', text: err.message })
    } finally {
      setBusy(false)
    }
  }

  function handleFileSelect(e) {
    const f = e.target.files?.[0] ?? null
    e.target.value = ''
    setMessage(null)
    setFile(f)
  }

  function readFile(f) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = ev => resolve(ev.target.result)
      reader.onerror = () => reject(new Error('Could not read the file.'))
      reader.readAsText(f)
    })
  }

  async function handleStartImport() {
    if (!file) return
    setBusy(true); setMessage(null)
    try {
      const bundle = JSON.parse(await readFile(file))
      const { project: proj, counts } = await importProjectBundle(bundle, { resetProgress: reset, name: nameOverride.trim() || undefined })
      const total = Object.values(counts).reduce((a, b) => a + b, 0)
      setImported({ proj, total })
    } catch (err) {
      setMessage({ type: 'err', text: err.message?.includes('JSON') ? 'That file is not a valid Tasker export.' : err.message })
    } finally {
      setBusy(false)
    }
  }

  // ── Success popup (after an import) ──────────────────────────
  if (imported) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-40">
        <div className="bg-paper rounded-2xl w-full max-w-sm mx-4 shadow-xl flex flex-col items-center text-center px-6 py-7 gap-3">
          <CheckCircle2 size={40} className="text-accent" />
          <p className="text-[16px] font-semibold text-ink">Project imported successfully</p>
          <p className="text-[13px] text-mute">
            "{imported.proj.name}" was recreated with {imported.total} items{reset ? ', progress cleared' : ''}.
          </p>
          <div className="flex gap-2 mt-2 w-full">
            <button onClick={onClose} className="btn btn-sm flex-1 min-w-0">Close</button>
            <button onClick={() => onGoToProject?.(imported.proj)} className="btn btn-sm btn-primary flex-1 min-w-0">
              <span className="truncate">Go to {imported.proj.name}</span>
            </button>
          </div>
        </div>
      </div>
    )
  }

  // ── Transfer form ────────────────────────────────────────────
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-40"
      onClick={e => { if (e.target === e.currentTarget && !busy) onClose() }}
    >
      <div className="bg-paper rounded-2xl w-full max-w-md mx-4 shadow-xl flex flex-col">
        <div className="flex items-center justify-between px-6 pt-6 pb-0">
          <p className="text-[15px] font-semibold text-ink">Export / Import project</p>
          <button onClick={() => !busy && onClose()} className="text-mute hover:text-ink text-lg leading-none transition-colors">×</button>
        </div>

        <div className="flex flex-col gap-4 px-6 pt-4 pb-6">
          <div className="flex gap-1 p-1 rounded-lg bg-surf-2">
            {['export', 'import'].map(m => (
              <button
                key={m}
                onClick={() => { setMode(m); setMessage(null) }}
                className={clsx(
                  'flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md text-[13px] font-medium transition-colors',
                  mode === m ? 'bg-paper text-ink shadow-sm' : 'text-mute hover:text-ink'
                )}
              >
                {m === 'export' ? <Download size={13} /> : <Upload size={13} />}
                {m === 'export' ? 'Export' : 'Import'}
              </button>
            ))}
          </div>

          <p className="text-[13px] text-ink-2">
            {mode === 'export'
              ? 'Download a project as a portable file — tasks, sections, groups, flows, contracts, the Knowledge Base, and the Instruction Set, all included.'
              : 'Create a new project from a Tasker export file. Everything is recreated under your account with fresh IDs.'}
          </p>

          {mode === 'export' && (
            projects.length ? (
              <select
                value={selectedId}
                onChange={e => setSelectedId(e.target.value)}
                className="text-[13px] bg-transparent border border-line rounded-lg px-3 py-2 outline-none focus:border-accent text-ink"
              >
                {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            ) : (
              <p className="text-[12px] text-mute">No projects to export yet.</p>
            )
          )}

          {mode === 'import' && (
            <>
              <div className="flex items-center gap-2">
                <input ref={fileInputRef} type="file" accept=".json,application/json" className="hidden" onChange={handleFileSelect} />
                <button onClick={() => fileInputRef.current?.click()} className="btn btn-sm shrink-0">Choose file</button>
                <span className={clsx('text-[12px] truncate', file ? 'text-ink-2' : 'text-mute')}>
                  {file ? file.name : 'No file selected'}
                </span>
              </div>
              <input
                type="text"
                value={nameOverride}
                onChange={e => setNameOverride(e.target.value)}
                placeholder="New project name (optional)"
                className="text-[13px] bg-transparent border border-line rounded-lg px-3 py-2 outline-none focus:border-accent text-ink placeholder:text-mute"
              />
            </>
          )}

          <ProgressChoice reset={reset} setReset={setReset} />

          {message && (
            <p className={clsx('text-[12px]', message.type === 'ok' ? 'text-ink-2' : 'text-red-500')}>{message.text}</p>
          )}

          <div className="flex justify-end pt-1">
            {mode === 'export' ? (
              <button onClick={handleExport} disabled={busy || !projects.length} className="btn btn-sm btn-primary disabled:opacity-50">
                <Download size={13} /> {busy ? 'Exporting…' : 'Download export'}
              </button>
            ) : (
              <button onClick={handleStartImport} disabled={busy || !file} className="btn btn-sm btn-primary disabled:opacity-50">
                <Upload size={13} /> {busy ? 'Importing…' : 'Start import'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
