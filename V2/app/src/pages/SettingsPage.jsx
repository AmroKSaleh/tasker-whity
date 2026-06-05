import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import AppShell from '../components/editorial/AppShell'
import { Kicker } from '../components/editorial/atoms'
import { getAISettings, saveAISettings, PROVIDERS } from '../lib/aiSettings'
import { testAIConnection } from '../lib/gemini'
import { useGoogleCalendar } from '../hooks/useGoogleCalendar'
import { useGitHub } from '../hooks/useGitHub'
import { useTheme } from '../hooks/useTheme'

const THEME_OPTIONS = [
  { id: 'light',  label: 'Light' },
  { id: 'dark',   label: 'Dark' },
  { id: 'system', label: 'System' },
]

const PROVIDER_KEYS = Object.keys(PROVIDERS)
const MCP_URL = 'https://smarttasksxdd.netlify.app/api/mcp'

const PLATFORMS = [
  { id: 'claude-code',     label: 'Claude Code' },
  { id: 'cursor',          label: 'Cursor' },
  { id: 'windsurf',        label: 'Windsurf' },
  { id: 'roo-code',        label: 'Roo Code' },
  { id: 'claude-ai',       label: 'Claude.ai' },
  { id: 'chatgpt',         label: 'ChatGPT' },
  { id: 'github-copilot',  label: 'Copilot' },
  { id: 'zed',             label: 'Zed',    soon: true },
  { id: 'gemini',          label: 'Gemini', soon: true },
]

function timeAgo(dateStr) {
  if (!dateStr) return null
  const diff = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

// ── Small guide primitives ────────────────────────────────────
function Step({ n, children }) {
  return (
    <div className="flex gap-3 mb-3">
      <span className="shrink-0 w-5 h-5 rounded-full bg-surf-2 border border-line text-[10px] font-semibold text-mute flex items-center justify-center mt-px">{n}</span>
      <div className="text-[12px] text-ink-2 leading-relaxed flex-1">{children}</div>
    </div>
  )
}

function CodeSnip({ children }) {
  const [copied, setCopied] = useState(false)
  function copy() {
    navigator.clipboard.writeText(typeof children === 'string' ? children : String(children))
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }
  return (
    <div className="relative mt-1.5 mb-3">
      <pre className="bg-paper border border-line rounded-lg px-3 py-2.5 pr-16 text-[11px] font-mono text-ink-2 leading-relaxed whitespace-pre overflow-x-auto">{children}</pre>
      <button
        onClick={copy}
        className="absolute top-2 right-2 px-2 py-1 rounded border border-line bg-paper text-[10px] text-mute hover:text-ink hover:border-ink-2 transition-colors"
      >
        {copied ? '✓' : 'Copy'}
      </button>
    </div>
  )
}

function Hint({ children }) {
  return <p className="mt-2 text-[11px] text-mute-2 leading-relaxed">{children}</p>
}

function PlatformLink({ href, label }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1.5 px-3 py-1.5 mb-4 rounded-lg border border-line text-[11px] font-medium text-accent hover:opacity-75 transition-opacity"
    >
      ↗ {label}
    </a>
  )
}

