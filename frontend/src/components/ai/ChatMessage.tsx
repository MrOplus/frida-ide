import { Wrench, ChevronDown, ChevronRight, User, Bot, Settings } from 'lucide-react'
import { useState } from 'react'
import { cn } from '@/lib/utils'
import type { ChatTurn, ChatToolUse } from './types'

const ROLE_ICON = {
  user: User,
  assistant: Bot,
  system: Settings,
}

export function ChatMessage({ turn }: { turn: ChatTurn }) {
  const Icon = ROLE_ICON[turn.role] ?? Bot

  return (
    <div className="border-b border-border/40 px-4 py-3">
      <div className="mb-1 flex items-center gap-2 text-xs">
        <Icon className="h-3.5 w-3.5 text-fg-muted" />
        <span
          className={cn(
            'font-medium uppercase tracking-wide',
            turn.role === 'assistant' && 'text-accent',
            turn.role === 'user' && 'text-fg-strong',
            turn.role === 'system' && 'text-fg-muted'
          )}
        >
          {turn.role}
        </span>
      </div>

      {turn.text && (
        <div className="whitespace-pre-wrap text-sm text-fg">{turn.text}</div>
      )}

      {turn.toolUses.length > 0 && (
        <div className="mt-2 space-y-1">
          {turn.toolUses.map((tu) => (
            <ToolCallRow key={tu.id} tool={tu} />
          ))}
        </div>
      )}
    </div>
  )
}

function ToolCallRow({ tool }: { tool: ChatToolUse }) {
  const [open, setOpen] = useState(false)
  const summary = formatToolSummary(tool)
  const hasResult = tool.result != null

  return (
    <div className="rounded border border-border bg-bg/50 text-xs">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 px-2 py-1 text-left text-fg-muted hover:text-fg"
      >
        {open ? (
          <ChevronDown className="h-3 w-3" />
        ) : (
          <ChevronRight className="h-3 w-3" />
        )}
        <Wrench
          className={cn(
            'h-3 w-3',
            tool.isError ? 'text-danger' : hasResult ? 'text-success' : 'text-warning animate-pulse'
          )}
        />
        <span className="font-medium text-fg">{tool.name}</span>
        <span className="truncate font-mono">{summary}</span>
      </button>
      {open && (
        <div className="border-t border-border bg-bg p-2">
          <div className="mb-1 text-fg-muted">Input:</div>
          <pre className="overflow-auto rounded bg-bg-elevated p-2 text-fg">
            {JSON.stringify(tool.input, null, 2)}
          </pre>
          {hasResult && (
            <>
              <div className="mt-2 mb-1 text-fg-muted">Result:</div>
              <pre
                className={cn(
                  'max-h-64 overflow-auto rounded bg-bg-elevated p-2',
                  tool.isError ? 'text-danger' : 'text-fg'
                )}
              >
                {tool.result}
              </pre>
            </>
          )}
        </div>
      )}
    </div>
  )
}

function formatToolSummary(tool: ChatToolUse): string {
  const input = tool.input ?? {}
  // Common claude tool inputs
  if (typeof input.file_path === 'string') return ' ' + input.file_path
  if (typeof input.path === 'string') return ' ' + input.path
  if (typeof input.pattern === 'string') return ' /' + input.pattern + '/'
  if (typeof input.command === 'string') return ' ' + input.command.slice(0, 60)
  if (typeof input.query === 'string') return ' ' + input.query.slice(0, 60)
  return ''
}
