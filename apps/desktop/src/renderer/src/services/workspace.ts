import type { Workspace, ProjectRecord } from '../../../shared/types'

function api() {
  return window.electron.workspace
}

export function list(): Promise<Workspace[]> {
  return api().list()
}

export function listProjects(): Promise<ProjectRecord[]> {
  return api().listProjects?.() ?? Promise.resolve([])
}

export function create(name: string): Promise<Workspace> {
  return api().create(name)
}

export function createFromFolder(folderPath: string): Promise<Workspace> {
  return api().createFromFolder(folderPath)
}

export function addProjectFolder(workspaceId: string, folderPath: string): Promise<Workspace | null> {
  return api().addProjectFolder(workspaceId, folderPath)
}

export function removeProjectFolder(workspaceId: string, folderPath: string): Promise<Workspace | null> {
  return api().removeProjectFolder(workspaceId, folderPath)
}

export function openFolder(): Promise<string | null> {
  return api().openFolder()
}

export function getActive(): Promise<Workspace | null> {
  return api().getActive()
}

export function setActive(id: string): Promise<void> {
  return api().setActive(id)
}

export function remove(id: string): Promise<void> {
  return api().delete(id)
}
