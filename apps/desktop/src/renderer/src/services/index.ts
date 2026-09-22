/**
 * Renderer service layer — wraps `window.electron.*` IPC calls with
 * typed, defensive wrappers. Keeps components from depending directly
 * on the preload bridge shape.
 */

export * as canvasService from './canvas'
export * as sessionsService from './sessions'
export * as workspaceService from './workspace'
export * as fsService from './fs'
