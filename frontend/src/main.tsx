import { StrictMode, Suspense, lazy } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider, createBrowserRouter } from 'react-router-dom'
import { Loader2 } from 'lucide-react'

import './index.css'
import { Layout } from './components/layout/Layout'
// Lightweight routes loaded eagerly so the dashboard renders without a flash.
import { DashboardRoute } from './routes/DashboardRoute'
import { DevicesRoute } from './routes/DevicesRoute'
import { ProcessesRoute } from './routes/ProcessesRoute'
import { ProjectsRoute } from './routes/ProjectsRoute'
import { SessionsRoute } from './routes/SessionsRoute'

// Heavy routes pulled into separate chunks because they import Monaco
// (~600 KB) and we don't want it in the initial bundle.
const EditorRoute = lazy(() =>
  import('./routes/EditorRoute').then((m) => ({ default: m.EditorRoute }))
)
const ProjectFilesRoute = lazy(() =>
  import('./routes/ProjectFilesRoute').then((m) => ({ default: m.ProjectFilesRoute }))
)
const ProjectAiRoute = lazy(() =>
  import('./routes/ProjectAiRoute').then((m) => ({ default: m.ProjectAiRoute }))
)
const SnippetsRoute = lazy(() =>
  import('./routes/SnippetsRoute').then((m) => ({ default: m.SnippetsRoute }))
)

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      staleTime: 5_000,
    },
  },
})

function RouteFallback() {
  return (
    <div className="flex h-full items-center justify-center text-fg-muted">
      <Loader2 className="h-5 w-5 animate-spin" />
    </div>
  )
}

const lazyEl = (Component: React.ComponentType) => (
  <Suspense fallback={<RouteFallback />}>
    <Component />
  </Suspense>
)

const router = createBrowserRouter([
  {
    path: '/',
    element: <Layout />,
    children: [
      { index: true, element: <DashboardRoute /> },
      { path: 'devices', element: <DevicesRoute /> },
      { path: 'devices/:serial/processes', element: <ProcessesRoute /> },
      { path: 'editor', element: lazyEl(EditorRoute) },
      { path: 'editor/:runSessionId', element: lazyEl(EditorRoute) },
      { path: 'projects', element: <ProjectsRoute /> },
      { path: 'projects/:projectId/files', element: lazyEl(ProjectFilesRoute) },
      { path: 'projects/:projectId/ai', element: lazyEl(ProjectAiRoute) },
      { path: 'snippets', element: lazyEl(SnippetsRoute) },
      { path: 'sessions', element: <SessionsRoute /> },
    ],
  },
])

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>
)
