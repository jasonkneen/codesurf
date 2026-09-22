/*
 * Minimal markdown-to-HTML renderer used only for LOCAL, USER-AUTHORED content
 * (the user's own note files). This is NOT used for untrusted external input.
 * HTML entities are escaped first to prevent injection from the source text.
 */
export function renderMarkdown(md: string): string {
  let html = md
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/__(.+?)__/g, '<strong>$1</strong>')
    .replace(/_(.+?)_/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label: string, url: string) => {
      // Only allow http/https links — strip javascript:, file://, data: etc.
      let safe = ''
      try {
        const parsed = new URL(url)
        if (parsed.protocol === 'http:' || parsed.protocol === 'https:') safe = url
      } catch {
        // Relative paths are fine for intra-note anchors.
        if (!url.includes(':')) safe = url
      }
      if (!safe) return label
      return `<a href="${safe}" target="_blank" rel="noopener noreferrer">${label}</a>`
    })
    .replace(/^---+$/gm, '<hr/>')
    .replace(/^\s*[-*+] (.+)$/gm, '<li>$1</li>')
    .replace(/^\s*\d+\. (.+)$/gm, '<li>$1</li>')
    .replace(/```[\w]*\n([\s\S]*?)```/g, '<pre><code>$1</code></pre>')
    .replace(/^> (.+)$/gm, '<blockquote>$1</blockquote>')
    .replace(/\n\n([^<])/g, '\n\n<p>$1')
    .replace(/\n/g, '<br/>')
  html = html.replace(/(<li>.*?<\/li>)(\s*<br\/>)*/g, match => `<ul>${match.replace(/<br\/>/g, '')}</ul>`)
  return html
}
