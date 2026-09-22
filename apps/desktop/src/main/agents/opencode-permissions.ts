export type OpenCodePermissionAction = 'allow' | 'deny' | 'ask'

export interface OpenCodePermissionRule {
  permission: string
  pattern: string
  action: OpenCodePermissionAction
}

const READ_SAFE_PERMISSIONS = ['read', 'list', 'grep', 'glob', 'todoread', 'question', 'codesearch', 'lsp']
const RISKY_PERMISSIONS = [
  'edit',
  'bash',
  'task',
  'external_directory',
  'todowrite',
  'webfetch',
  'websearch',
  'doom_loop',
  'skill',
]

function rulesFor(permissions: string[], action: OpenCodePermissionAction): OpenCodePermissionRule[] {
  return permissions.map(permission => ({
    permission,
    pattern: '*',
    action,
  }))
}

export function buildOpenCodeSessionPermissions(mode?: string | null): OpenCodePermissionRule[] {
  if (mode === 'plan') {
    return [
      ...rulesFor(READ_SAFE_PERMISSIONS, 'allow'),
      ...rulesFor(RISKY_PERMISSIONS, 'deny'),
    ]
  }

  if (mode === 'bypassPermissions') {
    return [
      ...rulesFor(READ_SAFE_PERMISSIONS, 'allow'),
      ...rulesFor(RISKY_PERMISSIONS, 'allow'),
    ]
  }

  return [
    ...rulesFor(READ_SAFE_PERMISSIONS, 'allow'),
    ...rulesFor(RISKY_PERMISSIONS, 'ask'),
  ]
}
