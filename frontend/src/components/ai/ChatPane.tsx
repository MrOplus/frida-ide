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

/**
 * AI chat pane. Hydration strategy:
 *
 *   1. On mount (or when sessionId changes), fetch ``/messages`` and reduce
 *      every persisted row into ``turns``. This is the full durable history.
 *   2. **Only after** the backfill is done, connect the live WS with
 *      ``initialLastEventId = null`` (live-only, no replay). This means the
 *      WS only delivers events that arrive *after* the backfill snapshot —
 *      zero overlap, zero duplicates, no dedup machinery.
 *
 * The only theoretical gap is events persisted between the backfill read and
 * the WS connect (milliseconds). In practice this is at most 1–2 tool-result
 * blocks for a session that was actively streaming while the page loaded; a
 * single browser refresh fills them in.
 */
export function ChatPane({ projectId, sessionId }: Props) {
  const [turns, setTurns] = useState<ChatTurn[]>([])
  const [input, setInput] = useState('')
  const [thinking, setThinking] = useState(false)
  const [thinkingTooLong, setThinkingTooLong] = useState(false)
  const thinkingTimerRef = useRef<number | null>(null)
  const [backfillDone, setBackfillDone] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  // When "thinking" starts, set a 45-second timer. If Claude still hasn't
  // responded, show a "taking too long" warning with recovery options.
  useEffect(() => {
    if (thinkingTimerRef.current != null) {
      window.clearTimeout(thinkingTimerRef.current)
      thinkingTimerRef.current = null
    }
    if (thinking) {
      setThinkingTooLong(false)
      thinkingTimerRef.current = window.setTimeout(() => {
        setThinkingTooLong(true)
      }, 45_000)
    } else {
      setThinkingTooLong(false)
    }
    return () => {
      if (thinkingTimerRef.current != null) {
        window.clearTimeout(thinkingTimerRef.current)
      }
    }
  }, [thinking])

  // ---- Phase 1: backfill from /messages ----

  useEffect(() => {
    setTurns([])
    setBackfillDone(false)
    setThinking(false)

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
            id: m.id,
          } as StreamEvent)
        }
        setTurns(acc)
        setBackfillDone(true)
      })
      .catch(() => {
        // Empty session or API error — still let the WS connect
        if (!cancelled) setBackfillDone(true)
      })
    return () => {
      cancelled = true
    }
  }, [projectId, sessionId])

  // ---- Phase 2: live WS (starts AFTER backfill) ----

  useStreamingWs({
    path: `/ws/ai/${sessionId}`,
    enabled: backfillDone,
    initialLastEventId: null,
    onMessage: (msg: WsEnvelope) => {
      const rawType = msg.type
      const payloadType = (msg as { payload?: { type?: string } }).payload?.type

      // Clear the "thinking" spinner on any terminal event from Claude:
      //   result  — normal completion (success or error)
      //   exited  — subprocess died (crash, timeout, SIGHUP on restart)
      if (
        rawType === 'result' ||
        rawType === 'exited' ||
        payloadType === 'result' ||
        payloadType === 'exited'
      ) {
        setThinking(false)
      }

      // Skip user_sent echoes — the user's message is already shown via
      // the optimistic insert in sendMutation.onMutate. Without this,
      // the same text would appear twice (once optimistic, once from WS).
      if (rawType === 'user_sent' || payloadType === 'user_sent') return

      // Surface subprocess exit as a visible system turn.
      if (rawType === 'exited' || payloadType === 'exited') {
        const rc =
          (msg as { returncode?: number }).returncode ??
          (msg as { payload?: { returncode?: number } }).payload?.returncode
        setTurns((prev) => [
          ...prev,
          {
            id: `exit-${Date.now()}`,
            role: 'system' as const,
            text:
              rc === 0
                ? 'Claude session ended.'
                : `Claude exited (code ${rc ?? '?'}). The session may have crashed or timed out. You can resume from the sidebar.`,
            toolUses: [],
            ts: new Date().toISOString(),
          },
        ])
        return
      }

      setTurns((prev) => reduceEvent(prev, msg as StreamEvent))
    },
    onClose: () => {
      // WS dropped (backend restart, network glitch). Clear the spinner so
      // the user isn't stuck staring at "Claude is thinking…" forever.
      setThinking(false)
    },
  })

  // ---- Autoscroll on new turns ----

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [turns])

  // ---- Sidebar preset injection listener ----

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<string>).detail
      if (typeof detail === 'string') setInput(detail)
    }
    window.addEventListener('frida-ide:inject-prompt', handler as EventListener)
    return () =>
      window.removeEventListener('frida-ide:inject-prompt', handler as EventListener)
  }, [])

  // ---- Send message ----

  const sendMutation = useMutation({
    mutationFn: (text: string) => api.sendAiMessage(projectId, sessionId, text),
    onMutate: (text) => {
      setThinking(true)
      // Show the user's message immediately so the chat never looks blank
      // after hitting Send. The WS echo (``user_sent``) is intentionally
      // suppressed below so it doesn't duplicate this optimistic turn.
      setTurns((prev) => [
        ...prev,
        {
          id: `opt-${Date.now()}`,
          role: 'user' as const,
          text,
          toolUses: [],
          ts: new Date().toISOString(),
        },
      ])
    },
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
        {!backfillDone && (
          <div className="flex items-center gap-2 px-4 py-8 text-sm text-fg-muted">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading messages…
          </div>
        )}
        {backfillDone && turns.length === 0 && (
          <div className="px-4 py-8 text-center text-sm text-fg-muted">
            No messages yet. Ask Claude something about the decompiled code.
          </div>
        )}
        {turns.map((turn) => (
          <ChatMessage key={turn.id} turn={turn} />
        ))}
        {thinking && (
          <div className="px-4 py-2">
            <div className="flex items-center gap-2 text-xs text-fg-muted">
              <Loader2 className="h-3 w-3 animate-spin" />
              Claude is thinking…
            </div>
            {thinkingTooLong && (
              <div className="mt-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
                Taking longer than usual — Claude's API may be slow or the
                subprocess might be stuck. You can stop the session and
                resume to retry.
              </div>
            )}
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
