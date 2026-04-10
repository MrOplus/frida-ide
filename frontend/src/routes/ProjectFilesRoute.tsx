import { useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { ChevronLeft, Package } from 'lucide-react'

import { api, type FileTreeEntry } from '@/lib/api'
import { FileTree } from '@/components/projects/FileTree'
import { FileViewer } from '@/components/projects/FileViewer'

export function ProjectFilesRoute() {
  const { projectId: param } = useParams<{ projectId: string }>()
  const projectId = param ? parseInt(param, 10) : null

  const projectQuery = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => api.getProject(projectId!),
    enabled: projectId != null,
  })

  const [source, setSource] = useState<'jadx' | 'apktool'>('jadx')
  const [selectedPath, setSelectedPath] = useState<string | null>(null)

  const onSelect = (entry: FileTreeEntry) => {
    setSelectedPath(entry.path)
  }

  if (projectId == null) return <div className="p-6 text-fg-muted">Invalid project</div>

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
            {projectQuery.data?.package_name ?? projectQuery.data?.name ?? `#${projectId}`}
          </span>
          {projectQuery.data?.version_name && (
            <span className="text-xs text-fg-muted">v{projectQuery.data.version_name}</span>
          )}
        </div>
        <div className="flex items-center gap-1 rounded-md border border-border p-0.5">
          <SourceTab active={source === 'jadx'} onClick={() => setSource('jadx')}>
            jadx
          </SourceTab>
          <SourceTab active={source === 'apktool'} onClick={() => setSource('apktool')}>
            apktool
          </SourceTab>
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        <div className="w-72 shrink-0 border-r border-border bg-bg-elevated">
          <FileTree
            projectId={projectId}
            source={source}
            selectedPath={selectedPath}
            onSelect={onSelect}
          />
        </div>
        <div className="flex-1">
          <FileViewer projectId={projectId} source={source} path={selectedPath} />
        </div>
      </div>
    </div>
  )
}

function SourceTab({
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
      className={`rounded px-2 py-0.5 text-xs transition-colors ${
        active ? 'bg-bg-hover text-fg-strong' : 'text-fg-muted hover:text-fg'
      }`}
    >
      {children}
    </button>
  )
}
