import { useEffect, useState, useCallback, useMemo } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Search, Zap, Play, AlertCircle, RefreshCw, Loader2 } from 'lucide-react'

import { api, type AppInfo } from '@/lib/api'
import { MonacoPane } from '@/components/editor/MonacoPane'
import { OutputConsole } from '@/components/editor/OutputConsole'
import { RunControls } from '@/components/editor/RunControls'
import { useEditorStore } from '@/store/editorStore'
import { cn } from '@/lib/utils'

type Status = 'idle' | 'starting' | 'running' | 'stopping' | 'error'

export function EditorRoute() {
  const { runSessionId: param } = useParams<{ runSessionId: string }>()
  const runSessionId = param ? parseInt(param, 10) : null

  const source = useEditorStore((s) => s.source)
  const setSource = useEditorStore((s) => s.setSource)

  return (
    <div className="flex h-full flex-col">
      {runSessionId == null ? (
        <InlineTargetPicker source={source} />
      ) : (
        <LiveEditor runSessionId={runSessionId} />
      )}
      {runSessionId == null && (
        <div className="flex flex-1 overflow-hidden">
          <div className="flex-1">
            <MonacoPane value={source} onChange={setSource} />
          </div>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Live mode: rendered when the URL has /editor/:runSessionId
// ---------------------------------------------------------------------------

function LiveEditor({ runSessionId }: { runSessionId: number }) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const source = useEditorStore((s) => s.source)
  const setSource = useEditorStore((s) => s.setSource)

  const [status, setStatus] = useState<Status>('running')
  const [errMsg, setErrMsg] = useState<string | null>(null)

  const sessionQuery = useQuery({
    queryKey: ['runSession', runSessionId],
    queryFn: () => api.getRunSession(runSessionId),
    refetchInterval: 2000,
  })

  useEffect(() => {
    const data = sessionQuery.data
    if (!data) return
    if (data.status === 'running') setStatus('running')
    else if (data.status === 'stopped') setStatus('idle')
    else if (data.status === 'error') {
      setStatus('error')
      setErrMsg(data.error_message ?? null)
    }
  }, [sessionQuery.data])

  const stopMutation = useMutation({
    mutationFn: () => api.stopScript(runSessionId),
    onMutate: () => setStatus('stopping'),
    onSuccess: () => {
      setStatus('idle')
      qc.invalidateQueries({ queryKey: ['runSession', runSessionId] })
    },
  })

  const onRun = useCallback(() => {
    // Re-run from a stopped session: drop back to the picker so the user can
    // re-target without leaving the Editor tab.
    navigate('/editor')
  }, [navigate])

  const target = sessionQuery.data
    ? `${sessionQuery.data.device_serial} pid ${sessionQuery.data.pid} (${sessionQuery.data.mode})`
    : ''

  return (
    <>
      <div className="flex items-center justify-between border-b border-border bg-bg-elevated px-4 py-2">
        <div className="flex items-center gap-3">
          <span className="font-mono text-xs text-fg-muted">
            run_session: {runSessionId}
          </span>
        </div>
        <button
          onClick={() => navigate('/editor')}
          className="text-xs text-fg-muted hover:text-fg"
        >
          New target →
        </button>
      </div>

      <RunControls
        target={target}
        status={status}
        onRun={onRun}
        onStop={() => stopMutation.mutate()}
        errorMessage={errMsg}
      />

      <div className="flex flex-1 overflow-hidden">
        <div className="flex-1 border-r border-border">
          <MonacoPane value={source} onChange={setSource} />
        </div>
        <div className="w-1/2 min-w-[400px]">
          <OutputConsole runSessionId={runSessionId} />
        </div>
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------
// Picker mode: rendered when there's no session in the URL. Lets the user
// pick a device + target inline so they don't have to drill through
// Devices → Processes → Spawn just to start a new run.
// ---------------------------------------------------------------------------

function InlineTargetPicker({ source }: { source: string }) {
  const navigate = useNavigate()
  const lastDeviceSerial = useEditorStore((s) => s.lastDeviceSerial)
  const setLastDeviceSerial = useEditorStore((s) => s.setLastDeviceSerial)

  const [serial, setSerial] = useState<string | null>(lastDeviceSerial)
  const [filter, setFilter] = useState('')

  const devicesQuery = useQuery({
    queryKey: ['devices'],
    queryFn: () => api.devices(),
    refetchInterval: 5000,
  })

  // When the device list arrives, auto-select if we have nothing yet
  useEffect(() => {
    if (serial != null) return
    const first = devicesQuery.data?.[0]
    if (first) {
      setSerial(first.id)
      setLastDeviceSerial(first.id)
    }
  }, [devicesQuery.data, serial, setLastDeviceSerial])

  const appsQuery = useQuery({
    queryKey: ['apps', serial],
    queryFn: () => api.apps(serial!),
    enabled: !!serial,
    refetchInterval: 5000,
  })

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

  const runMutation = useMutation({
    mutationFn: api.runScript,
    onSuccess: (resp) => {
      navigate(`/editor/${resp.run_session_id}`)
    },
  })

  const spawn = (identifier: string) => {
    if (!serial) return
    runMutation.mutate({
      device_serial: serial,
      mode: 'spawn',
      target_identifier: identifier,
      source,
    })
  }

  const attach = (pid: number) => {
    if (!serial) return
    runMutation.mutate({
      device_serial: serial,
      mode: 'attach',
      pid,
      source,
    })
  }

  return (
    <>
      <div className="border-b border-border bg-bg-elevated px-4 py-3">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <span className="text-xs uppercase tracking-wide text-fg-muted">
              Device
            </span>
            <select
              value={serial ?? ''}
              onChange={(e) => {
                setSerial(e.target.value || null)
                setLastDeviceSerial(e.target.value || null)
              }}
              className="rounded-md border border-border bg-bg px-2 py-1 text-sm text-fg focus:border-accent focus:outline-none"
            >
              {(devicesQuery.data ?? []).length === 0 && (
                <option value="">No devices</option>
              )}
              {devicesQuery.data?.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name} ({d.id})
                </option>
              ))}
            </select>
            <button
              onClick={() => devicesQuery.refetch()}
              disabled={devicesQuery.isFetching}
              className="rounded p-1 text-fg-muted hover:bg-bg-hover hover:text-fg disabled:opacity-50"
              title="Refresh devices"
            >
              <RefreshCw
                className={cn('h-3.5 w-3.5', devicesQuery.isFetching && 'animate-spin')}
              />
            </button>
          </div>

          <div className="relative flex-1 min-w-64">
            <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-fg-muted" />
            <input
              type="text"
              placeholder="Filter apps by name or package…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="w-full rounded-md border border-border bg-bg py-1.5 pl-8 pr-3 text-sm text-fg focus:border-accent focus:outline-none"
            />
          </div>

          <span className="text-xs text-fg-muted">
            {appsQuery.data ? `${filteredApps.length} apps` : ''}
          </span>
        </div>

        {runMutation.isError && (
          <div className="mt-2 flex items-center gap-2 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
            <AlertCircle className="h-3.5 w-3.5 shrink-0" />
            {(runMutation.error as Error).message}
          </div>
        )}
      </div>

      <div className="max-h-64 overflow-auto border-b border-border">
        {!serial && (
          <div className="px-4 py-6 text-center text-sm text-fg-muted">
            Pick a device to see its installed apps.
          </div>
        )}
        {serial && appsQuery.isLoading && (
          <div className="flex items-center justify-center px-4 py-6 text-sm text-fg-muted">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading apps…
          </div>
        )}
        {serial && appsQuery.data && (
          <table className="w-full">
            <tbody>
              {filteredApps.map((app, idx) => (
                <AppRow
                  key={`${app.identifier}-${idx}`}
                  app={app}
                  busy={runMutation.isPending}
                  onSpawn={() => spawn(app.identifier)}
                  onAttach={(pid) => attach(pid)}
                />
              ))}
              {filteredApps.length === 0 && (
                <tr>
                  <td className="px-4 py-6 text-center text-sm text-fg-muted">
                    No apps match "{filter}".
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>
    </>
  )
}

function AppRow({
  app,
  busy,
  onSpawn,
  onAttach,
}: {
  app: AppInfo
  busy: boolean
  onSpawn: () => void
  onAttach: (pid: number) => void
}) {
  return (
    <tr className="border-b border-border/50 text-sm hover:bg-bg-hover">
      <td className="w-10 px-3 py-2">
        {app.icon_b64 ? (
          <img
            src={`data:image/png;base64,${app.icon_b64}`}
            alt=""
            className="h-5 w-5 rounded-sm"
          />
        ) : (
          <div className="h-5 w-5 rounded-sm bg-bg-hover" />
        )}
      </td>
      <td className="px-2 py-2 text-fg-strong">{app.name}</td>
      <td className="px-2 py-2 font-mono text-xs text-fg-muted">{app.identifier}</td>
      <td className="px-2 py-2 font-mono text-xs text-fg">{app.pid ?? '—'}</td>
      <td className="px-3 py-2 text-right">
        <div className="flex justify-end gap-1">
          <button
            onClick={onSpawn}
            disabled={busy}
            className="flex items-center gap-1 rounded bg-accent-muted px-2 py-1 text-xs text-fg-strong hover:bg-accent disabled:opacity-50"
          >
            <Zap className="h-3 w-3" /> Spawn
          </button>
          {app.pid != null && (
            <button
              onClick={() => onAttach(app.pid!)}
              disabled={busy}
              className="flex items-center gap-1 rounded bg-bg-hover px-2 py-1 text-xs text-fg hover:bg-bg-hover/80 disabled:opacity-50"
            >
              <Play className="h-3 w-3" /> Attach
            </button>
          )}
        </div>
      </td>
    </tr>
  )
}
