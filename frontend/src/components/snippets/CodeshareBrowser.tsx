import { useMemo, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import Editor from '@monaco-editor/react'
import {
  Search,
  Download,
  ExternalLink,
  ThumbsUp,
  Eye,
  Loader2,
  CheckCircle2,
  AlertCircle,
  RefreshCw,
} from 'lucide-react'

import { api, type CodeshareEntry } from '@/lib/api'
import { cn } from '@/lib/utils'

export function CodeshareBrowser() {
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<CodeshareEntry | null>(null)
  const qc = useQueryClient()

  const browseQuery = useQuery({
    queryKey: ['codeshare', 'browse'],
    queryFn: () => api.codeshareBrowse(),
    staleTime: 5 * 60 * 1000,
  })

  const projectQuery = useQuery({
    queryKey: [
      'codeshare',
      'project',
      selected?.handle,
      selected?.slug,
    ],
    queryFn: () => api.codeshareProject(selected!.handle, selected!.slug),
    enabled: !!selected,
    staleTime: 5 * 60 * 1000,
  })

  const importMutation = useMutation({
    mutationFn: ({ handle, slug }: { handle: string; slug: string }) =>
      api.codeshareImport(handle, slug),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['snippets'] })
    },
  })

  const filtered = useMemo(() => {
    const list = browseQuery.data ?? []
    const q = query.toLowerCase().trim()
    if (!q) return list
    return list.filter(
      (e) =>
        e.name.toLowerCase().includes(q) ||
        e.handle.toLowerCase().includes(q) ||
        e.slug.toLowerCase().includes(q) ||
        e.description.toLowerCase().includes(q)
    )
  }, [browseQuery.data, query])

  return (
    <div className="flex flex-1 overflow-hidden">
      <aside className="flex w-96 shrink-0 flex-col border-r border-border bg-bg-elevated">
        <div className="space-y-2 border-b border-border p-3">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-fg-muted" />
            <input
              type="text"
              placeholder="Search the catalog…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="w-full rounded-md border border-border bg-bg py-1.5 pl-8 pr-3 text-sm text-fg focus:border-accent focus:outline-none"
            />
          </div>
          <div className="flex items-center justify-between text-xs text-fg-muted">
            <span>
              {browseQuery.data
                ? `${filtered.length} / ${browseQuery.data.length} projects`
                : 'Loading…'}
            </span>
            <button
              onClick={() => browseQuery.refetch()}
              disabled={browseQuery.isFetching}
              className="flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-bg-hover hover:text-fg disabled:opacity-50"
            >
              <RefreshCw
                className={cn('h-3 w-3', browseQuery.isFetching && 'animate-spin')}
              />
              Refresh
            </button>
          </div>
        </div>

        <div className="flex-1 space-y-1.5 overflow-auto p-3">
          {browseQuery.isLoading && (
            <div className="py-8 text-center text-sm text-fg-muted">
              <Loader2 className="mx-auto mb-2 h-5 w-5 animate-spin" />
              Loading codeshare catalog…
            </div>
          )}
          {browseQuery.isError && (
            <div className="rounded-md border border-danger/50 bg-danger/10 p-3 text-sm text-danger">
              {(browseQuery.error as Error).message}
            </div>
          )}
          {filtered.map((entry, idx) => (
            <CodeshareCard
              key={`${entry.full_slug}-${idx}`}
              entry={entry}
              active={selected?.full_slug === entry.full_slug}
              onClick={() => setSelected(entry)}
            />
          ))}
        </div>
      </aside>

      <div className="flex flex-1 flex-col overflow-hidden">
        {selected ? (
          <>
            <div className="flex items-center justify-between border-b border-border bg-bg-elevated px-4 py-2">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-sm font-medium text-fg-strong">
                  <span className="truncate">{selected.name}</span>
                  <a
                    href={selected.url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-fg-muted hover:text-fg"
                    title="Open on codeshare.frida.re"
                  >
                    <ExternalLink className="h-3 w-3" />
                  </a>
                </div>
                <div className="mt-0.5 flex items-center gap-3 text-xs text-fg-muted">
                  <span className="font-mono">@{selected.handle}/{selected.slug}</span>
                  {selected.likes != null && (
                    <span className="flex items-center gap-1">
                      <ThumbsUp className="h-3 w-3" />
                      {selected.likes}
                    </span>
                  )}
                  {selected.views && (
                    <span className="flex items-center gap-1">
                      <Eye className="h-3 w-3" />
                      {selected.views}
                    </span>
                  )}
                </div>
              </div>
              <button
                onClick={() =>
                  importMutation.mutate({
                    handle: selected.handle,
                    slug: selected.slug,
                  })
                }
                disabled={importMutation.isPending}
                className="flex items-center gap-1.5 rounded-md bg-accent-muted px-3 py-1.5 text-sm font-medium text-fg-strong hover:bg-accent disabled:opacity-50"
              >
                {importMutation.isPending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : importMutation.isSuccess &&
                  importMutation.variables.handle === selected.handle &&
                  importMutation.variables.slug === selected.slug ? (
                  <CheckCircle2 className="h-3.5 w-3.5 text-success" />
                ) : (
                  <Download className="h-3.5 w-3.5" />
                )}
                Import as snippet
              </button>
            </div>

            {importMutation.isError && (
              <div className="flex items-center gap-1.5 border-b border-danger/40 bg-danger/10 px-4 py-2 text-xs text-danger">
                <AlertCircle className="h-3.5 w-3.5" />
                {(importMutation.error as Error).message}
              </div>
            )}

            <div className="flex-1">
              {projectQuery.isLoading && (
                <div className="flex h-full items-center justify-center text-fg-muted">
                  <Loader2 className="h-5 w-5 animate-spin" />
                </div>
              )}
              {projectQuery.isError && (
                <div className="m-4 rounded-md border border-danger/50 bg-danger/10 p-3 text-sm text-danger">
                  {(projectQuery.error as Error).message}
                </div>
              )}
              {projectQuery.data && (
                <Editor
                  height="100%"
                  language="javascript"
                  theme="vs-dark"
                  value={projectQuery.data.source}
                  options={{
                    readOnly: true,
                    fontSize: 13,
                    fontFamily:
                      '"JetBrains Mono", ui-monospace, "SF Mono", Consolas, monospace',
                    minimap: { enabled: true },
                    scrollBeyondLastLine: false,
                    automaticLayout: true,
                  }}
                />
              )}
            </div>
          </>
        ) : (
          <div className="flex h-full items-center justify-center p-8 text-center text-sm text-fg-muted">
            Pick a project on the left to preview its source.
            <br />
            Click <strong>Import as snippet</strong> to save it locally.
          </div>
        )}
      </div>
    </div>
  )
}

function CodeshareCard({
  entry,
  active,
  onClick,
}: {
  entry: CodeshareEntry
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex w-full flex-col gap-1 rounded-md border p-3 text-left transition-colors',
        active
          ? 'border-accent bg-accent-muted/15'
          : 'border-border bg-bg hover:border-fg-muted hover:bg-bg-hover'
      )}
    >
      <div className="flex items-center gap-2">
        <span className="flex-1 truncate text-sm font-medium text-fg-strong">
          {entry.name}
        </span>
      </div>
      <div className="font-mono text-[11px] text-fg-muted">
        @{entry.handle}/{entry.slug}
      </div>
      {entry.description && (
        <div className="line-clamp-2 text-xs text-fg-muted">{entry.description}</div>
      )}
      <div className="flex items-center gap-3 text-[11px] text-fg-muted">
        {entry.likes != null && (
          <span className="flex items-center gap-1">
            <ThumbsUp className="h-2.5 w-2.5" />
            {entry.likes}
          </span>
        )}
        {entry.views && (
          <span className="flex items-center gap-1">
            <Eye className="h-2.5 w-2.5" />
            {entry.views}
          </span>
        )}
      </div>
    </button>
  )
}
