import { create } from 'zustand'

export const useProjectStore = create(set => ({
  projects: [],
  setProjects: projects => set({ projects }),
  addProject: project => set(state => ({ projects: [...state.projects, project] })),
  updateProject: (id, updates) => set(state => ({
    projects: state.projects.map(p => p.id === id ? { ...p, ...updates } : p),
  })),
  removeProject: id => set(state => ({ projects: state.projects.filter(p => p.id !== id) })),
}))
