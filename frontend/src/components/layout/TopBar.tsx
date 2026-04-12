import { useQuery } from '@tanstack/react-query'
import { Terminal as TerminalIcon } from 'lucide-react'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useUiStore } from '@/store/uiStore'
import { ProjectsMenu, SessionsMenu } from './TopBarMenus'

export function TopBar() {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['health'],
    queryFn: api.health,
    refetchInterval: 10_000,
  })

  const tools = data?.tools
  const consoleOpen = useUiStore((s) => s.bottomConsoleOpen)
  const toggleConsole = useUiStore((s) => s.toggleBottomConsole)

  return (
    <header className="flex h-12 items-center justify-between border-b border-border bg-bg-elevated px-4">
      <div className="flex items-center gap-4">
        <ToolStatus name="adb" available={!!tools?.adb} loading={isLoading || isError} />
        <ToolStatus name="jadx" available={!!tools?.jadx} loading={isLoading || isError} />
        <ToolStatus name="apktool" available={!!tools?.apktool} loading={isLoading || isError} />
        <ToolStatus name="claude" available={!!tools?.claude} loading={isLoading || isError} />
      </div>
      <div className="flex items-center gap-3">
        <ProjectsMenu />
        <SessionsMenu />
        <button
          onClick={toggleConsole}
          title="Toggle shell (Ctrl/Cmd+`)"
          className={cn(
            'flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition-colors',
            consoleOpen
              ? 'border-accent bg-accent-muted text-fg-strong'
              : 'border-border text-fg-muted hover:border-accent hover:text-fg'
          )}
        >
          <TerminalIcon className="h-3.5 w-3.5" />
          Shell
        </button>
      </div>
    </header>
  )
}

function ToolStatus({
  name,
  available,
  loading,
}: {
  name: string
  available: boolean
  loading: boolean
}) {
  return (
    <div className="flex items-center gap-1.5 text-xs">
      <span
        className={cn(
          'h-2 w-2 rounded-full',
          loading
            ? 'bg-fg-muted/40'
            : available
            ? 'bg-success'
            : 'bg-danger'
        )}
      />
      <span className={cn(available ? 'text-fg' : 'text-fg-muted')}>{name}</span>
    </div>
  )
}
