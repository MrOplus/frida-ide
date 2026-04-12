import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import {
  FolderArchive,
  Activity,
  ChevronDown,
  Play,
  Zap,
  AlertCircle,
} from 'lucide-react'

import { api, type ProjectInfo, type SessionSummary } from '@/lib/api'
import { cn } from '@/lib/utils'

/**
 * Two quick-access menus for the top bar:
 *
 *   Projects  — all projects in the DB, with pipeline status chips.
 *   Sessions  — currently-running Frida run sessions (status=running).
 *
 * Both are click-to-open popovers anchored to their trigger button. They
 * close on outside click and on navigation. The triggers double as
 * at-a-glance status indicators via the count badge.
 */

function useClickOutside(
  ref: React.RefObject<HTMLElement | null>,
  onOutside: () => void,
  active: boolean
) {
  useEffect(() => {
    if (!active) return
    const handler = (e: MouseEvent) => {
      if (!ref.current) return
      if (!ref.current.contains(e.target as Node)) onOutside()
    }
    window.addEventListener('mousedown', handler)
    return () => window.removeEventListener('mousedown', handler)
  }, [ref, onOutside, active])
}

// ---------------------------------------------------------------------------
// Projects menu
// ---------------------------------------------------------------------------

export function ProjectsMenu() {
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  useClickOutside(rootRef, () => setOpen(false), open)

  const q = useQuery({
    queryKey: ['projects'],
    queryFn: () => api.projects(),
    refetchInterval: open ? 3000 : 15_000,
  })

  const projects = q.data ?? []

  const go = (id: number) => {
    setOpen(false)
    navigate(`/projects/${id}/files`)
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition-colors',
          open
            ? 'border-accent bg-accent-muted text-fg-strong'
            : 'border-border text-fg-muted hover:border-accent hover:text-fg'
        )}
        title="Projects"
      >
        <FolderArchive className="h-3.5 w-3.5" />
        Projects
        <CountBadge n={projects.length} />
        <ChevronDown className="h-3 w-3" />
      </button>

      {open && (
        <div className="absolute right-0 top-full z-40 mt-1 w-80 overflow-hidden rounded-md border border-border bg-bg-elevated shadow-lg">
          <div className="max-h-80 overflow-auto">
            {projects.length === 0 && (
              <div className="px-3 py-4 text-center text-xs text-fg-muted">
                {q.isLoading ? 'Loading…' : 'No projects yet'}
              </div>
            )}
            {projects.map((p) => (
              <ProjectRow key={p.id} p={p} onClick={() => go(p.id)} />
            ))}
          </div>
          <div className="border-t border-border px-3 py-1.5 text-right">
            <button
              onClick={() => {
                setOpen(false)
                navigate('/projects')
              }}
              className="text-xs text-fg-muted hover:text-fg"
            >
              Open Projects tab →
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function ProjectRow({ p, onClick }: { p: ProjectInfo; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex w-full items-center justify-between gap-3 border-b border-border/50 px-3 py-2 text-left hover:bg-bg-hover"
    >
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm text-fg-strong">{p.name}</div>
        {p.package_name && (
          <div className="truncate font-mono text-[11px] text-fg-muted">
            {p.package_name}
          </div>
        )}
      </div>
      <ProjectStatusBadge status={p.status} />
    </button>
  )
}

function ProjectStatusBadge({ status }: { status: string }) {
  // ``queued`` → ``apktool`` → ``jadx`` → ``done`` | ``error``
  const label = status
  const cls =
    status === 'done'
      ? 'bg-success/15 text-success'
      : status === 'error'
      ? 'bg-danger/15 text-danger'
      : 'bg-warning/15 text-warning'
  return (
    <span
      className={cn(
        'shrink-0 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide',
        cls
      )}
    >
      {label}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Active run-sessions menu
// ---------------------------------------------------------------------------

export function SessionsMenu() {
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  useClickOutside(rootRef, () => setOpen(false), open)

  const q = useQuery({
    queryKey: ['sessions', 'topbar'],
    queryFn: () => api.sessions(50),
    // Poll a bit faster while the menu is open so the list feels live
    refetchInterval: open ? 2000 : 5000,
  })

  const all = q.data ?? []
  const running = all.filter((s) => s.status === 'running')

  const go = (id: number) => {
    setOpen(false)
    navigate(`/editor/${id}`)
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition-colors',
          open
            ? 'border-accent bg-accent-muted text-fg-strong'
            : 'border-border text-fg-muted hover:border-accent hover:text-fg',
          // Pulse a subtle dot when something is actively running so the
          // chip catches the eye even when the menu is closed.
          running.length > 0 &&
            !open &&
            'border-accent/60 text-fg'
        )}
        title="Running sessions"
      >
        <span className="relative flex items-center">
          <Activity className="h-3.5 w-3.5" />
          {running.length > 0 && (
            <span className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-success animate-pulse" />
          )}
        </span>
        Sessions
        <CountBadge n={running.length} />
        <ChevronDown className="h-3 w-3" />
      </button>

      {open && (
        <div className="absolute right-0 top-full z-40 mt-1 w-96 overflow-hidden rounded-md border border-border bg-bg-elevated shadow-lg">
          <div className="border-b border-border bg-bg px-3 py-1.5 text-[10px] uppercase tracking-wide text-fg-muted">
            Running ({running.length})
          </div>
          <div className="max-h-64 overflow-auto">
            {running.length === 0 && (
              <div className="px-3 py-4 text-center text-xs text-fg-muted">
                No active runs
              </div>
            )}
            {running.map((s) => (
              <SessionRow key={s.id} s={s} onClick={() => go(s.id)} />
            ))}
          </div>
          <div className="border-t border-border px-3 py-1.5 text-right">
            <button
              onClick={() => {
                setOpen(false)
                navigate('/sessions')
              }}
              className="text-xs text-fg-muted hover:text-fg"
            >
              All sessions →
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function SessionRow({ s, onClick }: { s: SessionSummary; onClick: () => void }) {
  const ModeIcon = s.mode === 'spawn' ? Zap : Play
  const elapsed = formatElapsed(s.started_at)
  return (
    <button
      onClick={onClick}
      className="flex w-full items-center gap-3 border-b border-border/50 px-3 py-2 text-left hover:bg-bg-hover"
    >
      <ModeIcon
        className={cn(
          'h-3.5 w-3.5 shrink-0',
          s.mode === 'spawn' ? 'text-accent' : 'text-success'
        )}
      />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm text-fg-strong">
          {s.target_identifier ?? `pid ${s.pid ?? '?'}`}
        </div>
        <div className="truncate font-mono text-[11px] text-fg-muted">
          {s.device_serial} · pid {s.pid ?? '?'} · {elapsed}
        </div>
      </div>
      {s.error_message && (
        <AlertCircle className="h-3.5 w-3.5 shrink-0 text-danger" />
      )}
    </button>
  )
}

function formatElapsed(isoStart: string): string {
  const ms = Date.now() - new Date(isoStart).getTime()
  if (!Number.isFinite(ms) || ms < 0) return ''
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

// ---------------------------------------------------------------------------
// Shared count pill
// ---------------------------------------------------------------------------

function CountBadge({ n }: { n: number }) {
  if (n === 0) return null
  return (
    <span className="rounded-full bg-bg-hover px-1.5 text-[10px] font-semibold text-fg">
      {n}
    </span>
  )
}
