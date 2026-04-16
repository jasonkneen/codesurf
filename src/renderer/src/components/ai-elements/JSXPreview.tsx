import React, { createContext, useContext, useEffect, useMemo, useState } from 'react'
import JsxParser from 'react-jsx-parser'
import type { TProps as JsxParserProps } from 'react-jsx-parser'

type JSXPreviewContextValue = {
  jsx: string
  isStreaming: boolean
  components?: JsxParserProps['components']
  bindings?: JsxParserProps['bindings']
  error: Error | null
  setError: React.Dispatch<React.SetStateAction<Error | null>>
  onError?: (error: Error) => void
}

const JSXPreviewContext = createContext<JSXPreviewContextValue | null>(null)

const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr',
])

function useJSXPreviewContext(): JSXPreviewContextValue {
  const value = useContext(JSXPreviewContext)
  if (!value) throw new Error('JSXPreview components must be used within <JSXPreview>')
  return value
}

function trimTrailingIncompleteTag(source: string): string {
  let inSingle = false
  let inDouble = false
  let inTemplate = false
  let braceDepth = 0
  let tagStart = -1

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    const prev = source[index - 1]

    if (char === "'" && !inDouble && !inTemplate && prev !== '\\') {
      inSingle = !inSingle
      continue
    }
    if (char === '"' && !inSingle && !inTemplate && prev !== '\\') {
      inDouble = !inDouble
      continue
    }
    if (char === '`' && !inSingle && !inDouble && prev !== '\\') {
      inTemplate = !inTemplate
      continue
    }
    if (inSingle || inDouble || inTemplate) continue

    if (char === '{') {
      braceDepth += 1
      continue
    }
    if (char === '}' && braceDepth > 0) {
      braceDepth -= 1
      continue
    }

    if (braceDepth > 0) continue

    if (char === '<' && tagStart === -1) {
      tagStart = index
      continue
    }
    if (char === '>' && tagStart !== -1) {
      tagStart = -1
    }
  }

  return tagStart === -1 ? source : source.slice(0, tagStart)
}

function readJsxTag(source: string, startIndex: number): { name: string; closing: boolean; selfClosing: boolean; endIndex: number } | null {
  if (source[startIndex] !== '<') return null
  const next = source[startIndex + 1]
  if (!next || /[!?]/.test(next)) return null

  let index = startIndex + 1
  let inSingle = false
  let inDouble = false
  let inTemplate = false
  let braceDepth = 0

  while (index < source.length) {
    const char = source[index]
    const prev = source[index - 1]

    if (char === "'" && !inDouble && !inTemplate && prev !== '\\') {
      inSingle = !inSingle
      index += 1
      continue
    }
    if (char === '"' && !inSingle && !inTemplate && prev !== '\\') {
      inDouble = !inDouble
      index += 1
      continue
    }
    if (char === '`' && !inSingle && !inDouble && prev !== '\\') {
      inTemplate = !inTemplate
      index += 1
      continue
    }
    if (inSingle || inDouble || inTemplate) {
      index += 1
      continue
    }

    if (char === '{') {
      braceDepth += 1
      index += 1
      continue
    }
    if (char === '}' && braceDepth > 0) {
      braceDepth -= 1
      index += 1
      continue
    }

    if (char === '>' && braceDepth === 0) {
      const raw = source.slice(startIndex, index + 1)
      const match = raw.match(/^<\/?\s*([A-Za-z][\w:.-]*)/)
      if (!match) return null
      const name = match[1]
      const closing = /^<\//.test(raw)
      const selfClosing = !closing && (VOID_ELEMENTS.has(name.toLowerCase()) || /\/\s*>$/.test(raw))
      return { name, closing, selfClosing, endIndex: index + 1 }
    }

    index += 1
  }

  return null
}

function autoCloseStreamingJsxTags(source: string): string {
  const trimmed = trimTrailingIncompleteTag(source)
  const stack: string[] = []

  for (let index = 0; index < trimmed.length; index += 1) {
    if (trimmed[index] !== '<') continue
    const tag = readJsxTag(trimmed, index)
    if (!tag) continue
    index = tag.endIndex - 1

    if (tag.selfClosing) continue
    if (tag.closing) {
      const matchIndex = stack.lastIndexOf(tag.name)
      if (matchIndex >= 0) stack.splice(matchIndex, 1)
      continue
    }

    stack.push(tag.name)
  }

  if (stack.length === 0) return trimmed
  return `${trimmed}${stack.reverse().map(tag => `</${tag}>`).join('')}`
}

