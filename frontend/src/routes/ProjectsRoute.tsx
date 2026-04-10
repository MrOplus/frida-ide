import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { ApkUpload } from '@/components/projects/ApkUpload'
import { ProjectCard } from '@/components/projects/ProjectCard'

export function ProjectsRoute() {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['projects'],
    queryFn: api.projects,
    refetchInterval: 3_000,
  })

  return (
    <div className="p-6">
      <h1 className="mb-4 text-xl font-semibold text-fg-strong">Projects</h1>

      <ApkUpload />

      <div className="mt-6">
        {isLoading && <div className="text-fg-muted">Loading projects…</div>}
        {isError && (
          <div className="rounded-md border border-danger/50 bg-danger/10 p-3 text-sm text-danger">
            {(error as Error).message}
          </div>
        )}

        {data && data.length === 0 && (
          <div className="rounded-md border border-border bg-bg-elevated p-6 text-center text-sm text-fg-muted">
            No projects yet. Drop an APK above to get started.
          </div>
        )}

        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {data?.map((project) => (
            <ProjectCard key={project.id} project={project} />
          ))}
        </div>
      </div>
    </div>
  )
}
