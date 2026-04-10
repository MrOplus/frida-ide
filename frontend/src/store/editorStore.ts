import { create } from 'zustand'

export type RunMode = 'spawn' | 'attach'

export interface PendingRun {
  deviceSerial: string
  mode: RunMode
  targetIdentifier?: string
  pid?: number
}

interface EditorState {
  /** Current Monaco buffer source */
  source: string
  setSource: (s: string) => void

  /** Active run target chosen from the Processes/Apps tab */
  pendingRun: PendingRun | null
  setPendingRun: (r: PendingRun | null) => void

  /** Last device the user picked in the inline editor target picker.
   * Persisted to localStorage so reopening the Editor tab doesn't make
   * the user choose again. */
  lastDeviceSerial: string | null
  setLastDeviceSerial: (s: string | null) => void
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

export const useEditorStore = create<EditorState>((set) => ({
  source: DEFAULT_SOURCE,
  setSource: (s) => set({ source: s }),
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
}))
