import { useCallback, useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Upload, Loader2, AlertCircle } from 'lucide-react'

import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

export function ApkUpload() {
  const qc = useQueryClient()
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)

  const upload = useMutation({
    mutationFn: api.uploadProject,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['projects'] })
      if (inputRef.current) inputRef.current.value = ''
    },
  })

  const handleFiles = useCallback(
    (filesIn: FileList | null) => {
      if (!filesIn || filesIn.length === 0) return
      const apks = Array.from(filesIn).filter((f) => f.name.endsWith('.apk'))
      if (apks.length === 0) return
      upload.mutate(apks)
    },
    [upload]
  )

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragging(false)
    handleFiles(e.dataTransfer.files)
  }

  return (
    <div
      onDrop={onDrop}
      onDragOver={(e) => {
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      className={cn(
        'rounded-lg border-2 border-dashed p-6 text-center transition-colors',
        dragging
          ? 'border-accent bg-accent/5'
          : 'border-border bg-bg-elevated hover:border-fg-muted'
      )}
    >
      <input
        ref={inputRef}
        type="file"
        accept=".apk"
        multiple
        onChange={(e) => handleFiles(e.target.files)}
        className="hidden"
      />

      <div className="flex flex-col items-center gap-2">
        {upload.isPending ? (
          <>
            <Loader2 className="h-8 w-8 animate-spin text-accent" />
            <div className="text-sm text-fg">Uploading…</div>
          </>
        ) : (
          <>
            <Upload className="h-8 w-8 text-fg-muted" />
            <div className="text-sm font-medium text-fg-strong">
              Drop APK file(s) here
            </div>
            <div className="text-xs text-fg-muted">
              You can upload a base APK plus its split configs
            </div>
            <button
              onClick={() => inputRef.current?.click()}
              className="mt-2 rounded-md bg-accent-muted px-3 py-1.5 text-sm font-medium text-fg-strong hover:bg-accent"
            >
              Browse files
            </button>
          </>
        )}

        {upload.isError && (
          <div className="mt-2 flex items-center gap-1.5 text-xs text-danger">
            <AlertCircle className="h-3.5 w-3.5" />
            {(upload.error as Error).message}
          </div>
        )}
      </div>
    </div>
  )
}
