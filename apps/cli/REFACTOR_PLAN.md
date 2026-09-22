# UI Architecture Refactor: God Component → Provider Tree

## Status (June 2026)

**Completed:** Phases 1a–c, 2, 3, 4a, 6 (partial), 7a–c, 9.
**Skipped:** Phase 4b (turn engine — no re-render benefit), Phase 5 (composer —
too intertwined), Phase 6 telegram (deeply coupled to turn engine), Phase 8
(handleKey — 2,448 lines, high risk for marginal benefit).

**Results:** app.tsx 7,300 → 6,798 lines. Render tree 800 → 130 lines.
9 context providers. 3 memoized route components. 277 hooks (down from 426).
Typecheck, 1096 tests, and build all pass.

## Problem

`src/ui/app.tsx` was a 7,200-line god component with 426 React hooks in a single
function. Every state change — a modal toggle, a theme switch, a tool-call
update, a queued message — re-ran all 426 hooks synchronously on the single JS
thread. During agent turns this starved keyboard input ("keyboard very slow
when processing"). The `stream-store` band-aid fixed streaming tokens but every
other state change still reconciled the whole tree.

opencode (also OpenTUI) is fast because it distributes state across a provider
tree (`ThemeProvider`, `SDKProvider`, `SyncProvider`, `LocalProvider`, etc.) and
its `App` is 774 lines that just routes between `<Home/>` and `<Session/>`.

## Goal

Split the god component into a tree of React Context providers so a state
change re-renders only the consumers of that context, not the entire tree.
Mirror opencode's architecture on React (not Solid — the stream-store proves
the external-store pattern works fine on React for hot paths).

## Constraints

- **Extension kernel (`src/core/extensions/*`) is a black box.** Never modify
  its exports, APIs, or behaviour. Providers consume `getHostServices()`,
  `useCommands`, `useExtensions`, `useIcon`, `useScreens`,
  `useStatusIndicators`, `subscribeToRegistry` exactly as App does today.
- **No behaviour changes.** Every keystroke, every modal, every slash command,
  every tool approval, every telegram bridge path must work identically.
- **Incremental.** Each phase is independently shippable. After each phase:
  `bunx tsc --noEmit --allowImportingTsExtensions` passes, `bun test` passes,
  and the app launches.

## Architecture

### Provider Tree (nesting order = dependency order)

```
<App>
  <ThemeProvider>           — themeId, uiMode, t, setUiMode, toggleUiMode
    <ToastProvider>         — toasts[], copyFlashId, pushToast, showCopyBanner
      <ModalProvider>       — all show*Modal booleans, indices, search queries
        <ModelProvider>     — model, adapter, mode, sandbox, context stats
          <ConversationProvider>  — messages, session, turn state, processMessage
            <ComposerProvider>    — inputRef, paste, typeahead, queue
              <ApprovalProvider>  — payment/edit/tool approvals
                <RunningAgentsProvider> — delegation tracking, popup, modal
                  <TelegramProvider>     — bridge, agents, turn coordinator
                    <AppShell />         — render tree (reads contexts)
```

### File Layout

```
src/ui/
  context/
    theme-context.tsx        — ThemeProvider + useTheme()
    toast-context.tsx        — ToastProvider + useToast()
    modal-context.tsx        — ModalProvider + useModal()
    model-context.tsx        — ModelProvider + useModel()
    conversation-context.tsx — ConversationProvider + useConversation()
    composer-context.tsx     — ComposerProvider + useComposer()
    approval-context.tsx     — ApprovalProvider + useApproval()
    running-agents-context.tsx — RunningAgentsProvider + useRunningAgents()
    telegram-context.tsx     — TelegramProvider + useTelegram()
  routes/
    home-route.tsx           — <HomeRoute/> (empty-state + composer)
    session-route.tsx        — <SessionRoute/> (message list + composer + status)
  app.tsx                    — provider tree + <AppShell/> (~200 lines target)
  app-shell.tsx              — read contexts, render routes + modals
  stream-store.ts            — unchanged (already external store)
```

### Context Value Pattern

Each provider follows this shape:

```tsx
interface ThemeCtx {
  themeId: string
  setThemeId: (id: string) => void
  t: Theme
  uiMode: UiMode
  setUiMode: (mode: UiMode) => void
  toggleUiMode: () => void
}

const ThemeContext = createContext<ThemeCtx | null>(null)

export function useTheme(): ThemeCtx {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error("useTheme must be used inside <ThemeProvider>")
  return ctx
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  // All theme state + actions here
  const value = useMemo<ThemeCtx>(() => ({ themeId, setThemeId, t, ... }), [deps])
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}
```

**Critical:** the context value must be `useMemo`'d so consumers don't re-render
on every provider render. Only include in the memo deps the values that
actually change.

## Migration Order

Each phase = one commit. After each: typecheck + test + launch.

### Phase 1a: ToastProvider (leaf, zero cross-deps)

**Move:** `toasts`, `setToasts`, `nextToastIdRef`, `copyFlashId`,
`setCopyFlashId`, `pushToast`, `showCopyBanner`, `copyTuiSelectionToHost`,
`handleRootMouseUp` (clipboard copy).

