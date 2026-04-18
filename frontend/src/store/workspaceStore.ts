import { create } from 'zustand'

export type TabKind =
  | 'dashboard'
  | 'devices'
  | 'processes'
  | 'editor'
  | 'projects'
  | 'project-files'
  | 'project-ai'
  | 'snippets'
  | 'sessions'

export interface WorkspaceTab {
  id: string
  kind: TabKind
  title: string
  path: string
  params: Record<string, string>
}

interface WorkspaceState {
  tabs: WorkspaceTab[]
  activeId: string | null

  openOrFocus: (tab: WorkspaceTab) => void
  focus: (id: string) => void
  close: (id: string) => string | null
  renameTab: (id: string, title: string) => void
  reorderTabs: (ids: string[]) => void
}

const TABS_LS_KEY = 'frida-ide:workspace-tabs'
const ACTIVE_LS_KEY = 'frida-ide:workspace-active'

function persist(state: Pick<WorkspaceState, 'tabs' | 'activeId'>) {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(TABS_LS_KEY, JSON.stringify(state.tabs))
    if (state.activeId) localStorage.setItem(ACTIVE_LS_KEY, state.activeId)
    else localStorage.removeItem(ACTIVE_LS_KEY)
  } catch {
    /* quota — ignore */
  }
}

function load(): { tabs: WorkspaceTab[]; activeId: string | null } | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = localStorage.getItem(TABS_LS_KEY)
    const activeId = localStorage.getItem(ACTIVE_LS_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as WorkspaceTab[]
    if (!Array.isArray(parsed) || parsed.length === 0) return null
    const valid = parsed.filter(
      (t) =>
        t &&
        typeof t.id === 'string' &&
        typeof t.kind === 'string' &&
        typeof t.path === 'string'
    )
    if (valid.length === 0) return null
    const activeIdResolved = valid.find((t) => t.id === activeId)?.id ?? valid[0].id
    return { tabs: valid, activeId: activeIdResolved }
  } catch {
    return null
  }
}

const DEFAULT_TAB: WorkspaceTab = {
  id: 'dashboard',
  kind: 'dashboard',
  title: 'Dashboard',
  path: '/',
  params: {},
}

const initial = load() ?? { tabs: [DEFAULT_TAB], activeId: DEFAULT_TAB.id }

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  tabs: initial.tabs,
  activeId: initial.activeId,

  openOrFocus: (tab) => {
    set((state) => {
      const existing = state.tabs.find((t) => t.id === tab.id)
      if (existing) {
        // Refresh the stored path/params so subsequent tab-strip clicks
        // return the user to the exact URL they last saw.
        const tabs = state.tabs.map((t) =>
          t.id === tab.id
            ? { ...t, path: tab.path, params: tab.params, title: tab.title }
            : t
        )
        if (state.activeId === tab.id) {
          persist({ tabs, activeId: state.activeId })
          return { tabs }
        }
        persist({ tabs, activeId: tab.id })
        return { tabs, activeId: tab.id }
      }
      const tabs = [...state.tabs, tab]
      persist({ tabs, activeId: tab.id })
      return { tabs, activeId: tab.id }
    })
  },

  focus: (id) => {
    set((state) => {
      if (state.activeId === id) return state
      if (!state.tabs.find((t) => t.id === id)) return state
      persist({ tabs: state.tabs, activeId: id })
      return { activeId: id }
    })
  },

  close: (id) => {
    const state = get()
    const idx = state.tabs.findIndex((t) => t.id === id)
    if (idx === -1) return state.activeId
    const tabs = state.tabs.filter((t) => t.id !== id)
    // Always keep the dashboard as a fallback. If the user closed the last
    // tab, reopen the dashboard so the workspace is never empty.
    if (tabs.length === 0) tabs.push(DEFAULT_TAB)
    let activeId = state.activeId
    if (activeId === id) {
      const neighbour = tabs[Math.max(0, idx - 1)] ?? tabs[0]
      activeId = neighbour?.id ?? null
    }
    persist({ tabs, activeId })
    set({ tabs, activeId })
    return activeId
  },

  renameTab: (id, title) => {
    set((state) => {
      const tabs = state.tabs.map((t) => (t.id === id ? { ...t, title } : t))
      persist({ tabs, activeId: state.activeId })
      return { tabs }
    })
  },

  reorderTabs: (ids) => {
    set((state) => {
      const byId = new Map(state.tabs.map((t) => [t.id, t]))
      const reordered: WorkspaceTab[] = []
      for (const id of ids) {
        const t = byId.get(id)
        if (t) {
          reordered.push(t)
          byId.delete(id)
        }
      }
      // Append any tab that wasn't in the reorder list so we never lose one
      for (const t of byId.values()) reordered.push(t)
      persist({ tabs: reordered, activeId: state.activeId })
      return { tabs: reordered }
    })
  },
}))

/**
 * Map a browser pathname onto a workspace tab spec. Returns null for
 * unknown paths — callers should leave the current active tab in place
 * in that case so unrelated routes (404, asset URLs) don't yank the user.
 */
export function resolveTabFromPath(pathname: string): WorkspaceTab | null {
  if (pathname === '/' || pathname === '') {
    return { ...DEFAULT_TAB }
  }
  if (pathname === '/devices') {
    return {
      id: 'devices',
      kind: 'devices',
      title: 'Devices',
      path: '/devices',
      params: {},
    }
  }
  const pm = pathname.match(/^\/devices\/([^/]+)\/processes$/)
  if (pm) {
    const serial = decodeURIComponent(pm[1])
    return {
      id: `processes:${serial}`,
      kind: 'processes',
      title: `Processes · ${serial}`,
      path: pathname,
      params: { serial },
    }
  }
  if (pathname === '/editor') {
    return {
      id: 'editor',
      kind: 'editor',
      title: 'Editor',
      path: '/editor',
      params: {},
    }
  }
  const em = pathname.match(/^\/editor\/(\d+)$/)
  if (em) {
    return {
      id: 'editor',
      kind: 'editor',
      title: `Editor · run ${em[1]}`,
      path: pathname,
      params: { runSessionId: em[1] },
    }
  }
  if (pathname === '/projects') {
    return {
      id: 'projects',
      kind: 'projects',
      title: 'Projects',
      path: '/projects',
      params: {},
    }
  }
  const pf = pathname.match(/^\/projects\/(\d+)\/files$/)
  if (pf) {
    return {
      id: `project-files:${pf[1]}`,
      kind: 'project-files',
      title: `Files · #${pf[1]}`,
      path: pathname,
      params: { projectId: pf[1] },
    }
  }
  const pa = pathname.match(/^\/projects\/(\d+)\/ai$/)
  if (pa) {
    return {
      id: `project-ai:${pa[1]}`,
      kind: 'project-ai',
      title: `AI · #${pa[1]}`,
      path: pathname,
      params: { projectId: pa[1] },
    }
  }
  if (pathname === '/snippets') {
    return {
      id: 'snippets',
      kind: 'snippets',
      title: 'Snippets',
      path: '/snippets',
      params: {},
    }
  }
  if (pathname === '/sessions') {
    return {
      id: 'sessions',
      kind: 'sessions',
      title: 'Sessions',
      path: '/sessions',
      params: {},
    }
  }
  return null
}
