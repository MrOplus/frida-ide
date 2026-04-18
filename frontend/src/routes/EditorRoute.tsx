import { useEffect, useState, useCallback, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTabParams } from '@/hooks/useTabParams'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Search,
  Zap,
  Play,
  AlertCircle,
  RefreshCw,
  Loader2,
  Plus,
  X,
  ChevronDown,
} from 'lucide-react'

import { api, type AppInfo } from '@/lib/api'
import { MonacoPane } from '@/components/editor/MonacoPane'
import { OutputConsole } from '@/components/editor/OutputConsole'
import { RunControls } from '@/components/editor/RunControls'
import { useEditorStore, type EditorFile } from '@/store/editorStore'
import { cn } from '@/lib/utils'

type Status = 'idle' | 'starting' | 'running' | 'stopping' | 'error'

export function EditorRoute() {
  const { runSessionId: param } = useTabParams<{ runSessionId: string }>()
  const runSessionId = param ? parseInt(param, 10) : null

  const files = useEditorStore((s) => s.files)
  const activeFileId = useEditorStore((s) => s.activeFileId)
  const openFile = useEditorStore((s) => s.openFile)
  const closeFile = useEditorStore((s) => s.closeFile)
  const setActiveFile = useEditorStore((s) => s.setActiveFile)
  const updateFileContent = useEditorStore((s) => s.updateFileContent)
  const renameFile = useEditorStore((s) => s.renameFile)

  const activeFile = files.find((f) => f.id === activeFileId) ?? files[0] ?? null

  return (
    <div className="flex h-full flex-col">
      <FileTabs
        files={files}
        activeFileId={activeFileId}
        onSwitch={setActiveFile}
        onClose={closeFile}
        onNew={() => openFile(suggestNewName(files), '// new frida script\n')}
        onRename={renameFile}
      />

      {runSessionId == null ? (
        <PickerAndEditor activeFile={activeFile} onChange={updateFileContent} />
      ) : (
        <LiveEditor
          runSessionId={runSessionId}
          activeFile={activeFile}
          onChange={updateFileContent}
        />
      )}
    </div>
  )
}

function suggestNewName(files: EditorFile[]): string {
  const names = new Set(files.map((f) => f.name))
  for (let i = 1; i < 200; i++) {
    const candidate = i === 1 ? 'hook.js' : `hook_${i}.js`
    if (!names.has(candidate)) return candidate
  }
  return `hook_${Date.now()}.js`
}

// ---------------------------------------------------------------------------
// Tab strip
// ---------------------------------------------------------------------------

function FileTabs({
  files,
  activeFileId,
  onSwitch,
  onClose,
  onNew,
  onRename,
}: {
  files: EditorFile[]
  activeFileId: string | null
  onSwitch: (id: string) => void
  onClose: (id: string) => void
  onNew: () => void
  onRename: (id: string, name: string) => void
}) {
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')

  const beginRename = (f: EditorFile) => {
    setRenamingId(f.id)
    setDraft(f.name)
  }

  const commitRename = () => {
    if (renamingId && draft.trim()) {
      onRename(renamingId, draft.trim())
    }
    setRenamingId(null)
  }

  return (
    <div className="flex items-stretch border-b border-border bg-bg-elevated">
      <div className="flex flex-1 items-stretch overflow-x-auto">
        {files.map((f) => {
          const isActive = f.id === activeFileId
          const isRenaming = renamingId === f.id
          return (
            <div
              key={f.id}
              className={cn(
                'group flex shrink-0 cursor-pointer items-center gap-1.5 border-r border-border px-3 py-2 text-sm transition-colors',
                isActive
                  ? 'bg-bg text-fg-strong'
                  : 'text-fg-muted hover:bg-bg-hover hover:text-fg'
              )}
              onClick={() => !isRenaming && onSwitch(f.id)}
              onDoubleClick={(e) => {
                e.stopPropagation()
                beginRename(f)
              }}
              title="Double-click to rename"
            >
              {isRenaming ? (
                <input
                  autoFocus
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={commitRename}
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitRename()
                    if (e.key === 'Escape') setRenamingId(null)
                  }}
                  className="w-32 rounded border border-border bg-bg px-1 font-mono text-xs text-fg focus:border-accent focus:outline-none"
                />
              ) : (
                <span className="font-mono text-xs">{f.name}</span>
              )}
              {files.length > 1 && !isRenaming && (
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    onClose(f.id)
                  }}
                  className="rounded p-0.5 text-fg-muted opacity-0 transition-opacity hover:bg-bg-hover hover:text-fg group-hover:opacity-100"
                  title="Close tab"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
          )
        })}
      </div>
      <button
        onClick={onNew}
        className="flex shrink-0 items-center gap-1 border-l border-border px-3 py-2 text-xs text-fg-muted hover:bg-bg-hover hover:text-fg"
        title="New file"
      >
        <Plus className="h-3.5 w-3.5" /> New
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Picker mode (no active run session in the URL). Now hosts the editor itself
// so the inline target picker's Run button can kick off a run for the
// currently-focused tab.
// ---------------------------------------------------------------------------

