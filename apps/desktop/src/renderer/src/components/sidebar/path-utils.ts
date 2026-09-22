export function normalizeSidebarPath(path: string | null | undefined): string {
  return String(path ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
}

export function sidebarPathBelongsToProject(
  projectPath: string | null | undefined,
  candidatePath: string | null | undefined,
): boolean {
  const project = normalizeSidebarPath(projectPath)
  const candidate = normalizeSidebarPath(candidatePath)
  if (!project || !candidate) return false
  return candidate === project || candidate.startsWith(`${project}/`)
}