**Render:** `<ToastStack>` and `<CopyFlashBanner>` move into ToastProvider's
children (they read from context, not props).

**Risk:** None — toasts are write-only from App's perspective; no other state
reads toast state.

### Phase 1b: ThemeProvider (read by many, written by few)

**Move:** `themeId`, `setThemeId`, `baseTheme`, `t`, `uiMode`, `setUiMode`,
`toggleUiMode`, `pendingComposerRestoreRef`, `previousUiModeRef`, the uiMode
restore effect, `showThemeModal`, `themeSearchQuery`, `themeModalIndex`,
`themePreviewOriginalRef`, `openThemeModal`, `previewTheme`, `applyTheme`,
`revertThemePreview`.

**Consumers:** Any component currently receiving `t` as a prop can instead call
`useTheme().t`. But initially we keep passing `t` as props from AppShell to
avoid touching every component — the win is that a theme change re-renders only
ThemeProvider + AppShell, not the 426 hooks.

**Risk:** Low — theme is read-heavy but the write paths (theme picker, /ui
toggle) are isolated.

### Phase 1c: BtwProvider (self-contained)

**Move:** `btwState`, `setBtwState`, `btwAbortRef`, `btwStateRef`,
`setBtwStateSync`, `dismissBtw`.

**Risk:** None — btw is an isolated overlay.

### Phase 2: ModalProvider (~100 useState, highest impact)

**Move:** Every `show*Modal` boolean, every `*ModalIndex`, every
`*SearchQuery`, every `show*Ref` mirror, all `open*Modal`/`close*Modal`
callbacks. Specifically:

- Theme modal (if not already in ThemeProvider)
- ClaudeAgent modal
- Terminal modal + terminalInputMode
- Showcase modal
- Command palette
- API key modal
- Slash menu
- MCP modal + editor + drill state (16 useState)
- Agents modal + editor (10 useState)
- Schedule modal
- Extensions modal
- Feature flags modal
- Sessions modal
- Provider auth modal
- Provider settings modal
- Provider setting edit modal
- Update modal
- Connect modal
- Telegram token/pair modals
- Quit confirm
- Wallet picker
- Sandbox picker
- Recap picker

**Pattern:** Each modal group gets a sub-object in the context value:

```tsx
interface ModalCtx {
  theme: { show: boolean; index: number; query: string; open: () => void; close: () => void; ... }
  mcp: { show: boolean; editorShow: boolean; index: number; ... }
  // etc.
}
```

**Why this is high impact:** ~100 of the 426 hooks are modal state. Opening
any modal currently re-runs all 426. After this phase, opening a modal
re-renders only ModalProvider + the modal component.

**Risk:** Medium — many `open*Modal` callbacks have side effects (loading data,
setting up drafts). These must move with the state.

### Phase 3: ModelProvider

**Move:** `model`, `modelAdapterId`, `mode`, `sandboxMode`, `sandboxSettings`,
`contextWindow`, `contextBreakdown`, `contextStats`, `reasoningEffortByModel`,
`recapsEnabled`, `permissionModeSnapshot`, `credentialsByAdapter`,
`activeModelAdapterId`, `activeModelCanRun`, all `setMode`/`cycleMode`/
`applySandbox*` callbacks, `setReasoningEfforts`, `getModelReasoningEffort`,
`adjustModelReasoningEffort`.

**Consumers:** ConversationProvider needs `model` + `mode` for processMessage.
Composer needs `model` for display. Render tree needs `contextStats` for the
meter.

**Risk:** Medium — model changes trigger agent reconfiguration. Must preserve
the exact sequence of `agent.setMode()` → `setModel()` → `setModelAdapterId()`.

### Phase 4: ConversationProvider (hardest — the turn engine)

**Move:** `messages`, `sessionId`, `sessionTitle`, `isProcessing`,
`justStopped`, `activeToolCalls`, `todoPlan`, `showTodoPanel`,
`pendingQuestionnaire`, `agentRoster`, `activeSubagent`, `activePlan`, `pqs`,
`expandedMessages`, `shellMode`, `liveTurnSourceLabel`, all refs
(`contentAccRef`, `reasoningAccRef`, `startTimeRef`, `activeToolStartRef`,
`isProcessingRef`, `shellModeRef`, `activeRunIdRef`, `interruptedRunIdRef`,
`activeTurnRef`, `scrollRef`, `transcriptAutoFollowRef`), and the core turn
functions: `processMessage`, `finalizeActiveTurn`, `beginLiveTurn`,
`clearLiveTurnUi`, `finishTurnProcessing`, `flushPendingAssistantMessage`,
`showLiveToolCalls`, `appendLiveToolResult`, `applyLocalAssistantDelta`,
`resetToNewSession`, `resumeSessionFromModal`, `deleteSessionFromModal`.

**Dependencies:** Reads `model` from ModelProvider, `pushToast` from
ToastProvider, modal close functions from ModalProvider. Writes to
`stream-store` (already external).