function KeyBanner({ apiKey, onSwitchToKey }) {
  const [copied, setCopied] = useState(false)
  if (apiKey) {
    function copy() {
      navigator.clipboard.writeText(apiKey)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
    return (
      <div className="flex items-center gap-2 mb-4 px-3 py-2 rounded-lg border border-line-2 bg-surf-2">
        <span className="text-[10px] text-green-600 shrink-0">●</span>
        <span className="font-mono text-[9px] text-mute-2 shrink-0">Your key</span>
        <code className="flex-1 text-[11px] font-mono text-ink truncate">{apiKey}</code>
        <button onClick={copy} className="btn btn-sm shrink-0 text-[10px]">{copied ? '✓ Copied' : 'Copy'}</button>
      </div>
    )
  }
  return (
    <p className="text-[12px] text-mute-2 mb-4 px-3 py-2 rounded-lg border border-dashed border-line bg-surf-2">
      You need a Tasker API key for this.{' '}
      <button
        onClick={() => onSwitchToKey('claude-code')}
        className="text-accent underline underline-offset-2 hover:opacity-75 transition-opacity"
      >
        Generate one in the Claude Code tab →
      </button>
    </p>
  )
}

// ── Claude Code API key widget ────────────────────────────────
function ClaudeCodeApiKey({ onKeyChange }) {
  const [hasKey, setHasKey]       = useState(null)
  const [newKey, setNewKey]       = useState(null)
  const [copied, setCopied]       = useState(false)
  const [generating, setGenerating] = useState(false)
  const [lastUsed, setLastUsed]   = useState(undefined)
  const [mcpStatus, setMcpStatus] = useState(null)
  const [testingMCP, setTestingMCP] = useState(false)

  useEffect(() => {
    async function check() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return
      const { data } = await supabase
        .from('user_api_keys')
        .select('id, last_used_at, key_plain')
        .eq('user_id', user.id)
        .maybeSingle()
      setHasKey(!!data)
      setLastUsed(data?.last_used_at ?? null)
      if (data?.key_plain) { setNewKey(data.key_plain); onKeyChange?.(data.key_plain) }
    }
    check()
  }, [])

  async function generate() {
    setGenerating(true)
    try {
      const { data: { user } } = await supabase.auth.getUser()
      const bytes = crypto.getRandomValues(new Uint8Array(32))
      const b64 = btoa(String.fromCharCode(...bytes))
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
      const rawKey = `tsk_${b64}`
      const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(rawKey))
      const keyHash = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('')
      await supabase.from('user_api_keys').delete().eq('user_id', user.id)
      await supabase.from('user_api_keys').insert({ user_id: user.id, key_hash: keyHash, key_plain: rawKey })
      setNewKey(rawKey)
      setHasKey(true)
      setLastUsed(null)
      onKeyChange?.(rawKey)
    } finally {
      setGenerating(false)
    }
  }

  async function revoke() {
    const { data: { user } } = await supabase.auth.getUser()
    await supabase.from('user_api_keys').delete().eq('user_id', user.id)
    setHasKey(false)
    setNewKey(null)
    setLastUsed(null)
    onKeyChange?.(null)
  }

  function copy() {
    navigator.clipboard.writeText(newKey)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  async function testMCP() {
    setTestingMCP(true)
    setMcpStatus(null)
    try {
      const res = await fetch(MCP_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'initialize', id: 1 }),
      })
      setMcpStatus(res.ok ? 'ok' : 'error')
    } catch {
      setMcpStatus('error')
    } finally {
      setTestingMCP(false)
    }
  }

  if (hasKey === null) return <p className="text-[13px] text-mute mb-4">Checking…</p>

  if (newKey) return (
    <div className="mb-4 space-y-2">
      <div className="rounded-xl border border-line bg-surf-2 p-4">
        <p className="font-mono text-[9px] font-bold uppercase tracking-widest text-mute-2 mb-2">
          Your API key — kept visible here until you revoke it
        </p>
        <div className="flex gap-2 items-center mb-3">
          <code className="flex-1 bg-paper border border-line rounded-lg px-3 py-2 text-[12px] font-mono text-ink break-all select-all">
            {newKey}
          </code>
          <button onClick={copy} className="btn btn-sm shrink-0">
            {copied ? '✓ Copied' : 'Copy'}
          </button>
        </div>
        <p className="text-[11px] text-mute-2 mb-3">
          Switch to any platform tab — your key is already filled in the config snippet.
        </p>
        <div className="flex items-center gap-4">
          <button onClick={generate} disabled={generating} className="text-[11px] text-mute hover:text-ink transition-colors">
            {generating ? 'Regenerating…' : 'Regenerate key'}
          </button>
          <button onClick={revoke} className="text-[11px] text-mute hover:text-red-500 transition-colors">
            Revoke key
          </button>
        </div>
      </div>
      <div className="flex items-center gap-3 px-4 py-2.5 rounded-xl border border-line bg-surf-2">
        <span className="text-[12px] text-ink-2 flex-1">MCP server reachable?</span>
        <button onClick={testMCP} disabled={testingMCP} className="btn btn-sm text-[11px] disabled:opacity-40">
          {testingMCP ? 'Testing…' : 'Test connection'}
        </button>
        {mcpStatus && (
          <span className={`text-[11px] font-medium ${mcpStatus === 'ok' ? 'text-green-600' : 'text-red-500'}`}>
            {mcpStatus === 'ok' ? '✓ Online' : '✗ Unreachable'}
          </span>
        )}
      </div>
    </div>
  )

  if (hasKey) return (
    <div className="mb-4 space-y-2">
      <div className="flex items-center justify-between gap-3 px-4 py-3 rounded-xl border border-line bg-surf-2">
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-green-600">●</span>
          <span className="text-[13px] text-ink font-medium">API key active</span>
          {lastUsed !== undefined && (
            <span className="text-[11px] text-mute-2">
              · {lastUsed ? `last used ${timeAgo(lastUsed)}` : 'never used'}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button onClick={generate} disabled={generating} className="btn btn-sm">
            {generating ? 'Generating…' : 'Regenerate'}
          </button>
          <button onClick={revoke} className="btn btn-sm text-mute hover:text-red-500 hover:border-red-300">
            Revoke
          </button>
        </div>
      </div>
      <div className="flex items-center gap-3 px-4 py-2.5 rounded-xl border border-line bg-surf-2">
        <span className="text-[12px] text-ink-2 flex-1">MCP server reachable?</span>
        <button
          onClick={testMCP}
          disabled={testingMCP}
          className="btn btn-sm text-[11px] disabled:opacity-40"
        >
          {testingMCP ? 'Testing…' : 'Test connection'}
        </button>
        {mcpStatus && (
          <span className={`text-[11px] font-medium ${mcpStatus === 'ok' ? 'text-green-600' : 'text-red-500'}`}>
            {mcpStatus === 'ok' ? '✓ Online' : '✗ Unreachable'}
          </span>
        )}
      </div>
    </div>
  )

  return (
    <button onClick={generate} disabled={generating} className="btn disabled:opacity-40 mb-4">
      {generating ? 'Generating…' : 'Generate API key'}
    </button>
  )
}

// ── Platform tab contents ─────────────────────────────────────
function ClaudeCodeTab({ apiKey, onKeyChange }) {
  const key = apiKey || 'YOUR_API_KEY'
  return (
    <div>
      <p className="text-[12px] text-mute-2 mb-4 leading-relaxed">
        Use Tasker tools directly in the Claude Code CLI via MCP.
      </p>
      <p className="font-mono text-[9px] font-bold uppercase tracking-widest text-mute-2 mb-2">API Key</p>
      <ClaudeCodeApiKey onKeyChange={onKeyChange} />
      <p className="font-mono text-[9px] font-bold uppercase tracking-widest text-mute-2 mb-2 mt-2">Setup</p>
      <Step n="1">Add this to your <span className="font-mono text-[11px]">~/.claude/settings.json</span> under <span className="font-mono text-[11px]">mcpServers</span>:</Step>
      <CodeSnip>{`"tasker": {
  "type": "http",
  "url": "${MCP_URL}",
  "headers": { "Authorization": "Bearer ${key}" }
}`}</CodeSnip>
      <Step n="2">Restart Claude Code. Verify Tasker tools loaded with <span className="font-mono text-[11px]">/tools</span>.</Step>
    </div>
  )
}

function CursorTab({ apiKey, onSwitchToKey }) {
  const key = apiKey || 'YOUR_API_KEY'
  return (
    <div>
      <p className="text-[12px] text-mute-2 mb-3 leading-relaxed">
        Connect Tasker to Cursor's AI agent via MCP.
      </p>
      <PlatformLink href="https://cursor.com" label="cursor.com" />
      <KeyBanner apiKey={apiKey} onSwitchToKey={onSwitchToKey} />
      <Step n="1">Open Cursor → Settings (<span className="font-mono text-[11px]">Cmd/Ctrl+Shift+J</span>) → <strong>MCP</strong>.</Step>
      <Step n="2">Click <strong>Add new MCP server</strong> and paste:</Step>
      <CodeSnip>{`{
  "tasker": {
    "url": "${MCP_URL}",
    "headers": {
      "Authorization": "Bearer ${key}"
    }
  }
}`}</CodeSnip>
      <Step n="3">Save. Tasker tools appear in Composer in <strong>Agent</strong> mode.</Step>
      <Step n="4">Ask Cursor: <span className="font-mono text-[11px]">"List my projects using Tasker"</span> to verify.</Step>
    </div>
  )
}

function WindsurfTab({ apiKey, onSwitchToKey }) {
  const key = apiKey || 'YOUR_API_KEY'
  return (
    <div>
      <p className="text-[12px] text-mute-2 mb-3 leading-relaxed">
        Access Tasker tools in Windsurf's Cascade AI via MCP.
      </p>
      <PlatformLink href="https://windsurf.com" label="windsurf.com" />
      <KeyBanner apiKey={apiKey} onSwitchToKey={onSwitchToKey} />
      <Step n="1">Open or create <span className="font-mono text-[11px]">~/.codeium/windsurf/mcp_config.json</span>.</Step>
      <Step n="2">Add the Tasker server:</Step>
      <CodeSnip>{`{
  "mcpServers": {
    "tasker": {
      "serverUrl": "${MCP_URL}",
      "headers": {
        "Authorization": "Bearer ${key}"
      }
    }
  }
}`}</CodeSnip>
      <Step n="3">Restart Windsurf. Tasker tools are available in Cascade chat.</Step>
      <Step n="4">Ask Cascade: <span className="font-mono text-[11px]">"List my projects using Tasker"</span> to verify.</Step>
    </div>
  )
}

function RooCodeTab({ apiKey, onSwitchToKey }) {
  const key = apiKey || 'YOUR_API_KEY'
  return (
    <div>
      <p className="text-[12px] text-mute-2 mb-3 leading-relaxed">
        Use Tasker in VS Code with the Roo Code extension via MCP.
      </p>
      <PlatformLink href="https://github.com/RooVetGit/Roo-Code" label="github.com/RooVetGit/Roo-Code" />
      <KeyBanner apiKey={apiKey} onSwitchToKey={onSwitchToKey} />
      <Step n="1">Open VS Code → Roo Code panel → click the <strong>⚙ settings icon</strong> → <strong>Edit MCP Settings</strong>.</Step>
      <Step n="2">Add the server config:</Step>
      <CodeSnip>{`{
  "mcpServers": {
    "tasker": {
      "type": "streamableHttp",
      "url": "${MCP_URL}",
      "headers": {
        "Authorization": "Bearer ${key}"
      }
    }
  }
}`}</CodeSnip>
      <Step n="3">Save. Roo Code connects and lists Tasker tools automatically.</Step>
      <Step n="4">Ask Roo: <span className="font-mono text-[11px]">"List my projects using Tasker"</span> to verify.</Step>
    </div>
  )
}

function ClaudeAiTab({ apiKey, onSwitchToKey }) {
  const key = apiKey || 'YOUR_API_KEY'
  return (
    <div>
      <p className="text-[12px] text-mute-2 mb-3 leading-relaxed">
        Use Tasker in Claude.ai web or Claude Desktop via MCP.
      </p>

      <p className="font-mono text-[9px] font-bold uppercase tracking-widest text-mute-2 mb-2">Claude.ai (web)</p>
      <PlatformLink href="https://claude.ai/settings" label="claude.ai/settings" />
      <KeyBanner apiKey={apiKey} onSwitchToKey={onSwitchToKey} />
      <Step n="1">Go to <strong>claude.ai → Settings → Integrations</strong>.</Step>
      <Step n="2">Click <strong>Add Integration</strong> and enter the server URL:</Step>
      <CodeSnip>{MCP_URL}</CodeSnip>
      <Step n="3">When prompted, log in to Tasker to authorize the connection.</Step>
      <Hint>Claude.ai Integrations require a Pro or Team plan.</Hint>

      <div className="mt-5 border-t border-line-2 pt-4">
        <p className="font-mono text-[9px] font-bold uppercase tracking-widest text-mute-2 mb-3">Claude Desktop (app)</p>
        <Step n="1">Open Claude Desktop → Settings → Developer → <strong>Edit Config</strong>.</Step>
        <Step n="2">Add to <span className="font-mono text-[11px]">claude_desktop_config.json</span>:</Step>
        <CodeSnip>{`"mcpServers": {
  "tasker": {
    "command": "npx",
    "args": [
      "-y", "mcp-remote",
      "${MCP_URL}",
      "--header",
      "Authorization: Bearer ${key}"
    ]
  }
}`}</CodeSnip>
        <Step n="3">Restart Claude Desktop. Tasker tools appear in the tools panel.</Step>
        <Step n="4">Ask Claude: <span className="font-mono text-[11px]">"List my projects using Tasker"</span> to verify.</Step>
      </div>
    </div>
  )
}

function ChatGPTTab({ apiKey, onSwitchToKey }) {
  return (
    <div>
      <p className="text-[12px] text-mute-2 mb-3 leading-relaxed">
        Access Tasker tools in ChatGPT via MCP. Requires developer mode.
      </p>
      <PlatformLink href="https://chatgpt.com" label="chatgpt.com" />
      <KeyBanner apiKey={apiKey} onSwitchToKey={onSwitchToKey} />
      <Step n="1">Go to <strong>chatgpt.com → Settings → Builder profile</strong> and enable <strong>Developer mode</strong>.</Step>
      <Step n="2">Click your profile icon → <strong>Apps</strong> → <strong>Create new app</strong> → <strong>MCP Server</strong>.</Step>
      <Step n="3">Enter the server URL:</Step>
      <CodeSnip>{MCP_URL}</CodeSnip>
      <Step n="4">Click <strong>Connect</strong>. An OAuth window opens — log in to Tasker to authorize.</Step>
      <Step n="5">Ask ChatGPT: <span className="font-mono text-[11px]">"List my projects using Tasker"</span> to verify.</Step>
      <Hint>MCP Apps are in early access and require developer mode to be enabled first.</Hint>
    </div>
  )
}

function CopilotTab({ apiKey, onSwitchToKey }) {
  const key = apiKey || 'YOUR_API_KEY'
  return (
    <div>
      <p className="text-[12px] text-mute-2 mb-3 leading-relaxed">
        Use Tasker tools in GitHub Copilot agent mode (VS Code) via MCP.
      </p>
      <PlatformLink href="https://github.com/features/copilot" label="github.com/features/copilot" />
      <KeyBanner apiKey={apiKey} onSwitchToKey={onSwitchToKey} />
      <Step n="1">Open VS Code <span className="font-mono text-[11px]">settings.json</span> (<span className="font-mono text-[11px]">Ctrl+Shift+P</span> → <strong>Open User Settings JSON</strong>).</Step>
      <Step n="2">Add the MCP block:</Step>
      <CodeSnip>{`"mcp": {
  "servers": {
    "tasker": {
      "type": "http",
      "url": "${MCP_URL}",
      "headers": {
        "Authorization": "Bearer ${key}"
      }
    }
  }
}`}</CodeSnip>
      <Step n="3">Switch Copilot Chat to <strong>Agent</strong> mode, then click <strong>Configure tools</strong> (⊕) to verify Tasker appears.</Step>
      <Step n="4">Ask Copilot: <span className="font-mono text-[11px]">"List my projects using Tasker"</span> to verify.</Step>
      <Hint>First time: explicitly ask "Use the list_projects tool from the tasker server" if Tasker tools don't activate automatically.</Hint>
    </div>
  )
}

function ComingSoon({ label }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <p className="text-[13px] font-medium text-ink mb-1">{label}</p>
      <p className="text-[12px] text-mute-2">Integration coming soon.</p>
    </div>
  )
}

