const root = document.getElementById('root') as HTMLElement | null

function showBootstrapError(error: unknown): void {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  if (root) {
    // Build DOM nodes instead of innerHTML to avoid XSS from error messages
    const outer = document.createElement('div')
    outer.style.cssText = 'width:100vw;height:100vh;background:#1e1e1e;color:#ff7b72;display:flex;align-items:center;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text",sans-serif;padding:24px;box-sizing:border-box;'
    const card = document.createElement('div')
    card.style.cssText = 'max-width:900px;width:100%;background:#161b22;border:1px solid #30363d;border-radius:12px;padding:20px;box-shadow:0 10px 40px rgba(0,0,0,0.35);'
    const heading = document.createElement('div')
    heading.style.cssText = 'font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#8b949e;margin-bottom:10px;'
    heading.textContent = 'Renderer failed to start'
    const pre = document.createElement('pre')
    pre.style.cssText = 'margin:0;white-space:pre-wrap;word-break:break-word;font-size:13px;line-height:1.5;color:#ff7b72;'
    pre.textContent = message
    card.appendChild(heading)
    card.appendChild(pre)
    outer.appendChild(card)
    root.replaceChildren(outer)
  }
  console.error('Renderer bootstrap failed', error)
}

if (!root) {
  showBootstrapError(new Error('Missing #root element in renderer HTML'))
} else {
  import('./AppBootstrap')
    .then(({ bootstrap }) => bootstrap(root))
    .catch(showBootstrapError)
}
