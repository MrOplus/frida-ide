/**
 * Reduces a stream of Claude stream-json events into the rendered ChatTurn[]
 * shape used by ChatPane.
 *
 * ## Dedup
 *
 * Events reach this reducer from two paths that can overlap on a single page
 * load:
 *   1. The ``/messages`` HTTP backfill (persisted rows, on mount).
 *   2. The live WebSocket stream (live events, starting at mount).
 *
 * When the page is loaded *during* an active Claude response, an event can be
 * delivered via BOTH paths (the backfill snapshot sees the persisted row, and
 * the live WS also forwards the same event). Without dedup, every such turn
 * renders twice.
 *
 * The fix: callers pass a mutable ``seen: Set<string>`` that tracks stable
 * dedup keys — primarily Claude's ``message.id`` (present on both paths, now
 * that the backend persists the full message object).
 *
 * Dedup keys by event kind:
 *
 *   - assistant (text / tool_use):  ``a:${message.id}``
 *   - user      (tool_result):      ``tr:${first tool_use_id}``
 *   - user_sent (our own echo):     ``us:${ts}:${text.length}``
 *   - system    (init / etc.):      ``sys:${subtype}:${session_id}``
 *
 * ## Event shapes
 *
 * Stream-json events (live WS path):
 *
 *   {type: "system", subtype: "init", session_id, model, ...}
 *   {type: "assistant", message: {id, role, content: [...]}}
 *   {type: "user",      message: {id, role, content: [tool_result, ...]}}
 *   {type: "result", ...}                                  (ignored)
 *   {type: "user_sent", content: "..."}                    (our own echo)
 *
 * Persisted message rows (backfill path, /messages endpoint):
 *
 *   {role: "assistant",   content: {id, role, content: [...]}}  (new shape)
 *   {role: "tool_result", content: {id, role, content: [...]}}  (new shape)
 *   {role: "user",        content: "plain text"}                (user_sent echo)
 *   {role: "system",      content: {type, subtype, session_id, model, ...}}
 *
 * Old dev DBs from before the persistence change have ``content`` as the raw
 * content array for assistant/tool_result rows — we fall back to handling that
 * shape too so stale databases don't break the chat.
 */

import type { ChatTurn, ChatToolUse } from './types'

interface ContentBlock {
  type: 'text' | 'tool_use' | 'tool_result' | string
  text?: string
  id?: string
  name?: string
  input?: Record<string, unknown>
  tool_use_id?: string
  content?: unknown
  is_error?: boolean
}

interface ClaudeMessage {
  id?: string
  role?: string
  content?: ContentBlock[] | string
}

export interface StreamEvent {
  type?: string
  subtype?: string
  message?: ClaudeMessage
  payload?: unknown
  ts?: string
  // The PubSub envelope wraps the Claude event under .payload — the reducer
  // accepts both shapes.
  [k: string]: unknown
}

let _idCounter = 0
const nextId = () => `t${++_idCounter}`

function unwrap(event: StreamEvent): StreamEvent {
  // PubSub envelope: {type:"system|assistant|user|result", ts, payload: <claude_event>}
  // The Claude event is what we want.
  if (
    event.payload &&
    typeof event.payload === 'object' &&
    'type' in (event.payload as object)
  ) {
    return event.payload as StreamEvent
  }
  return event
}

function flattenText(content: ContentBlock[] | string | undefined): string {
  if (!content) return ''
  if (typeof content === 'string') return content
  // Include thinking blocks as well — Claude's stream-json output often
  // delivers a lone thinking block as the first event for a message, and
  // dropping it caused the dedup key to be claimed by an "empty" turn,
  // which then swallowed the real text/tool_use events that followed.
  // Prefix them so the UI can still tell reasoning from final output.
  return content
    .filter(
      (c) =>
        (c.type === 'text' && typeof c.text === 'string') ||
        (c.type === 'thinking' &&
          typeof (c as ContentBlock & { thinking?: string }).thinking === 'string')
    )
    .map((c) => {
      if (c.type === 'thinking') {
        const t = (c as ContentBlock & { thinking?: string }).thinking ?? ''
        return t ? `(thinking) ${t}` : ''
      }
      return c.text!
    })
    .filter((s) => s.length > 0)
    .join('\n')
}

function extractToolUses(content: ContentBlock[] | string | undefined): ChatToolUse[] {
  if (!content || typeof content === 'string') return []
  return content
    .filter((c) => c.type === 'tool_use' && c.id && c.name)
    .map((c) => ({
      id: c.id!,
      name: c.name!,
      input: (c.input ?? {}) as Record<string, unknown>,
    }))
}

interface ToolResultEntry {
  toolUseId: string
  result: string
  isError: boolean
}

