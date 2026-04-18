import { useEffect } from 'react'
import { useLocation } from 'react-router-dom'

import { useWorkspaceStore, resolveTabFromPath } from '@/store/workspaceStore'
import { Sidebar } from './Sidebar'
import { TopBar } from './TopBar'
import { BottomConsole } from './BottomConsole'
import { Toaster } from './Toaster'
import { Workspace } from './Workspace'

export function Layout() {
  const location = useLocation()
  const openOrFocus = useWorkspaceStore((s) => s.openOrFocus)

  // URL is the source of truth for the active tab. Every location change
  // — from a NavLink click, navigate() call, or browser back/forward —
  // funnels through here and opens/focuses the matching tab. Tabs the
  // user explicitly opened stay mounted, so their WebSockets + scroll +
  // Monaco buffers survive the switch.
  useEffect(() => {
    const tab = resolveTabFromPath(location.pathname)
    if (tab) openOrFocus(tab)
  }, [location.pathname, openOrFocus])

  return (
    <div className="flex h-screen w-screen">
      <Sidebar />
      <div className="flex flex-1 flex-col overflow-hidden">
        <TopBar />
        <main className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <Workspace />
        </main>
        {/* Persistent pty-backed shell. Mounted once and kept alive across
            tab changes — when closed it hides via CSS but the WS + shell
            subprocess stay up. */}
        <BottomConsole />
      </div>
      {/* Fixed-position toast stack. Mounted at the outermost level so
          toasts render on top of the sidebar, console drawer, and any
          future modal. */}
      <Toaster />
    </div>
  )
}
