/**
 * Permissions settings section — extracted from SettingsPanel's
 * `case 'permissions'` render closure. theme/fonts via context; permission
 * grant data + callbacks via props. Owns PermissionListResult type.
 */
import React from 'react'
import type { AppSettings, ToolPermissionGrant } from '../../../../shared/types'
import { useTheme } from '../../ThemeContext'
import { useAppFonts } from '../../FontContext'
import { SectionLabel, SettingRow, Toggle } from './controls'

export type PermissionListResult = {
  path: string
  grants: ToolPermissionGrant[]
}

export interface PermissionsSectionProps {
  settings: AppSettings
  updateSettingsPatch: (patch: Partial<AppSettings>) => void
  permissionData: PermissionListResult | null
  permissionsLoading: boolean
  permissionsError: string | null
  loadPermissions: () => void | Promise<void>
  clearPermissionGrantById: (id: string) => void | Promise<void>
  clearAllPermissionGrants: () => void | Promise<void>
}

export function PermissionsSection(props: PermissionsSectionProps): React.JSX.Element {
  const {
    settings,
    updateSettingsPatch,
    permissionData,
    permissionsLoading,
    permissionsError,
    loadPermissions,
    clearPermissionGrantById,
    clearAllPermissionGrants,
  } = props
  const theme = useTheme()
  const fonts = useAppFonts()

  return (
          <>
            <SectionLabel label="Tool Permission Memory" />
            <div style={{ background: theme.surface.panelMuted, borderRadius: 10, padding: '12px 16px', marginBottom: 12 }}>
              <div style={{ fontSize: fonts.size, color: theme.text.secondary, marginBottom: 6 }}>
                Approvals are remembered per provider, tool, and workspace.
              </div>
              <div style={{ fontSize: fonts.secondarySize, color: theme.text.muted, lineHeight: 1.6 }}>
                When a tool asks for approval, CodeSurf can allow it once, for this session, for the rest of today, or permanently.
              </div>
              <div style={{ fontSize: Math.max(10, fonts.secondarySize - 1), color: theme.text.disabled, fontFamily: fonts.mono, marginTop: 8 }}>
                {permissionData?.path ?? '~/.codesurf/permissions.json'}
              </div>
            </div>
            <SettingRow label="Stored grants" description="Clear remembered approvals so tools prompt again.">
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  type="button"
                  onClick={() => { void loadPermissions() }}
                  disabled={permissionsLoading}
                  style={{
                    padding: '6px 12px',
                    borderRadius: 8,
                    fontSize: fonts.secondarySize,
                    fontWeight: 600,
                    border: `1px solid ${theme.border.default}`,
                    background: theme.surface.input,
                    color: theme.text.secondary,
                    cursor: permissionsLoading ? 'not-allowed' : 'pointer',
                    opacity: permissionsLoading ? 0.6 : 1,
                  }}
                >
                  Refresh
                </button>
                <button
                  type="button"
                  onClick={() => { void clearAllPermissionGrants() }}
                  disabled={permissionsLoading || (permissionData?.grants.length ?? 0) === 0}
                  style={{
                    padding: '6px 12px',
                    borderRadius: 8,
                    fontSize: fonts.secondarySize,
                    fontWeight: 600,
                    border: `1px solid ${theme.border.default}`,
                    background: `${theme.status.danger}14`,
                    color: theme.status.danger,
                    cursor: permissionsLoading || (permissionData?.grants.length ?? 0) === 0 ? 'not-allowed' : 'pointer',
                    opacity: permissionsLoading || (permissionData?.grants.length ?? 0) === 0 ? 0.6 : 1,
                  }}
                >
                  Clear all
                </button>
              </div>
            </SettingRow>
            {permissionsError && (
              <div style={{ fontSize: fonts.secondarySize, color: theme.status.danger, padding: '4px 2px 10px' }}>
                {permissionsError}
              </div>
            )}
            <SectionLabel label="Filesystem Access" />
            <SettingRow
              label="Restrict file access to workspace folders"
              description="When enabled, read/write IPC only allows paths under workspace project roots or ~/.codesurf. Enabled by default on new and migrated installs; turn off only if you need broader file access."
            >
              <Toggle
                value={settings.security.restrictFsToWorkspaceRoots}
                onChange={v => updateSettingsPatch({
                  security: {
                    ...settings.security,
                    restrictFsToWorkspaceRoots: v,
                    fsScopingMigrated: true,
                    fsScopingUserOptedOut: v ? undefined : true,
                  },
                })}
              />
            </SettingRow>

            {(permissionData?.grants.length ?? 0) === 0 ? (
              <div style={{ fontSize: fonts.secondarySize, color: theme.text.muted, padding: '8px 2px' }}>
                {permissionsLoading ? 'Loading permission grants…' : 'No remembered tool approvals.'}
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {permissionData!.grants.map(grant => (
                  <div key={grant.id} style={{ background: theme.surface.panelMuted, borderRadius: 10, padding: '12px 14px', display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        <span style={{ fontSize: fonts.size, color: theme.text.primary, fontWeight: 600 }}>{grant.title || grant.toolName}</span>
                        <span style={{ fontSize: Math.max(10, fonts.secondarySize - 1), color: theme.text.disabled, background: theme.surface.input, padding: '2px 8px', borderRadius: 999 }}>
                          {grant.provider}
                        </span>
                        <span style={{ fontSize: Math.max(10, fonts.secondarySize - 1), color: grant.action === 'deny' ? theme.status.danger : theme.status.success, background: `${grant.action === 'deny' ? theme.status.danger : theme.status.success}14`, padding: '2px 8px', borderRadius: 999 }}>
                          {grant.action === 'deny' ? 'blocked' : grant.scope === 'forever' ? 'all time' : grant.scope}
                        </span>
                      </div>
                      {grant.description && (
                        <div style={{ fontSize: fonts.secondarySize, color: theme.text.muted, marginTop: 4 }}>
                          {grant.description}
                        </div>
                      )}
                      <div style={{ fontSize: Math.max(10, fonts.secondarySize - 1), color: theme.text.disabled, fontFamily: fonts.mono, marginTop: 6, wordBreak: 'break-all' }}>
                        {grant.toolName}{grant.workspaceDir ? ` · ${grant.workspaceDir}` : ''}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => { void clearPermissionGrantById(grant.id) }}
                      style={{
                        padding: '6px 10px',
                        borderRadius: 8,
                        fontSize: fonts.secondarySize,
                        fontWeight: 600,
                        border: `1px solid ${theme.border.default}`,
                        background: 'transparent',
                        color: theme.text.secondary,
                        cursor: 'pointer',
                        flexShrink: 0,
                      }}
                    >
                      Clear
                    </button>
                  </div>
                ))}
              </div>
            )}
          </>
        )
}
