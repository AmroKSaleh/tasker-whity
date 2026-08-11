import { useMemo } from 'react'
import { useParams, Link } from 'react-router-dom'
import { marked } from 'marked'
import { NAV_APP, PAGES_APP } from '../docs/contentApp'
import { NAV_MCP, PAGES_MCP } from '../docs/contentMcp'

// Public /docs route (flow step ④). Combines the two drafting tracks into one
// nav + page map and renders the selected page's markdown.
const NAV = [...NAV_APP, ...NAV_MCP]
const PAGES = { ...PAGES_APP, ...PAGES_MCP }
const ITEMS = NAV.flatMap(s => s.items)

marked.setOptions({ gfm: true })

export default function DocsPage() {
  const params = useParams()
  const slug = params['*'] || ''
  const item = ITEMS.find(i => i.slug === slug)
  const cleanSlug = useMemo(() => slug.replace(/[^a-zA-Z0-9\-_/]/g, ''), [slug])
  const body = PAGES[slug] || (item
    ? `# ${item.title}\n\n${item.purpose}\n\n*Full content coming soon.*`
    : `# Page not found\n\nNothing lives at \`/docs/${cleanSlug}\`. [Back to the start](/docs).`)
  const html = useMemo(() => marked.parse(body), [body])

  return (
    <div className="min-h-screen bg-paper text-ink flex flex-col">
      <header className="border-b border-line-2 px-5 h-12 flex items-center gap-3 shrink-0 sticky top-0 bg-paper z-10">
        <Link to="/docs" className="flex items-center gap-2 hover:opacity-70 transition-opacity">
          <span style={{ color: '#D97757', fontWeight: 700 }}>✦</span>
          <span className="text-[14px] font-extrabold tracking-tight">Tasker Docs</span>
        </Link>
        <div className="flex-1" />
        <Link to="/home" className="font-mono text-[10px] tracking-[0.08em] uppercase text-mute hover:text-ink transition-colors">Open app →</Link>
      </header>

      <div className="flex-1 flex flex-col md:flex-row max-w-[1100px] w-full mx-auto">
        <aside className="md:w-[230px] shrink-0 md:border-r border-line-2 px-4 py-6 md:h-[calc(100vh-3rem)] md:sticky md:top-12 overflow-auto no-scrollbar">
          {NAV.map(sec => (
            <div key={sec.section} className="mb-5">
              <div className="kicker mb-2">{sec.section}</div>
              <div className="flex flex-col gap-0.5">
                {sec.items.map(it => {
                  const active = it.slug === slug
                  const href = it.slug ? `/docs/${it.slug}` : '/docs'
                  return (
                    <Link
                      key={it.slug}
                      to={href}
                      className={`text-[12.5px] px-2 py-1 rounded-md transition-colors ${active ? 'bg-surf text-ink font-semibold' : 'text-ink-2 hover:bg-surf-2'}`}
                    >
                      {it.title}
                    </Link>
                  )
                })}
              </div>
            </div>
          ))}
        </aside>

        <main className="flex-1 min-w-0 px-6 md:px-10 py-8">
          <article className="docs-prose" dangerouslySetInnerHTML={{ __html: html }} />
        </main>
      </div>
    </div>
  )
}
