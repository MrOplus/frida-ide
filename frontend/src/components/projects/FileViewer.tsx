import { useEffect, useMemo, useRef } from 'react'
import Editor, { type OnMount } from '@monaco-editor/react'
import { useQuery } from '@tanstack/react-query'
import { Loader2, FileX, FileText } from 'lucide-react'

import { api } from '@/lib/api'
import { ApiError } from '@/lib/api'

interface Props {
  projectId: number
  source: 'jadx' | 'apktool'
  path: string | null
}

const EXT_TO_LANG: Record<string, string> = {
  '.java': 'java',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  '.xml': 'xml',
  '.json': 'json',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.html': 'html',
  '.js': 'javascript',
  '.ts': 'typescript',
  '.css': 'css',
  '.md': 'markdown',
  '.py': 'python',
  '.c': 'c',
  '.cpp': 'cpp',
  '.h': 'cpp',
  '.smali': 'java', // closest match for highlighting
}

function langForPath(path: string): string {
  const lower = path.toLowerCase()
  const dot = lower.lastIndexOf('.')
  if (dot < 0) return 'plaintext'
  return EXT_TO_LANG[lower.slice(dot)] ?? 'plaintext'
}

export function FileViewer({ projectId, source, path }: Props) {
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null)

  const fileQuery = useQuery({
    queryKey: ['fileContent', projectId, source, path],
    queryFn: () => api.fileContent(projectId, path!, source),
    enabled: !!path,
    staleTime: 60_000,
    retry: false,
  })

  const language = useMemo(() => (path ? langForPath(path) : 'plaintext'), [path])

  useEffect(() => {
    const onResize = () => editorRef.current?.layout()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  if (!path) {
    return (
      <Empty>
        <FileText className="h-8 w-8" />
        <div className="mt-2 text-sm">Select a file from the tree</div>
      </Empty>
    )
  }

  if (fileQuery.isLoading) {
    return (
      <Empty>
        <Loader2 className="h-6 w-6 animate-spin" />
      </Empty>
    )
  }

  if (fileQuery.isError) {
    const err = fileQuery.error as Error
    const detail =
      err instanceof ApiError && err.body && typeof err.body === 'object'
        ? (err.body as { detail?: string }).detail ?? err.message
        : err.message
    return (
      <Empty>
        <FileX className="h-8 w-8 text-danger" />
        <div className="mt-2 max-w-md text-center text-sm text-danger">{detail}</div>
        <div className="mt-1 text-xs text-fg-muted">{path}</div>
      </Empty>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border bg-bg-elevated px-4 py-2">
        <div className="flex items-center gap-2 text-xs">
          <FileText className="h-3.5 w-3.5 text-fg-muted" />
          <span className="font-mono text-fg">{path}</span>
        </div>
        <span className="text-xs text-fg-muted">{language}</span>
      </div>
      <div className="flex-1">
        <Editor
          height="100%"
          language={language}
          theme="vs-dark"
          value={fileQuery.data ?? ''}
          onMount={(editor) => {
            editorRef.current = editor
          }}
          options={{
            readOnly: true,
            fontSize: 13,
            fontFamily:
              '"JetBrains Mono", ui-monospace, "SF Mono", Consolas, monospace',
            minimap: { enabled: true },
            scrollBeyondLastLine: false,
            wordWrap: 'off',
            renderLineHighlight: 'gutter',
            smoothScrolling: true,
            automaticLayout: true,
          }}
        />
      </div>
    </div>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center text-fg-muted">
      {children}
    </div>
  )
}
