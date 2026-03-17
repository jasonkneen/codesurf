import React, { useEffect, useRef, useState, useCallback } from 'react'
import Editor from '@monaco-editor/react'

interface Props {
  filePath?: string
  initialContent?: string
}

// Minimal markdown → HTML renderer (no deps)
function renderMarkdown(md: string): string {
  let html = md
    // Escape HTML
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    // Headings
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    // Bold / italic
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/__(.+?)__/g, '<strong>$1</strong>')
    .replace(/_(.+?)_/g, '<em>$1</em>')
    // Inline code
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    // Links
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>')
    // Horizontal rule
    .replace(/^---+$/gm, '<hr/>')
    // Unordered lists
    .replace(/^\s*[-*+] (.+)$/gm, '<li>$1</li>')
    // Ordered lists
    .replace(/^\s*\d+\. (.+)$/gm, '<li>$1</li>')
    // Code blocks (fenced)
    .replace(/```[\w]*\n([\s\S]*?)```/g, '<pre><code>$1</code></pre>')
    // Blockquote
    .replace(/^> (.+)$/gm, '<blockquote>$1</blockquote>')
    // Paragraphs (double newline)
    .replace(/\n\n([^<])/g, '\n\n<p>$1')
    // Line breaks
    .replace(/\n/g, '<br/>')

  // Wrap consecutive <li> in <ul>
  html = html.replace(/(<li>.*?<\/li>)(\s*<br\/>)*/g, (m) => `<ul>${m.replace(/<br\/>/g, '')}</ul>`)

  return html
}

export function NoteTile({ filePath, initialContent = '' }: Props): JSX.Element {
  const [content, setContent] = useState<string | undefined>(undefined)
  const [mode, setMode] = useState<'edit' | 'preview'>('edit')
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const loaded = useRef(false)

  useEffect(() => {
    loaded.current = false
    if (!filePath) {
      setContent(initialContent || '# Untitled\n\nStart writing…')
      loaded.current = true
      return
    }
    window.electron.fs.readFile(filePath).then(text => {
      setContent(text)
      loaded.current = true
    }).catch(() => {
      setContent('')
      loaded.current = true
    })
  }, [filePath, initialContent])

  const handleChange = useCallback((value: string | undefined) => {
    if (!loaded.current || value === undefined) return
    setContent(value)
    if (!filePath) return
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      window.electron.fs.writeFile(filePath, value)
    }, 500)
  }, [filePath])

  useEffect(() => () => { if (saveTimer.current) clearTimeout(saveTimer.current) }, [])

  return (
    <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', background: '#1e1e1e' }}>
      {/* Mode toggle */}
      <div style={{
        display: 'flex', gap: 1, padding: '4px 8px',
        borderBottom: '1px solid #2d2d2d', flexShrink: 0
      }}>
        <button
          onClick={() => setMode('edit')}
          style={{
            fontSize: 11, padding: '2px 10px', borderRadius: '3px 0 0 3px',
            background: mode === 'edit' ? '#3a3a3a' : '#252525',
            color: mode === 'edit' ? '#ccc' : '#666',
            border: '1px solid #333', cursor: 'pointer', fontFamily: 'inherit'
          }}
        >
          Edit
        </button>
        <button
          onClick={() => setMode('preview')}
          style={{
            fontSize: 11, padding: '2px 10px', borderRadius: '0 3px 3px 0',
            background: mode === 'preview' ? '#3a3a3a' : '#252525',
            color: mode === 'preview' ? '#ccc' : '#666',
            border: '1px solid #333', borderLeft: 'none', cursor: 'pointer', fontFamily: 'inherit'
          }}
        >
          Preview
        </button>
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflow: 'hidden', minHeight: 0 }}>
        {mode === 'edit' ? (
          <Editor
            height="100%"
            language="markdown"
            value={content}
            onChange={handleChange}
            theme="vs-dark"
            loading={<div style={{ height: '100%', background: '#1e1e1e' }} />}
            options={{
              minimap: { enabled: false },
              fontSize: 13,
              lineHeight: 1.7,
              wordWrap: 'on',
              automaticLayout: true,
              padding: { top: 12 },
              scrollBeyondLastLine: false,
              fontFamily: '"JetBrains Mono", "Menlo", "Monaco", monospace',
              lineNumbers: 'off',
              folding: false,
              renderLineHighlight: 'none',
              overviewRulerBorder: false,
              scrollbar: { verticalScrollbarSize: 4 }
            }}
          />
        ) : (
          <div
            className="note-preview"
            style={{ height: '100%', overflowY: 'auto', padding: '16px 20px' }}
            dangerouslySetInnerHTML={{ __html: renderMarkdown(content ?? '') }}
          />
        )}
      </div>

      {/* Preview styles injected inline */}
      <style>{`
        .note-preview h1 { font-size: 1.6em; font-weight: 700; color: #e0e0e0; margin: 0 0 12px; }
        .note-preview h2 { font-size: 1.3em; font-weight: 600; color: #d0d0d0; margin: 16px 0 8px; }
        .note-preview h3 { font-size: 1.1em; font-weight: 600; color: #c0c0c0; margin: 12px 0 6px; }
        .note-preview p  { color: #cccccc; line-height: 1.7; margin: 0 0 10px; }
        .note-preview code { background: #2a2a2a; color: #ce9178; padding: 1px 5px; border-radius: 3px; font-size: 12px; font-family: "JetBrains Mono", monospace; }
        .note-preview pre { background: #1a1a1a; border: 1px solid #333; border-radius: 4px; padding: 12px; overflow-x: auto; margin: 10px 0; }
        .note-preview pre code { background: none; padding: 0; }
        .note-preview ul, .note-preview ol { color: #cccccc; padding-left: 20px; margin: 6px 0; }
        .note-preview li { line-height: 1.7; }
        .note-preview a { color: #4a9eff; text-decoration: none; }
        .note-preview a:hover { text-decoration: underline; }
        .note-preview blockquote { border-left: 3px solid #444; padding-left: 12px; color: #888; margin: 8px 0; }
        .note-preview hr { border: none; border-top: 1px solid #333; margin: 16px 0; }
        .note-preview strong { color: #e0e0e0; }
      `}</style>
    </div>
  )
}
