import { Tag, ShieldCheck, Settings as SettingsIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { SnippetInfo } from '@/lib/api'

interface Props {
  snippet: SnippetInfo
  onClick?: () => void
  active?: boolean
}

export function SnippetCard({ snippet, onClick, active }: Props) {
  const hasParams = snippet.parameters.length > 0
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex w-full flex-col gap-1.5 rounded-md border p-3 text-left transition-colors',
        active
          ? 'border-accent bg-accent-muted/15'
          : 'border-border bg-bg-elevated hover:border-fg-muted hover:bg-bg-hover'
      )}
    >
      <div className="flex items-center gap-2">
        <span className="flex-1 truncate text-sm font-medium text-fg-strong">
          {snippet.name}
        </span>
        {snippet.builtin && (
          <span
            className="flex items-center gap-0.5 rounded bg-accent-muted/30 px-1.5 py-0.5 text-[10px] font-medium uppercase text-accent"
            title="Built-in snippet"
          >
            <ShieldCheck className="h-2.5 w-2.5" />
            built-in
          </span>
        )}
        {hasParams && (
          <span
            className="flex items-center gap-0.5 rounded bg-warning/20 px-1.5 py-0.5 text-[10px] font-medium uppercase text-warning"
            title={`Requires ${snippet.parameters.length} parameter(s)`}
          >
            <SettingsIcon className="h-2.5 w-2.5" />
            params
          </span>
        )}
      </div>
      {snippet.description && (
        <div className="line-clamp-2 text-xs text-fg-muted">{snippet.description}</div>
      )}
      {snippet.tags.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          {snippet.tags.map((t) => (
            <span
              key={t}
              className="flex items-center gap-0.5 rounded bg-bg px-1.5 py-0.5 text-[10px] text-fg-muted"
            >
              <Tag className="h-2.5 w-2.5" />
              {t}
            </span>
          ))}
        </div>
      )}
    </button>
  )
}
