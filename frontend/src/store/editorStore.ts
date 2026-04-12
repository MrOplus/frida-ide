import { create } from 'zustand'

export type RunMode = 'spawn' | 'attach'

export interface PendingRun {
  deviceSerial: string
  mode: RunMode
  targetIdentifier?: string
  pid?: number
}

export interface EditorFile {
  id: string
  name: string
  content: string
}

interface EditorState {
  /** Open file tabs in the editor. */
  files: EditorFile[]
  /** ID of the currently focused tab, or null if no files are open. */
  activeFileId: string | null

  /** Return the currently focused file, or null. */
  getActiveFile: () => EditorFile | null

  /**
   * Open a brand-new file tab and focus it. Returns the new id so callers
   * (snippet picker, extract-script) can remember which one they created.
   */
  openFile: (name: string, content: string) => string

  /** Close a tab. If it was the active one, focus a neighbour. */
  closeFile: (id: string) => void

  /** Focus a different tab by id. */
  setActiveFile: (id: string) => void

  /** Rename a tab in place. */
  renameFile: (id: string, name: string) => void

  /** Replace a tab's content (called by Monaco's onChange on every keystroke). */
  updateFileContent: (id: string, content: string) => void

  // --- Legacy single-buffer API, now proxied to the active file ---------
  // Existing call sites (SnippetsRoute, ProjectAiRoute, ProcessesRoute) use
  // ``setSource`` and ``source`` to mean "the editor's current buffer".
  // We keep them as thin adapters over ``files[activeFileId]`` so nothing
  // breaks when we add tabs.
  source: string
  setSource: (s: string) => void

  /** Active run target chosen from the Processes/Apps tab */
  pendingRun: PendingRun | null
  setPendingRun: (r: PendingRun | null) => void

  /** Last device the user picked in the inline editor target picker. */
  lastDeviceSerial: string | null
  setLastDeviceSerial: (s: string | null) => void

  /** Last target (app id + spawn/attach mode) picked in the editor. Stays
   * selected across Run clicks so the user doesn't have to re-pick every
   * time they execute a script. */
  lastTarget: LastTarget | null
  setLastTarget: (t: LastTarget | null) => void

  /** ID of the run session this editor most recently started. When the
   * user fires another Run (either from the picker or by switching to
   * another tab) we stop this one first so the sessions list doesn't
   * accumulate zombie rows. */
  activeRunSessionId: number | null
  setActiveRunSessionId: (id: number | null) => void
}

export interface LastTarget {
  mode: RunMode
  identifier?: string
  pid?: number
  label: string
}

const DEFAULT_SOURCE = `// Frida hook script
// Use send(value) to push messages to the output console.
// Documentation: https://frida.re/docs/javascript-api/

send('Script loaded');

Java.perform(function () {
  send('Java runtime ready');
  // Example: log every Activity.onResume call
  // var Activity = Java.use('android.app.Activity');
  // Activity.onResume.implementation = function () {
  //   send('Activity.onResume: ' + this.getClass().getName());
  //   return this.onResume();
  // };
});
`

const LAST_DEVICE_LS_KEY = 'frida-ide:last-device-serial'
const LAST_TARGET_LS_KEY = 'frida-ide:last-target'
const FILES_LS_KEY = 'frida-ide:editor-files'
const ACTIVE_LS_KEY = 'frida-ide:editor-active-id'

function loadLastTarget(): LastTarget | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = localStorage.getItem(LAST_TARGET_LS_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as LastTarget
    if (parsed && (parsed.mode === 'spawn' || parsed.mode === 'attach')) {
      return parsed
    }
  } catch {
    /* fall through */
  }
  return null
}

let _fileCounter = 0
const nextFileId = () => `f${Date.now().toString(36)}${++_fileCounter}`

function loadFiles(): { files: EditorFile[]; activeFileId: string | null } {
  if (typeof window === 'undefined') {
    const f: EditorFile = { id: nextFileId(), name: 'hook.js', content: DEFAULT_SOURCE }
    return { files: [f], activeFileId: f.id }
  }
  try {
    const raw = localStorage.getItem(FILES_LS_KEY)
    const activeId = localStorage.getItem(ACTIVE_LS_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as EditorFile[]
      if (Array.isArray(parsed) && parsed.length > 0) {
        const valid = parsed.filter(
          (f) => f && typeof f.id === 'string' && typeof f.content === 'string'
        )
        if (valid.length > 0) {
          const active = valid.find((f) => f.id === activeId)?.id ?? valid[0].id
          return { files: valid, activeFileId: active }
        }
      }
    }
  } catch {
    /* fall through to seed */
  }
  const seeded: EditorFile = {
    id: nextFileId(),
    name: 'hook.js',
    content: DEFAULT_SOURCE,
  }
  return { files: [seeded], activeFileId: seeded.id }
}

