import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useTabParams } from '@/hooks/useTabParams'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  ChevronLeft,
  Package,
  Bot,
  Square,
  PlusCircle,
  Sparkles,
  AlertCircle,
  RotateCcw,
} from 'lucide-react'

import { api } from '@/lib/api'
import { ChatPane } from '@/components/ai/ChatPane'
import { useEditorStore } from '@/store/editorStore'

const PRESET_PROMPTS = [
  'Summarize this app: package, key activities, services, networking surface.',
  'Find the authentication flow. Which classes handle login?',
  'Find any subscription / premium / billing checks and tell me where to hook.',
  'Find SSL pinning and TLS validation. List the classes that need bypassing.',
  'Find the API endpoints this app talks to.',
]

export function ProjectAiRoute() {
  const { projectId: param } = useTabParams<{ projectId: string }>()
  const projectId = param ? parseInt(param, 10) : null
  const navigate = useNavigate()
  const qc = useQueryClient()
  const openFile = useEditorStore((s) => s.openFile)

  const projectQuery = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => api.getProject(projectId!),
    enabled: projectId != null,
  })

  const sessionsQuery = useQuery({
    queryKey: ['aiSessions', projectId],
    queryFn: () => api.listAiSessions(projectId!),
    enabled: projectId != null,
    refetchInterval: 5_000,
  })

  // Pick the most recent running session, or the most recent resumable one
  const runningSession = sessionsQuery.data?.find((s) => s.status === 'running') ?? null
  const resumableSession =
    runningSession ??
    sessionsQuery.data?.find((s) => s.can_resume) ??
    null

  const [activeSessionId, setActiveSessionId] = useState<number | null>(null)

  // Auto-select the running or resumable session when the list loads
  useEffect(() => {
    if (activeSessionId == null && resumableSession) {
      setActiveSessionId(resumableSession.id)
    }
  }, [activeSessionId, resumableSession])

  const activeSession = sessionsQuery.data?.find((s) => s.id === activeSessionId) ?? null
  const canResume = activeSession?.can_resume ?? false

  const createMutation = useMutation({
    mutationFn: () => api.createAiSession(projectId!),
    onSuccess: (s) => {
      setActiveSessionId(s.id)
      qc.invalidateQueries({ queryKey: ['aiSessions', projectId] })
    },
  })

  const stopMutation = useMutation({
    mutationFn: (sid: number) => api.stopAiSession(projectId!, sid),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['aiSessions', projectId] })
    },
  })

  const resumeMutation = useMutation({
    mutationFn: (sid: number) => api.resumeAiSession(projectId!, sid),
    onSuccess: (s) => {
      setActiveSessionId(s.id)
      qc.invalidateQueries({ queryKey: ['aiSessions', projectId] })
    },
  })

  const extractMutation = useMutation({
    mutationFn: (sid: number) => api.extractScript(projectId!, sid),
    onSuccess: (result) => {
      if (result.found && result.source) {
        // Open the extracted script as a fresh tab so the user's existing
        // buffers are preserved, then jump to the Editor tab so they can
        // pick a target and Run it.
        openFile('extracted.js', result.source)
        navigate('/editor')
      } else {
        alert('No JavaScript code block found in the most recent assistant message.')
      }
    },
  })

  if (projectId == null) {
    return <div className="p-6 text-fg-muted">Invalid project</div>
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border bg-bg-elevated px-4 py-2">
        <div className="flex items-center gap-3">
          <Link
            to="/projects"
            className="flex items-center gap-1 text-sm text-fg-muted hover:text-fg"
          >
            <ChevronLeft className="h-4 w-4" /> Projects
          </Link>
          <span className="text-fg-muted">/</span>
          <Package className="h-4 w-4 text-accent" />
          <span className="font-mono text-sm text-fg-strong">
            {projectQuery.data?.package_name ?? `#${projectId}`}
          </span>
          {projectQuery.data?.version_name && (
            <span className="text-xs text-fg-muted">v{projectQuery.data.version_name}</span>
          )}
          <span className="text-fg-muted">/</span>
          <Bot className="h-4 w-4 text-accent" />
          <span className="text-sm text-fg-strong">AI Chat</span>
        </div>
        <div className="flex items-center gap-2">
          <Link
            to={`/projects/${projectId}/files`}
            className="rounded-md bg-bg-hover px-2 py-1 text-xs text-fg hover:bg-bg-hover/80"
          >
            Browse files
          </Link>
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar: session controls + presets */}
        <aside className="w-64 shrink-0 overflow-auto border-r border-border bg-bg-elevated p-3">
          <div className="mb-4">
            <div className="mb-1 text-xs font-medium uppercase text-fg-muted">
              Session
            </div>
            {activeSessionId != null ? (
              <div className="space-y-2">
                <div className="rounded-md bg-bg-hover p-2 text-xs">
                  <div className="text-fg-strong">Session #{activeSessionId}</div>
                  <div className="font-mono text-fg-muted">
                    {projectQuery.data?.package_name ?? '?'}/jadx-out
                  </div>
                </div>
                <button
                  onClick={() => extractMutation.mutate(activeSessionId)}
                  disabled={extractMutation.isPending}
                  className="flex w-full items-center justify-center gap-1.5 rounded-md bg-accent-muted px-3 py-1.5 text-xs font-medium text-fg-strong hover:bg-accent disabled:opacity-50"
                >
                  <Sparkles className="h-3 w-3" />
                  Extract Script → Editor
                </button>
                {canResume ? (
                  <button
                    onClick={() => resumeMutation.mutate(activeSessionId)}
                    disabled={resumeMutation.isPending}
                    className="flex w-full items-center justify-center gap-1.5 rounded-md bg-accent-muted px-3 py-1.5 text-xs font-medium text-fg-strong hover:bg-accent disabled:opacity-50"
                  >
                    <RotateCcw className="h-3 w-3" />
                    {resumeMutation.isPending ? 'Resuming…' : 'Resume session'}
                  </button>
                ) : (
                  <button
                    onClick={() => stopMutation.mutate(activeSessionId)}
                    disabled={stopMutation.isPending}
                    className="flex w-full items-center justify-center gap-1.5 rounded-md border border-border bg-bg px-3 py-1.5 text-xs text-fg hover:bg-bg-hover disabled:opacity-50"
                  >
                    <Square className="h-3 w-3" />
                    Stop session
                  </button>
                )}
              </div>
            ) : (
              <button
                onClick={() => createMutation.mutate()}
                disabled={createMutation.isPending || projectQuery.data?.status !== 'done'}
                className="flex w-full items-center justify-center gap-1.5 rounded-md bg-accent-muted px-3 py-2 text-sm font-medium text-fg-strong hover:bg-accent disabled:opacity-50"
              >
                <PlusCircle className="h-3.5 w-3.5" />
                Start AI session
              </button>
            )}
            {createMutation.isError && (
              <div className="mt-2 flex items-start gap-1.5 text-xs text-danger">
                <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
                {(createMutation.error as Error).message}
              </div>
            )}
            {resumeMutation.isError && (
              <div className="mt-2 flex items-start gap-1.5 text-xs text-danger">
                <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
                Resume failed: {(resumeMutation.error as Error).message}
              </div>
            )}
          </div>

          {activeSessionId != null && (
            <div>
              <div className="mb-1 text-xs font-medium uppercase text-fg-muted">
                Quick prompts
              </div>
              <div className="space-y-1">
                {PRESET_PROMPTS.map((prompt) => (
                  <PresetButton
                    key={prompt}
                    prompt={prompt}
                    onClick={() => {
                      // Inject prompt into the chat input via a custom event
                      window.dispatchEvent(
                        new CustomEvent('frida-ide:inject-prompt', { detail: prompt })
                      )
                    }}
                  />
                ))}
              </div>
            </div>
          )}
        </aside>

        {/* Main: chat */}
        <div className="flex-1 overflow-hidden">
          {activeSessionId != null ? (
            <ChatPane projectId={projectId} sessionId={activeSessionId} />
          ) : (
            <div className="flex h-full items-center justify-center p-8 text-center">
              <div className="max-w-md text-fg-muted">
                <Bot className="mx-auto h-12 w-12 text-fg-muted/40" />
                <div className="mt-4 text-sm">
                  Start an AI session to chat with Claude about{' '}
                  <span className="font-mono text-fg">
                    {projectQuery.data?.package_name ?? 'this project'}
                  </span>
                  . Claude will run with its working directory set to the decompiled
                  source tree, so it can read any class directly.
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function PresetButton({ prompt, onClick }: { prompt: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="block w-full rounded-md border border-border bg-bg p-2 text-left text-xs text-fg-muted hover:border-accent/40 hover:text-fg"
    >
      {prompt}
    </button>
  )
}
