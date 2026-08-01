import { useState, useEffect, useMemo } from 'react'
import { supabase } from '../../lib/supabase'
import { FileText, Link as LinkIcon, Database, CheckSquare, Clock } from 'lucide-react'

function groupByProject(items, projects) {
  const byProject = new Map()
  for (const item of items) {
    const label = item.project?.prefix || item.project?.name || projects.find(p => p.id === item.project_id)?.prefix || 'Unknown project'
    if (!byProject.has(label)) byProject.set(label, [])
    byProject.get(label).push(item)
  }
  return [...byProject.entries()]
}

export default function SummaryModal({ tasks, projects, projectId = null, onClose }) {
  const [scope, setScope] = useState('today')
  const [tab, setTab] = useState('mechanical')
  const [kbItems, setKbItems] = useState([])
  const [kbLoading, setKbLoading] = useState(true)
  const [copied, setCopied] = useState(false)

  // Calculate bounds
  const { start, end } = useMemo(() => {
    const now = new Date()
    let s, e = now.toISOString()
    if (scope === 'session') {
      s = new Date(now.getTime() - 4 * 3600000).toISOString()
    } else if (scope === 'today') {
      const d = new Date(now)
      d.setHours(0, 0, 0, 0)
      s = d.toISOString()
    } else if (scope === 'yesterday') {
      const d = new Date(now)
      d.setDate(d.getDate() - 1)
      d.setHours(0, 0, 0, 0)
      s = d.toISOString()
      const endY = new Date(d)
      endY.setHours(23, 59, 59, 999)
      e = endY.toISOString()
    } else if (scope === '3d') {
      const d = new Date(now)
      d.setDate(d.getDate() - 3)
      d.setHours(0, 0, 0, 0)
      s = d.toISOString()
    }
    return { start: s, end: e }
  }, [scope])

  const filteredTasks = useMemo(() => projectId ? tasks.filter(t => t.project_id === projectId) : tasks, [tasks, projectId])

  const completed = useMemo(() =>
    filteredTasks.filter(t => t.status === 'done' && t.completed_at >= start && t.completed_at <= end), [filteredTasks, start, end])
  
  const inProgress = useMemo(() =>
    filteredTasks.filter(t => t.status !== 'done' && t.updated_at >= start && t.updated_at <= end), [filteredTasks, start, end])

  useEffect(() => {
    setKbLoading(true)
    let q = supabase.from('project_knowledge')
      .select('id, title, project_id, category, source, created_at')
      .gte('created_at', start)
      .lte('created_at', end)
      .order('created_at', { ascending: false })
    if (projectId) q = q.eq('project_id', projectId)
    
    q.then(({ data }) => { setKbItems(data ?? []); setKbLoading(false) })
  }, [start, end, projectId])

  const completedByProject = groupByProject(completed, projects)
  const inProgressByProject = groupByProject(inProgress, projects)
  const kbByProject = groupByProject(kbItems, projects)

  const isEmpty = !kbLoading && completed.length === 0 && inProgress.length === 0 && kbItems.length === 0

  function buildPrompt() {
    let p = `Please write a conversational summary of my progress based on this data (time scope: ${scope}):\n\n`
    if (completed.length) {
      p += `[Completed Tasks]\n`
      completed.forEach(t => {
        p += `- ${t.short_id || t.id}: ${t.text}\n`
        const out = t.output || {}
        if (out.artifact) p += `  Artifact: ${out.artifact.slice(0, 150).replace(/\n/g, ' ')}...\n`
        if (out.drive_files?.length) p += `  Files: ${out.drive_files.map(f => f.filename).join(', ')}\n`
        if (out.links?.length) p += `  Links: ${out.links.map(l => l.url).join(', ')}\n`
      })
      p += `\n`
    }
    if (inProgress.length) {
      p += `[In Progress Tasks (Modified)]\n`
      inProgress.forEach(t => {
        p += `- ${t.short_id || t.id}: ${t.text} (last updated: ${new Date(t.updated_at).toLocaleTimeString()})\n`
      })
      p += `\n`
    }
    if (kbItems.length) {
      p += `[Knowledge Added]\n`
      kbItems.forEach(k => p += `- ${k.title}\n`)
    }
    if (p.trim() === `Please write a conversational summary of my progress based on this data (time scope: ${scope}):`) {
      return 'No activity in this time window.'
    }
    return p.trim()
  }

  async function handleCopy() {
    try { await navigator.clipboard.writeText(buildPrompt()) } catch { /* clipboard blocked */ }
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-40"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="bg-paper rounded-2xl p-6 w-full max-w-[640px] mx-4 shadow-xl flex flex-col gap-4 max-h-[85vh]">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <p className="text-[15px] font-semibold text-ink">Summary Recap</p>
            <select
              value={scope}
              onChange={e => setScope(e.target.value)}
              className="bg-wash border border-line-2 rounded px-2 py-1 text-[12px] text-ink outline-none cursor-pointer"
            >
              <option value="session" className="text-black bg-white">Session (Last 4h)</option>
              <option value="today" className="text-black bg-white">Today</option>
              <option value="yesterday" className="text-black bg-white">Yesterday</option>
              <option value="3d" className="text-black bg-white">Past 3 Days</option>
            </select>
          </div>
          <button onClick={onClose} className="text-mute hover:text-ink text-lg leading-none">×</button>
        </div>

        <div className="flex gap-4 border-b border-line-2">
          <button
            onClick={() => setTab('mechanical')}
            className={`pb-2 text-[13px] font-medium transition-colors ${tab === 'mechanical' ? 'text-ink border-b-2 border-ink' : 'text-mute hover:text-ink'}`}
          >Mechanical</button>
          <button
            onClick={() => setTab('prompt')}
            className={`pb-2 text-[13px] font-medium transition-colors ${tab === 'prompt' ? 'text-ink border-b-2 border-ink' : 'text-mute hover:text-ink'}`}
          >Narrative Prompt</button>
        </div>

        <div className="flex-1 overflow-y-auto flex flex-col gap-5 -mr-2 pr-2">
          {tab === 'mechanical' ? (
            isEmpty ? (
              <p className="text-[13px] text-mute-2 py-6 text-center">No activity in this time window.</p>
            ) : (
              <>
                {completedByProject.length > 0 && (
                  <div>
                    <p className="flex items-center gap-1.5 text-[11px] font-semibold text-mute uppercase tracking-wide mb-3"><CheckSquare size={12} /> Completed ({completed.length})</p>
                    <div className="flex flex-col gap-3">
                      {completedByProject.map(([label, items]) => (
                        <div key={label} className="flex flex-col gap-2">
                          <div className="font-mono text-[10px] text-mute-2 uppercase tracking-wide">{label}</div>
                          {items.map(t => {
                            const out = t.output || {}
                            return (
                              <div key={t.id} className="flex flex-col gap-1.5 bg-wash rounded p-2.5 border border-line">
                                <div className="text-[13px] text-ink-2 font-medium">{t.text}</div>
                                {(out.artifact || out.drive_files?.length > 0 || out.links?.length > 0) && (
                                  <div className="flex flex-col gap-1.5 mt-1 border-t border-line-2 pt-2">
                                    {out.drive_files?.map(f => (
                                      <a key={f.file_id} href={`https://drive.google.com/open?id=${f.file_id}`} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 text-[12px] text-accent hover:underline">
                                        <FileText size={12} /> {f.filename}
                                      </a>
                                    ))}
                                    {out.links?.map((l, idx) => (
                                      <a key={idx} href={l.url} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 text-[12px] text-accent hover:underline">
                                        <LinkIcon size={12} /> {l.title || l.url}
                                      </a>
                                    ))}
                                    {out.artifact && (
                                      <div className="text-[11px] font-mono text-mute bg-paper p-1.5 rounded truncate">
                                        {out.artifact.slice(0, 120).replace(/\n/g, ' ')}...
                                      </div>
                                    )}
                                  </div>
                                )}
                              </div>
                            )
                          })}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {inProgressByProject.length > 0 && (
                  <div>
                    <p className="flex items-center gap-1.5 text-[11px] font-semibold text-mute uppercase tracking-wide mb-3 mt-2"><Clock size={12} /> In Progress ({inProgress.length})</p>
                    <div className="flex flex-col gap-2">
                      {inProgressByProject.map(([label, items]) => (
                        <div key={label} className="flex flex-col gap-1.5">
                          <div className="font-mono text-[10px] text-mute-2 uppercase tracking-wide">{label}</div>
                          {items.map(t => (
                            <div key={t.id} className="flex flex-col gap-0.5 bg-wash rounded p-2 border border-line">
                              <span className="text-[13px] text-ink-2 truncate">{t.text}</span>
                              <span className="text-[10px] text-mute">Modified {new Date(t.updated_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                            </div>
                          ))}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {kbByProject.length > 0 && (
                  <div>
                    <p className="flex items-center gap-1.5 text-[11px] font-semibold text-mute uppercase tracking-wide mb-2 mt-2"><Database size={12} /> Knowledge added ({kbItems.length})</p>
                    <div className="flex flex-col gap-1">
                      {kbByProject.map(([label, items]) => items.map(k => (
                        <div key={k.id} className="flex items-baseline gap-2 text-[13px] pl-1">
                          <span className="font-mono text-[10px] text-mute-2 shrink-0">{label}</span>
                          <span className="text-ink-2 truncate">{k.title}</span>
                        </div>
                      )))}
                    </div>
                  </div>
                )}
              </>
            )
          ) : (
            <div className="flex flex-col h-full">
              <p className="text-[13px] text-mute mb-2">Paste this prompt into Antigravity or Claude Code to get a conversational summary of this activity:</p>
              <pre className="flex-1 bg-wash border border-line p-3 rounded-lg text-[12px] font-mono text-ink-2 overflow-y-auto whitespace-pre-wrap select-all">
                {buildPrompt()}
              </pre>
            </div>
          )}
        </div>

        <div className="flex gap-2 justify-end pt-2 border-t border-line-2">
          {tab === 'prompt' && (
            <button onClick={handleCopy} className="btn btn-sm text-accent font-medium">
              {copied ? 'Copied!' : '⎘ Copy Prompt'}
            </button>
          )}
          <button onClick={onClose} className="px-4 py-2 text-[13px] text-mute hover:text-ink transition-colors">Close</button>
        </div>
      </div>
    </div>
  )
}
