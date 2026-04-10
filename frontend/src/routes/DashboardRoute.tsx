import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import {
  Smartphone,
  Package,
  Bot,
  History,
  Zap,
  CheckCircle2,
  Loader2,
} from 'lucide-react'

import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

export function DashboardRoute() {
  const devicesQuery = useQuery({
    queryKey: ['devices'],
    queryFn: api.devices,
    refetchInterval: 5_000,
  })

  const projectsQuery = useQuery({
    queryKey: ['projects'],
    queryFn: api.projects,
    refetchInterval: 5_000,
  })

  const sessionsQuery = useQuery({
    queryKey: ['sessions'],
    queryFn: () => api.sessions(20),
    refetchInterval: 5_000,
  })

  const usbDevices = (devicesQuery.data ?? []).filter((d) => d.type === 'usb')
  const fridaUp = usbDevices.filter((d) => d.frida_server_running).length
  const projects = projectsQuery.data ?? []
  const projectsDone = projects.filter((p) => p.status === 'done').length
  const sessions = sessionsQuery.data ?? []
  const runningSessions = sessions.filter((s) => s.status === 'running').length

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center gap-2">
        <Zap className="h-5 w-5 text-accent" strokeWidth={2.5} />
        <h1 className="text-xl font-semibold text-fg-strong">Frida IDE</h1>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          icon={Smartphone}
          label="Devices"
          value={`${fridaUp} / ${usbDevices.length}`}
          hint="frida-server up / total USB"
          to="/devices"
        />
        <StatCard
          icon={Package}
          label="Projects"
          value={`${projectsDone} / ${projects.length}`}
          hint="ready / total"
          to="/projects"
        />
        <StatCard
          icon={History}
          label="Sessions"
          value={`${runningSessions} running · ${sessions.length} total`}
          hint="recordings stored"
          to="/sessions"
        />
        <StatCard
          icon={Bot}
          label="AI Chat"
          value="Per-project"
          hint="open a project to start"
          to="/projects"
        />
      </div>

      <section>
        <SectionHeader title="Devices" to="/devices" />
        <div className="grid grid-cols-1 gap-2 lg:grid-cols-2">
          {usbDevices.length === 0 && (
            <div className="rounded-md border border-border bg-bg-elevated p-4 text-sm text-fg-muted">
              No USB devices connected.
            </div>
          )}
          {usbDevices.map((d) => (
            <Link
              key={d.id}
              to={d.frida_server_running ? `/devices/${encodeURIComponent(d.id)}/processes` : '/devices'}
              className="flex items-center gap-3 rounded-md border border-border bg-bg-elevated p-3 hover:bg-bg-hover"
            >
              <Smartphone className="h-4 w-4 text-accent" />
              <div className="flex-1 min-w-0">
                <div className="truncate text-sm text-fg-strong">{d.name}</div>
                <div className="font-mono text-xs text-fg-muted">{d.id}</div>
              </div>
              <span
                className={cn(
                  'h-2 w-2 rounded-full',
                  d.frida_server_running ? 'bg-success' : 'bg-danger'
                )}
              />
            </Link>
          ))}
        </div>
      </section>

      <section>
        <SectionHeader title="Recent projects" to="/projects" />
        <div className="grid grid-cols-1 gap-2 lg:grid-cols-2">
          {projects.length === 0 && (
            <div className="rounded-md border border-border bg-bg-elevated p-4 text-sm text-fg-muted">
              No projects yet. Upload an APK on the Projects page.
            </div>
          )}
          {projects.slice(0, 6).map((p) => (
            <Link
              key={p.id}
              to={p.status === 'done' ? `/projects/${p.id}/files` : '/projects'}
              className="flex items-center gap-3 rounded-md border border-border bg-bg-elevated p-3 hover:bg-bg-hover"
            >
              <Package className="h-4 w-4 text-accent" />
              <div className="flex-1 min-w-0">
                <div className="truncate text-sm text-fg-strong">
                  {p.package_name ?? p.name}
                </div>
                <div className="text-xs text-fg-muted">
                  {p.version_name ? `v${p.version_name} · ` : ''}
                  {p.status}
                </div>
              </div>
              {p.status === 'done' ? (
                <CheckCircle2 className="h-3.5 w-3.5 text-success" />
              ) : (
                <Loader2 className="h-3.5 w-3.5 animate-spin text-warning" />
              )}
            </Link>
          ))}
        </div>
      </section>

      <section>
        <SectionHeader title="Recent recordings" to="/sessions" />
        <div className="grid grid-cols-1 gap-2 lg:grid-cols-2">
          {sessions.length === 0 && (
            <div className="rounded-md border border-border bg-bg-elevated p-4 text-sm text-fg-muted">
              No sessions yet. Run a script to record one.
            </div>
          )}
          {sessions.slice(0, 6).map((s) => (
            <Link
              key={s.id}
              to="/sessions"
              className="flex items-center gap-3 rounded-md border border-border bg-bg-elevated p-3 hover:bg-bg-hover"
            >
              <History className="h-4 w-4 text-accent" />
              <div className="flex-1 min-w-0">
                <div className="text-sm text-fg-strong">
                  #{s.id} · {s.target_identifier ?? `pid ${s.pid}`}
                </div>
                <div className="text-xs text-fg-muted">
                  {s.event_count} events ·{' '}
                  {s.duration_ms != null
                    ? `${(s.duration_ms / 1000).toFixed(1)}s`
                    : '?'}
                </div>
              </div>
              <span className="text-[11px] uppercase font-mono text-fg-muted">
                {s.status}
              </span>
            </Link>
          ))}
        </div>
      </section>
    </div>
  )
}

function StatCard({
  icon: Icon,
  label,
  value,
  hint,
  to,
}: {
  icon: typeof Smartphone
  label: string
  value: string
  hint: string
  to: string
}) {
  return (
    <Link
      to={to}
      className="rounded-md border border-border bg-bg-elevated p-4 transition-colors hover:border-accent/40"
    >
      <div className="flex items-center gap-2 text-xs uppercase text-fg-muted">
        <Icon className="h-3.5 w-3.5" />
        {label}
      </div>
      <div className="mt-2 text-xl font-semibold text-fg-strong">{value}</div>
      <div className="mt-0.5 text-xs text-fg-muted">{hint}</div>
    </Link>
  )
}

function SectionHeader({ title, to }: { title: string; to: string }) {
  return (
    <div className="mb-2 flex items-center justify-between">
      <h2 className="text-sm font-medium uppercase text-fg-muted">{title}</h2>
      <Link to={to} className="text-xs text-accent hover:underline">
        View all →
      </Link>
    </div>
  )
}