function PickerAndEditor({
  activeFile,
  onChange,
}: {
  activeFile: EditorFile | null
  onChange: (id: string, content: string) => void
}) {
  const navigate = useNavigate()
  const lastDeviceSerial = useEditorStore((s) => s.lastDeviceSerial)
  const setLastDeviceSerial = useEditorStore((s) => s.setLastDeviceSerial)
  const lastTarget = useEditorStore((s) => s.lastTarget)
  const setLastTarget = useEditorStore((s) => s.setLastTarget)
  const activeRunSessionId = useEditorStore((s) => s.activeRunSessionId)
  const setActiveRunSessionId = useEditorStore((s) => s.setActiveRunSessionId)

  const [serial, setSerial] = useState<string | null>(lastDeviceSerial)
  // Initialise from the persisted target so opening the Editor tab after a
  // run restores the previous selection — the user doesn't have to re-pick
  // the app every time they hit Run.
  const [target, setTarget] = useState<typeof lastTarget>(lastTarget)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [filter, setFilter] = useState('')

  const devicesQuery = useQuery({
    queryKey: ['devices'],
    queryFn: () => api.devices(),
    refetchInterval: 5000,
  })

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
    enabled: !!serial && pickerOpen,
    refetchInterval: pickerOpen ? 5000 : false,
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
    // Stop any prior session we know about before starting a new one, so
    // the Sessions tab doesn't accumulate zombie "running" rows when the
    // user hits Run repeatedly.
    mutationFn: async (req: Parameters<typeof api.runScript>[0]) => {
      if (activeRunSessionId != null) {
        try {
          await api.stopScript(activeRunSessionId)
        } catch {
          /* already stopped / gone — ignore */
        }
      }
      return api.runScript(req)
    },
    onSuccess: (resp) => {
      setActiveRunSessionId(resp.run_session_id)
      navigate(`/editor/${resp.run_session_id}`)
    },
  })

  const pickApp = (app: AppInfo, mode: 'spawn' | 'attach') => {
    const t = {
      mode,
      identifier: app.identifier,
      pid: mode === 'attach' ? (app.pid ?? undefined) : undefined,
      label: `${mode === 'spawn' ? '⚡' : '▶'} ${app.name} (${app.identifier})`,
    }
    setTarget(t)
    setLastTarget(t) // remember across runs
    setPickerOpen(false)
  }

  const runActiveFile = () => {
    if (!serial || !activeFile || !target) return
    runMutation.mutate({
      device_serial: serial,
      mode: target.mode,
      target_identifier: target.mode === 'spawn' ? target.identifier : undefined,
      pid: target.mode === 'attach' ? target.pid : undefined,
      source: activeFile.content,
    })
  }

  return (
    <>
      <div className="border-b border-border bg-bg-elevated px-4 py-2">
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
                setTarget(null)
                setLastTarget(null)
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
                className={cn(
                  'h-3.5 w-3.5',
                  devicesQuery.isFetching && 'animate-spin'
                )}
              />
            </button>
          </div>

          <div className="flex items-center gap-2">
            <span className="text-xs uppercase tracking-wide text-fg-muted">
              Target
            </span>
            <button
              onClick={() => setPickerOpen((o) => !o)}
              disabled={!serial}
              className="flex items-center gap-1 rounded-md border border-border bg-bg px-2 py-1 text-sm text-fg hover:bg-bg-hover disabled:opacity-50"
            >
              <span className="font-mono text-xs">
                {target?.label ?? 'Pick app…'}
              </span>
              <ChevronDown className="h-3.5 w-3.5" />
            </button>
          </div>

          <div className="flex-1" />

          <button
            onClick={runActiveFile}
            disabled={!serial || !target || !activeFile || runMutation.isPending}
            className="flex items-center gap-1.5 rounded-md bg-accent-muted px-3 py-1.5 text-sm font-medium text-fg-strong hover:bg-accent disabled:opacity-50"
            title="Run this tab against the selected target"
          >
            {runMutation.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Play className="h-3.5 w-3.5" />
            )}
            Run {activeFile?.name ?? ''}
          </button>
        </div>

        {runMutation.isError && (
          <div className="mt-2 flex items-center gap-2 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
            <AlertCircle className="h-3.5 w-3.5 shrink-0" />
            {(runMutation.error as Error).message}
          </div>
        )}
      </div>

      {pickerOpen && (
        <div className="border-b border-border bg-bg-elevated">
          <div className="border-b border-border px-4 py-2">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-fg-muted" />
              <input
                autoFocus
                type="text"
                placeholder="Filter apps by name or package…"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                className="w-full rounded-md border border-border bg-bg py-1.5 pl-8 pr-3 text-sm text-fg focus:border-accent focus:outline-none"
              />
            </div>
          </div>
          <div className="max-h-64 overflow-auto">
            {appsQuery.isLoading && (
              <div className="flex items-center justify-center px-4 py-6 text-sm text-fg-muted">
                <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading apps…
              </div>
            )}
            {appsQuery.data && (
              <table className="w-full">
                <tbody>
                  {filteredApps.map((app, idx) => (
                    <tr
                      key={`${app.identifier}-${idx}`}
                      className="border-b border-border/50 text-sm hover:bg-bg-hover"
                    >
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
                      <td className="px-2 py-2 font-mono text-xs text-fg-muted">
                        {app.identifier}
                      </td>
                      <td className="px-2 py-2 font-mono text-xs text-fg">
                        {app.pid ?? '—'}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <div className="flex justify-end gap-1">
                          <button
                            onClick={() => pickApp(app, 'spawn')}
                            className="flex items-center gap-1 rounded bg-accent-muted px-2 py-1 text-xs text-fg-strong hover:bg-accent"
                          >
                            <Zap className="h-3 w-3" /> Spawn
                          </button>
                          {app.pid != null && (
                            <button
                              onClick={() => pickApp(app, 'attach')}
                              className="flex items-center gap-1 rounded bg-bg-hover px-2 py-1 text-xs text-fg hover:bg-bg-hover/80"
                            >
                              <Play className="h-3 w-3" /> Attach
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                  {filteredApps.length === 0 && !appsQuery.isLoading && (
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
        </div>
      )}

      <div className="flex flex-1 overflow-hidden">
        <div className="flex-1">
          {activeFile && (
            <MonacoPane
              key={activeFile.id}
              value={activeFile.content}
              onChange={(v) => onChange(activeFile.id, v)}
            />
          )}
        </div>
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------
// Live mode: URL has /editor/:runSessionId
// ---------------------------------------------------------------------------

function LiveEditor({
  runSessionId,
  activeFile,
  onChange,
}: {
  runSessionId: number
  activeFile: EditorFile | null
  onChange: (id: string, content: string) => void
}) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const setActiveRunSessionId = useEditorStore((s) => s.setActiveRunSessionId)

  const [status, setStatus] = useState<Status>('running')
  const [errMsg, setErrMsg] = useState<string | null>(null)

  // Adopt whichever session this route is currently showing. That way, if
  // the user reloads the page while on /editor/:id, the store reflects the
  // live session immediately (so the next Run can stop it).
  useEffect(() => {
    setActiveRunSessionId(runSessionId)
  }, [runSessionId, setActiveRunSessionId])

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
      setActiveRunSessionId(null)
      qc.invalidateQueries({ queryKey: ['runSession', runSessionId] })
    },
  })

  const onRun = useCallback(() => {
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
          {activeFile && (
            <MonacoPane
              key={activeFile.id}
              value={activeFile.content}
              onChange={(v) => onChange(activeFile.id, v)}
            />
          )}
        </div>
        <div className="w-1/2 min-w-[400px]">
          <OutputConsole runSessionId={runSessionId} />
        </div>
      </div>
    </>
  )
}

