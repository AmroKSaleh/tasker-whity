import { useState } from 'react'
import { generateDailyBriefing } from '../../lib/gemini'

export default function DailyBriefing({ tasks }) {
  const [expanded, setExpanded] = useState(false)
  const [briefing, setBriefing] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  async function handleGenerate() {
    setLoading(true)
    setError(null)
    try {
      const text = await generateDailyBriefing(tasks)
      setBriefing(text)
    } catch {
      setError('Could not generate briefing. Check your API key and try again.')
    } finally {
      setLoading(false)
    }
  }

  async function handleExpand() {
    const next = !expanded
    setExpanded(next)
    if (next && !briefing && !loading) {
      await handleGenerate()
    }
  }

  return (
    <div className="mb-5 bg-surface-container border border-outline-variant rounded-xl overflow-hidden">
      {/* Header */}
      <button
        onClick={handleExpand}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-surface-container-high transition-colors text-left"
      >
        <div className="flex items-center gap-2">
          <span className="text-primary text-sm">✦</span>
          <span className="text-label-large font-medium text-on-surface">Daily Briefing</span>
        </div>
        <div className="flex items-center gap-2">
          {briefing && !loading && (
            <button
              onClick={e => { e.stopPropagation(); handleGenerate() }}
              className="text-label-small text-on-surface-variant hover:text-primary transition-colors px-2 py-0.5 rounded"
              title="Regenerate"
            >
              ↺
            </button>
          )}
          <span className={`text-on-surface-variant text-xs transition-transform duration-200 ${expanded ? 'rotate-90' : ''}`}>
            ▶
          </span>
        </div>
      </button>

      {/* Content */}
      {expanded && (
        <div className="px-4 pb-4 pt-1 border-t border-outline-variant">
          {loading && (
            <div className="flex items-center gap-2 py-3">
              <span className="text-primary text-sm animate-pulse">✦</span>
              <span className="text-body-small text-on-surface-variant animate-pulse">Generating your briefing…</span>
            </div>
          )}
          {error && (
            <div className="py-3">
              <p className="text-body-small text-error mb-2">{error}</p>
              <button
                onClick={handleGenerate}
                className="text-label-small text-primary hover:opacity-70 transition-opacity"
              >
                Try again
              </button>
            </div>
          )}
          {briefing && !loading && (
            <p className="text-body-medium text-on-surface leading-relaxed pt-2">{briefing}</p>
          )}
        </div>
      )}
    </div>
  )
}
