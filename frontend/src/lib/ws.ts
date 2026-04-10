/**
 * Reconnecting WebSocket client with replay-from-event-id and heartbeat.
 *
 * Used by the editor's xterm output console, the AI chat stream, the device
 * dashboard, and the APK pipeline progress view. All four backends share the
 * same envelope shape: { event_id, type, ts, payload }.
 */

import { useEffect, useRef } from 'react'

export interface WsEnvelope {
  event_id?: number
  type: string
  ts?: string
  payload?: unknown
  [key: string]: unknown
}

export interface UseStreamingWsOptions {
  /**
   * Path on the same origin (e.g. "/ws/devices"). The Vite dev server proxies
   * /ws/* to the backend; in production FastAPI serves both.
   */
  path: string
  enabled?: boolean
  onMessage: (msg: WsEnvelope) => void
  onOpen?: () => void
  onClose?: () => void
  onError?: (err: Event) => void
  /** If set, request replay of buffered events newer than this id. */
  initialLastEventId?: number | null
}

const HEARTBEAT_MS = 15_000
const RECONNECT_INITIAL_MS = 1_000
const RECONNECT_MAX_MS = 30_000

export function useStreamingWs({
  path,
  enabled = true,
  onMessage,
  onOpen,
  onClose,
  onError,
  initialLastEventId = null,
}: UseStreamingWsOptions) {
  const wsRef = useRef<WebSocket | null>(null)
  const lastEventIdRef = useRef<number | null>(initialLastEventId)
  const reconnectDelayRef = useRef<number>(RECONNECT_INITIAL_MS)
  const heartbeatTimerRef = useRef<number | null>(null)
  const reconnectTimerRef = useRef<number | null>(null)
  const closedByUserRef = useRef<boolean>(false)
  const onMessageRef = useRef(onMessage)
  const onOpenRef = useRef(onOpen)
  const onCloseRef = useRef(onClose)
  const onErrorRef = useRef(onError)

  // Keep callback refs fresh without retriggering connect
  useEffect(() => {
    onMessageRef.current = onMessage
    onOpenRef.current = onOpen
    onCloseRef.current = onClose
    onErrorRef.current = onError
  }, [onMessage, onOpen, onClose, onError])

  useEffect(() => {
    if (!enabled) return

    closedByUserRef.current = false

    const connect = () => {
      if (closedByUserRef.current) return

      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      const qs =
        lastEventIdRef.current != null
          ? `?last_event_id=${lastEventIdRef.current}`
          : ''
      const url = `${proto}//${window.location.host}${path}${qs}`

      const ws = new WebSocket(url)
      wsRef.current = ws

      ws.onopen = () => {
        reconnectDelayRef.current = RECONNECT_INITIAL_MS
        startHeartbeat()
        onOpenRef.current?.()
      }

      ws.onmessage = (ev) => {
        let parsed: WsEnvelope
        try {
          parsed = JSON.parse(ev.data) as WsEnvelope
        } catch {
          return
        }
        if (typeof parsed.event_id === 'number') {
          lastEventIdRef.current = parsed.event_id
        }
        if (parsed.type === 'pong') return // heartbeat ack
        if (parsed.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong' }))
          return
        }
        onMessageRef.current(parsed)
      }

      ws.onerror = (e) => {
        onErrorRef.current?.(e)
      }

      ws.onclose = () => {
        stopHeartbeat()
        wsRef.current = null
        onCloseRef.current?.()
        if (closedByUserRef.current) return
        scheduleReconnect()
      }
    }

    const scheduleReconnect = () => {
      const delay = reconnectDelayRef.current
      reconnectDelayRef.current = Math.min(delay * 2, RECONNECT_MAX_MS)
      reconnectTimerRef.current = window.setTimeout(connect, delay)
    }

    const startHeartbeat = () => {
      stopHeartbeat()
      heartbeatTimerRef.current = window.setInterval(() => {
        const ws = wsRef.current
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'ping' }))
        }
      }, HEARTBEAT_MS)
    }

    const stopHeartbeat = () => {
      if (heartbeatTimerRef.current != null) {
        window.clearInterval(heartbeatTimerRef.current)
        heartbeatTimerRef.current = null
      }
    }

    connect()

    return () => {
      closedByUserRef.current = true
      if (reconnectTimerRef.current != null) {
        window.clearTimeout(reconnectTimerRef.current)
        reconnectTimerRef.current = null
      }
      stopHeartbeat()
      const ws = wsRef.current
      if (ws) {
        ws.close()
        wsRef.current = null
      }
    }
    // We intentionally only re-subscribe when path/enabled change.
    // Callbacks are tracked via refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, enabled])
}
