import { Suspense, lazy } from 'react'
import { Loader2 } from 'lucide-react'

import { DashboardRoute } from '@/routes/DashboardRoute'
import { DevicesRoute } from '@/routes/DevicesRoute'
import { ProcessesRoute } from '@/routes/ProcessesRoute'
import { ProjectsRoute } from '@/routes/ProjectsRoute'
import { SessionsRoute } from '@/routes/SessionsRoute'
import { useWorkspaceStore, type TabKind, type WorkspaceTab } from '@/store/workspaceStore'
import { TabParamsContext } from '@/hooks/useTabParams'
import { cn } from '@/lib/utils'
import { TabStrip } from './TabStrip'

const EditorRoute = lazy(() =>
  import('@/routes/EditorRoute').then((m) => ({ default: m.EditorRoute }))
)
const ProjectFilesRoute = lazy(() =>
  import('@/routes/ProjectFilesRoute').then((m) => ({ default: m.ProjectFilesRoute }))
)
const ProjectAiRoute = lazy(() =>
  import('@/routes/ProjectAiRoute').then((m) => ({ default: m.ProjectAiRoute }))
)
const SnippetsRoute = lazy(() =>
  import('@/routes/SnippetsRoute').then((m) => ({ default: m.SnippetsRoute }))
)

function Fallback() {
  return (
    <div className="flex h-full items-center justify-center text-fg-muted">
      <Loader2 className="h-5 w-5 animate-spin" />
    </div>
  )
}

function renderTab(kind: TabKind) {
  switch (kind) {
    case 'dashboard':
      return <DashboardRoute />
    case 'devices':
      return <DevicesRoute />
    case 'processes':
      return <ProcessesRoute />
    case 'editor':
      return (
        <Suspense fallback={<Fallback />}>
          <EditorRoute />
        </Suspense>
      )
    case 'projects':
      return <ProjectsRoute />
    case 'project-files':
      return (
        <Suspense fallback={<Fallback />}>
          <ProjectFilesRoute />
        </Suspense>
      )
    case 'project-ai':
      return (
        <Suspense fallback={<Fallback />}>
          <ProjectAiRoute />
        </Suspense>
      )
    case 'snippets':
      return (
        <Suspense fallback={<Fallback />}>
          <SnippetsRoute />
        </Suspense>
      )
    case 'sessions':
      return <SessionsRoute />
  }
}

export function Workspace() {
  const tabs = useWorkspaceStore((s) => s.tabs)
  const activeId = useWorkspaceStore((s) => s.activeId)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <TabStrip />
      {/* Relative container so each tab's absolute-positioned panel fills
          the remaining space. Keeping every tab mounted — hidden via CSS —
          is what lets AI chats, Monaco buffers, and WebSockets survive
          switching between them. */}
      <div className="relative min-h-0 flex-1">
        {tabs.map((tab) => (
          <TabPanel key={tab.id} tab={tab} visible={tab.id === activeId} />
        ))}
      </div>
    </div>
  )
}

function TabPanel({ tab, visible }: { tab: WorkspaceTab; visible: boolean }) {
  return (
    <div
      className={cn(
        'absolute inset-0 flex min-h-0 flex-col overflow-hidden',
        visible ? '' : 'hidden'
      )}
      aria-hidden={!visible}
    >
      <TabParamsContext.Provider value={tab.params}>
        {renderTab(tab.kind)}
      </TabParamsContext.Provider>
    </div>
  )
}
