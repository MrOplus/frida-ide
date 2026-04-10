import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  ChevronRight,
  ChevronDown,
  Folder,
  FolderOpen,
  FileText,
  FileCode,
  Loader2,
} from 'lucide-react'

import { api, type FileTreeEntry } from '@/lib/api'
import { cn } from '@/lib/utils'

interface Props {
  projectId: number
  source: 'jadx' | 'apktool'
  selectedPath: string | null
  onSelect: (entry: FileTreeEntry) => void
}

const CODE_EXTENSIONS = new Set([
  '.java',
  '.kt',
  '.kts',
  '.smali',
  '.js',
  '.ts',
  '.py',
  '.c',
  '.cpp',
  '.h',
])

function fileIcon(name: string) {
  const lower = name.toLowerCase()
  const ext = lower.includes('.') ? '.' + lower.split('.').pop() : ''
  if (CODE_EXTENSIONS.has(ext)) return FileCode
  return FileText
}

export function FileTree({ projectId, source, selectedPath, onSelect }: Props) {
  return (
    <div className="overflow-auto">
      <TreeNode
        projectId={projectId}
        source={source}
        path=""
        name={source === 'jadx' ? 'jadx-out' : 'apktool-out'}
        depth={0}
        defaultOpen
        selectedPath={selectedPath}
        onSelect={onSelect}
      />
    </div>
  )
}

interface NodeProps {
  projectId: number
  source: 'jadx' | 'apktool'
  path: string
  name: string
  depth: number
  defaultOpen?: boolean
  selectedPath: string | null
  onSelect: (entry: FileTreeEntry) => void
}

function TreeNode({
  projectId,
  source,
  path,
  name,
  depth,
  defaultOpen = false,
  selectedPath,
  onSelect,
}: NodeProps) {
  const [open, setOpen] = useState(defaultOpen)

  const childrenQuery = useQuery({
    queryKey: ['fileTree', projectId, source, path],
    queryFn: () => api.fileTree(projectId, path, source),
    enabled: open,
    staleTime: 60_000,
  })

  return (
    <div>
      <button
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'flex w-full items-center gap-1 px-2 py-1 text-left text-sm hover:bg-bg-hover',
          'text-fg-strong'
        )}
        style={{ paddingLeft: 8 + depth * 14 }}
      >
        {open ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-fg-muted" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-fg-muted" />
        )}
        {open ? (
          <FolderOpen className="h-3.5 w-3.5 shrink-0 text-accent" />
        ) : (
          <Folder className="h-3.5 w-3.5 shrink-0 text-accent" />
        )}
        <span className="truncate">{name}</span>
      </button>

      {open && (
        <div>
          {childrenQuery.isLoading && (
            <div
              className="flex items-center gap-1.5 py-1 text-xs text-fg-muted"
              style={{ paddingLeft: 8 + (depth + 1) * 14 }}
            >
              <Loader2 className="h-3 w-3 animate-spin" />
              loading…
            </div>
          )}
          {childrenQuery.data?.entries.map((entry) =>
            entry.type === 'dir' ? (
              <TreeNode
                key={entry.path}
                projectId={projectId}
                source={source}
                path={entry.path}
                name={entry.name}
                depth={depth + 1}
                selectedPath={selectedPath}
                onSelect={onSelect}
              />
            ) : (
              <FileLeaf
                key={entry.path}
                entry={entry}
                depth={depth + 1}
                selected={selectedPath === entry.path}
                onSelect={() => onSelect(entry)}
              />
            )
          )}
        </div>
      )}
    </div>
  )
}

function FileLeaf({
  entry,
  depth,
  selected,
  onSelect,
}: {
  entry: FileTreeEntry
  depth: number
  selected: boolean
  onSelect: () => void
}) {
  const Icon = fileIcon(entry.name)
  return (
    <button
      onClick={onSelect}
      className={cn(
        'flex w-full items-center gap-1 py-1 pr-2 text-left text-sm hover:bg-bg-hover',
        selected ? 'bg-accent-muted/40 text-fg-strong' : 'text-fg'
      )}
      style={{ paddingLeft: 8 + depth * 14 + 14 }}
    >
      <Icon className="h-3.5 w-3.5 shrink-0 text-fg-muted" />
      <span className="truncate">{entry.name}</span>
    </button>
  )
}
