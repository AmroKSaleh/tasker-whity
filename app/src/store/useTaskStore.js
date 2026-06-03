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

  addTask: task => set(state => ({ tasks: [...state.tasks, task] })),
  addSection: section => set(state => ({ sections: [...state.sections, section] })),
  addGroup: group => set(state => ({ groups: [...state.groups, group] })),
  updateGroup: (id, updates) => set(state => ({
    groups: state.groups.map(g => g.id === id ? { ...g, ...updates } : g),
  })),

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
