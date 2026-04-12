import { Outlet } from 'react-router-dom'
import { Sidebar } from './Sidebar'
import { TopBar } from './TopBar'
import { BottomConsole } from './BottomConsole'
import { Toaster } from './Toaster'

export function Layout() {
  return (
    <div className="flex h-screen w-screen">
      <Sidebar />
      <div className="flex flex-1 flex-col overflow-hidden">
        <TopBar />
        <main className="min-h-0 flex-1 overflow-auto">
          <Outlet />
        </main>
        {/* Persistent pty-backed shell. Mounted once and kept alive across
            route changes — when closed it hides via CSS but the WS + shell
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
