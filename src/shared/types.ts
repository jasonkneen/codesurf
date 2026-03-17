export interface Workspace {
  id: string
  name: string
  path: string
}

export interface Config {
  workspaces: Workspace[]
  activeWorkspaceIndex: number
}

export interface TileState {
  id: string
  type: 'terminal' | 'note' | 'code' | 'image' | 'kanban'
  x: number
  y: number
  width: number
  height: number
  zIndex: number
  filePath?: string
  groupId?: string
}

export interface GroupState {
  id: string
  label?: string
  parentGroupId?: string
}

export interface CanvasState {
  tiles: TileState[]
  groups: GroupState[]
  viewport: { tx: number; ty: number; zoom: number }
  nextZIndex: number
}
