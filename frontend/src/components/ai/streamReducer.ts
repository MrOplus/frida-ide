/**
 * Reduces a stream of Claude stream-json events into the rendered ChatTurn[]
 * shape used by ChatPane. Persistent (no React state needed) so it can also
 * back-fill from /messages on first mount.
 *
 * Stream-json event shapes (the ones we care about):
 *
 *   {type: "system", subtype: "init", ...}                  -> system turn
 *   {type: "assistant", message: {role, content: [...]}}    -> assistant turn
 *   {type: "user", message: {role, content: [tool_result]}} -> append tool_result to last turn
 *   {type: "result", subtype, ...}                          -> ignored (could show "done")
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

export interface StreamEvent {
  type?: string
  subtype?: string
  message?: { role?: string; content?: ContentBlock[] | string }
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
  return content
    .filter((c) => c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text!)
    .join('')
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

function findToolResultsInUserMessage(
  content: ContentBlock[] | string | undefined
): { toolUseId: string; result: string; isError: boolean }[] {
  if (!content || typeof content === 'string') return []
  const out: { toolUseId: string; result: string; isError: boolean }[] = []
  for (const c of content) {
    if (c.type !== 'tool_result' || !c.tool_use_id) continue
    let resultText = ''
    if (typeof c.content === 'string') {
      resultText = c.content
    } else if (Array.isArray(c.content)) {
      resultText = c.content
        .map((b) => (typeof b === 'object' && b && 'text' in b ? (b as { text: string }).text : ''))
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

export function reduceEvent(turns: ChatTurn[], rawEvent: StreamEvent): ChatTurn[] {
  const event = unwrap(rawEvent)
  const eventType = event.type

  if (eventType === 'user_sent') {
    // Our own server-side echo when the client sends a message
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
    const results = findToolResultsInUserMessage(event.message.content)
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
        // We've matched all the tool results we needed — done
        break
      }
    }
    return updated
  }

  // Persisted message rows (from /messages endpoint, replay path) come in
  // shaped slightly differently — they have role + content only.
  if ('role' in event && 'content' in event) {
    const role = event.role as string
    const content = event.content as ContentBlock[] | string
    if (role === 'user' && typeof content === 'string') {
      return [
        ...turns,
        { id: nextId(), role: 'user', text: content, toolUses: [], ts: (event.ts as string) ?? '' },
      ]
    }
    if (role === 'assistant') {
      const text = flattenText(content)
      const toolUses = extractToolUses(content)
      if (!text && toolUses.length === 0) return turns
      return [
        ...turns,
        {
          id: nextId(),
          role: 'assistant',
          text,
          toolUses,
          ts: (event.ts as string) ?? '',
        },
      ]
    }
    if (role === 'tool_result') {
      const results = findToolResultsInUserMessage(content as ContentBlock[])
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
  }

  return turns
}
