import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import {
  validateGitHubToken,
  fetchGitHubAccount,
  saveGitHubToken,
  loadGitHubToken,
  removeGitHubToken,
  markGitHubTokenInvalid,
  isGitHubTokenKnownInvalid,
  clearGitHubTokenInvalid,
  fetchRepoIssues,
  fetchUserRepos,
  fetchRepoInfo,
  fetchRepoReadme,
  mapIssuePriority,
  getSectionName,
} from '../lib/github'

export function useGitHub() {
  const [token, setToken] = useState(null)
  const [loading, setLoading] = useState(true)
  const [userId, setUserId] = useState(null)
  const [isOAuthUser, setIsOAuthUser] = useState(false)
  const [account, setAccount] = useState(null)   // { login, email } | null
  // TDE-865: 'unknown' until the stored token has actually been exercised against GitHub.
  const [tokenStatus, setTokenStatus] = useState('unknown')   // unknown | valid | invalid

  useEffect(() => {
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (!user) { setLoading(false); return }
      setUserId(user.id)
      setIsOAuthUser(user.app_metadata?.provider === 'github')
      loadGitHubToken(user.id).then(t => {
        setToken(t)
        setLoading(false)
        if (!t) return
        // A token we already know 401s is not probed again — that request is the console
        // noise this bug is about, and it cannot succeed until the user reconnects.
        if (isGitHubTokenKnownInvalid()) { setTokenStatus('invalid'); return }
        // The probe IS the status. Previously this resolved the account handle and swallowed
        // failures, so a dead credential still rendered as a healthy green connector.
        fetchGitHubAccount(t)
          .then(a => { setAccount(a); setTokenStatus('valid'); clearGitHubTokenInvalid() })
          .catch(err => {
            if (err?.status === 401) { markGitHubTokenInvalid(); setTokenStatus('invalid') }
            // Anything else (offline, GitHub 5xx) is not evidence the credential is bad —
            // leave it 'unknown' rather than telling the user to reconnect over a blip.
          })
      })
    })
  }, [])

  // A stored token is not a connection. Only claim connected when a probe has not disproved it.
  const isConnected = !!token && tokenStatus !== 'invalid'
  const needsReconnect = !!token && tokenStatus === 'invalid'

  const connect = useCallback(async (pat) => {
    await validateGitHubToken(pat)
    await saveGitHubToken(userId, pat)
    setToken(pat)
    setTokenStatus('valid')          // validateGitHubToken just proved it
    fetchGitHubAccount(pat).then(setAccount).catch(() => {})
  }, [userId])

  const disconnect = useCallback(async () => {
    if (!userId) return
    await removeGitHubToken(userId)
    setToken(null)
    setAccount(null)
    setTokenStatus('unknown')
  }, [userId])

  const syncIssues = useCallback(async (repo, existingIssueNumbers) => {
    if (!isConnected) return []
    const issues = await fetchRepoIssues(token, repo)
    return issues
      .filter(i => !existingIssueNumbers.includes(i.number))
      .map(i => ({
        text: i.title,
        detail: i.body ?? null,
        priority: mapIssuePriority(i.labels),
        github_issue_number: i.number,
        sectionName: getSectionName(i.labels),
      }))
  }, [token, isConnected])

  const fetchRepos = useCallback(async () => {
    if (!isConnected) return []
    return fetchUserRepos(token)
  }, [token, isConnected])

  const getIssuesWithBody = useCallback(async (repo) => {
    if (!isConnected) return []
    return fetchRepoIssues(token, repo)
  }, [token, isConnected])

  const importRepo = useCallback(async (repo) => {
    if (!isConnected) return null
    const [repoInfo, readme, rawIssues] = await Promise.all([
      fetchRepoInfo(token, repo),
      fetchRepoReadme(token, repo),
      fetchRepoIssues(token, repo),
    ])
    const issues = rawIssues.map(i => ({
      text: i.title,
      detail: i.body ? i.body.slice(0, 5000) : null,
      priority: mapIssuePriority(i.labels),
      github_issue_number: i.number,
      sectionName: getSectionName(i.labels) ?? 'Backlog',
    }))
    const sectionMap = {}
    for (const issue of issues) {
      if (!sectionMap[issue.sectionName]) sectionMap[issue.sectionName] = []
      sectionMap[issue.sectionName].push(issue)
    }
    const sections = Object.entries(sectionMap).map(([name, tasks]) => ({ name, tasks }))
    if (!sections.length) sections.push({ name: 'Backlog', tasks: [] })
    return { repoInfo, readme, sections }
  }, [token, isConnected])

  return { isConnected, needsReconnect, isOAuthUser, loading, account, connect, disconnect, syncIssues, fetchRepos, getIssuesWithBody, importRepo }
}