function extractReturnedJsx(source: string): string {
  const returnIndex = source.indexOf('return')
  if (returnIndex === -1) return source

  const openParen = source.indexOf('(', returnIndex)
  if (openParen === -1) return source

  let depth = 0
  let inSingle = false
  let inDouble = false
  let inTemplate = false

  for (let index = openParen; index < source.length; index += 1) {
    const char = source[index]
    const prev = source[index - 1]

    if (char === "'" && !inDouble && !inTemplate && prev !== '\\') {
      inSingle = !inSingle
      continue
    }
    if (char === '"' && !inSingle && !inTemplate && prev !== '\\') {
      inDouble = !inDouble
      continue
    }
    if (char === '`' && !inSingle && !inDouble && prev !== '\\') {
      inTemplate = !inTemplate
      continue
    }
    if (inSingle || inDouble || inTemplate) continue

    if (char === '(') {
      depth += 1
      continue
    }
    if (char === ')') {
      depth -= 1
      if (depth === 0) return source.slice(openParen + 1, index).trim()
    }
  }

  return source.slice(openParen + 1).trim()
}

function normalizePreviewJsx(source: string, isStreaming: boolean): string {
  let normalized = source.trim()
  if (!normalized) return ''

  normalized = normalized
    .replace(/^```[\w-]*\s*/i, '')
    .replace(/\s*```$/i, '')
    .replace(/^['"]use client['"];?\s*/i, '')
    .trim()

  if (normalized.startsWith('return ')) {
    normalized = normalized.replace(/^return\s+/, '').replace(/;\s*$/, '').trim()
  }

  if (!normalized.startsWith('<') && normalized.includes('return')) {
    const returned = extractReturnedJsx(normalized)
    if (returned.startsWith('<') || returned.startsWith('(')) normalized = returned
  }

  if (normalized.startsWith('(') && normalized.endsWith(')')) {
    const inner = normalized.slice(1, -1).trim()
    if (inner.startsWith('<')) normalized = inner
  }

  return isStreaming ? autoCloseStreamingJsxTags(normalized) : normalized
}

class PreviewErrorBoundary extends React.Component<{
  onError: (error: Error) => void
  children: React.ReactNode
}, { error: Error | null }> {
  constructor(props: { onError: (error: Error) => void; children: React.ReactNode }) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error): void {
    this.props.onError(error)
  }

  componentDidUpdate(prevProps: Readonly<{ onError: (error: Error) => void; children: React.ReactNode }>): void {
    if (prevProps.children !== this.props.children && this.state.error) {
      this.setState({ error: null })
    }
  }

  render(): React.ReactNode {
    if (this.state.error) return null
    return this.props.children
  }
}

export interface JSXPreviewProps extends React.ComponentProps<'div'> {
  jsx: string
  isStreaming?: boolean
  components?: JsxParserProps['components']
  bindings?: JsxParserProps['bindings']
  onError?: (error: Error) => void
}

export function JSXPreview({
  jsx,
  isStreaming = false,
  components,
  bindings,
  onError,
  children,
  ...props
}: JSXPreviewProps): JSX.Element {
  const [error, setError] = useState<Error | null>(null)
  const normalizedJsx = useMemo(() => normalizePreviewJsx(jsx, isStreaming), [jsx, isStreaming])

  useEffect(() => {
    setError(null)
  }, [normalizedJsx])

  const value = useMemo<JSXPreviewContextValue>(() => ({
    jsx: normalizedJsx,
    isStreaming,
    components,
    bindings,
    error,
    setError,
    onError,
  }), [bindings, components, error, isStreaming, normalizedJsx, onError])

  return (
    <div {...props}>
      <JSXPreviewContext.Provider value={value}>{children}</JSXPreviewContext.Provider>
    </div>
  )
}

export interface JSXPreviewContentProps extends React.ComponentProps<'div'> {
  renderError?: JsxParserProps['renderError']
}

export function JSXPreviewContent({ renderError, ...props }: JSXPreviewContentProps): JSX.Element {
  const { jsx, components, bindings, setError, onError } = useJSXPreviewContext()

  const handleError = useCallbackErrorReporter(setError, onError)

  if (!jsx.trim()) return <div {...props} />

  return (
    <div {...props}>
      <PreviewErrorBoundary onError={handleError}>
        <JsxParser
          autoCloseVoidElements
          bindings={bindings}
          blacklistedTags={['script']}
          components={components}
          jsx={jsx}
          onError={handleError}
          renderError={renderError}
          renderInWrapper={false}
        />
      </PreviewErrorBoundary>
    </div>
  )
}

function useCallbackErrorReporter(
  setError: React.Dispatch<React.SetStateAction<Error | null>>,
  onError?: (error: Error) => void,
): (error: Error) => void {
  return useMemo(() => (error: Error) => {
    setError(previous => {
      if (previous?.message === error.message) return previous
      return error
    })
    onError?.(error)
  }, [onError, setError])
}

export interface JSXPreviewErrorProps extends React.ComponentProps<'div'> {
  children?: React.ReactNode | ((error: Error) => React.ReactNode)
}

export function JSXPreviewError({ children, ...props }: JSXPreviewErrorProps): JSX.Element | null {
  const { error } = useJSXPreviewContext()
  if (!error) return null

  const content = typeof children === 'function'
    ? children(error)
    : children ?? error.message

  return <div {...props}>{content}</div>
}
