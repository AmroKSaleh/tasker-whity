import { useState, useRef, useEffect } from 'react'
import { Link } from 'react-router-dom'

export default function ProjectHeader({ project, onRename, onFocus, onOpenContext, onOpenKB, onOpenIS, onExportXLSX, onExportMarkdown, onCopyTaskList, githubConnected, onSaveRepo, onSyncIssues, syncing, onAnalyzeIssues, analyzing, hasGithubTasks }) {
  const [showExport, setShowExport] = useState(false)
  const [copied, setCopied] = useState(false)
  const [repoInput, setRepoInput] = useState(project.github_repo || '')
  const [editingRepo, setEditingRepo] = useState(false)
  const repoRef = useRef(null)

  useEffect(() => {
    setRepoInput(project.github_repo || '')
  }, [project.github_repo])

  const pct = project.totalCount > 0
    ? Math.round((project.doneCount / project.totalCount) * 100)
    : 0

  function normalizeRepo(input) {
    const trimmed = input.trim().replace(/\/+$/, '')
    const match = trimmed.match(/github\.com\/([^/]+\/[^/\s]+)/)
    if (match) return match[1]
    return trimmed
  }

  function commitRepo() {
    const val = normalizeRepo(repoInput)
    setRepoInput(val)
    setEditingRepo(false)
    if (val !== (project.github_repo || '')) onSaveRepo?.(val || null)
  }

  return (
    <header className="flex flex-col gap-2 border-b border-line-2 bg-paper px-6 py-3.5 shrink-0">
      {/* Back nav */}
      <div>
        <Link
          to="/home"
          className="font-mono text-[10px] tracking-widest uppercase text-mute-2 hover:text-mute transition-colors"
        >
          ← Home
        </Link>
      </div>

      {/* Title + progress */}
      <div>
        <h1
          contentEditable
          suppressContentEditableWarning
          spellCheck={false}
          onBlur={(e) => {
            const name = e.currentTarget.textContent?.trim()
            if (name && name !== project.name) onRename?.(name)
          }}
          className="text-xl font-semibold leading-tight tracking-[-0.015em] outline-none focus:underline focus:decoration-accent focus:decoration-1 focus:underline-offset-4"
        >
          {project.name}
        </h1>
        <div className="mt-1.5 flex items-center gap-3">
          <div className="h-1 w-[160px] overflow-hidden rounded-sm bg-line-2">
            <div className="h-full rounded-sm bg-ink" style={{ width: `${pct}%` }} />
          </div>
          <span className="font-mono text-[10px] tracking-[0.04em] text-mute">
            {project.doneCount} of {project.totalCount} · {pct}%
          </span>
        </div>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2 flex-wrap">
        {/* Export dropdown */}
        <div className="relative">
          <button className="btn btn-sm" onClick={() => setShowExport(v => !v)}>
            ↓ Export
          </button>
          {showExport && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setShowExport(false)} />
              <div className="absolute left-0 top-full mt-1 z-20 bg-paper border border-line rounded-xl shadow-hero overflow-hidden min-w-[160px]">
                <button
                  onClick={() => { onExportXLSX?.(); setShowExport(false) }}
                  className="w-full flex items-center gap-2.5 px-4 py-2.5 text-[13px] text-ink hover:bg-surf-2 transition-colors text-left"
                >
                  <span className="text-[11px]">⊞</span> Export as XLSX
                </button>
                <div className="h-px bg-line-2" />
                <button
                  onClick={() => { onExportMarkdown?.(); setShowExport(false) }}
                  className="w-full flex items-center gap-2.5 px-4 py-2.5 text-[13px] text-ink hover:bg-surf-2 transition-colors text-left"
                >
                  <span className="text-[11px]">✦</span> Export for Claude (.md)
                </button>
                <div className="h-px bg-line-2" />
                <button
                  onClick={() => {
                    onCopyTaskList?.()
                    setCopied(true)
                    setTimeout(() => setCopied(false), 2000)
                    setShowExport(false)
                  }}
                  className="w-full flex items-center gap-2.5 px-4 py-2.5 text-[13px] text-ink hover:bg-surf-2 transition-colors text-left"
                >
                  <span className="text-[11px]">⎘</span> {copied ? 'Copied!' : 'Copy task list'}
                </button>
              </div>
            </>
          )}
        </div>

        <button className="btn btn-sm" onClick={onOpenContext}>
          ✦ Foundation
        </button>
        <button className="btn btn-sm" onClick={onOpenKB}>
          KB
        </button>
        <button className="btn btn-sm" onClick={onOpenIS}>
          IS
        </button>
        <button className="btn-focus btn-sm" onClick={onFocus}>
          Focus
        </button>

        {/* GitHub repo + sync — only when GitHub is connected */}
        {githubConnected && (
          <div className="flex items-center gap-1.5 ml-auto">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" className="text-mute shrink-0">
              <path d="M12 2C6.477 2 2 6.477 2 12c0 4.418 2.865 8.167 6.839 9.49.5.092.682-.217.682-.482 0-.237-.009-.868-.013-1.703-2.782.604-3.369-1.34-3.369-1.34-.454-1.156-1.11-1.463-1.11-1.463-.908-.62.069-.608.069-.608 1.003.07 1.531 1.03 1.531 1.03.892 1.529 2.341 1.087 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.11-4.555-4.943 0-1.091.39-1.984 1.029-2.683-.103-.253-.446-1.27.098-2.647 0 0 .84-.268 2.75 1.026A9.578 9.578 0 0112 6.836c.85.004 1.705.114 2.504.337 1.909-1.294 2.747-1.026 2.747-1.026.546 1.377.202 2.394.1 2.647.64.699 1.028 1.592 1.028 2.683 0 3.842-2.339 4.687-4.566 4.935.359.309.678.919.678 1.852 0 1.336-.012 2.415-.012 2.743 0 .267.18.578.688.48C19.138 20.163 22 16.418 22 12c0-5.523-4.477-10-10-10z"/>
            </svg>
            {editingRepo ? (
              <input
                ref={repoRef}
                autoFocus
                value={repoInput}
                onChange={e => setRepoInput(e.target.value)}
                onBlur={commitRepo}
                onKeyDown={e => { if (e.key === 'Enter') commitRepo(); if (e.key === 'Escape') { setRepoInput(project.github_repo || ''); setEditingRepo(false) } }}
                placeholder="owner/repo"
                className="font-mono text-[11px] text-ink bg-surf-2 border border-line rounded px-2 py-0.5 outline-none focus:border-ink w-40"
              />
            ) : (
              <button
                onClick={() => setEditingRepo(true)}
                className="font-mono text-[11px] text-mute hover:text-ink transition-colors"
              >
                {project.github_repo || 'Link repo…'}
              </button>
            )}
            {project.github_repo && (
              <button
                onClick={onSyncIssues}
                disabled={syncing}
                className="btn btn-sm disabled:opacity-40"
              >
                {syncing ? 'Syncing…' : '↓ Sync Issues'}
              </button>
            )}
            {project.github_repo && hasGithubTasks && (
              <button
                onClick={onAnalyzeIssues}
                disabled={analyzing}
                className="btn btn-sm disabled:opacity-40"
              >
                {analyzing ? 'Analyzing…' : '✦ Analyze'}
              </button>
            )}
          </div>
        )}
      </div>
    </header>
  )
}
