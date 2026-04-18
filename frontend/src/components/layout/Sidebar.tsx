import { useNavigate } from 'react-router-dom'
import {
  LayoutDashboard,
  Smartphone,
  FolderArchive,
  ScrollText,
  History,
  Zap,
  Code2,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useWorkspaceStore, type TabKind } from '@/store/workspaceStore'

type NavItem = {
  to: string
  label: string
  icon: typeof LayoutDashboard
  kind: TabKind
}

const NAV: readonly NavItem[] = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, kind: 'dashboard' },
  { to: '/devices', label: 'Devices', icon: Smartphone, kind: 'devices' },
  { to: '/editor', label: 'Editor', icon: Code2, kind: 'editor' },
  { to: '/projects', label: 'Projects', icon: FolderArchive, kind: 'projects' },
  { to: '/snippets', label: 'Snippets', icon: ScrollText, kind: 'snippets' },
  { to: '/sessions', label: 'Sessions', icon: History, kind: 'sessions' },
] as const

export function Sidebar() {
  const navigate = useNavigate()
  const tabs = useWorkspaceStore((s) => s.tabs)
  const activeId = useWorkspaceStore((s) => s.activeId)
  const activeKind = tabs.find((t) => t.id === activeId)?.kind

  const go = (item: NavItem) => {
    // Jump back to the exact URL the tab was last at (e.g. /editor/123)
    // if it's already open, so clicking "Editor" in the sidebar after a
    // Run returns you to the live session rather than resetting.
    const existing = tabs.find((t) => t.kind === item.kind)
    navigate(existing?.path ?? item.to)
  }

  return (
    <aside className="flex w-56 flex-col border-r border-border bg-bg-elevated">
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <Zap className="h-5 w-5 text-accent" strokeWidth={2.5} />
        <span className="text-base font-semibold text-fg-strong">Frida IDE</span>
      </div>
      <nav className="flex flex-1 flex-col gap-1 p-2">
        {NAV.map((item) => {
          const isActive = activeKind === item.kind
          return (
            <button
              key={item.to}
              onClick={() => go(item)}
              className={cn(
                'flex items-center gap-3 rounded-md px-3 py-2 text-left text-sm transition-colors',
                isActive
                  ? 'bg-bg-hover text-fg-strong'
                  : 'text-fg-muted hover:bg-bg-hover hover:text-fg'
              )}
            >
              <item.icon className="h-4 w-4" />
              {item.label}
            </button>
          )
        })}
      </nav>
      <div className="border-t border-border px-4 py-2 text-xs text-fg-muted">
        v0.1.0 — M0
      </div>
    </aside>
  )
}
