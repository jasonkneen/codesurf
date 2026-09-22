/**
 * DevSandboxFrame — the visible marker for a Dev Sandbox instance (point 4).
 *
 * When the window was opened as a Dev Sandbox (`?devSandbox=1`), this paints a
 * dashed border + a "DEV SANDBOX" badge over everything, so it's unmistakable you're
 * in the isolated plugin-testing instance and not your real workspace. Renders
 * nothing in normal windows. Pure overlay — pointer-events:none, no behaviour change.
 */

const isDevSandbox = (): boolean => {
  try {
    return new URLSearchParams(window.location.search).get('devSandbox') === '1'
  } catch {
    return false
  }
}

export function DevSandboxFrame(): React.JSX.Element | null {
  if (!isDevSandbox()) return null
  const accent = 'var(--ct-accent, #f59e0b)'
  return (
    <>
      <div
        aria-hidden
        style={{
          position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 2147483600,
          border: `2px dashed ${accent}`, borderRadius: 8,
        }}
      />
      <div
        aria-hidden
        style={{
          position: 'fixed', top: 8, left: '50%', transform: 'translateX(-50%)',
          pointerEvents: 'none', zIndex: 2147483601,
          background: accent, color: '#1e1e1e',
          fontSize: 10, fontWeight: 700, letterSpacing: '0.08em',
          padding: '2px 10px', borderRadius: 999,
          fontFamily: 'var(--ct-font-sans, sans-serif)', textTransform: 'uppercase',
        }}
      >
        Dev Sandbox
      </div>
    </>
  )
}
