import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useSession } from '../auth/SessionProvider'
import AppShell from '../components/editorial/AppShell'
import { Kicker } from '../components/editorial/atoms'
import { getAISettings, saveAISettings, PROVIDERS } from '../lib/aiSettings'
import { testAIConnection } from '../lib/gemini'
import { useTheme } from '../hooks/useTheme'
import ThemeToggle from '../components/editorial/ThemeToggle'
import TaskStatusSettings from '../components/settings/TaskStatusSettings'
import ConnectorsSection from '../components/settings/ConnectorsSection'
import DefaultInstructionsSection from '../components/settings/DefaultInstructionsSection'
import WebhooksSection from '../components/settings/WebhooksSection'

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
  { id: 'codex',           label: 'Codex' },
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
  const [agentLabel, setAgentLabel] = useState('')
  const [labelSaved, setLabelSaved] = useState(false)

  useEffect(() => {
    async function check() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return
      const { data } = await supabase
        .from('user_api_keys')
        .select('id, last_used_at, key_plain, agent_label')
        .eq('user_id', user.id)
        .maybeSingle()
      setHasKey(!!data)
      setLastUsed(data?.last_used_at ?? null)
      setAgentLabel(data?.agent_label ?? '')
      if (data?.key_plain) { setNewKey(data.key_plain); onKeyChange?.(data.key_plain) }
    }
    check()
  }, [])

  // TDE-375: the human names their key so the agent's writes are attributed to a
  // trustworthy, token-derived actor (not a value the agent supplies per call).
  async function saveLabel() {
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return
    await supabase.from('user_api_keys').update({ agent_label: agentLabel.trim() || null }).eq('user_id', user.id)
    setLabelSaved(true)
    setTimeout(() => setLabelSaved(false), 2000)
  }

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
      await supabase.from('user_api_keys').insert({ user_id: user.id, key_hash: keyHash, key_plain: rawKey, agent_label: agentLabel.trim() || null })
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
        <span className="text-[12px] text-ink-2 shrink-0">Agent name</span>
        <input
          value={agentLabel}
          onChange={e => setAgentLabel(e.target.value)}
          onBlur={saveLabel}
          onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }}
          placeholder="e.g. Claude Code"
          className="flex-1 bg-transparent text-right text-[12px] text-ink outline-none placeholder:text-mute-2"
        />
        {labelSaved
          ? <span className="text-[10px] font-medium text-green-600 shrink-0">✓ saved</span>
          : <span className="text-[10px] text-mute-2 shrink-0" title="Attributes this key's writes to a name in the agent activity ledger">attributes writes</span>}
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

