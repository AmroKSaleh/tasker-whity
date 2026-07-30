import { updateProject } from './useProjects'

export function useProjectDiscussion(project) {
  const messages = project?.discussion_messages ?? []

  async function saveMessages(msgs) {
    await updateProject(project.id, { discussion_messages: msgs })
  }

  return { messages, saveMessages }
}
