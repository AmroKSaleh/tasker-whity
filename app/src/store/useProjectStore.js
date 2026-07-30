import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export const useProjectStore = create(
  persist(
    set => ({
      projects: [],
      setProjects: projects => set({ projects }),
      addProject: project => set(state => ({ projects: [...state.projects, project] })),
      updateProject: (id, updates) => set(state => ({
        projects: state.projects.map(p => p.id === id ? { ...p, ...updates } : p),
      })),
      reorderProjectsInStore: (orderedProjects) => set({ projects: orderedProjects }),
      removeProject: id => set(state => ({ projects: state.projects.filter(p => p.id !== id) })),
    }),
    { name: 'tasker-projects', partialize: state => ({ projects: state.projects }) }
  )
)
