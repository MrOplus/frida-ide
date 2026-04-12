import { useEffect, useRef, useState } from 'react'
import { X, Terminal as TerminalIcon } from 'lucide-react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'

import { useUiStore } from '@/store/uiStore'
import { cn } from '@/lib/utils'

/**
 * A persistent pty-backed shell at the bottom of the Layout.
 *
 * The component mounts exactly once (from Layout) and stays mounted for the
 * whole session. When the user "closes" the drawer, the panel is hidden via
 * the ``hidden`` Tailwind class but the xterm + WebSocket + server-side PTY
 * stay alive, so toggling the drawer back doesn't lose shell state, history,
 * or a currently-running process.
 *
 * Protocol ({@link ../../../backend/app/routers/tty.py}):
 *   client → server   {type: "data",   data: "<base64 stdin>"}
 *                     {type: "resize", rows: N, cols: N}
 *                     {type: "ping"}
 *   server → client   {type: "data",   data: "<base64 stdout>"}
 *                     {type: "ready"}
 *                     {type: "pong"}
 */
export function BottomConsole() {
  const open = useUiStore((s) => s.bottomConsoleOpen)
  const height = useUiStore((s) => s.bottomConsoleHeight)
  const setHeight = useUiStore((s) => s.setBottomConsoleHeight)
  const setOpen = useUiStore((s) => s.setBottomConsoleOpen)

  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectTimerRef = useRef<number | null>(null)
  const reconnectingRef = useRef(false)

  const [status, setStatus] = useState<'connecting' | 'open' | 'closed'>(
    'connecting'
  )

  // Initialise xterm + WS once on mount, tear down on unmount. Both sides
  // survive route changes because this component lives at the Layout level.
  useEffect(() => {
    if (!containerRef.current) return

    const term = new Terminal({
      convertEol: false,
      cursorBlink: true,
      cursorStyle: 'bar',
      fontFamily:
        '"JetBrains Mono", ui-monospace, "SF Mono", Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.2,
      theme: {
        background: '#0d1117',
        foreground: '#c9d1d9',
        cursor: '#58a6ff',
        selectionBackground: '#1f6feb55',
      },
      scrollback: 10_000,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new WebLinksAddon())
    term.open(containerRef.current)
    termRef.current = term
    fitRef.current = fit
    // First fit after mount so cols/rows are valid before we connect
    try {
      fit.fit()
    } catch {
      /* ignore — container may be display:none */
    }

    // ---- WebSocket ---------------------------------------------------

    const sendResize = () => {
      const ws = wsRef.current
      if (!ws || ws.readyState !== WebSocket.OPEN) return
      ws.send(
        JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows })
      )
    }

    const connect = () => {
      reconnectingRef.current = false
      setStatus('connecting')
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      const ws = new WebSocket(`${proto}//${window.location.host}/ws/tty`)
      wsRef.current = ws

      ws.onopen = () => {
        setStatus('open')
        // Tell the backend our initial viewport so curses TUIs start right.
        sendResize()
      }

      ws.onmessage = (ev) => {
        let msg: { type?: string; data?: string }
        try {
          msg = JSON.parse(ev.data)
        } catch {
          return
        }
        if (msg.type === 'data' && typeof msg.data === 'string') {
          try {
            const bytes = atob(msg.data)
            term.write(bytes)
          } catch {
            /* malformed payload — drop */
          }
        } else if (msg.type === 'pong') {
          // heartbeat ack; nothing to do
        }
      }

      ws.onclose = () => {
        setStatus('closed')
        wsRef.current = null
        term.writeln(
          '\r\n\x1b[90m[shell exited — will reconnect when you type]\x1b[0m'
        )
      }

      ws.onerror = () => {
        // Let onclose handle reconnect so we don't fire twice.
      }
    }

    // Stream terminal input to the server
    const onDataSub = term.onData((data) => {
      const ws = wsRef.current
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'data', data: btoa(data) }))
      } else if (!reconnectingRef.current) {
        // Auto-reconnect on next keystroke after an exit
        reconnectingRef.current = true
        connect()
      }
    })

    // Propagate resize events from xterm to the server
    const onResizeSub = term.onResize(sendResize)

    connect()

    // ---- Re-fit on window + container size changes -------------------

    const refit = () => {
      const f = fitRef.current
      if (!f) return
      try {
        f.fit()
      } catch {
        /* panel might be hidden */
      }
    }
    window.addEventListener('resize', refit)
    const ro = new ResizeObserver(() => refit())
    ro.observe(containerRef.current)

    return () => {
      window.removeEventListener('resize', refit)
      ro.disconnect()
      onDataSub.dispose()
      onResizeSub.dispose()
      if (reconnectTimerRef.current != null) {
        window.clearTimeout(reconnectTimerRef.current)
      }
      const ws = wsRef.current
      if (ws) {
        try {
          ws.close()
        } catch {
          /* ignore */
        }
      }
      term.dispose()
      termRef.current = null
      fitRef.current = null
      wsRef.current = null
    }
  }, [])

  // When the drawer re-opens or resizes, the xterm's underlying canvas
  // needs to refit. Fire a fit on every open/height change after paint.
  useEffect(() => {
    if (!open) return
    const id = window.setTimeout(() => {
      try {
        fitRef.current?.fit()
      } catch {
        /* ignore */
      }
    }, 0)
    return () => window.clearTimeout(id)
  }, [open, height])

  // Global Ctrl/Cmd+` toggle
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === '`') {
        e.preventDefault()
        useUiStore.getState().toggleBottomConsole()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // ---- Drag handle for resizing ----------------------------------------

  const dragStartRef = useRef<{ y: number; h: number } | null>(null)
  const onDragStart = (e: React.MouseEvent) => {
    e.preventDefault()
    dragStartRef.current = { y: e.clientY, h: height }
    const onMove = (ev: MouseEvent) => {
      const start = dragStartRef.current
      if (!start) return
      const delta = start.y - ev.clientY
      setHeight(start.h + delta)
    }
    const onUp = () => {
      dragStartRef.current = null
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  return (
    <div
      className={cn(
        'flex shrink-0 flex-col border-t border-border bg-[#0d1117]',
        !open && 'hidden'
      )}
      style={{ height: `${height}px` }}
    >
      {/* Resize handle */}
      <div
        onMouseDown={onDragStart}
        className="h-1 cursor-row-resize bg-border hover:bg-accent"
        title="Drag to resize"
      />
      {/* Title bar */}
      <div className="flex h-8 shrink-0 items-center justify-between border-b border-border bg-bg-elevated px-3 text-xs">
        <div className="flex items-center gap-2 text-fg-muted">
          <TerminalIcon className="h-3.5 w-3.5" />
          <span className="font-medium text-fg">Shell</span>
          <span
            className={cn(
              'rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide',
              status === 'open' && 'bg-success/20 text-success',
              status === 'connecting' && 'bg-warning/20 text-warning',
              status === 'closed' && 'bg-danger/20 text-danger'
            )}
          >
            {status}
          </span>
          <span className="text-fg-muted/60">
            Ctrl/Cmd+` to toggle
          </span>
        </div>
        <button
          onClick={() => setOpen(false)}
          className="rounded p-1 text-fg-muted hover:bg-bg-hover hover:text-fg"
          title="Close (Ctrl/Cmd+`)"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      {/* xterm viewport — padded so the cursor doesn't kiss the border */}
      <div className="flex-1 overflow-hidden p-1">
        <div ref={containerRef} className="h-full w-full" />
      </div>
    </div>
  )
}
