import { supabase } from './supabase'

const API = 'https://api.github.com'

async function githubFetch(token, path, options = {}) {
  const res = await fetch(`${API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(options.headers ?? {}),
    },
  })
  if (res.status === 401) {
    const err = new Error('invalid_token')
    err.status = 401
    throw err
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.message || `GitHub API ${res.status}`)
  }
  return res.json()
}

export async function validateGitHubToken(token) {
  return githubFetch(token, '/user')
}

// The connected account's handle (and email if public) — shown in Settings → Connectors.
export async function fetchGitHubAccount(token) {
  const u = await githubFetch(token, '/user')
  return { login: u.login, email: u.email ?? null }
}

export async function fetchRepoIssues(token, repo) {
  const data = await githubFetch(token, `/repos/${repo}/issues?state=open&per_page=100`)
  return data.filter(i => !i.pull_request)
}

const PRIORITY_PATTERN = /rush|urgent|critical|p0|high|important|p1|medium|p2|low|p3/

export function mapIssuePriority(labels) {
  const names = labels.map(l => l.name.toLowerCase())
  if (names.some(n => /rush|urgent|critical|p0/.test(n))) return 'rush'
  if (names.some(n => /high|important|p1/.test(n))) return 'high'
  if (names.some(n => /medium|p2/.test(n))) return 'medium'
  if (names.some(n => /low|p3/.test(n))) return 'low'
  return null
}

export function getSectionName(labels) {
  const nonPriority = labels.find(l => !PRIORITY_PATTERN.test(l.name.toLowerCase()))
  return nonPriority ? nonPriority.name : null
}

export async function fetchUserRepos(token) {
  return githubFetch(token, '/user/repos?sort=updated&per_page=100&affiliation=owner,collaborator,organization_member')
}

export async function saveGitHubToken(userId, token) {
  await supabase.from('user_settings').upsert({ user_id: userId, github_access_token: token })
}

export async function loadGitHubToken(userId) {
  const { data } = await supabase
    .from('user_settings')
    .select('github_access_token')
    .eq('user_id', userId)
    .single()
  return data?.github_access_token || null
}

export async function removeGitHubToken(userId) {
  await supabase.from('user_settings').upsert({ user_id: userId, github_access_token: null })
}

export async function fetchRepoInfo(token, repo) {
  return githubFetch(token, `/repos/${repo}`)
}

export async function fetchRepoReadme(token, repo) {
  try {
    const data = await githubFetch(token, `/repos/${repo}/readme`)
    const bytes = Uint8Array.from(atob(data.content.replace(/\n/g, '')), c => c.charCodeAt(0))
    return new TextDecoder().decode(bytes)
  } catch {
    return null
  }
}
