/**
 * Frontend representation of a chat turn, normalized from Claude stream-json
 * events. Each turn collects the text + tool_use blocks emitted by one
 * "assistant" event, plus the corresponding tool_results that arrive as a
 * "user" event afterwards.
 */

export interface ChatToolUse {
  id: string
  name: string
  input: Record<string, unknown>
  result?: string
  isError?: boolean
}

export interface ChatTurn {
  id: string
  role: 'user' | 'assistant' | 'system'
  text: string
  toolUses: ChatToolUse[]
  ts: string
}
