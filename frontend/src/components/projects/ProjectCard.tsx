import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Package,
  Loader2,
  CheckCircle2,
  XCircle,
  Trash2,
  Folder,
  AlertCircle,
  Bot,
} from 'lucide-react'

import type { ProjectInfo } from '@/lib/api'
import { api } from '@/lib/api'
import { useStreamingWs } from '@/lib/ws'
import { cn } from '@/lib/utils'

const STATUS_COLORS: Record<string, string> = {
  queued: 'bg-fg-muted/40',
  apktool: 'bg-warning animate-pulse',
  jadx: 'bg-warning animate-pulse',
  done: 'bg-success',
  error: 'bg-danger',
}

const STATUS_LABEL: Record<string, string> = {
  queued: 'Queued',
  apktool: 'Running apktool…',
  jadx: 'Running jadx…',
  done: 'Ready',
  error: 'Error',
}

export function ProjectCard({ project }: { project: ProjectInfo }) {
  const qc = useQueryClient()
  const inProgress = project.status !== 'done' && project.status !== 'error'

  // Local copy that we can update from WS events without waiting for the next refetch
  const [liveStatus, setLiveStatus] = useState(project.status)
  const [liveError, setLiveError] = useState<string | null>(project.error_message)
  useEffect(() => {
    setLiveStatus(project.status)
    setLiveError(project.error_message)
  }, [project.status, project.error_message])

  // Stream pipeline events for in-progress projects so the UI updates instantly
  useStreamingWs({
    path: `/ws/projects/${project.id}/pipeline`,
    enabled: inProgress,
    initialLastEventId: -1,
    onMessage: (msg) => {
      const payload = (msg.payload ?? {}) as {
        stage?: string
        error_message?: string
      }
      // Server publishes both 'stage' (mid-stage progress) and the topic name
      // matches the project status enum.
      if (msg.type === 'stage') {
        if (payload.stage === 'running') return
        if (typeof payload.stage === 'string') {
          setLiveStatus(payload.stage as ProjectInfo['status'])
          if (payload.error_message) setLiveError(payload.error_message)
          if (
            payload.stage === 'done' ||
            payload.stage === 'error'
          ) {
            qc.invalidateQueries({ queryKey: ['projects'] })
          }
        }
      }
    },
  })

  const del = useMutation({
    mutationFn: () => api.deleteProject(project.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['projects'] }),
  })

  const status = liveStatus
  const statusLabel = STATUS_LABEL[status] ?? status

  return (
    <div className="rounded-md border border-border bg-bg-elevated p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3 min-w-0">
          <Package className="mt-0.5 h-5 w-5 shrink-0 text-accent" />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="truncate font-medium text-fg-strong">
                {project.package_name ?? project.name}
              </span>
              {project.version_name && (
                <span className="text-xs text-fg-muted">v{project.version_name}</span>
              )}
            </div>
            <div className="mt-0.5 truncate font-mono text-xs text-fg-muted">
              {project.sha256?.slice(0, 16)}…
            </div>
          </div>
        </div>

        <div className="flex items-center gap-1">
          {status === 'done' && (
            <>
              <Link
                to={`/projects/${project.id}/ai`}
                className="flex items-center gap-1 rounded-md bg-accent-muted px-2 py-1 text-xs text-fg-strong hover:bg-accent"
              >
                <Bot className="h-3 w-3" /> AI Chat
              </Link>
              <Link
                to={`/projects/${project.id}/files`}
                className="flex items-center gap-1 rounded-md bg-bg-hover px-2 py-1 text-xs text-fg hover:bg-bg-hover/80"
              >
                <Folder className="h-3 w-3" /> Browse
              </Link>
            </>
          )}
          <button
            onClick={() => {
              if (confirm(`Delete project "${project.name}"?`)) del.mutate()
            }}
            disabled={del.isPending || inProgress}
            className="rounded-md p-1 text-fg-muted hover:bg-bg-hover hover:text-danger disabled:opacity-30"
            title="Delete project"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <div className="mt-3 flex items-center gap-2 text-xs">
        <span className={cn('h-2 w-2 rounded-full', STATUS_COLORS[status])} />
        <span className="text-fg">{statusLabel}</span>
        {status === 'apktool' || status === 'jadx' ? (
          <Loader2 className="h-3 w-3 animate-spin text-fg-muted" />
        ) : status === 'done' ? (
          <CheckCircle2 className="h-3 w-3 text-success" />
        ) : status === 'error' ? (
          <XCircle className="h-3 w-3 text-danger" />
        ) : null}
      </div>

      {liveError && status === 'error' && (
        <div className="mt-2 flex items-start gap-1.5 rounded border border-danger/30 bg-danger/5 p-2 text-xs text-danger">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="break-all">{liveError}</span>
        </div>
      )}

      {project.permissions && project.permissions.length > 0 && status === 'done' && (
        <details className="mt-3 text-xs">
          <summary className="cursor-pointer text-fg-muted hover:text-fg">
            {project.permissions.length} permissions
          </summary>
          <div className="mt-1 max-h-32 overflow-auto rounded bg-bg p-2 font-mono text-fg">
            {project.permissions.map((p) => (
              <div key={p}>{p}</div>
            ))}
          </div>
        </details>
      )}
    </div>
  )
}

