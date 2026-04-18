import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider, createBrowserRouter } from 'react-router-dom'

import './index.css'
import { Layout } from './components/layout/Layout'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      staleTime: 5_000,
    },
  },
})

// The workspace (components/layout/Workspace.tsx) owns which route
// components are mounted — it keeps each open tab alive across navigation
// so AI chats + editor state survive tab switches. React Router is used
// only for the browser URL / history integration: every path maps to the
// same Layout, and Layout's useLocation effect syncs the URL to the
// active workspace tab.
const router = createBrowserRouter([{ path: '*', element: <Layout /> }])

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>
)
