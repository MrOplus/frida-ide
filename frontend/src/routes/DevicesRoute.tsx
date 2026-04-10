import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import {
  Smartphone,
  Wifi,
  Cpu,
  ShieldCheck,
  Plug,
  RefreshCw,
  ArrowRight,
  AlertCircle,
  Download,
  Loader2,
  Power,
  Play,
  Tablet,
} from 'lucide-react'

import { api, type DeviceInfo, type AvdInfo } from '@/lib/api'
import { cn } from '@/lib/utils'

export function DevicesRoute() {
  const qc = useQueryClient()
  const { data, isLoading, isError, error, refetch, isFetching } = useQuery({
    queryKey: ['devices'],
    queryFn: api.devices,
    refetchInterval: 5_000,
  })

  const [host, setHost] = useState('')
  const [port, setPort] = useState('5555')
  const connectMutation = useMutation({
    mutationFn: ({ host, port }: { host: string; port: number }) =>
      api.connectDevice(host, port),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['devices'] })
      setHost('')
    },
  })

  return (
    <div className="p-6">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold text-fg-strong">Devices</h1>
        <button
          onClick={() => refetch()}
          disabled={isFetching}
          className="flex items-center gap-2 rounded-md border border-border bg-bg-elevated px-3 py-1.5 text-sm text-fg hover:bg-bg-hover disabled:opacity-50"
        >
          <RefreshCw className={cn('h-3.5 w-3.5', isFetching && 'animate-spin')} />
          Refresh
        </button>
      </div>

      <EmulatorPanel />

      <div className="mb-6 rounded-md border border-border bg-bg-elevated p-4">
        <div className="mb-2 text-sm font-medium text-fg-strong">Connect network device</div>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (host) connectMutation.mutate({ host, port: parseInt(port, 10) || 5555 })
          }}
          className="flex items-center gap-2"
        >
          <input
            type="text"
            placeholder="host (e.g. 192.168.1.10)"
            value={host}
            onChange={(e) => setHost(e.target.value)}
            className="flex-1 rounded-md border border-border bg-bg px-3 py-1.5 text-sm text-fg focus:border-accent focus:outline-none"
          />
          <input
            type="text"
            placeholder="port"
            value={port}
            onChange={(e) => setPort(e.target.value)}
            className="w-20 rounded-md border border-border bg-bg px-3 py-1.5 text-sm text-fg focus:border-accent focus:outline-none"
          />
          <button
            type="submit"
            disabled={!host || connectMutation.isPending}
            className="rounded-md bg-accent-muted px-3 py-1.5 text-sm font-medium text-fg-strong hover:bg-accent disabled:opacity-50"
          >
            <Plug className="inline h-3.5 w-3.5" /> Connect
          </button>
        </form>
        {connectMutation.isError && (
          <div className="mt-2 flex items-center gap-1.5 text-xs text-danger">
            <AlertCircle className="h-3.5 w-3.5" />
            {(connectMutation.error as Error).message}
          </div>
        )}
      </div>

      {isLoading && <div className="text-fg-muted">Loading devices…</div>}
      {isError && (
        <div className="rounded-md border border-danger/50 bg-danger/10 p-3 text-sm text-danger">
          Failed to load devices: {(error as Error).message}
        </div>
      )}

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {data?.map((device) => (
          <DeviceCard key={device.id} device={device} />
        ))}
      </div>
    </div>
  )
}

function DeviceCard({ device }: { device: DeviceInfo }) {
  const qc = useQueryClient()
  const isUsb = device.type === 'usb'
  const fridaUp = device.frida_server_running === true

  const installMutation = useMutation({
    mutationFn: () => api.fridaServerInstall(device.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['devices'] }),
  })
  const stopMutation = useMutation({
    mutationFn: () => api.fridaServerStop(device.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['devices'] }),
  })

  return (
    <div className="rounded-md border border-border bg-bg-elevated p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-start gap-3 min-w-0">
          {isUsb ? (
            <Smartphone className="mt-0.5 h-5 w-5 text-accent" />
          ) : (
            <Wifi className="mt-0.5 h-5 w-5 text-fg-muted" />
          )}
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="truncate font-medium text-fg-strong">{device.name}</span>
              {isUsb && (
                <span
                  className={cn(
                    'h-2 w-2 shrink-0 rounded-full',
                    fridaUp ? 'bg-success' : 'bg-danger'
                  )}
                  title={fridaUp ? 'frida-server running' : 'frida-server not detected'}
                />
              )}
            </div>
            <div className="mt-0.5 truncate font-mono text-xs text-fg-muted">{device.id}</div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {isUsb && !fridaUp && (
            <button
              onClick={() => installMutation.mutate()}
              disabled={installMutation.isPending}
              className="flex items-center gap-1 rounded-md bg-accent-muted px-2 py-1 text-xs font-medium text-fg-strong hover:bg-accent disabled:opacity-50"
            >
              {installMutation.isPending ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Download className="h-3 w-3" />
              )}
              {installMutation.isPending ? 'Installing…' : 'Install frida-server'}
            </button>
          )}
          {isUsb && fridaUp && (
            <>
              <button
                onClick={() => {
                  if (confirm('Stop frida-server on this device?')) stopMutation.mutate()
                }}
                disabled={stopMutation.isPending}
                title="Stop frida-server"
                className="rounded-md p-1 text-fg-muted hover:bg-bg-hover hover:text-danger disabled:opacity-50"
              >
                <Power className="h-3.5 w-3.5" />
              </button>
              <Link
                to={`/devices/${encodeURIComponent(device.id)}/processes`}
                className="flex items-center gap-1 rounded-md bg-bg-hover px-2 py-1 text-xs text-fg hover:bg-bg-hover/80"
              >
                Processes <ArrowRight className="h-3 w-3" />
              </Link>
            </>
          )}
        </div>
      </div>

      {installMutation.isError && (
        <div className="mt-2 flex items-start gap-1.5 rounded border border-danger/30 bg-danger/5 p-2 text-xs text-danger">
          <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
          {(installMutation.error as Error).message}
        </div>
      )}

      {isUsb && (
        <div className="mt-4 grid grid-cols-2 gap-2 text-xs">
          <Field icon={Cpu} label="ABI" value={device.abi} />
          <Field
            icon={Smartphone}
            label="Android"
            value={
              device.android_release
                ? `${device.android_release} (SDK ${device.android_sdk ?? '?'})`
                : null
            }
          />
          <Field
            icon={ShieldCheck}
            label="Root"
            value={device.rooted == null ? null : device.rooted ? 'yes' : 'no'}
          />
          <Field
            icon={Plug}
            label="frida-server"
            value={device.frida_server_version ?? (fridaUp ? 'running' : 'down')}
          />
        </div>
      )}
    </div>
  )
}

