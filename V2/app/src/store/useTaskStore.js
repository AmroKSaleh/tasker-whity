import { create } from 'zustand'

export const useTaskStore = create(set => ({
  tasks: [],
  sections: [],
  groups: [],
  activeProjectId: null,

  setTasks: tasks => set({ tasks }),
  setSections: sections => set({ sections }),
  setGroups: groups => set({ groups }),
  setActiveProjectId: id => set({ activeProjectId: id }),

  updateTask: (id, updates) => set(state => ({
    tasks: state.tasks.map(t => t.id === id ? { ...t, ...updates } : t),
  })),

  addTask: task => set(state =>
    state.tasks.some(t => t.id === task.id) ? state : { tasks: [...state.tasks, task] }
  ),
  addSection: section => set(state =>
    state.sections.some(s => s.id === section.id) ? state : { sections: [...state.sections, section] }
  ),
  addGroup: group => set(state =>
    state.groups.some(g => g.id === group.id) ? state : { groups: [...state.groups, group] }
  ),
  updateGroup: (id, updates) => set(state => ({
    groups: state.groups.map(g => g.id === id ? { ...g, ...updates } : g),
  })),
  updateSection: (id, updates) => set(state => ({
    sections: state.sections.map(s => s.id === id ? { ...s, ...updates } : s),
  })),

  pinTaskInStore: (taskId, pinnedAt = null) => set(state => {
    const task = state.tasks.find(t => t.id === taskId)
    const nowPinned = !task?.pinned
    return {
      tasks: state.tasks.map(t => {
        if (t.id === taskId) {
          return { ...t, pinned: nowPinned, pinned_at: nowPinned ? pinnedAt : t.pinned_at, pin_snoozed: false }
        }
        return { ...t, pinned: false }
      }),
    }
  }),

  moveTask: (taskId, sectionId, groupId) => set(state => ({
    tasks: state.tasks.map(t =>
      t.id === taskId ? { ...t, section_id: sectionId, group_id: groupId ?? null } : t
    ),
  })),

  reorderTasksInStore: (orderedTasks) => set(state => {
    const idSet = new Set(orderedTasks.map(t => t.id))
    const firstPos = state.tasks.findIndex(t => idSet.has(t.id))
    const others = state.tasks.filter(t => !idSet.has(t.id))
    return {
      tasks: [
        ...others.slice(0, firstPos),
        ...orderedTasks,
        ...others.slice(firstPos),
      ]
    }
  }),

  removeTask: id => set(state => ({ tasks: state.tasks.filter(t => t.id !== id) })),
  removeGroup: id => set(state => ({
    groups: state.groups.filter(g => g.id !== id),
    tasks: state.tasks.filter(t => t.group_id !== id),
  })),
  removeSection: id => set(state => ({
    sections: state.sections.filter(s => s.id !== id),
    groups: state.groups.filter(g => g.section_id !== id),
    tasks: state.tasks.filter(t => t.section_id !== id),
  })),
}))
