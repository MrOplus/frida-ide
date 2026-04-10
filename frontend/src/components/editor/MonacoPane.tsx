import { useEffect, useRef } from 'react'
import Editor, { type OnMount } from '@monaco-editor/react'

interface Props {
  value: string
  onChange: (value: string) => void
}

export function MonacoPane({ value, onChange }: Props) {
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null)

  const handleMount: OnMount = (editor, monaco) => {
    editorRef.current = editor

    // Loose JS settings — Frida scripts are JS, not TS, and use lots of dynamic types
    monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions({
      noSemanticValidation: true,
      noSyntaxValidation: false,
    })

    monaco.languages.typescript.javascriptDefaults.setCompilerOptions({
      target: monaco.languages.typescript.ScriptTarget.ES2020,
      allowNonTsExtensions: true,
      lib: ['es2020'],
    })

    // Minimal Frida API stub so autocompletion works
    monaco.languages.typescript.javascriptDefaults.addExtraLib(
      `
declare function send(message: any, data?: ArrayBuffer | null): void;
declare function recv(callback: (message: any) => void): { wait(): void };
declare function recv(type: string, callback: (message: any) => void): { wait(): void };
declare const console: { log(...args: any[]): void; warn(...args: any[]): void; error(...args: any[]): void };
declare const Java: any;
declare const ObjC: any;
declare const Process: any;
declare const Module: any;
declare const Memory: any;
declare const Interceptor: any;
declare const Stalker: any;
declare const Thread: any;
declare const NativePointer: any;
declare const NativeFunction: any;
declare const NativeCallback: any;
declare const Frida: { version: string };
`,
      'frida-gum.d.ts'
    )
  }

  // Resize when the parent panel resizes
  useEffect(() => {
    const onResize = () => editorRef.current?.layout()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  return (
    <Editor
      height="100%"
      defaultLanguage="javascript"
      theme="vs-dark"
      value={value}
      onChange={(v) => onChange(v ?? '')}
      onMount={handleMount}
      options={{
        fontSize: 13,
        fontFamily:
          '"JetBrains Mono", ui-monospace, "SF Mono", Consolas, monospace',
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        wordWrap: 'off',
        tabSize: 2,
        renderLineHighlight: 'gutter',
        smoothScrolling: true,
        automaticLayout: true,
      }}
    />
  )
}
