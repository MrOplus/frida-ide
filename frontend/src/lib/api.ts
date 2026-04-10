/**
 * Typed fetch client for the Frida IDE backend.
 *
 * Uses the Vite proxy in dev (`/api/*` -> http://127.0.0.1:8765) and same-origin
 * in production (when FastAPI serves the built SPA).
 */

export class ApiError extends Error {
  status: number
  body: unknown
  constructor(status: number, body: unknown, message?: string) {
    super(message ?? `HTTP ${status}`)
    this.status = status
    this.body = body
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  })
  if (!res.ok) {
    let body: unknown = null
    try {
      body = await res.json()
    } catch {
      // ignore
    }
    throw new ApiError(res.status, body)
  }
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

export interface HealthResponse {
  status: 'ok'
  version: string
  data_dir: string
  tools: {
    adb: string | null
    jadx: string | null
    apktool: string | null
    claude: string | null
  }
}

export interface DeviceInfo {
  id: string
  name: string
  type: 'local' | 'remote' | 'usb'
  abi: string | null
  android_release: string | null
  android_sdk: string | null
  rooted: boolean | null
  frida_server_running: boolean | null
  frida_server_version: string | null
}

export interface ProcessInfo {
  pid: number
  name: string
  icon_b64: string | null
}

export interface AppInfo {
  identifier: string
  name: string
  pid: number | null
  icon_b64: string | null
}

export interface RunRequest {
  device_serial: string
  mode: 'spawn' | 'attach'
  target_identifier?: string | null
  pid?: number | null
  source: string
}

export interface RunResponse {
  run_session_id: number
  pid: number
  mode: 'spawn' | 'attach'
  status: string
}

export interface RunSessionInfo {
  id: number
  device_serial: string
  target_identifier: string | null
  pid: number | null
  mode: 'spawn' | 'attach'
  status: string
  started_at: string
  ended_at: string | null
  error_message: string | null
}

export interface ProjectInfo {
  id: number
  name: string
  package_name: string | null
  version_name: string | null
  version_code: number | null
  sha256: string | null
  path: string
  status: 'queued' | 'apktool' | 'jadx' | 'done' | 'error'
  error_message: string | null
  created_at: string
  permissions: string[]
  launcher_activity: string | null
  debuggable: boolean | null
}

export interface FileTreeEntry {
  name: string
  path: string
  type: 'dir' | 'file'
  size: number | null
}

export interface FileTreeResponse {
  source: 'jadx' | 'apktool'
  path: string
  entries: FileTreeEntry[]
}

export interface AiSession {
  id: number
  project_id: number
  pid: number | null
  status: 'starting' | 'running' | 'stopped' | 'error'
  started_at: string
  ended_at: string | null
  project_name?: string
  cwd?: string
}

export interface AiMessage {
  id: number
  role: 'user' | 'assistant' | 'tool_result' | 'system'
  ts: string
  content: unknown
}

export interface ExtractedScript {
  found: boolean
  source: string | null
  language: string | null
}

export interface SnippetInfo {
  id: number
  name: string
  description: string | null
  source: string
  tags: string[]
  parameters: { name: string; description: string; required: boolean }[]
  builtin: boolean
  created_at: string
}

export interface FridaServerStatus {
  running: boolean
  remote_version: string | null
  expected_version: string
  version_match: boolean | null
}

export interface SessionSummary {
  id: number
  device_serial: string
  target_identifier: string | null
  pid: number | null
  mode: 'spawn' | 'attach'
  status: string
  started_at: string
  ended_at: string | null
  duration_ms: number | null
  error_message: string | null
  event_count: number
}

export interface SessionEvent {
  id: number
  ts: string
  kind: string
  payload: unknown
}

export interface AvdInfo {
  name: string
  running: boolean
  serial: string | null
}

export interface CodeshareEntry {
  handle: string
  slug: string
  full_slug: string
  name: string
  description: string
  likes: number | null
  views: string | null
  url: string
}

export interface CodeshareProject {
  handle: string
  slug: string
  full_slug: string
  name: string
  source: string
  fingerprint: string
  url: string
}

async function requestText(path: string, init?: RequestInit): Promise<string> {
  const res = await fetch(path, init)
  if (!res.ok) {
    let body: unknown = null
    try {
      body = await res.json()
    } catch {
      // ignore
    }
    throw new ApiError(res.status, body)
  }
  return await res.text()
}