function CodexTab({ apiKey, onSwitchToKey }) {
  const key = apiKey || 'YOUR_API_KEY'
  return (
    <div>
      <p className="text-[12px] text-mute-2 mb-3 leading-relaxed">
        Use Tasker tools in OpenAI Codex CLI via MCP.
      </p>
      <PlatformLink href="https://github.com/openai/codex" label="github.com/openai/codex" />
      <KeyBanner apiKey={apiKey} onSwitchToKey={onSwitchToKey} />

      <p className="font-mono text-[9px] font-bold uppercase tracking-widest text-mute-2 mb-2">Setup</p>
      <Step n="1">Set your Tasker key as an environment variable:</Step>
      <CodeSnip>{`TASKER_API_KEY=${key}`}</CodeSnip>
      <Hint>Add this to your shell profile (.bashrc, .zshrc, or Windows Environment Variables) so it persists across sessions.</Hint>

      <Step n="2">Add Tasker to Codex via the CLI:</Step>
      <CodeSnip>{`codex mcp add tasker --url ${MCP_URL}`}</CodeSnip>
      <p className="text-[11px] text-mute-2 mb-3 -mt-1 leading-relaxed">Or add it manually to <span className="font-mono">~/.codex/config.toml</span>:</p>
      <CodeSnip>{`[mcp_servers.tasker]\nurl = "${MCP_URL}"\nbearer_token_env_var = "TASKER_API_KEY"`}</CodeSnip>

      <Step n="3">Restart Codex or open a new thread so the server loads.</Step>
      <Step n="4">Type <span className="font-mono text-[11px]">/mcp</span> to confirm Tasker appears in active servers.</Step>
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
  const { signOut } = useSession()
  const [settings, setSettings] = useState(getAISettings)
  const [showKey, setShowKey] = useState(false)
  const [testStatus, setTestStatus] = useState(null)
  const [saved, setSaved] = useState(false)
  const [userEmail, setUserEmail] = useState('')
  const [activeTab, setActiveTab] = useState('claude-code')
  const [taskerKey, setTaskerKey] = useState(null)
  const { preference: themePref, setPreference: setThemePref, resolved: themeResolved } = useTheme()

  useEffect(() => {
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (user) setUserEmail(user.email ?? '')
    })
  }, [])

  async function handleSignOut() {
    await signOut()
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

  function handleCustomUrlChange(e) {
    setSettings(s => ({ ...s, customBaseUrl: e.target.value }))
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
      await testAIConnection({ ...settings, customBaseUrl: settings.customBaseUrl })
      setTestStatus('ok')
    } catch (err) {
      setTestStatus({ error: err.message })
    }
  }

  const canSave = settings.provider === 'gemini' || provider.customEndpoint || !!settings.apiKey?.trim()

  const tabProps = { apiKey: taskerKey, onSwitchToKey: setActiveTab }
  const TAB_CONTENT = {
    'claude-code':    <ClaudeCodeTab apiKey={taskerKey} onKeyChange={setTaskerKey} />,
    'cursor':         <CursorTab {...tabProps} />,
    'windsurf':       <WindsurfTab {...tabProps} />,
    'roo-code':       <RooCodeTab {...tabProps} />,
    'claude-ai':      <ClaudeAiTab {...tabProps} />,
    'chatgpt':        <ChatGPTTab {...tabProps} />,
    'github-copilot': <CopilotTab {...tabProps} />,
    'codex':          <CodexTab {...tabProps} />,
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
              <div className="flex items-center gap-4">
                <ThemeToggle
                  dark={themeResolved === 'dark'}
                  onChange={next => setThemePref(next ? 'dark' : 'light')}
                />
                <span className="text-[13px] font-medium text-ink">{themeResolved === 'dark' ? 'Dark' : 'Light'}</span>
              </div>
              <p className="text-[11px] text-mute-2 mt-2">
                {themePref === 'system'
                  ? 'Following your operating system.'
                  : <>Always {themePref}. <button onClick={() => setThemePref('system')} className="text-accent hover:underline">Match system instead</button></>}
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

            {/* Endpoint URL (custom provider only) */}
            {provider.customEndpoint && (
              <section className="mb-7">
                <label className="block font-mono text-[9px] font-bold tracking-widest text-mute-2 uppercase mb-2">
                  Endpoint URL
                </label>
                <input
                  type="text"
                  value={settings.customBaseUrl || ''}
                  onChange={handleCustomUrlChange}
                  placeholder="http://localhost:11434/v1"
                  className="w-full bg-surf-2 border border-line rounded-lg px-3 py-2.5 text-[13px] text-ink outline-none focus:border-ink transition-colors placeholder:text-mute-2 font-mono"
                />
                <p className="text-[11px] text-mute-2 mt-1.5 leading-relaxed">
                  Any OpenAI-compatible base URL — Ollama, LM Studio, Azure OpenAI, OpenRouter, etc.
                </p>
              </section>
            )}

            {/* Model */}
            <section className="mb-7">
              <label className="block font-mono text-[9px] font-bold tracking-widest text-mute-2 uppercase mb-2">
                Model
              </label>
              {provider.customEndpoint ? (
                <input
                  type="text"
                  value={settings.model || ''}
                  onChange={handleModelChange}
                  placeholder="e.g. llama3, mistral, gpt-4o"
                  className="w-full bg-surf-2 border border-line rounded-lg px-3 py-2.5 text-[13px] text-ink outline-none focus:border-ink transition-colors placeholder:text-mute-2 font-mono"
                />
              ) : (
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
              )}
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

            <ConnectorsSection />

            <div className="border-t border-line-2 my-8" />

            <WebhooksSection />

            <div className="border-t border-line-2 my-8" />

            <DefaultInstructionsSection />

            <div className="border-t border-line-2 my-8" />

            {/* Task Statuses */}
            <section className="mb-7">
              <label className="block font-mono text-[9px] font-bold tracking-widest text-mute-2 uppercase mb-3">
                Task Statuses
              </label>
              <p className="text-[11px] text-mute-2 mb-4 leading-relaxed">
                Define custom statuses per project — like Blocked, In Review, or Waiting. Each maps to a base state so flows and AI still work correctly.
              </p>
              <TaskStatusSettings />
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
