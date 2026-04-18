import { useNavigate } from 'react-router-dom'
import {
  Activity,
  Bot,
  Code2,
  Folder,
  FolderArchive,
  History,
  LayoutDashboard,
  ScrollText,
  Smartphone,
  X,
} from 'lucide-react'

import { useWorkspaceStore, type TabKind } from '@/store/workspaceStore'
import { cn } from '@/lib/utils'

const ICONS: Record<TabKind, React.ComponentType<{ className?: string }>> = {
  dashboard: LayoutDashboard,
  devices: Smartphone,
  processes: Activity,
  editor: Code2,
  projects: FolderArchive,
  'project-files': Folder,
  'project-ai': Bot,
  snippets: ScrollText,
  sessions: History,
}

/**
 * Horizontal tab strip above the main workspace. Clicking a tab navigates
 * to its stored path — the Layout's URL → workspace sync picks the change
 * up and focuses the tab. Middle-click or the X button closes it.
 */
export function TabStrip() {
  const navigate = useNavigate()
  const tabs = useWorkspaceStore((s) => s.tabs)
  const activeId = useWorkspaceStore((s) => s.activeId)
  const close = useWorkspaceStore((s) => s.close)

  const focusTab = (path: string) => {
    navigate(path)
  }

  const closeTab = (id: string) => {
    const nextActiveId = close(id)
    if (!nextActiveId) {
      navigate('/')
      return
    }
    // Read the post-close tabs to get the surviving tab's path — the
    // return value of close() is just the id, not the full tab.
    const tab = useWorkspaceStore.getState().tabs.find((t) => t.id === nextActiveId)
    navigate(tab?.path ?? '/')
  }

  if (tabs.length === 0) return null

  return (
    <div className="flex items-stretch overflow-x-auto border-b border-border bg-bg-elevated">
      {tabs.map((tab) => {
        const isActive = tab.id === activeId
        const Icon = ICONS[tab.kind]
        return (
          <div
            key={tab.id}
            onClick={() => focusTab(tab.path)}
            onMouseDown={(e) => {
              // Middle-click closes, matching browser tab UX.
              if (e.button === 1) {
                e.preventDefault()
                closeTab(tab.id)
              }
            }}
            className={cn(
              'group flex shrink-0 cursor-pointer items-center gap-1.5 border-r border-border px-3 py-1.5 text-xs transition-colors',
              isActive
                ? 'bg-bg text-fg-strong'
                : 'text-fg-muted hover:bg-bg-hover hover:text-fg'
            )}
            title={tab.path}
          >
            <Icon className="h-3.5 w-3.5" />
            <span className="max-w-[180px] truncate">{tab.title}</span>
            <button
              onClick={(e) => {
                e.stopPropagation()
                closeTab(tab.id)
              }}
              className={cn(
                'ml-1 rounded p-0.5 text-fg-muted transition-opacity hover:bg-bg-hover hover:text-fg',
                isActive ? 'opacity-70' : 'opacity-0 group-hover:opacity-70'
              )}
              title="Close tab"
              aria-label={`Close ${tab.title}`}
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        )
      })}
    </div>
  )
}
