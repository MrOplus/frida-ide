import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Clock,
  Smartphone,
  Hash,
  Trash2,
  Download,
  AlertCircle,
  CheckCircle2,
  Loader2,
} from 'lucide-react'

import { api, type SessionSummary, type SessionEvent } from '@/lib/api'
import { cn } from '@/lib/utils'

export function SessionsRoute() {
  const qc = useQueryClient()
  const sessionsQuery = useQuery({
    queryKey: ['sessions'],
    queryFn: () => api.sessions(100),
    refetchInterval: 5_000,
  })

  const [selectedId, setSelectedId] = useState<number | null>(null)

  const eventsQuery = useQuery({
    queryKey: ['sessionEvents', selectedId],
    queryFn: () => api.sessionEvents(selectedId!, 0, 500),
    enabled: selectedId != null,
  })

  const del = useMutation({
    mutationFn: (id: number) => api.deleteSession(id),
    onSuccess: (_, id) => {
      qc.invalidateQueries({ queryKey: ['sessions'] })
      if (selectedId === id) setSelectedId(null)
    },
  })

  const delAll = useMutation({
    mutationFn: () => api.deleteAllSessions(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sessions'] })
      setSelectedId(null)
    },
  })

  const sessions = sessionsQuery.data ?? []

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border bg-bg-elevated px-4 py-3">
        <h1 className="text-lg font-semibold text-fg-strong">Sessions</h1>
        <div className="flex items-center gap-3">
          <span className="text-xs text-fg-muted">{sessions.length} recorded</span>
          {sessions.length > 0 && (
            <button
              onClick={() => {
                if (confirm(`Delete all ${sessions.length} sessions and their events?`))
                  delAll.mutate()
              }}
              disabled={delAll.isPending}
              className="flex items-center gap-1.5 rounded-md border border-danger/40 bg-danger/10 px-2 py-1 text-xs text-danger hover:bg-danger/20 disabled:opacity-50"
            >
              {delAll.isPending ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Trash2 className="h-3 w-3" />
              )}
              Clear all
            </button>
          )}
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* Sessions list */}
        <aside className="flex w-96 shrink-0 flex-col border-r border-border bg-bg-elevated overflow-auto">
          {sessions.length === 0 && !sessionsQuery.isLoading && (
            <div className="p-6 text-center text-sm text-fg-muted">
              No sessions yet. Run a script to record one.
            </div>
          )}
          {sessions.map((session) => (
            <SessionRow
              key={session.id}
              session={session}
              active={selectedId === session.id}
              onClick={() => setSelectedId(session.id)}
              onDelete={() => {
                if (confirm(`Delete session #${session.id}?`)) del.mutate(session.id)
              }}
            />
          ))}
        </aside>

        {/* Detail */}
        <div className="flex flex-1 flex-col overflow-hidden">
          {selectedId != null ? (
            <>
              <div className="flex items-center justify-between border-b border-border bg-bg-elevated px-4 py-2">
                <div className="text-sm font-mono text-fg-strong">
                  Session #{selectedId}
                </div>
                <a
                  href={api.exportSessionUrl(selectedId)}
                  download
                  className="flex items-center gap-1.5 rounded-md bg-bg-hover px-2 py-1 text-xs text-fg hover:bg-bg-hover/80"
                >
                  <Download className="h-3 w-3" />
                  Export JSON
                </a>
              </div>
              <div className="flex-1 overflow-auto">
                {eventsQuery.isLoading && (
                  <div className="p-6 text-center text-fg-muted">
                    <Loader2 className="mx-auto h-5 w-5 animate-spin" />
                  </div>
                )}
                {eventsQuery.data && (
                  <table className="w-full text-xs">
                    <thead className="sticky top-0 bg-bg-elevated text-left text-[11px] font-medium uppercase text-fg-muted">
                      <tr>
                        <th className="px-3 py-2 w-32">Time</th>
                        <th className="px-3 py-2 w-20">Kind</th>
                        <th className="px-3 py-2">Payload</th>
                      </tr>
                    </thead>
                    <tbody>
                      {eventsQuery.data.events.map((e) => (
                        <EventRow key={e.id} event={e} />
                      ))}
                      {eventsQuery.data.events.length === 0 && (
                        <tr>
                          <td colSpan={3} className="px-3 py-6 text-center text-fg-muted">
                            No events recorded for this session.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                )}
              </div>
            </>
          ) : (
            <div className="flex h-full items-center justify-center p-8 text-center text-sm text-fg-muted">
              Select a session on the left to view its recorded events.
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function SessionRow({
  session,
  active,
  onClick,
  onDelete,
}: {
  session: SessionSummary
  active: boolean
  onClick: () => void
  onDelete: () => void
}) {
  const isRunning = session.status === 'running'
  const isError = session.status === 'error'

  return (
    <div
      className={cn(
        'border-b border-border/50 px-3 py-2 cursor-pointer',
        active ? 'bg-accent-muted/15' : 'hover:bg-bg-hover'
      )}
      onClick={onClick}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-sm">
            {isRunning ? (
              <Loader2 className="h-3 w-3 animate-spin text-warning" />
            ) : isError ? (
              <AlertCircle className="h-3 w-3 text-danger" />
            ) : (
              <CheckCircle2 className="h-3 w-3 text-success" />
            )}
            <span className="font-medium text-fg-strong">#{session.id}</span>
            <span className="font-mono text-xs text-fg-muted">{session.mode}</span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-fg-muted">
            <span className="flex items-center gap-1">
              <Smartphone className="h-2.5 w-2.5" />
              {session.device_serial}
            </span>
            <span className="flex items-center gap-1">
              <Hash className="h-2.5 w-2.5" />
              pid {session.pid ?? '?'}
            </span>
            <span className="flex items-center gap-1">
              <Clock className="h-2.5 w-2.5" />
              {session.duration_ms != null
                ? `${(session.duration_ms / 1000).toFixed(1)}s`
                : '?'}
            </span>
            <span>{session.event_count} events</span>
          </div>
          {session.target_identifier && (
            <div className="mt-1 truncate font-mono text-[11px] text-fg-muted">
              {session.target_identifier}
            </div>
          )}
        </div>
        <button
          onClick={(e) => {
            e.stopPropagation()
            onDelete()
          }}
          className="rounded p-1 text-fg-muted hover:bg-bg-hover hover:text-danger"
        >
          <Trash2 className="h-3 w-3" />
        </button>
      </div>
    </div>
  )
}

function EventRow({ event }: { event: SessionEvent }) {
  const time = new Date(event.ts).toLocaleTimeString()
  const payloadStr = formatPayload(event.payload)
  const isError = event.kind === 'error'
  return (
    <tr className="border-b border-border/30 align-top">
      <td className="px-3 py-1.5 font-mono text-fg-muted">{time}</td>
      <td
        className={cn(
          'px-3 py-1.5 font-mono uppercase',
          isError ? 'text-danger' : 'text-accent'
        )}
      >
        {event.kind}
      </td>
      <td className="px-3 py-1.5 font-mono text-fg whitespace-pre-wrap break-words">
        {payloadStr}
      </td>
    </tr>
  )
}

function formatPayload(payload: unknown): string {
  if (payload == null) return ''
  if (typeof payload === 'string') return payload
  // The Frida message envelope is {type: "send", payload: <user value>}
  if (typeof payload === 'object') {
    const p = payload as { payload?: unknown; type?: string; description?: string }
    if (p.description) return p.description
    if ('payload' in p) {
      const inner = p.payload
      if (typeof inner === 'string') return inner
      try {
        return JSON.stringify(inner)
      } catch {
        return String(inner)
      }
    }
    try {
      return JSON.stringify(payload)
    } catch {
      return String(payload)
    }
  }
  return String(payload)
}
