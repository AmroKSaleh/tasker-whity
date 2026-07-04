import { create } from 'zustand'
import { persist } from 'zustand/middleware'

// Environments partition the user's projects (single-user; Personal / Work / Learning).
// activeEnvironmentId is mirrored to user_settings server-side so the MCP can report it;
// it is persisted here too for instant, optimistic switching that survives reload.
export const useEnvironmentStore = create(
  persist(
    set => ({
      environments: [],
      activeEnvironmentId: null,
      setEnvironments: environments => set({ environments }),
      setActiveEnvironmentId: activeEnvironmentId => set({ activeEnvironmentId }),
    }),
    { name: 'tasker-environments' }
  )
)
