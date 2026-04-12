/**
 * Small Zustand store for cross-cutting UI toggles that live outside any
 * single route (bottom console open state, future drawers, etc.). Persisted
 * to localStorage so the user's layout preferences survive reloads.
 */
import { create } from 'zustand'

const CONSOLE_OPEN_LS_KEY = 'frida-ide:bottom-console-open'
const CONSOLE_HEIGHT_LS_KEY = 'frida-ide:bottom-console-height'

function loadBool(key: string, fallback: boolean): boolean {
  if (typeof window === 'undefined') return fallback
  const v = localStorage.getItem(key)
  if (v == null) return fallback
  return v === '1'
}

function loadNum(key: string, fallback: number): number {
  if (typeof window === 'undefined') return fallback
  const v = localStorage.getItem(key)
  if (v == null) return fallback
  const n = parseInt(v, 10)
  return Number.isFinite(n) ? n : fallback
}

interface UiState {
  bottomConsoleOpen: boolean
  bottomConsoleHeight: number
  toggleBottomConsole: () => void
  setBottomConsoleOpen: (open: boolean) => void
  setBottomConsoleHeight: (h: number) => void
}

export const useUiStore = create<UiState>((set, get) => ({
  bottomConsoleOpen: loadBool(CONSOLE_OPEN_LS_KEY, false),
  bottomConsoleHeight: loadNum(CONSOLE_HEIGHT_LS_KEY, 260),
  toggleBottomConsole: () => {
    const open = !get().bottomConsoleOpen
    if (typeof window !== 'undefined') {
      localStorage.setItem(CONSOLE_OPEN_LS_KEY, open ? '1' : '0')
    }
    set({ bottomConsoleOpen: open })
  },
  setBottomConsoleOpen: (open) => {
    if (typeof window !== 'undefined') {
      localStorage.setItem(CONSOLE_OPEN_LS_KEY, open ? '1' : '0')
    }
    set({ bottomConsoleOpen: open })
  },
  setBottomConsoleHeight: (h) => {
    const clamped = Math.max(120, Math.min(800, Math.round(h)))
    if (typeof window !== 'undefined') {
      localStorage.setItem(CONSOLE_HEIGHT_LS_KEY, String(clamped))
    }
    set({ bottomConsoleHeight: clamped })
  },
}))
