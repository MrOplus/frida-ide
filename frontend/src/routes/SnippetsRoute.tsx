import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import Editor from '@monaco-editor/react'
import { Search, Sparkles, Send, Library, Globe } from 'lucide-react'
import { useNavigate } from 'react-router-dom'

import { api, type SnippetInfo } from '@/lib/api'
import { SnippetCard } from '@/components/snippets/SnippetCard'
import { CodeshareBrowser } from '@/components/snippets/CodeshareBrowser'
import { useEditorStore } from '@/store/editorStore'
import { cn } from '@/lib/utils'

type Tab = 'local' | 'codeshare'

export function SnippetsRoute() {
  const [tab, setTab] = useState<Tab>('local')
  const [query, setQuery] = useState('')
  const [selectedTag, setSelectedTag] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [paramValues, setParamValues] = useState<Record<string, string>>({})
  const navigate = useNavigate()
  const setSource = useEditorStore((s) => s.setSource)

  const snippetsQuery = useQuery({
    queryKey: ['snippets'],
    queryFn: () => api.snippets(),
  })

  const allTags = useMemo(() => {
    const set = new Set<string>()
    snippetsQuery.data?.forEach((s) => s.tags.forEach((t) => set.add(t)))
    return Array.from(set).sort()
  }, [snippetsQuery.data])

  const filtered = useMemo(() => {
    const list = snippetsQuery.data ?? []
    const q = query.toLowerCase().trim()
    return list.filter((s) => {
      if (selectedTag && !s.tags.includes(selectedTag)) return false
      if (q) {
        const hay = (
          s.name +
          ' ' +
          (s.description ?? '') +
          ' ' +
          s.tags.join(' ')
        ).toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })
  }, [snippetsQuery.data, query, selectedTag])

  const selected = useMemo<SnippetInfo | null>(() => {
    if (selectedId == null) return null
    return snippetsQuery.data?.find((s) => s.id === selectedId) ?? null
  }, [snippetsQuery.data, selectedId])

  const insertIntoEditor = async () => {
    if (!selected) return
    let source = selected.source
    if (selected.parameters.length > 0) {
      const rendered = await api.renderSnippet(selected.id, paramValues)
      source = rendered.source
    }
    setSource(source)
    navigate('/devices')
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border bg-bg-elevated px-4 py-3">
        <div className="flex items-center gap-4">
          <h1 className="text-lg font-semibold text-fg-strong">Snippets</h1>
          <div className="flex items-center gap-1 rounded-md border border-border p-0.5">
            <SourceTab active={tab === 'local'} onClick={() => setTab('local')}>
              <Library className="h-3 w-3" />
              Local
            </SourceTab>
            <SourceTab
              active={tab === 'codeshare'}
              onClick={() => setTab('codeshare')}
            >
              <Globe className="h-3 w-3" />
              CodeShare
            </SourceTab>
          </div>
        </div>
        <span className="text-xs text-fg-muted">
          {tab === 'local'
            ? `${snippetsQuery.data?.length ?? 0} local`
            : 'codeshare.frida.re'}
        </span>
      </div>

      {tab === 'codeshare' ? (
        <CodeshareBrowser />
      ) : (
        <LocalSnippetsBody
          query={query}
          setQuery={setQuery}
          selectedTag={selectedTag}
          setSelectedTag={setSelectedTag}
          selectedId={selectedId}
          setSelectedId={setSelectedId}
          paramValues={paramValues}
          setParamValues={setParamValues}
          insertIntoEditor={insertIntoEditor}
          allTags={allTags}
          filtered={filtered}
          selected={selected}
        />
      )}
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
      className={cn(
        'flex items-center gap-1 rounded px-2.5 py-1 text-xs transition-colors',
        active
          ? 'bg-bg-hover text-fg-strong'
          : 'text-fg-muted hover:text-fg'
      )}
    >
      {children}
    </button>
  )
}

interface LocalBodyProps {
  query: string
  setQuery: React.Dispatch<React.SetStateAction<string>>
  selectedTag: string | null
  setSelectedTag: React.Dispatch<React.SetStateAction<string | null>>
  selectedId: number | null
  setSelectedId: React.Dispatch<React.SetStateAction<number | null>>
  paramValues: Record<string, string>
  setParamValues: React.Dispatch<React.SetStateAction<Record<string, string>>>
  insertIntoEditor: () => void
  allTags: string[]
  filtered: SnippetInfo[]
  selected: SnippetInfo | null
}

function LocalSnippetsBody({
  query,
  setQuery,
  selectedTag,
  setSelectedTag,
  selectedId,
  setSelectedId,
  paramValues,
  setParamValues,
  insertIntoEditor,
  allTags,
  filtered,
  selected,
}: LocalBodyProps) {
  return (
    <div className="flex flex-1 overflow-hidden">
      {/* Sidebar: filters + list */}
        <aside className="flex w-80 shrink-0 flex-col border-r border-border bg-bg-elevated">
          <div className="space-y-2 border-b border-border p-3">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-fg-muted" />
              <input
                type="text"
                placeholder="Search snippets…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="w-full rounded-md border border-border bg-bg py-1.5 pl-8 pr-3 text-sm text-fg focus:border-accent focus:outline-none"
              />
            </div>
            {allTags.length > 0 && (
              <div className="flex flex-wrap gap-1">
                <TagPill
                  active={selectedTag == null}
                  onClick={() => setSelectedTag(null)}
                >
                  All
                </TagPill>
                {allTags.map((t) => (
                  <TagPill
                    key={t}
                    active={selectedTag === t}
                    onClick={() => setSelectedTag(t)}
                  >
                    {t}
                  </TagPill>
                ))}
              </div>
            )}
          </div>

          <div className="flex-1 space-y-2 overflow-auto p-3">
            {filtered.map((s) => (
              <SnippetCard
                key={s.id}
                snippet={s}
                active={selectedId === s.id}
                onClick={() => {
                  setSelectedId(s.id)
                  // Reset param values when switching snippets
                  setParamValues({})
                }}
              />
            ))}
            {filtered.length === 0 && (
              <div className="py-8 text-center text-sm text-fg-muted">
                No snippets match your filter.
              </div>
            )}
          </div>
        </aside>

        {/* Main: preview + insert */}
        <div className="flex flex-1 flex-col overflow-hidden">
          {selected ? (
            <>
              <div className="flex items-center justify-between border-b border-border bg-bg-elevated px-4 py-2">
                <div>
                  <div className="text-sm font-medium text-fg-strong">{selected.name}</div>
                  {selected.description && (
                    <div className="text-xs text-fg-muted">{selected.description}</div>
                  )}
                </div>
                <button
                  onClick={insertIntoEditor}
                  className="flex items-center gap-1.5 rounded-md bg-accent-muted px-3 py-1.5 text-sm font-medium text-fg-strong hover:bg-accent"
                >
                  <Send className="h-3.5 w-3.5" />
                  Insert into editor
                </button>
              </div>

              {selected.parameters.length > 0 && (
                <div className="border-b border-border bg-bg-elevated/50 p-3">
                  <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-fg-strong">
                    <Sparkles className="h-3 w-3 text-warning" />
                    Parameters
                  </div>
                  <div className="space-y-2">
                    {selected.parameters.map((p) => (
                      <label key={p.name} className="block">
                        <div className="mb-0.5 text-xs text-fg-muted">
                          <span className="font-mono text-fg">{p.name}</span>
                          {p.required && <span className="ml-1 text-danger">*</span>}
                          {p.description && (
                            <span className="ml-2">— {p.description}</span>
                          )}
                        </div>
                        <input
                          type="text"
                          value={paramValues[p.name] ?? ''}
                          onChange={(e) =>
                            setParamValues((v) => ({ ...v, [p.name]: e.target.value }))
                          }
                          className="w-full rounded border border-border bg-bg px-2 py-1 font-mono text-xs text-fg focus:border-accent focus:outline-none"
                          placeholder={`{{${p.name}}}`}
                        />
                      </label>
                    ))}
                  </div>
                </div>
              )}

              <div className="flex-1">
                <Editor
                  height="100%"
                  language="javascript"
                  theme="vs-dark"
                  value={selected.source}
                  options={{
                    readOnly: true,
                    fontSize: 13,
                    fontFamily:
                      '"JetBrains Mono", ui-monospace, "SF Mono", Consolas, monospace',
                    minimap: { enabled: false },
                    scrollBeyondLastLine: false,
                    automaticLayout: true,
                  }}
                />
              </div>
            </>
          ) : (
            <div className="flex h-full items-center justify-center p-8 text-center text-sm text-fg-muted">
              Pick a snippet on the left to preview and insert into the editor.
            </div>
          )}
        </div>
    </div>
  )
}

function TagPill({
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
      className={cn(
        'rounded px-2 py-0.5 text-xs',
        active
          ? 'bg-accent-muted text-fg-strong'
          : 'border border-border bg-bg text-fg-muted hover:text-fg'
      )}
    >
      {children}
    </button>
  )
}
