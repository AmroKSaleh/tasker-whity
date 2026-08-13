export const PROVIDERS = {
  gemini: {
    label: 'Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    models: ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-pro'],
    defaultModel: 'gemini-2.5-flash',
    keyPlaceholder: 'AIza…',
    keyHint: 'aistudio.google.com',
    hasBuiltinKey: true,
  },
  claude: {
    label: 'Claude',
    baseUrl: 'https://api.anthropic.com/v1',
    models: ['claude-opus-4-7', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001'],
    defaultModel: 'claude-sonnet-4-6',
    keyPlaceholder: 'sk-ant-…',
    keyHint: 'console.anthropic.com/settings/keys',
    hasBuiltinKey: false,
    format: 'anthropic',
  },
  openai: {
    label: 'GPT-4o',
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-4o', 'gpt-4o-mini'],
    defaultModel: 'gpt-4o',
    keyPlaceholder: 'sk-…',
    keyHint: 'platform.openai.com/api-keys',
    hasBuiltinKey: false,
  },
  grok: {
    label: 'Grok',
    baseUrl: 'https://api.x.ai/v1',
    models: ['grok-3', 'grok-3-mini'],
    defaultModel: 'grok-3',
    keyPlaceholder: 'xai-…',
    keyHint: 'console.x.ai',
    hasBuiltinKey: false,
  },
  groq: {
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'mixtral-8x7b-32768'],
    defaultModel: 'llama-3.3-70b-versatile',
    keyPlaceholder: 'gsk_…',
    keyHint: 'console.groq.com/keys',
    hasBuiltinKey: false,
  },
  custom: {
    label: 'Custom',
    baseUrl: '',
    models: [],
    defaultModel: '',
    keyPlaceholder: 'sk-… (optional)',
    keyHint: 'your provider dashboard',
    hasBuiltinKey: false,
    customEndpoint: true,
  },
}

import { supabase } from './supabase'

const STORAGE_KEY = 'tasker_ai_settings'
const DEFAULTS = { provider: 'gemini', apiKey: '', model: 'gemini-2.5-flash', apiKeys: {}, customBaseUrl: '' }

export function getAISettings() {
  try {
    const s = localStorage.getItem(STORAGE_KEY)
    const parsed = s ? { ...DEFAULTS, ...JSON.parse(s) } : { ...DEFAULTS }
    if (!parsed.apiKeys) parsed.apiKeys = {}
    // Restore active key from per-provider map if apiKey is missing
    if (!parsed.apiKey && parsed.apiKeys[parsed.provider]) {
      parsed.apiKey = parsed.apiKeys[parsed.provider]
    }
    return parsed
  } catch {
    return { ...DEFAULTS }
  }
}

export async function saveAISettings(settings) {
  const toSave = {
    ...settings,
    apiKeys: { ...settings.apiKeys, [settings.provider]: settings.apiKey },
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(toSave))
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return
  await supabase.from('user_settings').upsert({
    user_id: user.id,
    ai_provider: settings.provider,
    ai_key: settings.apiKey ?? '',
    ai_model: settings.model,
    updated_at: new Date().toISOString(),
  })
}

export async function syncSettingsFromSupabase() {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return
  const { data } = await supabase
    .from('user_settings')
    .select('ai_provider, ai_key, ai_model')
    .eq('user_id', user.id)
    .single()
  if (!data) return
  const settings = { provider: data.ai_provider, apiKey: data.ai_key, model: data.ai_model }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
}