**Risk:** High — this is the turn engine. `processMessage` is 280 lines with
deep coupling to agent callbacks, stream-store, and a dozen state setters. Must
be moved as a unit. The refs that `handleKey` and `inputRouter` read
(`isProcessingRef`, `activeTurnRef`, `activeRunIdRef`) must be exposed via
context so those external listeners can still read them.

**Key design:** ConversationProvider exposes refs via context:

```tsx
interface ConversationCtx {
  // ... state + actions ...
  refs: {
    isProcessing: React.RefObject<boolean>;
    activeTurn: React.RefObject<ActiveTurnState | null>;
    activeRunId: React.RefObject<number>;
    interruptedRunId: React.RefObject<number | null>;
  };
}
```

This lets `useInputRouter` (which is called in AppShell) read the refs without
App owning them.

### Phase 5: ComposerProvider

**Move:** `inputRef`, `commitComposer`, `pasteBlocks`, `pasteCounterRef`,
`pasteBlocksRef`, `typeahead`, `typeaheadRef`, `promptHistory`,
`promptHistoryRef`, `workspaceId`, `fileMentionCounterRef`,
`fileMentionBlocksRef`, `handleFileAccept`, `queuedMessages`,
`queuedMessagesRef`, `nextQueueIdRef`, `queueFocusId`, `queueFocusIdRef`,
`suggestionsDismissedAtLength`, `handlePaste`, `handleSubmit`,
`insertDroppedFilePaths`, `insertImagePathBlock`, `insertFileMentionBlock`,
`replacePasteBlocks`.

**Risk:** Medium — composer is complex but self-contained. The main cross-dep
is `handleSubmit` calling `processMessage` (from ConversationProvider).

### Phase 6: Remaining providers

- **ApprovalProvider:** `pendingPaymentApproval`, `pendingEditApproval`,
  `pendingToolApproval` + their setters.
- **RunningAgentsProvider:** `runningDelegations`, `agentsFooterFocused`,
  `showAgentsPopup`, `agentsPopupIndex`, `agentModalId`, `agentModalSnapshot`,
  `agentModalOutput`, `agentModalLoading`, `agentsNow`, `runningAgentRowsRef`,
  all open/close callbacks.
- **TelegramProvider:** `bridgeRef`, `telegramAgentsRef`,
  `telegramEntryCountsRef`, `telegramSubagentUnsubsRef`, `coordinatorRef`,
  all telegram callbacks (`startTelegramBridge`, `wireTelegramAgentUi`,
  `getTelegramAgent`, `appendTelegramUserMessage`, `upsertTelegramAssistantMessage`,
  etc.).

### Phase 7: Split render tree

Replace the 800-line inline JSX in App's return with:

```tsx
function AppShell() {
  const { messages } = useConversation()
  return (
    <box ...>
      {messages.length > 0 ? <SessionRoute /> : <HomeRoute />}
      <ModalLayer />      // reads useModal(), renders all modals
      <OverlayLayer />    // quit confirm, agents popup, btw, etc.
      <ScreenSlot />      // extension screens (unchanged)
    </box>
  )
}
```

- `HomeRoute` — empty state + hero + composer + footer
- `SessionRoute` — message list + status slot + layout + composer
- `ModalLayer` — all modal components, each reads its own context slice
- `OverlayLayer` — quit confirm, agents popup, copy flash, toasts

**Impact:** The 800-line render expression is currently re-evaluated on every
state change. After splitting, `<HomeRoute/>` is memoized and doesn't
re-render when a modal toggles.

### Phase 8: Decompose handleKey

The 1,800-line `handleKey` is a dispatch ladder: "if modal X is open, handle
its keys; else if modal Y is open, handle its keys; else..."

Move each modal's key handling into the modal component itself via its own
`useKeyboard`. The remaining `handleKey` in AppShell handles only:

- Global shortcuts (Ctrl+K, /, Ctrl+X) — already in `inputRouter.handleKey`
- Composer keys (Up/Down history, Enter submit)
- Queue navigation

**Risk:** Medium — must preserve exact priority order. The current
innermost-first dispatch must be replicated. Each modal's `useKeyboard` must
call `key.preventDefault()` + `key.stopPropagation()` to prevent fallthrough.

### Phase 9: Renderer config

- Add `targetFps: 60` to the render config in `src/index.ts` (matches opencode).
- Audit `enableMouseMovement: true` — if hover states are only needed in
  modals, consider disabling globally and enabling per-component.

## Verification

After each phase:

1. `bunx tsc --noEmit --allowImportingTsExtensions` — typecheck
2. `bun test` — run all tests
3. Manual smoke: launch app, send a message, open /models, /mcp, /themes, Esc
   out of each, verify keyboard responsiveness during streaming

## What NOT to touch

- `src/core/extensions/*` — extension kernel (black box)
- `src/agent/*` — agent engine
- `src/ui/stream-store.ts` — already external store (working pattern)
- `src/ui/components/message-list.tsx` — message virtualization (separate concern)
- `src/ui/markdown.tsx` — markdown renderer (separate concern)
- `src/ui/input/useInputRouter.ts` — already extracted, will consume context refs
- `src/ui/layouts/*` — layout registry (already extracted)
- All `*-modal.tsx` component files — they already exist; just change how they
  receive props (from App state → from context)
