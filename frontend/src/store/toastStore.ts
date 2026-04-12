/**
 * Tiny toast-notification store. Deliberately minimal — one Zustand store
 * plus a render component in Layout — so we avoid pulling in yet another
 * npm dependency just to surface "operation succeeded" messages.
 *
 * Usage anywhere:
 *
 *   import { toast } from '@/store/toastStore'
 *   toast.success('Pulled', { description: resp.output_dir })
 *   toast.error('Pull failed', { description: err.message })
 */
import { create } from 'zustand'

export type ToastKind = 'success' | 'error' | 'info'

export interface ToastAction {
  label: string
  onClick: () => void
}

export interface ToastMessage {
  id: number
  kind: ToastKind
  title: string
  description?: string
  /** ms before auto-dismiss. 0 = sticky. */
  duration: number
  /** Optional primary action button rendered inside the toast. */
  action?: ToastAction
}

interface ToastOptions {
  description?: string
  duration?: number
  action?: ToastAction
}

interface ToastState {
  items: ToastMessage[]
  push: (kind: ToastKind, title: string, opts?: ToastOptions) => number
  dismiss: (id: number) => void
}

let _counter = 0

export const useToastStore = create<ToastState>((set, get) => ({
  items: [],
  push: (kind, title, opts) => {
    const id = ++_counter
    // Toasts with an action button get a longer default so the user has a
    // chance to click it before it auto-dismisses.
    const hasAction = !!opts?.action
    const duration =
      opts?.duration ??
      (kind === 'error' ? 8000 : hasAction ? 12000 : 5000)
    set((state) => ({
      items: [
        ...state.items,
        {
          id,
          kind,
          title,
          description: opts?.description,
          duration,
          action: opts?.action,
        },
      ],
    }))
    if (duration > 0) {
      window.setTimeout(() => get().dismiss(id), duration)
    }
    return id
  },
  dismiss: (id) =>
    set((state) => ({ items: state.items.filter((t) => t.id !== id) })),
}))

/**
 * Imperative helper so call sites don't have to `getState()` everywhere.
 *
 *   toast.success('Pulled', { description: '/Users/.../pulled/...' })
 */
export const toast = {
  success: (title: string, opts?: ToastOptions) =>
    useToastStore.getState().push('success', title, opts),
  error: (title: string, opts?: ToastOptions) =>
    useToastStore.getState().push('error', title, opts),
  info: (title: string, opts?: ToastOptions) =>
    useToastStore.getState().push('info', title, opts),
  dismiss: (id: number) => useToastStore.getState().dismiss(id),
}
