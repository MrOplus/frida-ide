import { useEffect, useRef, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { Send, Loader2 } from 'lucide-react'

import { api } from '@/lib/api'
import { useStreamingWs, type WsEnvelope } from '@/lib/ws'
import { cn } from '@/lib/utils'
import { ChatMessage } from './ChatMessage'
import { reduceEvent, type StreamEvent } from './streamReducer'
import type { ChatTurn } from './types'

interface Props {
  projectId: number
  sessionId: number
}

export function ChatPane({ projectId, sessionId }: Props) {
  const [turns, setTurns] = useState<ChatTurn[]>([])
  const [input, setInput] = useState('')
  const [thinking, setThinking] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  // Backfill from /messages on mount so reload restores the conversation.
  useEffect(() => {
    let cancelled = false
    api
      .getAiMessages(projectId, sessionId)
      .then((msgs) => {
        if (cancelled) return
        let acc: ChatTurn[] = []
        for (const m of msgs) {
          acc = reduceEvent(acc, {
            role: m.role,
            content: m.content,
            ts: m.ts,
          } as StreamEvent)
        }
        setTurns(acc)
      })
      .catch(() => {
        /* ignore — empty session is fine */
      })
    return () => {
      cancelled = true
    }
  }, [projectId, sessionId])

  // Live updates from the runner via WS. We use `initialLastEventId: null`
  // (live-only) because the /messages backfill above is already the source
  // of truth for history. Asking the WS to also replay (-1) double-feeds
  // every turn into reduceEvent, which is what caused the duplicate
  // assistant/tool_use blocks in the UI.
  useStreamingWs({
    path: `/ws/ai/${sessionId}`,
    enabled: true,
    initialLastEventId: null,
    onMessage: (msg: WsEnvelope) => {
      // Detect "thinking" state from result events
      if (msg.type === 'result' || (msg as { payload?: { type?: string } }).payload?.type === 'result') {
        setThinking(false)
      }
      setTurns((prev) => reduceEvent(prev, msg as StreamEvent))
    },
  })

  // Autoscroll on new turns
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [turns])

  // Listen for sidebar preset injections
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<string>).detail
      if (typeof detail === 'string') setInput(detail)
    }
    window.addEventListener('frida-ide:inject-prompt', handler as EventListener)
    return () =>
      window.removeEventListener('frida-ide:inject-prompt', handler as EventListener)
  }, [])

  const sendMutation = useMutation({
    mutationFn: (text: string) => api.sendAiMessage(projectId, sessionId, text),
    onMutate: () => setThinking(true),
    onError: () => setThinking(false),
  })

  const handleSend = () => {
    const text = input.trim()
    if (!text || sendMutation.isPending) return
    sendMutation.mutate(text)
    setInput('')
  }

  return (
    <div className="flex h-full flex-col">
      <div ref={scrollRef} className="flex-1 overflow-auto">
        {turns.length === 0 && (
          <div className="px-4 py-8 text-center text-sm text-fg-muted">
            No messages yet. Ask Claude something about the decompiled code.
          </div>
        )}
        {turns.map((turn) => (
          <ChatMessage key={turn.id} turn={turn} />
        ))}
        {thinking && (
          <div className="flex items-center gap-2 px-4 py-2 text-xs text-fg-muted">
            <Loader2 className="h-3 w-3 animate-spin" />
            Claude is thinking…
          </div>
        )}
      </div>

      <div className="border-t border-border bg-bg-elevated p-3">
        <div className="flex items-end gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault()
                handleSend()
              }
            }}
            placeholder="Ask Claude (Cmd/Ctrl+Enter to send)…"
            rows={2}
            className="flex-1 resize-none rounded-md border border-border bg-bg px-3 py-2 text-sm text-fg placeholder:text-fg-muted/60 focus:border-accent focus:outline-none"
          />
          <button
            onClick={handleSend}
            disabled={!input.trim() || sendMutation.isPending}
            className={cn(
              'flex h-10 items-center gap-1 rounded-md bg-accent-muted px-3 text-sm font-medium text-fg-strong hover:bg-accent disabled:opacity-50'
            )}
          >
            <Send className="h-3.5 w-3.5" />
            Send
          </button>
        </div>
      </div>
    </div>
  )
}