function Field({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Smartphone
  label: string
  value: string | null
}) {
  return (
    <div className="flex items-center gap-1.5 text-fg-muted">
      <Icon className="h-3.5 w-3.5 shrink-0" />
      <span className="shrink-0">{label}:</span>
      <span className="truncate text-fg">{value ?? '—'}</span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Emulator panel — list configured AVDs and start them
// ---------------------------------------------------------------------------

function EmulatorPanel() {
  const qc = useQueryClient()
  const [pendingStart, setPendingStart] = useState<string | null>(null)

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['emulators'],
    queryFn: api.emulators,
    // Poll faster while a start is in flight so the UI flips quickly
    refetchInterval: pendingStart ? 2_000 : 10_000,
  })

  // Clear the "pending" marker once the AVD reports running
  if (pendingStart && data?.some((a) => a.name === pendingStart && a.running)) {
    setPendingStart(null)
  }

  const startMutation = useMutation({
    mutationFn: (name: string) => api.startEmulator(name),
    onSuccess: (_, name) => {
      setPendingStart(name)
      qc.invalidateQueries({ queryKey: ['emulators'] })
      qc.invalidateQueries({ queryKey: ['devices'] })
    },
  })

  // Hide the panel entirely when the emulator binary isn't on the host (503)
  if (
    isError &&
    (error as { status?: number } | undefined)?.status === 503
  ) {
    return null
  }

  return (
    <div className="mb-6 rounded-md border border-border bg-bg-elevated p-4">
      <div className="mb-2 flex items-center justify-between">
        <div className="text-sm font-medium text-fg-strong">Available emulators</div>
        {data && (
          <span className="text-xs text-fg-muted">
            {data.filter((a) => a.running).length} / {data.length} running
          </span>
        )}
      </div>

      {isLoading && <div className="text-xs text-fg-muted">Loading AVDs…</div>}

      {data && data.length === 0 && (
        <div className="text-xs text-fg-muted">
          No AVDs configured. Create one in Android Studio.
        </div>
      )}

      <div className="space-y-1.5">
        {data?.map((avd) => (
          <AvdRow
            key={avd.name}
            avd={avd}
            starting={pendingStart === avd.name || (startMutation.isPending && startMutation.variables === avd.name)}
            onStart={() => startMutation.mutate(avd.name)}
          />
        ))}
      </div>

      {startMutation.isError && (
        <div className="mt-2 flex items-center gap-1.5 text-xs text-danger">
          <AlertCircle className="h-3.5 w-3.5" />
          {(startMutation.error as Error).message}
        </div>
      )}
    </div>
  )
}

function AvdRow({
  avd,
  starting,
  onStart,
}: {
  avd: AvdInfo
  starting: boolean
  onStart: () => void
}) {
  return (
    <div className="flex items-center gap-3 rounded-md border border-border/60 bg-bg/50 px-3 py-2">
      <Tablet className="h-4 w-4 shrink-0 text-fg-muted" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-fg-strong">{avd.name}</div>
        <div className="flex items-center gap-1.5 text-xs">
          <span
            className={cn(
              'h-1.5 w-1.5 rounded-full',
              avd.running ? 'bg-success' : 'bg-fg-muted/40',
              starting && 'bg-warning animate-pulse'
            )}
          />
          <span className="text-fg-muted">
            {starting
              ? 'Booting…'
              : avd.running
              ? `Running · ${avd.serial ?? '?'}`
              : 'Stopped'}
          </span>
        </div>
      </div>
      {avd.running ? (
        avd.serial ? (
          <Link
            to={`/devices/${encodeURIComponent(avd.serial)}/processes`}
            className="flex items-center gap-1 rounded-md bg-bg-hover px-2 py-1 text-xs text-fg hover:bg-bg-hover/80"
          >
            Processes <ArrowRight className="h-3 w-3" />
          </Link>
        ) : null
      ) : (
        <button
          onClick={onStart}
          disabled={starting}
          className="flex items-center gap-1 rounded-md bg-accent-muted px-2 py-1 text-xs font-medium text-fg-strong hover:bg-accent disabled:opacity-50"
        >
          {starting ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Play className="h-3 w-3" />
          )}
          Start
        </button>
      )}
    </div>
  )
}
