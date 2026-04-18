import { useState, useMemo } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { useTabParams } from '@/hooks/useTabParams'
import { useQuery, useMutation } from '@tanstack/react-query'
import {
  ChevronLeft,
  Search,
  Play,
  Zap,
  AlertCircle,
  Download,
  Loader2,
  Check,
} from 'lucide-react'

import { api } from '@/lib/api'
import { useEditorStore } from '@/store/editorStore'
import { toast } from '@/store/toastStore'

type Tab = 'apps' | 'processes'

export function ProcessesRoute() {
  const { serial = '' } = useTabParams<{ serial: string }>()
  const navigate = useNavigate()
  const setPendingRunFn = useEditorStore((s) => s.setPendingRun)

  const [tab, setTab] = useState<Tab>('apps')
  const [filter, setFilter] = useState('')

  const processesQuery = useQuery({
    queryKey: ['processes', serial],
    queryFn: () => api.processes(serial),
    enabled: !!serial && tab === 'processes',
    refetchInterval: tab === 'processes' ? 3000 : false,
  })

  const appsQuery = useQuery({
    queryKey: ['apps', serial],
    queryFn: () => api.apps(serial),
    enabled: !!serial && tab === 'apps',
    refetchInterval: tab === 'apps' ? 5000 : false,
  })

  const editorSource = useEditorStore((s) => s.source)

  const runMutation = useMutation({
    mutationFn: api.runScript,
    onSuccess: (resp) => {
      navigate(`/editor/${resp.run_session_id}`)
    },
  })

  const filteredProcesses = useMemo(() => {
    const list = processesQuery.data ?? []
    const q = filter.toLowerCase().trim()
    if (!q) return list
    return list.filter(
      (p) => p.name.toLowerCase().includes(q) || String(p.pid).includes(q)
    )
  }, [processesQuery.data, filter])

  const filteredApps = useMemo(() => {
    const list = appsQuery.data ?? []
    const q = filter.toLowerCase().trim()
    if (!q) return list
    return list.filter(
      (a) =>
        a.identifier.toLowerCase().includes(q) ||
        a.name.toLowerCase().includes(q)
    )
  }, [appsQuery.data, filter])

  const spawn = (identifier: string) => {
    setPendingRunFn({ deviceSerial: serial, mode: 'spawn', targetIdentifier: identifier })
    runMutation.mutate({
      device_serial: serial,
      mode: 'spawn',
      target_identifier: identifier,
      source: editorSource,
    })
  }

  const attach = (pid: number) => {
    setPendingRunFn({ deviceSerial: serial, mode: 'attach', pid })
    runMutation.mutate({
      device_serial: serial,
      mode: 'attach',
      pid,
      source: editorSource,
    })
  }

  // Per-package pull state so each row can show its own spinner/check
  // without blocking clicks on the others.
  const [pullState, setPullState] = useState<
    Record<string, 'idle' | 'pulling' | 'done' | 'error'>
  >({})
  const [pullError, setPullError] = useState<string | null>(null)

  const openInNewProject = async (identifier: string) => {
    try {
      const proj = await api.createProjectFromPulled(serial, identifier)
      toast.success(`Project created: ${proj.name}`, {
        description: `Decompile pipeline queued · id=${proj.id}`,
      })
      navigate(`/projects/${proj.id}/files`)
    } catch (e) {
      toast.error('Failed to open as project', {
        description: (e as Error).message,
      })
    }
  }

  const pullApk = async (identifier: string) => {
    setPullState((s) => ({ ...s, [identifier]: 'pulling' }))
    setPullError(null)
    try {
      const resp = await api.pullApk(serial, identifier)
      setPullState((s) => ({ ...s, [identifier]: 'done' }))
      // Build a toast description that shows exactly where the APK(s)
      // landed. When there's one APK, show its full path; with splits,
      // show the containing directory + size summary.
      const mb = (resp.total_size / (1024 * 1024)).toFixed(1)
      const description =
        resp.apks.length === 1
          ? `${resp.apks[0].local_path} (${mb} MB)`
          : `${resp.output_dir} · ${resp.apks.length} APKs, ${mb} MB`
      toast.success(`Pulled ${identifier}`, {
        description,
        action: {
          label: 'Open in new project',
          onClick: () => openInNewProject(identifier),
        },
      })
      // Flip back to idle after a moment so the user can pull again
      window.setTimeout(
        () => setPullState((s) => ({ ...s, [identifier]: 'idle' })),
        3000
      )
    } catch (e) {
      const msg = (e as Error).message
      setPullState((s) => ({ ...s, [identifier]: 'error' }))
      setPullError(msg)
      toast.error(`Pull failed: ${identifier}`, { description: msg })
      window.setTimeout(
        () => setPullState((s) => ({ ...s, [identifier]: 'idle' })),
        4000
      )
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border bg-bg-elevated px-4 py-3">
        <div className="flex items-center gap-3">
          <Link
            to="/devices"
            className="flex items-center gap-1 text-sm text-fg-muted hover:text-fg"
          >
            <ChevronLeft className="h-4 w-4" /> Devices
          </Link>
          <span className="text-fg-muted">/</span>
          <span className="font-mono text-sm text-fg-strong">{serial}</span>
        </div>
        <div className="flex items-center gap-1 rounded-md border border-border p-0.5">
          <TabBtn active={tab === 'apps'} onClick={() => setTab('apps')}>
            Apps
          </TabBtn>
          <TabBtn active={tab === 'processes'} onClick={() => setTab('processes')}>
            Processes
          </TabBtn>
        </div>
      </div>

      <div className="border-b border-border bg-bg-elevated px-4 py-2">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-fg-muted" />
          <input
            type="text"
            placeholder={tab === 'apps' ? 'Filter apps…' : 'Filter processes…'}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="w-full rounded-md border border-border bg-bg py-1.5 pl-8 pr-3 text-sm text-fg focus:border-accent focus:outline-none"
          />
        </div>
      </div>

      {runMutation.isError && (
        <div className="flex items-center gap-2 border-b border-danger/40 bg-danger/10 px-4 py-2 text-sm text-danger">
          <AlertCircle className="h-4 w-4" />
          {(runMutation.error as Error).message}
        </div>
      )}
      {pullError && (
        <div className="flex items-center gap-2 border-b border-danger/40 bg-danger/10 px-4 py-2 text-xs text-danger">
          <AlertCircle className="h-3.5 w-3.5" />
          Pull failed: {pullError}
        </div>
      )}

      <div className="flex-1 overflow-auto">
        {tab === 'apps' ? (
          <table className="w-full">
            <thead className="sticky top-0 bg-bg-elevated text-left text-xs font-medium uppercase text-fg-muted">
              <tr>
                <th className="px-4 py-2">Name</th>
                <th className="px-4 py-2">Identifier</th>
                <th className="px-4 py-2">PID</th>
                <th className="px-4 py-2 text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {filteredApps.map((app, idx) => (
                <tr
                  key={`${app.identifier}-${app.pid ?? 'idle'}-${idx}`}
                  className="border-b border-border/50 text-sm hover:bg-bg-hover"
                >
                  <td className="px-4 py-2 text-fg-strong">
                    <div className="flex items-center gap-2">
                      {app.icon_b64 ? (
                        <img
                          src={`data:image/png;base64,${app.icon_b64}`}
                          alt=""
                          className="h-5 w-5 rounded-sm"
                        />
                      ) : (
                        <div className="h-5 w-5 rounded-sm bg-bg-hover" />
                      )}
                      <span>{app.name}</span>
                    </div>
                  </td>
                  <td className="px-4 py-2 font-mono text-xs text-fg-muted">{app.identifier}</td>
                  <td className="px-4 py-2 font-mono text-xs text-fg">{app.pid ?? '—'}</td>
                  <td className="px-4 py-2 text-right">
                    <div className="flex justify-end gap-1">
                      <PullButton
                        state={pullState[app.identifier] ?? 'idle'}
                        onClick={() => pullApk(app.identifier)}
                      />
                      <button
                        onClick={() => spawn(app.identifier)}
                        disabled={runMutation.isPending}
                        className="flex items-center gap-1 rounded bg-accent-muted px-2 py-1 text-xs text-fg-strong hover:bg-accent disabled:opacity-50"
                      >
                        <Zap className="h-3 w-3" /> Spawn
                      </button>
                      {app.pid != null && (
                        <button
                          onClick={() => attach(app.pid!)}
                          disabled={runMutation.isPending}
                          className="flex items-center gap-1 rounded bg-bg-hover px-2 py-1 text-xs text-fg hover:bg-bg-hover/80 disabled:opacity-50"
                        >
                          <Play className="h-3 w-3" /> Attach
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {appsQuery.isLoading && (
                <tr>
                  <td colSpan={4} className="px-4 py-4 text-center text-fg-muted">
                    Loading…
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        ) : (
          <table className="w-full">
            <thead className="sticky top-0 bg-bg-elevated text-left text-xs font-medium uppercase text-fg-muted">
              <tr>
                <th className="px-4 py-2 w-24">PID</th>
                <th className="px-4 py-2">Name</th>
                <th className="px-4 py-2 text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {filteredProcesses.map((p) => (
                <tr
                  key={p.pid}
                  className="border-b border-border/50 text-sm hover:bg-bg-hover"
                >
                  <td className="px-4 py-2 font-mono text-xs text-fg">{p.pid}</td>
                  <td className="px-4 py-2 text-fg-strong">
                    <div className="flex items-center gap-2">
                      {p.icon_b64 ? (
                        <img
                          src={`data:image/png;base64,${p.icon_b64}`}
                          alt=""
                          className="h-5 w-5 rounded-sm"
                        />
                      ) : null}
                      <span>{p.name}</span>
                    </div>
                  </td>
                  <td className="px-4 py-2 text-right">
                    <button
                      onClick={() => attach(p.pid)}
                      disabled={runMutation.isPending}
                      className="flex items-center gap-1 rounded bg-bg-hover px-2 py-1 text-xs text-fg hover:bg-bg-hover/80 disabled:opacity-50 ml-auto"
                    >
                      <Play className="h-3 w-3" /> Attach
                    </button>
                  </td>
                </tr>
              ))}
              {processesQuery.isLoading && (
                <tr>
                  <td colSpan={3} className="px-4 py-4 text-center text-fg-muted">
                    Loading…
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

function TabBtn({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded px-3 py-1 text-sm transition-colors ${
        active ? 'bg-bg-hover text-fg-strong' : 'text-fg-muted hover:text-fg'
      }`}
    >
      {children}
    </button>
  )
}

function PullButton({
  state,
  onClick,
}: {
  state: 'idle' | 'pulling' | 'done' | 'error'
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      disabled={state === 'pulling'}
      title="Pull APK(s) from device into ~/.frida-ide/pulled/"
      className="flex items-center gap-1 rounded bg-bg-hover px-2 py-1 text-xs text-fg hover:bg-bg-hover/80 disabled:opacity-50"
    >
      {state === 'pulling' ? (
        <Loader2 className="h-3 w-3 animate-spin" />
      ) : state === 'done' ? (
        <Check className="h-3 w-3 text-success" />
      ) : (
        <Download className="h-3 w-3" />
      )}
      Pull
    </button>
  )
}
