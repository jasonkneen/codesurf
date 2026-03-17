import React, { useEffect, useRef, useState } from 'react'
import Editor from '@monaco-editor/react'

interface Props {
  filePath?: string
  initialContent?: string
}

function getLang(filePath?: string): string {
  if (!filePath) return 'plaintext'
  const ext = filePath.split('.').pop()?.toLowerCase() ?? ''
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript',
    js: 'javascript', jsx: 'javascript',
    json: 'json', md: 'markdown', markdown: 'markdown',
    py: 'python', rs: 'rust', go: 'go',
    cpp: 'cpp', c: 'c', java: 'java',
    css: 'css', html: 'html', sh: 'shell', bash: 'shell',
    yaml: 'yaml', yml: 'yaml', toml: 'toml', xml: 'xml'
  }
  return map[ext] ?? 'plaintext'
}

export function CodeTile({ filePath, initialContent = '' }: Props): JSX.Element {
  const [content, setContent] = useState<string | undefined>(undefined)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isLoaded = useRef(false)

  useEffect(() => {
    isLoaded.current = false
    if (!filePath) {
      setContent(initialContent)
      isLoaded.current = true
      return
    }
    window.electron.fs.readFile(filePath).then(text => {
      setContent(text)
      isLoaded.current = true
    }).catch(() => {
      setContent('')
      isLoaded.current = true
    })
  }, [filePath, initialContent])

  const handleChange = (value: string | undefined): void => {
    if (!isLoaded.current) return
    setContent(value)
    if (!filePath || value === undefined) return
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      window.electron.fs.writeFile(filePath, value)
    }, 500)
  }

  useEffect(() => {
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current) }
  }, [])

  return (
    <div style={{ width: '100%', height: '100%' }}>
      <Editor
        height="100%"
        language={getLang(filePath)}
        value={content}
        onChange={handleChange}
        theme="vs-dark"
        loading={
          <div style={{
            height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: '#1e1e1e', color: '#555', fontSize: 12
          }}>
            Loading…
          </div>
        }
        options={{
          minimap: { enabled: false },
          fontSize: 13,
          lineNumbers: 'on',
          scrollBeyondLastLine: false,
          wordWrap: 'on',
          automaticLayout: true,
          padding: { top: 10 },
          renderLineHighlight: 'none',
          overviewRulerBorder: false,
          hideCursorInOverviewRuler: true,
          scrollbar: {
            verticalScrollbarSize: 6,
            horizontalScrollbarSize: 6
          },
          fontFamily: '"JetBrains Mono", "Menlo", "Monaco", "SF Mono", monospace',
          fontLigatures: true
        }}
      />
    </div>
  )
}
