import { useState, useEffect, useMemo } from 'react'
import { supabase } from '../../lib/supabase'

// Day Summary (TDE-323, merged into the broader recap idea in TDE-160): a mechanical, "today"-
// scoped recap built from real task/KB timestamps — no AI call, so it's free and reproducible for
// any day. Session/date-range scoping and an AI-narrated version are left for TDE-160 to extend
// this same modal with, not rebuilt from scratch.
function groupByProject(items, projects) {
  const byProject = new Map()
  for (const item of items) {
    const label = item.project?.prefix || item.project?.name || projects.find(p => p.id === item.project_id)?.prefix || 'Unknown project'
    if (!byProject.has(label)) byProject.set(label, [])
    byProject.get(label).push(item)
  }
  return [...byProject.entries()]
}

export default function DaySummaryModal({ tasks, projects, onClose }) {
  const [kbToday, setKbToday] = useState([])
  const [kbLoading, setKbLoading] = useState(true)
  const [copied, setCopied] = useState(false)

  const today = useMemo(() => new Date().toISOString().slice(0, 10), [])

  const completedToday = useMemo(() =>
    tasks.filter(t => t.status === 'done' && t.completed_at?.slice(0, 10) === today), [tasks, today])
  const createdToday = useMemo(() =>
    tasks.filter(t => t.created_at?.slice(0, 10) === today), [tasks, today])

  useEffect(() => {
    const startOfDayUTC = `${today}T00:00:00.000Z`
    supabase.from('project_knowledge')
      .select('id, title, project_id, category, source, created_at')
      .gte('created_at', startOfDayUTC)
      .order('created_at', { ascending: false })
      .then(({ data }) => { setKbToday(data ?? []); setKbLoading(false) })
  }, [today])

  const completedByProject = groupByProject(completedToday, projects)
  const createdByProject = groupByProject(createdToday, projects)
  const kbByProject = groupByProject(kbToday, projects)
  const projectName = (id) => projects.find(p => p.id === id)?.prefix || projects.find(p => p.id === id)?.name || 'Unknown project'

  const isEmpty = !kbLoading && completedToday.length === 0 && createdToday.length === 0 && kbToday.length === 0

  function buildPlainText() {
    const lines = [`Day Summary — ${new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}`, '']
    if (completedByProject.length) {
      lines.push(`Completed (${completedToday.length}):`)
      completedByProject.forEach(([label, items]) => items.forEach(t => lines.push(`  - [${label}] ${t.text}`)))
      lines.push('')
    }
    if (createdByProject.length) {
      lines.push(`Created (${createdToday.length}):`)
      createdByProject.forEach(([label, items]) => items.forEach(t => lines.push(`  - [${label}] ${t.text}`)))
      lines.push('')
    }
    if (kbByProject.length) {
      lines.push(`Knowledge added (${kbToday.length}):`)
      kbByProject.forEach(([label, items]) => items.forEach(k => lines.push(`  - [${label}] ${k.title}`)))
    }
    return lines.join('\n')
  }

  async function handleCopy() {
    try { await navigator.clipboard.writeText(buildPlainText()) } catch { /* clipboard blocked */ }
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-40"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="bg-paper rounded-2xl p-6 w-full max-w-[520px] mx-4 shadow-xl flex flex-col gap-4 max-h-[80vh]">
        <div className="flex items-center justify-between">
          <p className="text-[15px] font-semibold text-ink">Day Summary</p>
          <button onClick={onClose} className="text-mute hover:text-ink text-lg leading-none">×</button>
        </div>

        <div className="flex-1 overflow-y-auto flex flex-col gap-5 -mr-2 pr-2">
          {isEmpty ? (
            <p className="text-[13px] text-mute-2 py-6 text-center">No activity yet today.</p>
          ) : (
            <>
              {completedByProject.length > 0 && (
                <div>
                  <p className="text-[11px] font-semibold text-mute uppercase tracking-wide mb-2">Completed ({completedToday.length})</p>
                  <div className="flex flex-col gap-1">
                    {completedByProject.map(([label, items]) => items.map(t => (
                      <div key={t.id} className="flex items-baseline gap-2 text-[13px]">
                        <span className="font-mono text-[10px] text-mute-2 shrink-0">{label}</span>
                        <span className="text-ink-2 truncate">{t.text}</span>
                      </div>
                    )))}
                  </div>
                </div>
              )}

              {createdByProject.length > 0 && (
                <div>
                  <p className="text-[11px] font-semibold text-mute uppercase tracking-wide mb-2">Created ({createdToday.length})</p>
                  <div className="flex flex-col gap-1">
                    {createdByProject.map(([label, items]) => items.map(t => (
                      <div key={t.id} className="flex items-baseline gap-2 text-[13px]">
                        <span className="font-mono text-[10px] text-mute-2 shrink-0">{label}</span>
                        <span className="text-ink-2 truncate">{t.text}</span>
                      </div>
                    )))}
                  </div>
                </div>
              )}

              {kbToday.length > 0 && (
                <div>
                  <p className="text-[11px] font-semibold text-mute uppercase tracking-wide mb-2">Knowledge added ({kbToday.length})</p>
                  <div className="flex flex-col gap-1">
                    {kbToday.map(k => (
                      <div key={k.id} className="flex items-baseline gap-2 text-[13px]">
                        <span className="font-mono text-[10px] text-mute-2 shrink-0">{projectName(k.project_id)}</span>
                        <span className="text-ink-2 truncate">{k.title}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        <div className="flex gap-2 justify-end pt-1 border-t border-line-2">
          <button onClick={handleCopy} disabled={isEmpty} className="btn btn-sm disabled:opacity-40">
            {copied ? 'Copied!' : '⎘ Copy summary'}
          </button>
          <button onClick={onClose} className="px-4 py-2 text-[13px] text-mute hover:text-ink transition-colors">Close</button>
        </div>
      </div>
    </div>
  )
}
