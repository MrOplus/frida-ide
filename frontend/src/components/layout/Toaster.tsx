import { CheckCircle2, AlertCircle, Info, X } from 'lucide-react'
import { useToastStore, type ToastMessage } from '@/store/toastStore'
import { cn } from '@/lib/utils'

/**
 * Fixed bottom-right stack of toasts. Mounted once at the Layout level so
 * any component can fire a toast via the imperative ``toast`` helper
 * regardless of where it sits in the route tree.
 */
export function Toaster() {
  const items = useToastStore((s) => s.items)
  const dismiss = useToastStore((s) => s.dismiss)

  if (items.length === 0) return null

  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-[min(420px,calc(100vw-2rem))] flex-col gap-2">
      {items.map((t) => (
        <ToastItem key={t.id} toast={t} onDismiss={() => dismiss(t.id)} />
      ))}
    </div>
  )
}

function ToastItem({
  toast,
  onDismiss,
}: {
  toast: ToastMessage
  onDismiss: () => void
}) {
  const Icon =
    toast.kind === 'success'
      ? CheckCircle2
      : toast.kind === 'error'
      ? AlertCircle
      : Info

  return (
    <div
      role="status"
      className={cn(
        'pointer-events-auto flex items-start gap-3 rounded-md border bg-bg-elevated px-3 py-2.5 shadow-lg',
        toast.kind === 'success' && 'border-success/40',
        toast.kind === 'error' && 'border-danger/40',
        toast.kind === 'info' && 'border-border'
      )}
      style={{
        animation: 'toast-slide-in 180ms ease-out',
      }}
    >
      <Icon
        className={cn(
          'mt-0.5 h-4 w-4 shrink-0',
          toast.kind === 'success' && 'text-success',
          toast.kind === 'error' && 'text-danger',
          toast.kind === 'info' && 'text-fg-muted'
        )}
      />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-fg-strong">{toast.title}</div>
        {toast.description && (
          <div className="mt-0.5 break-all font-mono text-[11px] leading-snug text-fg-muted">
            {toast.description}
          </div>
        )}
        {toast.action && (
          <button
            onClick={() => {
              toast.action?.onClick()
              onDismiss()
            }}
            className="mt-2 rounded border border-accent bg-accent-muted px-2 py-1 text-xs font-medium text-fg-strong hover:bg-accent"
          >
            {toast.action.label}
          </button>
        )}
      </div>
      <button
        onClick={onDismiss}
        className="shrink-0 rounded p-0.5 text-fg-muted hover:bg-bg-hover hover:text-fg"
        title="Dismiss"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}
