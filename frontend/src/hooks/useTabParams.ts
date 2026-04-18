import { createContext, useContext } from 'react'

/**
 * Per-tab params context. Populated by each TabPanel in Workspace.tsx
 * from the tab's stored params ({ serial, projectId, runSessionId, … }).
 *
 * Route components call ``useTabParams()`` instead of react-router's
 * ``useParams()`` because the app's router is a single catch-all — the
 * component tree is owned by the workspace tab system, not by route
 * matching.
 *
 * Lives in its own module (rather than inside Workspace.tsx) so route
 * files can import the hook without creating a circular dependency on
 * the eagerly-imported routes inside Workspace.
 */
export const TabParamsContext = createContext<Record<string, string>>({})

export function useTabParams<T extends Record<string, string>>(): Partial<T> {
  return useContext(TabParamsContext) as Partial<T>
}
