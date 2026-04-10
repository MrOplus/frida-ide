import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

export function TopBar() {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['health'],
    queryFn: api.health,
    refetchInterval: 10_000,
  })

  const tools = data?.tools

  return (
    <header className="flex h-12 items-center justify-between border-b border-border bg-bg-elevated px-4">
      <div className="flex items-center gap-4">
        <ToolStatus name="adb" available={!!tools?.adb} loading={isLoading || isError} />
        <ToolStatus name="jadx" available={!!tools?.jadx} loading={isLoading || isError} />
        <ToolStatus name="apktool" available={!!tools?.apktool} loading={isLoading || isError} />
        <ToolStatus name="claude" available={!!tools?.claude} loading={isLoading || isError} />
      </div>
      <div className="text-xs text-fg-muted">
        {data?.data_dir && <span>data: {data.data_dir}</span>}
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