// ── Main settings page ────────────────────────────────────────
export default function SettingsPage() {
  const navigate = useNavigate()
  const [settings, setSettings] = useState(getAISettings)
  const [showKey, setShowKey] = useState(false)
  const [testStatus, setTestStatus] = useState(null)
  const [saved, setSaved] = useState(false)
  const [userEmail, setUserEmail] = useState('')
  const [activeTab, setActiveTab] = useState('claude-code')
  const [taskerKey, setTaskerKey] = useState(null)
  const { preference: themePref, setPreference: setThemePref } = useTheme()

  useEffect(() => {
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (user) setUserEmail(user.email ?? '')
    })
  }, [])

  async function handleSignOut() {
    await supabase.auth.signOut()
    navigate('/login', { replace: true })
  }

  const provider = PROVIDERS[settings.provider] ?? PROVIDERS.gemini

  function handleProviderChange(p) {
    setSettings(s => {
      const updatedKeys = { ...s.apiKeys, [s.provider]: s.apiKey }
      return { ...s, provider: p, model: PROVIDERS[p].defaultModel, apiKey: updatedKeys[p] || '', apiKeys: updatedKeys }
    })
    setTestStatus(null)
    setSaved(false)
  }

  function handleKeyChange(e) {
    const val = e.target.value
    setSettings(s => ({ ...s, apiKey: val, apiKeys: { ...s.apiKeys, [s.provider]: val } }))
    setTestStatus(null)
    setSaved(false)
  }

  function handleModelChange(e) {
    setSettings(s => ({ ...s, model: e.target.value }))
    setTestStatus(null)
    setSaved(false)
  }

  async function handleSave() {
    await saveAISettings(settings)
    setSaved(true)
    setTimeout(() => setSaved(false), 2500)
  }

  async function handleTest() {
    setTestStatus('testing')
    try {
      await testAIConnection(settings)
      setTestStatus('ok')
    } catch (err) {
      setTestStatus({ error: err.message })
    }
  }

  const { isConnected, isExpired, loading: calLoading, connect: connectCal, disconnect: disconnectCal } = useGoogleCalendar()
  const [calConnecting, setCalConnecting] = useState(false)
  const [calError, setCalError] = useState(null)

  const { isConnected: ghConnected, isOAuthUser: ghIsOAuth, loading: ghLoading, connect: connectGH, disconnect: disconnectGH } = useGitHub()
  const [ghPat, setGhPat] = useState('')
  const [ghShowKey, setGhShowKey] = useState(false)
  const [ghConnecting, setGhConnecting] = useState(false)
  const [ghError, setGhError] = useState(null)

  async function handleConnectGH() {
    if (!ghPat.trim()) return
    setGhConnecting(true)
    setGhError(null)
    try {
      await connectGH(ghPat.trim())
      setGhPat('')
    } catch (err) {
      setGhError(err.message ?? 'Invalid token. Check your PAT and try again.')
    } finally {
      setGhConnecting(false)
    }
  }

  async function handleConnectCal() {
    setCalConnecting(true)
    setCalError(null)
    try {
      await connectCal()
    } catch (err) {
      setCalError(err.message ?? 'Could not connect. Try again.')
    } finally {
      setCalConnecting(false)
    }
  }

  const canSave = settings.provider === 'gemini' || !!settings.apiKey?.trim()

  const tabProps = { apiKey: taskerKey, onSwitchToKey: setActiveTab }
  const TAB_CONTENT = {
    'claude-code':    <ClaudeCodeTab apiKey={taskerKey} onKeyChange={setTaskerKey} />,
    'cursor':         <CursorTab {...tabProps} />,
    'windsurf':       <WindsurfTab {...tabProps} />,
    'roo-code':       <RooCodeTab {...tabProps} />,
    'claude-ai':      <ClaudeAiTab {...tabProps} />,
    'chatgpt':        <ChatGPTTab {...tabProps} />,
    'github-copilot': <CopilotTab {...tabProps} />,
    'zed':            <ComingSoon label="Zed" />,
    'gemini':         <ComingSoon label="Gemini" />,
  }

  return (
    <AppShell active="settings">
      <div className="px-7 py-8 md:px-10" style={{ maxWidth: 1140 }}>
        <header className="mb-7">
          <Kicker className="mb-2">SETTINGS</Kicker>
          <h1 className="text-h1 m-0">Settings.</h1>
        </header>
        <div className="flex flex-col lg:flex-row gap-10">

          {/* ── Left column: settings ── */}
          <div className="w-full lg:w-[460px] shrink-0">

            {/* Appearance */}
            <section className="mb-7">
              <label className="block font-mono text-[9px] font-bold tracking-widest text-mute-2 uppercase mb-3">
                Appearance
              </label>
              <div className="flex gap-2 flex-wrap">
                {THEME_OPTIONS.map(opt => (
                  <button
                    key={opt.id}
                    onClick={() => setThemePref(opt.id)}
                    className={`px-4 py-2 rounded-lg text-[13px] font-medium transition-colors border ${
                      themePref === opt.id
                        ? 'bg-ink text-paper border-ink'
                        : 'bg-paper text-ink-2 border-line hover:bg-surf-2'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
              <p className="text-[11px] text-mute-2 mt-1.5">
                {themePref === 'system' ? 'Follows your operating system preference.' : `Always ${themePref}.`}
              </p>
            </section>

            <div className="border-t border-line-2 my-8" />

            {/* AI Provider */}
            <section className="mb-7">
              <label className="block font-mono text-[9px] font-bold tracking-widest text-mute-2 uppercase mb-3">
                AI Provider
              </label>
              <div className="flex gap-2 flex-wrap">
                {PROVIDER_KEYS.map(key => (
                  <button
                    key={key}
                    onClick={() => handleProviderChange(key)}
                    className={`px-4 py-2 rounded-lg text-[13px] font-medium transition-colors border ${
                      settings.provider === key
                        ? 'bg-ink text-paper border-ink'
                        : 'bg-paper text-ink-2 border-line hover:bg-surf-2'
                    }`}
                  >
                    {PROVIDERS[key].label}
                    {PROVIDERS[key].hasBuiltinKey && (
                      <span className={`ml-1.5 text-[10px] font-normal ${settings.provider === key ? 'opacity-60' : 'text-mute-2'}`}>
                        built-in
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </section>

            {/* Model */}
            <section className="mb-7">
              <label className="block font-mono text-[9px] font-bold tracking-widest text-mute-2 uppercase mb-2">
                Model
              </label>
              <select
                value={settings.model}
                onChange={handleModelChange}
                className="w-full bg-surf-2 border border-line rounded-lg px-3 py-2.5 text-[13px] text-ink outline-none focus:border-ink transition-colors appearance-none cursor-pointer"
                style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' fill='none'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%23999' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E")`, backgroundRepeat: 'no-repeat', backgroundPosition: 'right 12px center' }}
              >
                {provider.models.map(m => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            </section>

            {/* API Key */}
            <section className="mb-7">
              <label className="block font-mono text-[9px] font-bold tracking-widest text-mute-2 uppercase mb-2">
                API Key
              </label>
              <div className="flex gap-2">
                <input
                  type={showKey ? 'text' : 'password'}
                  value={settings.apiKey}
                  onChange={handleKeyChange}
                  placeholder={provider.hasBuiltinKey ? `${provider.keyPlaceholder} (optional)` : provider.keyPlaceholder}
                  className="flex-1 bg-surf-2 border border-line rounded-lg px-3 py-2.5 text-[13px] text-ink outline-none focus:border-ink transition-colors placeholder:text-mute-2 font-mono"
                />
                <button
                  onClick={() => setShowKey(v => !v)}
                  className="px-3 py-2 rounded-lg border border-line bg-surf-2 text-[11px] text-mute hover:text-ink transition-colors shrink-0"
                >
                  {showKey ? 'Hide' : 'Show'}
                </button>
              </div>
              <p className="text-[11px] text-mute-2 mt-1.5 leading-relaxed">
                {provider.hasBuiltinKey
                  ? 'Leave blank to use the built-in key. Your key takes priority.'
                  : 'Required for this provider.'
                }{' '}
                <span className="text-mute">Get yours at {provider.keyHint}</span>
              </p>
            </section>

            {/* Test + Save */}
            <div className="flex items-center gap-3 flex-wrap">
              <button
                onClick={handleTest}
                disabled={testStatus === 'testing'}
                className="px-4 py-2 rounded-lg border border-line text-[13px] text-ink hover:bg-surf-2 transition-colors disabled:opacity-40"
              >
                {testStatus === 'testing' ? 'Testing…' : 'Test connection'}
              </button>
              <button
                onClick={handleSave}
                disabled={!canSave}
                className="px-4 py-2 rounded-lg bg-ink text-paper text-[13px] font-medium disabled:opacity-40 transition-colors"
              >
                {saved ? '✓ Saved' : 'Save'}
              </button>
            </div>

            {testStatus && testStatus !== 'testing' && (
              <div className={`mt-3 text-[12px] flex items-start gap-1.5 ${testStatus === 'ok' ? 'text-green-600' : 'text-red-500'}`}>
                <span>{testStatus === 'ok' ? '✓' : '✗'}</span>
                <span>{testStatus === 'ok' ? 'Connected successfully.' : testStatus.error}</span>
              </div>
            )}
            {!canSave && (
              <p className="mt-2 text-[11px] text-amber-500">Enter an API key to use {provider.label}.</p>
            )}

            <div className="border-t border-line-2 my-8" />

            {/* Google Calendar */}
            <section className="mb-7">
              <label className="block font-mono text-[9px] font-bold tracking-widest text-mute-2 uppercase mb-3">
                Google Calendar
              </label>
              {calLoading ? (
                <p className="text-[13px] text-mute">Checking connection…</p>
              ) : isConnected ? (
                <div className="flex items-center justify-between gap-3 px-4 py-3 rounded-xl border border-line bg-surf-2">
                  <div className="flex items-center gap-2.5">
                    <span className="text-[10px] text-green-600">●</span>
                    <span className="text-[13px] text-ink font-medium">Google Calendar connected</span>
                  </div>
                  <button onClick={disconnectCal} className="text-[12px] text-mute hover:text-ink transition-colors shrink-0">
                    Disconnect
                  </button>
                </div>
              ) : isExpired ? (
                <div className="flex items-center justify-between gap-3 px-4 py-3 rounded-xl border border-line bg-surf-2">
                  <div className="flex items-center gap-2.5">
                    <span className="text-[10px] text-amber-500">●</span>
                    <span className="text-[13px] text-ink-2">Session expired</span>
                  </div>
                  <button onClick={handleConnectCal} disabled={calConnecting} className="text-[12px] text-accent font-medium hover:opacity-70 transition-opacity disabled:opacity-40 shrink-0">
                    {calConnecting ? 'Connecting…' : 'Reconnect'}
                  </button>
                </div>
              ) : (
                <button
                  onClick={handleConnectCal}
                  disabled={calConnecting}
                  className="w-full flex items-center justify-center gap-2.5 px-4 py-3 rounded-xl border border-line bg-surf-2 text-[13px] text-ink hover:bg-paper transition-colors disabled:opacity-40"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                    <rect x="3" y="4" width="18" height="18" rx="2" stroke="currentColor" strokeWidth="1.5"/>
                    <path d="M3 9h18M8 2v4M16 2v4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                  </svg>
                  {calConnecting ? 'Connecting…' : 'Connect Google Calendar'}
                </button>
              )}
              {calError && <p className="mt-2 text-[11px] text-red-500">{calError}</p>}
              <p className="text-[11px] text-mute-2 mt-2 leading-relaxed">
                Tasks with due dates sync to your Google Calendar. Calendar events appear in Today view.
              </p>
            </section>

            <div className="border-t border-line-2 my-8" />

            {/* GitHub */}
            <section className="mb-7">
              <label className="block font-mono text-[9px] font-bold tracking-widest text-mute-2 uppercase mb-3">
                GitHub
              </label>
              {ghLoading ? (
                <p className="text-[13px] text-mute">Checking connection…</p>
              ) : ghConnected ? (
                <div className="flex items-center justify-between gap-3 px-4 py-3 rounded-xl border border-line bg-surf-2">
                  <div className="flex items-center gap-2.5">
                    <span className="text-[10px] text-green-600">●</span>
                    <span className="text-[13px] text-ink font-medium">
                      {ghIsOAuth ? 'Connected via GitHub login' : 'GitHub connected'}
                    </span>
                  </div>
                  <button onClick={disconnectGH} className="text-[12px] text-mute hover:text-ink transition-colors shrink-0">
                    Disconnect
                  </button>
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  {!ghIsOAuth && (
                    <>
                      <div className="flex gap-2">
                        <input
                          type={ghShowKey ? 'text' : 'password'}
                          value={ghPat}
                          onChange={e => { setGhPat(e.target.value); setGhError(null) }}
                          placeholder="github_pat_..."
                          className="flex-1 bg-surf-2 border border-line rounded-lg px-3 py-2.5 text-[13px] text-ink outline-none focus:border-ink transition-colors placeholder:text-mute-2 font-mono"
                        />
                        <button
                          onClick={() => setGhShowKey(v => !v)}
                          className="px-3 py-2 rounded-lg border border-line bg-surf-2 text-[11px] text-mute hover:text-ink transition-colors shrink-0"
                        >
                          {ghShowKey ? 'Hide' : 'Show'}
                        </button>
                      </div>
                      <button
                        onClick={handleConnectGH}
                        disabled={ghConnecting || !ghPat.trim()}
                        className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl border border-line bg-surf-2 text-[13px] text-ink hover:bg-paper transition-colors disabled:opacity-40"
                      >
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
                          <path d="M12 2C6.477 2 2 6.477 2 12c0 4.418 2.865 8.167 6.839 9.49.5.092.682-.217.682-.482 0-.237-.009-.868-.013-1.703-2.782.604-3.369-1.34-3.369-1.34-.454-1.156-1.11-1.463-1.11-1.463-.908-.62.069-.608.069-.608 1.003.07 1.531 1.03 1.531 1.03.892 1.529 2.341 1.087 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.11-4.555-4.943 0-1.091.39-1.984 1.029-2.683-.103-.253-.446-1.27.098-2.647 0 0 .84-.268 2.75 1.026A9.578 9.578 0 0112 6.836c.85.004 1.705.114 2.504.337 1.909-1.294 2.747-1.026 2.747-1.026.546 1.377.202 2.394.1 2.647.64.699 1.028 1.592 1.028 2.683 0 3.842-2.339 4.687-4.566 4.935.359.309.678.919.678 1.852 0 1.336-.012 2.415-.012 2.743 0 .267.18.578.688.48C19.138 20.163 22 16.418 22 12c0-5.523-4.477-10-10-10z"/>
                        </svg>
                        {ghConnecting ? 'Connecting…' : 'Connect GitHub'}
                      </button>
                    </>
                  )}
                  {ghIsOAuth && (
                    <p className="text-[13px] text-mute">Sign out and sign back in with GitHub to connect automatically.</p>
                  )}
                </div>
              )}
              {ghError && <p className="mt-2 text-[11px] text-red-500">{ghError}</p>}
              {!ghIsOAuth && (
                <p className="text-[11px] text-mute-2 mt-2 leading-relaxed">
                  Connect with a Personal Access Token (PAT) with <span className="font-mono">repo</span> scope.{' '}
                  <a href="https://github.com/settings/tokens" target="_blank" rel="noopener noreferrer" className="text-accent hover:opacity-70 transition-opacity underline underline-offset-2">
                    Get your PAT here
                  </a>
                </p>
              )}
            </section>

            <div className="border-t border-line-2 my-8" />

            {/* Account */}
            <section className="mb-7">
              <label className="block font-mono text-[9px] font-bold tracking-widest text-mute-2 uppercase mb-3">
                Account
              </label>
              <div className="flex items-center justify-between gap-3 px-4 py-3 rounded-xl border border-line bg-surf-2">
                <span className="text-[13px] text-ink truncate">{userEmail}</span>
                <button
                  onClick={handleSignOut}
                  className="shrink-0 px-3 py-1.5 rounded-lg border border-line text-[12px] font-medium text-mute hover:text-red-500 hover:border-red-300 transition-colors"
                >
                  Sign out
                </button>
              </div>
            </section>

          </div>

          {/* ── Right column: integrations ── */}
          <div className="flex-1 min-w-0">
            <label className="block font-mono text-[9px] font-bold tracking-widest text-mute-2 uppercase mb-4">
              Integrations
            </label>

            <div className="flex flex-col sm:flex-row gap-0 rounded-xl border border-line overflow-hidden bg-paper">

              {/* Tab list */}
              <div className="flex sm:flex-col gap-0 overflow-x-auto sm:overflow-visible sm:w-32 shrink-0 border-b sm:border-b-0 sm:border-r border-line bg-surf-2">
                {PLATFORMS.map(p => (
                  <button
                    key={p.id}
                    onClick={() => !p.soon && setActiveTab(p.id)}
                    className={`relative shrink-0 text-left px-4 py-2.5 text-[12px] font-medium transition-colors whitespace-nowrap sm:whitespace-normal ${
                      p.soon
                        ? 'text-mute-2 cursor-default'
                        : activeTab === p.id
                          ? 'bg-paper text-ink sm:shadow-[-1px_0_0_0_theme(colors.paper)] relative z-10'
                          : 'text-ink-2 hover:text-ink hover:bg-paper/50'
                    }`}
                  >
                    {p.label}
                    {p.soon && (
                      <span className="ml-1.5 text-[9px] font-normal text-mute-2">soon</span>
                    )}
                  </button>
                ))}
              </div>

              {/* Tab content */}
              <div className="flex-1 min-w-0 p-5 overflow-y-auto" style={{ maxHeight: 600 }}>
                {TAB_CONTENT[activeTab]}
              </div>

            </div>
          </div>

        </div>
      </div>
    </AppShell>
  )
}