export const api = {
  health: () => request<HealthResponse>('/api/health'),
  devices: () => request<DeviceInfo[]>('/api/devices'),
  connectDevice: (host: string, port: number) =>
    request<{ ok: boolean; result: string }>('/api/devices/connect', {
      method: 'POST',
      body: JSON.stringify({ host, port }),
    }),
  processes: (serial: string) =>
    request<ProcessInfo[]>(`/api/devices/${encodeURIComponent(serial)}/processes`),
  apps: (serial: string) =>
    request<AppInfo[]>(`/api/devices/${encodeURIComponent(serial)}/apps`),
  runScript: (req: RunRequest) =>
    request<RunResponse>('/api/scripts/run', {
      method: 'POST',
      body: JSON.stringify(req),
    }),
  stopScript: (runSessionId: number) =>
    request<{ ok: boolean }>(`/api/scripts/${runSessionId}/stop`, { method: 'POST' }),
  getRunSession: (runSessionId: number) =>
    request<RunSessionInfo>(`/api/scripts/${runSessionId}`),

  // ----- Projects -----
  projects: () => request<ProjectInfo[]>('/api/projects'),
  getProject: (id: number) => request<ProjectInfo>(`/api/projects/${id}`),
  uploadProject: async (files: File[]): Promise<ProjectInfo> => {
    const fd = new FormData()
    for (const f of files) fd.append('files', f, f.name)
    const res = await fetch('/api/projects', { method: 'POST', body: fd })
    if (!res.ok) {
      let body: unknown = null
      try {
        body = await res.json()
      } catch {
        /* ignore */
      }
      throw new ApiError(res.status, body)
    }
    return (await res.json()) as ProjectInfo
  },
  deleteProject: (id: number) =>
    request<{ ok: boolean }>(`/api/projects/${id}`, { method: 'DELETE' }),

  // ----- Files -----
  fileTree: (projectId: number, path = '', source: 'jadx' | 'apktool' = 'jadx') => {
    const qs = new URLSearchParams({ path, source })
    return request<FileTreeResponse>(`/api/projects/${projectId}/tree?${qs}`)
  },
  fileContent: (projectId: number, path: string, source: 'jadx' | 'apktool' = 'jadx') => {
    const qs = new URLSearchParams({ path, source })
    return requestText(`/api/projects/${projectId}/file?${qs}`)
  },

  // ----- AI sessions -----
  createAiSession: (projectId: number) =>
    request<AiSession>(`/api/projects/${projectId}/ai/session`, { method: 'POST' }),
  listAiSessions: (projectId: number) =>
    request<AiSession[]>(`/api/projects/${projectId}/ai/sessions`),
  getAiSession: (projectId: number, sessionId: number) =>
    request<AiSession>(`/api/projects/${projectId}/ai/session/${sessionId}`),
  getAiMessages: (projectId: number, sessionId: number) =>
    request<AiMessage[]>(`/api/projects/${projectId}/ai/session/${sessionId}/messages`),
  sendAiMessage: (projectId: number, sessionId: number, text: string) =>
    request<{ ok: boolean }>(
      `/api/projects/${projectId}/ai/session/${sessionId}/message`,
      { method: 'POST', body: JSON.stringify({ text }) }
    ),
  stopAiSession: (projectId: number, sessionId: number) =>
    request<{ ok: boolean }>(
      `/api/projects/${projectId}/ai/session/${sessionId}`,
      { method: 'DELETE' }
    ),
  extractScript: (projectId: number, sessionId: number) =>
    request<ExtractedScript>(
      `/api/projects/${projectId}/ai/session/${sessionId}/extract-script`,
      { method: 'POST' }
    ),

  // ----- Snippets -----
  snippets: (params?: { tag?: string; q?: string; builtin?: boolean }) => {
    const qs = new URLSearchParams()
    if (params?.tag) qs.set('tag', params.tag)
    if (params?.q) qs.set('q', params.q)
    if (params?.builtin != null) qs.set('builtin', String(params.builtin))
    const suffix = qs.toString() ? `?${qs}` : ''
    return request<SnippetInfo[]>(`/api/snippets${suffix}`)
  },
  getSnippet: (id: number) => request<SnippetInfo>(`/api/snippets/${id}`),
  renderSnippet: (id: number, params: Record<string, string>) =>
    request<{ name: string; source: string }>(`/api/snippets/${id}/render`, {
      method: 'POST',
      body: JSON.stringify({ params }),
    }),

  // ----- frida-server installer -----
  fridaServerStatus: (serial: string) =>
    request<FridaServerStatus>(
      `/api/devices/${encodeURIComponent(serial)}/frida-server/status`
    ),
  fridaServerInstall: (serial: string) =>
    request<{ ok: boolean; version: string; arch: string }>(
      `/api/devices/${encodeURIComponent(serial)}/frida-server/install`,
      { method: 'POST' }
    ),
  fridaServerStop: (serial: string) =>
    request<{ ok: boolean }>(
      `/api/devices/${encodeURIComponent(serial)}/frida-server/stop`,
      { method: 'POST' }
    ),

  // ----- Sessions (recordings) -----
  sessions: (limit = 100) =>
    request<SessionSummary[]>(`/api/sessions?limit=${limit}`),
  getSession: (id: number) => request<SessionSummary>(`/api/sessions/${id}`),
  sessionEvents: (id: number, offset = 0, limit = 500) =>
    request<{ session_id: number; offset: number; count: number; events: SessionEvent[] }>(
      `/api/sessions/${id}/events?offset=${offset}&limit=${limit}`
    ),
  exportSessionUrl: (id: number) => `/api/sessions/${id}/export`,
  deleteSession: (id: number) =>
    request<{ ok: boolean; deleted_events: number }>(`/api/sessions/${id}`, {
      method: 'DELETE',
    }),

  // ----- Emulators (AVDs) -----
  emulators: () => request<AvdInfo[]>('/api/emulators'),
  startEmulator: (name: string) =>
    request<{ ok: boolean; pid: number; log: string }>(
      `/api/emulators/${encodeURIComponent(name)}/start`,
      { method: 'POST' }
    ),

  // ----- Codeshare -----
  codeshareBrowse: (q?: string, refresh?: boolean) => {
    const qs = new URLSearchParams()
    if (q) qs.set('q', q)
    if (refresh) qs.set('refresh', 'true')
    const suffix = qs.toString() ? `?${qs}` : ''
    return request<CodeshareEntry[]>(`/api/codeshare/browse${suffix}`)
  },
  codeshareProject: (handle: string, slug: string) =>
    request<CodeshareProject>(
      `/api/codeshare/project/${encodeURIComponent(handle)}/${encodeURIComponent(slug)}`
    ),
  codeshareImport: (handle: string, slug: string) =>
    request<{
      ok: boolean
      snippet_id: number
      full_slug: string
      fingerprint: string
    }>(
      `/api/codeshare/import/${encodeURIComponent(handle)}/${encodeURIComponent(slug)}`,
      { method: 'POST' }
    ),
}
