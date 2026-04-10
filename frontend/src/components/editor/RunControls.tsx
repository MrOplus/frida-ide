import { Play, Square } from 'lucide-react'
import { cn } from '@/lib/utils'

interface Props {
  target: string
  status: 'idle' | 'starting' | 'running' | 'stopping' | 'error'
  onRun: () => void
  onStop: () => void
  errorMessage?: string | null
}

export function RunControls({ target, status, onRun, onStop, errorMessage }: Props) {
  const isRunning = status === 'running'
  const isBusy = status === 'starting' || status === 'stopping'

  return (
    <div className="flex items-center gap-3 border-b border-border bg-bg-elevated px-4 py-2">
      <div className="flex items-center gap-2">
        {!isRunning ? (
          <button
            onClick={onRun}
            disabled={isBusy || !target}
            className={cn(
              'flex items-center gap-1.5 rounded-md bg-success px-3 py-1.5 text-sm font-medium text-black hover:bg-success/90 disabled:opacity-50',
            )}
          >
            <Play className="h-3.5 w-3.5" /> Run
          </button>
        ) : (
          <button
            onClick={onStop}
            disabled={isBusy}
            className="flex items-center gap-1.5 rounded-md bg-danger px-3 py-1.5 text-sm font-medium text-fg-strong hover:bg-danger/90 disabled:opacity-50"
          >
            <Square className="h-3.5 w-3.5" /> Stop
          </button>
        )}
      </div>

      <div className="flex items-center gap-2 text-sm">
        <span className="text-fg-muted">Target:</span>
        <span className="font-mono text-fg">{target || '—'}</span>
      </div>

      <div className="ml-auto flex items-center gap-2 text-xs">
        <span
          className={cn(
            'h-2 w-2 rounded-full',
            status === 'running' && 'bg-success',
            status === 'starting' && 'bg-warning animate-pulse',
            status === 'stopping' && 'bg-warning animate-pulse',
            status === 'error' && 'bg-danger',
            status === 'idle' && 'bg-fg-muted/40',
          )}
        />
        <span className="text-fg-muted">{status}</span>
      </div>

      {errorMessage && (
        <div className="text-xs text-danger">{errorMessage}</div>
      )}
    </div>
  )
}
