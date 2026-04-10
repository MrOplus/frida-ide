import { NavLink } from 'react-router-dom'
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

const NAV = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/devices', label: 'Devices', icon: Smartphone },
  { to: '/editor', label: 'Editor', icon: Code2 },
  { to: '/projects', label: 'Projects', icon: FolderArchive },
  { to: '/snippets', label: 'Snippets', icon: ScrollText },
  { to: '/sessions', label: 'Sessions', icon: History },
] as const

export function Sidebar() {
  return (
    <aside className="flex w-56 flex-col border-r border-border bg-bg-elevated">
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <Zap className="h-5 w-5 text-accent" strokeWidth={2.5} />
        <span className="text-base font-semibold text-fg-strong">Frida IDE</span>
      </div>
      <nav className="flex flex-1 flex-col gap-1 p-2">
        {NAV.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={'end' in item ? item.end : false}
            className={({ isActive }) =>
              cn(
                'flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors',
                isActive
                  ? 'bg-bg-hover text-fg-strong'
                  : 'text-fg-muted hover:bg-bg-hover hover:text-fg'
              )
            }
          >
            <item.icon className="h-4 w-4" />
            {item.label}
          </NavLink>
        ))}
      </nav>
      <div className="border-t border-border px-4 py-2 text-xs text-fg-muted">
        v0.1.0 — M0
      </div>
    </aside>
  )
}
