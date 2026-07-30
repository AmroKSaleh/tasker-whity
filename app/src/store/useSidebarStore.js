import { create } from 'zustand'

// Shared expand/collapse state for the left rail. Lives outside the component
// tree so it survives the AppShell remount that happens on route navigation —
// otherwise the rail would reset to collapsed on every page change.
// Deliberately NOT persisted: "expanded" means "the mouse is on the rail", which
// is never true on a fresh load, so it should always start collapsed on reload.
export const useSidebarStore = create(set => ({
  expanded: false,
  setExpanded: expanded => set({ expanded }),
}))
