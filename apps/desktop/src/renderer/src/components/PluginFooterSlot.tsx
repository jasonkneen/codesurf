/**
 * PluginFooterSlot — renders plugin `contributes.footer` items in the status bar.
 *
 * The first concrete <Slot> consumer: declarative footer chips (icon/label) that any
 * plugin can contribute with zero status-bar edits. Clicking one dispatches a
 * `codesurf:footer-activate` window event with the contribution (host/plugins bind it;
 * a command can be wired via the contribution's id). Rich footer content
 * (render:'mcp-ui' | 'iframe') layers on in the surface-render pass; a labelled chip
 * covers the common status/launcher case today. Renders nothing when no plugin
 * contributes a footer item, so it's invisible until used.
 */

import { useContributions } from '../hooks/useContributions'

export function PluginFooterSlot(): React.JSX.Element | null {
  const items = useContributions('footer')
  const left = items.filter(i => (i.position ?? 'left') !== 'right')
  const right = items.filter(i => i.position === 'right')
  const ordered = [...left, ...right]
  if (ordered.length === 0) return null

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, pointerEvents: 'auto' }}>
      {ordered.map(item => (
        <button
          key={`${item.extId}:${item.id}`}
          title={item.label || item.id}
          onClick={() => window.dispatchEvent(new CustomEvent('codesurf:footer-activate', { detail: item }))}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            height: 20,
            padding: '0 7px',
            borderRadius: 'var(--ct-radius, 6px)',
            border: '1px solid var(--ct-border, rgba(127,127,127,0.25))',
            background: 'var(--ct-panel, rgba(127,127,127,0.08))',
            color: 'var(--ct-text, inherit)',
            font: 'inherit',
            fontSize: 11,
            lineHeight: '18px',
            cursor: 'pointer',
            whiteSpace: 'nowrap',
            maxWidth: 160,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {item.label || item.id}
        </button>
      ))}
    </div>
  )
}