function findToolResults(content: ContentBlock[] | string | undefined): ToolResultEntry[] {
  if (!content || typeof content === 'string') return []
  const out: ToolResultEntry[] = []
  for (const c of content) {
    if (c.type !== 'tool_result' || !c.tool_use_id) continue
    let resultText = ''
    if (typeof c.content === 'string') {
      resultText = c.content
    } else if (Array.isArray(c.content)) {
      resultText = c.content
        .map((b) =>
          typeof b === 'object' && b && 'text' in b ? (b as { text: string }).text : ''
        )
        .join('')
    }
    out.push({
      toolUseId: c.tool_use_id,
      result: resultText,
      isError: !!c.is_error,
    })
  }
  return out
}

/**
 * Normalise a backfilled row ({role, content, ts}) into a stream-json-shaped
 * StreamEvent so both paths can share the same reduction code below.
 *
 * Handles both the current persistence shape (content is the full message
 * dict {id, role, content}) and the legacy shape (content is just the array).
 */
function normalizeBackfillRow(event: StreamEvent): StreamEvent | null {
  if (!('role' in event && 'content' in event)) return null
  const role = event.role as string
  const content = event.content as unknown

  if (role === 'assistant') {
    // New shape: content is {id, role, content: [...]}
    if (
      content &&
      typeof content === 'object' &&
      !Array.isArray(content) &&
      'content' in (content as object)
    ) {
      const msg = content as ClaudeMessage
      return {
        type: 'assistant',
        message: msg,
        ts: event.ts,
      }
    }
    // Legacy shape: content is the array directly
    if (Array.isArray(content)) {
      return {
        type: 'assistant',
        message: { content: content as ContentBlock[] },
        ts: event.ts,
      }
    }
    return null
  }

  if (role === 'tool_result') {
    if (
      content &&
      typeof content === 'object' &&
      !Array.isArray(content) &&
      'content' in (content as object)
    ) {
      const msg = content as ClaudeMessage
      return { type: 'user', message: msg, ts: event.ts }
    }
    if (Array.isArray(content)) {
      return {
        type: 'user',
        message: { content: content as ContentBlock[] },
        ts: event.ts,
      }
    }
    return null
  }

  if (role === 'user') {
    // user_sent echo: content is a plain string. The backfill row also has
    // ``id`` (DB row pk) — pass it through as ``db_id`` so dedupKey can
    // produce a stable ``us:db:<id>`` key that matches the live WS path,
    // which now carries the same id on the payload (see claude_runner.py
    // send_user_message).
    if (typeof content === 'string') {
      return {
        type: 'user_sent',
        content,
        ts: event.ts,
        db_id: (event as { id?: number }).id,
      } as StreamEvent
    }
    return null
  }

  if (role === 'system') {
    if (content && typeof content === 'object') {
      return { ...(content as object), ts: event.ts } as StreamEvent
    }
    return null
  }

  return null
}


export function reduceEvent(
  turns: ChatTurn[],
  rawEvent: StreamEvent,
): ChatTurn[] {
  // Normalise backfilled rows into stream-json shape so the rest of this
  // function only deals with one event format.
  const normalized = normalizeBackfillRow(rawEvent) ?? unwrap(rawEvent)
  const event = normalized
  const eventType = event.type

  if (eventType === 'user_sent') {
    const text = (event as { content?: string }).content ?? ''
    return [
      ...turns,
      {
        id: nextId(),
        role: 'user',
        text,
        toolUses: [],
        ts: (event.ts as string) ?? new Date().toISOString(),
      },
    ]
  }

  if (eventType === 'system') {
    const subtype = (event as { subtype?: string }).subtype
    if (subtype === 'init') {
      const model = (event as { model?: string }).model
      return [
        ...turns,
        {
          id: nextId(),
          role: 'system',
          text: `Session initialized · model=${model ?? '?'}`,
          toolUses: [],
          ts: (event.ts as string) ?? new Date().toISOString(),
        },
      ]
    }
    return turns
  }

  if (eventType === 'assistant' && event.message) {
    const text = flattenText(event.message.content)
    const toolUses = extractToolUses(event.message.content)
    if (!text && toolUses.length === 0) return turns
    return [
      ...turns,
      {
        id: nextId(),
        role: 'assistant',
        text,
        toolUses,
        ts: (event.ts as string) ?? new Date().toISOString(),
      },
    ]
  }

  if (eventType === 'user' && event.message) {
    // Tool results — attach them to the matching tool_use in the prior assistant turn
    const results = findToolResults(event.message.content)
    if (results.length === 0) return turns
    const updated = [...turns]
    for (let i = updated.length - 1; i >= 0; i--) {
      const turn = updated[i]
      let touched = false
      const newToolUses = turn.toolUses.map((tu) => {
        const match = results.find((r) => r.toolUseId === tu.id)
        if (match) {
          touched = true
          return { ...tu, result: match.result, isError: match.isError }
        }
        return tu
      })
      if (touched) {
        updated[i] = { ...turn, toolUses: newToolUses }
        break
      }
    }
    return updated
  }

  return turns
}
