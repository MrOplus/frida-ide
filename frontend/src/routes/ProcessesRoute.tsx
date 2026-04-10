import { useState, useMemo } from 'react'
import { useNavigate, useParams, Link } from 'react-router-dom'
import { useQuery, useMutation } from '@tanstack/react-query'
import { ChevronLeft, Search, Play, Zap, AlertCircle } from 'lucide-react'

import { api } from '@/lib/api'
import { useEditorStore } from '@/store/editorStore'

type Tab = 'apps' | 'processes'

export function ProcessesRoute() {
  const { serial = '' } = useParams<{ serial: string }>()
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
