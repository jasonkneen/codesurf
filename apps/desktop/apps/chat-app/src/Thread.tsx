import {
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  AuiIf,
} from '@assistant-ui/react'
import {
  ArrowDownIcon,
  ArrowUpIcon,
  PaperclipIcon,
  SquareIcon,
} from 'lucide-react'

export function Thread() {
  return (
    <ThreadPrimitive.Root
      className="flex h-full flex-col bg-background text-sm text-foreground"
      style={{ ['--thread-max-width' as string]: '48rem' } as React.CSSProperties}
    >
      <ThreadPrimitive.Viewport
        turnAnchor="top"
        className="cs-no-scrollbar relative flex flex-1 flex-col overflow-y-scroll scroll-smooth px-4 pt-4"
      >
        <AuiIf condition={(s) => s.thread.isEmpty}>
          <Welcome />
        </AuiIf>

        <ThreadPrimitive.Messages
          components={{ UserMessage, AssistantMessage }}
        />

        <ThreadPrimitive.ViewportFooter className="sticky bottom-0 mx-auto mt-auto flex w-full max-w-[var(--thread-max-width)] flex-col gap-2 bg-background pb-3 pt-2">
          <ScrollToBottom />
          <Composer />
        </ThreadPrimitive.ViewportFooter>
      </ThreadPrimitive.Viewport>
    </ThreadPrimitive.Root>
  )
}

/**
 * Welcome screen. Sized so it sits comfortably above the composer
 * without an enormous empty band — `pt-12` instead of stretching to
 * mid-viewport. Suggestion grid is 2-up from sm and above (~500px),
 * single-column under that so it stays usable in narrow embeds like
 * a sidebar tile or muxy's split panel.
 */
function Welcome() {
  return (
    <div className="mx-auto flex w-full max-w-[var(--thread-max-width)] flex-grow flex-col justify-center gap-6 pt-8 pb-2">
      <div className="flex flex-col items-center gap-1 text-center">
        <div className="text-2xl font-semibold text-foreground">Hello there</div>
        <div className="text-base text-muted-foreground">How can I help you today?</div>
      </div>
      <div className="grid w-full grid-cols-1 gap-2 sm:grid-cols-2">
        <SuggestionCard
          prompt="Explain the project architecture"
          title="Explain the project"
          subtitle="architecture"
        />
        <SuggestionCard
          prompt="Show me the most recent changes"
          title="Show recent changes"
          subtitle="in this workspace"
        />
      </div>
    </div>
  )
}

function SuggestionCard({
  prompt,
  title,
  subtitle,
}: {
  prompt: string
  title: string
  subtitle: string
}) {
  return (
    <ThreadPrimitive.Suggestion prompt={prompt} method="replace" autoSend asChild>
      <button
        type="button"
        className="flex h-auto w-full flex-col items-start gap-1 rounded-2xl border border-border bg-card px-4 py-3 text-left text-sm transition-colors hover:bg-muted"
      >
        <span className="font-medium text-foreground">{title}</span>
        <span className="text-xs text-muted-foreground">{subtitle}</span>
      </button>
    </ThreadPrimitive.Suggestion>
  )
}

/**
 * ScrollToBottom — sized to match the composer toolbar buttons so
 * when it's hidden (at-bottom) the layout doesn't shift, and when
 * shown it sits visibly above the composer. The previous `p-3` made
 * it look like an orphan target circle when the disabled state
 * collapsed wrong; now we let the asChild fully control disabled
 * state and use a less ambiguous shape.
 */
function ScrollToBottom() {
  return (
    <ThreadPrimitive.ScrollToBottom asChild>
      <button
        type="button"
        className="mx-auto flex size-7 items-center justify-center rounded-full border border-border bg-background text-muted-foreground transition hover:text-foreground disabled:pointer-events-none disabled:opacity-0"
        aria-label="Scroll to bottom"
      >
        <ArrowDownIcon className="size-3.5" />
      </button>
    </ThreadPrimitive.ScrollToBottom>
  )
}

function Composer() {
  return (
    <ComposerPrimitive.Root className="relative flex w-full flex-col">
      <ComposerPrimitive.AttachmentDropzone className="flex w-full flex-col rounded-3xl border border-border bg-card px-1 pt-2 outline-none transition-shadow has-[textarea:focus-visible]:border-ring has-[textarea:focus-visible]:ring-2 has-[textarea:focus-visible]:ring-ring/20 data-[dragging=true]:border-dashed data-[dragging=true]:bg-muted/40">
        <ComposerPrimitive.Input
          placeholder="Send a message…"
          className="mb-1 max-h-32 min-h-12 w-full resize-none bg-transparent px-4 pt-2 pb-2 text-sm text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-0"
          rows={1}
          autoFocus
          aria-label="Message input"
        />
        <ComposerActions />
      </ComposerPrimitive.AttachmentDropzone>
    </ComposerPrimitive.Root>
  )
}

function ComposerActions() {
  return (
    <div className="relative mx-2 mb-2 flex items-center justify-between">
      <button
        type="button"
        className="flex size-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        aria-label="Attach file"
        title="Attach file"
      >
        <PaperclipIcon className="size-4" />
      </button>
      <AuiIf condition={(s) => !s.thread.isRunning}>
        <ComposerPrimitive.Send asChild>
          <button
            type="submit"
            className="flex size-8 items-center justify-center rounded-full text-[color:var(--accent-foreground)] transition-opacity hover:opacity-90 disabled:opacity-40"
            style={{ backgroundColor: 'var(--accent-color)' }}
            aria-label="Send message"
          >
            <ArrowUpIcon className="size-4" />
          </button>
        </ComposerPrimitive.Send>
      </AuiIf>
      <AuiIf condition={(s) => s.thread.isRunning}>
        <ComposerPrimitive.Cancel asChild>
          <button
            type="button"
            className="flex size-8 items-center justify-center rounded-full bg-foreground text-background transition-opacity hover:opacity-90"
            aria-label="Stop generating"
          >
            <SquareIcon className="size-3 fill-current" />
          </button>
        </ComposerPrimitive.Cancel>
      </AuiIf>
    </div>
  )
}

function UserMessage() {
  return (
    <MessagePrimitive.Root
      className="mx-auto grid w-full max-w-[var(--thread-max-width)] grid-cols-[minmax(72px,1fr)_auto] gap-y-2 px-2 py-3"
      data-role="user"
    >
      <div className="col-start-2 min-w-0">
        <div className="break-words rounded-3xl bg-muted px-4 py-2.5 text-sm text-foreground">
          <MessagePrimitive.Parts />
        </div>
      </div>
    </MessagePrimitive.Root>
  )
}

function AssistantMessage() {
  return (
    <MessagePrimitive.Root
      className="relative mx-auto w-full max-w-[var(--thread-max-width)] py-3"
      data-role="assistant"
    >
      <div className="break-words px-2 text-sm leading-relaxed text-foreground">
        <MessagePrimitive.Parts />
        <AuiIf condition={(s) => s.thread.isRunning && s.message.content.length === 0}>
          <span className="text-muted-foreground">thinking…</span>
        </AuiIf>
      </div>
    </MessagePrimitive.Root>
  )
}
