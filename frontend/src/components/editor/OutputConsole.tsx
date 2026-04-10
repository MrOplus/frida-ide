import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'

import { useStreamingWs, type WsEnvelope } from '@/lib/ws'

interface Props {
  runSessionId: number | null
}

const COLORS = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  red: '\x1b[31m',
  brightRed: '\x1b[91m',
  yellow: '\x1b[33m',
  green: '\x1b[32m',
  gray: '\x1b[90m',
}

function formatTime(ts?: string): string {
  if (!ts) return ''
  try {
    const d = new Date(ts)
    return d.toTimeString().slice(0, 8)
  } catch {
    return ''
  }
}

function formatPayload(p: unknown): string {
  if (p == null) return ''
  if (typeof p === 'string') return p
  try {
    return JSON.stringify(p)
  } catch {
    return String(p)
  }
}

export function OutputConsole({ runSessionId }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)

  useEffect(() => {
    if (!containerRef.current) return

    const term = new Terminal({
      convertEol: true,
      cursorBlink: false,
      cursorStyle: 'bar',
      disableStdin: true,
      fontFamily: '"JetBrains Mono", ui-monospace, "SF Mono", Consolas, monospace',
      fontSize: 12,
      lineHeight: 1.3,
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
    fit.fit()

    term.writeln(
      `${COLORS.dim}Frida IDE output console — waiting for run session${COLORS.reset}`
    )

    termRef.current = term
    fitRef.current = fit

    const onResize = () => fit.fit()
    window.addEventListener('resize', onResize)
    const ro = new ResizeObserver(() => fit.fit())
    ro.observe(containerRef.current)

    return () => {
      window.removeEventListener('resize', onResize)
      ro.disconnect()
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
  }, [])

  // Reset terminal when the run session changes
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    term.clear()
    if (runSessionId == null) {
      term.writeln(
        `${COLORS.dim}No active run session. Pick a process and click Run.${COLORS.reset}`
      )
    } else {
      term.writeln(
        `${COLORS.gray}=== run_session ${runSessionId} ===${COLORS.reset}`
      )
    }
  }, [runSessionId])

  useStreamingWs({
    path: runSessionId != null ? `/ws/run/${runSessionId}` : '',
    enabled: runSessionId != null,
    // Replay all buffered events since this session began so we don't miss
    // send() messages emitted before the WS connection was established.
    initialLastEventId: -1,
    onMessage: (msg: WsEnvelope) => {
      const term = termRef.current
      if (!term) return
      const ts = formatTime(msg.ts as string | undefined)
      const prefix = `${COLORS.gray}[${ts}]${COLORS.reset} `
      switch (msg.type) {
        case 'hello':
          term.writeln(`${prefix}${COLORS.dim}connected${COLORS.reset}`)
          break
        case 'send': {
          const payload = msg.payload as { payload?: unknown; type?: string } | undefined
          // The Frida message arrives nested: payload = {type: 'send', payload: <user value>}
          const inner = payload?.payload ?? payload
          term.writeln(`${prefix}${COLORS.cyan}send${COLORS.reset} ${formatPayload(inner)}`)
          break
        }
        case 'error': {
          const payload = msg.payload as { description?: string; stack?: string } | undefined
          term.writeln(
            `${prefix}${COLORS.brightRed}error${COLORS.reset} ${payload?.description ?? formatPayload(msg.payload)}`
          )
          if (payload?.stack) {
            term.writeln(`${COLORS.red}${payload.stack}${COLORS.reset}`)
          }
          break
        }
        case 'status': {
          const status = (msg.payload as { status?: string } | undefined)?.status
          term.writeln(`${prefix}${COLORS.yellow}status${COLORS.reset} ${status ?? ''}`)
          break
        }
        default:
          term.writeln(`${prefix}${msg.type} ${formatPayload(msg.payload)}`)
      }
    },
  })

  return <div ref={containerRef} className="h-full w-full bg-bg" />
}