function persistFiles(files: EditorFile[], activeFileId: string | null) {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(FILES_LS_KEY, JSON.stringify(files))
    if (activeFileId) localStorage.setItem(ACTIVE_LS_KEY, activeFileId)
  } catch {
    /* quota — ignore */
  }
}

const initial = loadFiles()
const initialActive = initial.files.find((f) => f.id === initial.activeFileId)

export const useEditorStore = create<EditorState>((set, get) => ({
  files: initial.files,
  activeFileId: initial.activeFileId,

  getActiveFile: () => {
    const { files, activeFileId } = get()
    return files.find((f) => f.id === activeFileId) ?? null
  },

  openFile: (name, content) => {
    const id = nextFileId()
    const newFile: EditorFile = { id, name, content }
    set((state) => {
      const files = [...state.files, newFile]
      persistFiles(files, id)
      return {
        files,
        activeFileId: id,
        source: content,
      }
    })
    return id
  },

  closeFile: (id) => {
    set((state) => {
      const idx = state.files.findIndex((f) => f.id === id)
      if (idx === -1) return state
      const files = state.files.filter((f) => f.id !== id)
      // Always keep at least one file open so the editor isn't blank.
      if (files.length === 0) {
        const seeded: EditorFile = {
          id: nextFileId(),
          name: 'hook.js',
          content: DEFAULT_SOURCE,
        }
        files.push(seeded)
      }
      let activeFileId = state.activeFileId
      if (activeFileId === id) {
        // Focus the left neighbour, or the first remaining tab
        activeFileId = files[Math.max(0, idx - 1)].id
      }
      persistFiles(files, activeFileId)
      const active = files.find((f) => f.id === activeFileId)
      return {
        files,
        activeFileId,
        source: active?.content ?? '',
      }
    })
  },

  setActiveFile: (id) => {
    set((state) => {
      const file = state.files.find((f) => f.id === id)
      if (!file) return state
      persistFiles(state.files, id)
      return { activeFileId: id, source: file.content }
    })
  },

  renameFile: (id, name) => {
    set((state) => {
      const files = state.files.map((f) => (f.id === id ? { ...f, name } : f))
      persistFiles(files, state.activeFileId)
      return { files }
    })
  },

  updateFileContent: (id, content) => {
    set((state) => {
      const files = state.files.map((f) => (f.id === id ? { ...f, content } : f))
      persistFiles(files, state.activeFileId)
      return {
        files,
        source: state.activeFileId === id ? content : state.source,
      }
    })
  },

  source: initialActive?.content ?? DEFAULT_SOURCE,
  setSource: (s) => {
    const { activeFileId, updateFileContent } = get()
    if (activeFileId) updateFileContent(activeFileId, s)
    else set({ source: s })
  },

  pendingRun: null,
  setPendingRun: (r) => set({ pendingRun: r }),

  lastDeviceSerial:
    typeof window !== 'undefined' ? localStorage.getItem(LAST_DEVICE_LS_KEY) : null,
  setLastDeviceSerial: (s) => {
    if (typeof window !== 'undefined') {
      if (s) localStorage.setItem(LAST_DEVICE_LS_KEY, s)
      else localStorage.removeItem(LAST_DEVICE_LS_KEY)
    }
    set({ lastDeviceSerial: s })
  },

  lastTarget: loadLastTarget(),
  setLastTarget: (t) => {
    if (typeof window !== 'undefined') {
      if (t) localStorage.setItem(LAST_TARGET_LS_KEY, JSON.stringify(t))
      else localStorage.removeItem(LAST_TARGET_LS_KEY)
    }
    set({ lastTarget: t })
  },

  // Deliberately not persisted — process identity doesn't survive backend
  // restarts, so on reload we want this to start empty.
  activeRunSessionId: null,
  setActiveRunSessionId: (id) => set({ activeRunSessionId: id }),
}))
