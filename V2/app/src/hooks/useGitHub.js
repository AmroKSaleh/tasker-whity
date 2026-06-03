import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import {
  validateGitHubToken,
  saveGitHubToken,
  loadGitHubToken,
  removeGitHubToken,
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

  useEffect(() => {
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (!user) { setLoading(false); return }
      setUserId(user.id)
      setIsOAuthUser(user.app_metadata?.provider === 'github')
      loadGitHubToken(user.id).then(t => {
        setToken(t)
        setLoading(false)
      })
    })
  }, [])

  const isConnected = !!token

  const connect = useCallback(async (pat) => {
    await validateGitHubToken(pat)
    await saveGitHubToken(userId, pat)
    setToken(pat)
  }, [userId])

  const disconnect = useCallback(async () => {
    if (!userId) return
    await removeGitHubToken(userId)
    setToken(null)
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

  return { isConnected, isOAuthUser, loading, connect, disconnect, syncIssues, fetchRepos, getIssuesWithBody, importRepo }
}
