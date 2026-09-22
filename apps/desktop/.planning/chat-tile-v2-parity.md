# ChatTile V2 Parity Inventory

**Purpose**: enumerate every feature, state, side-effect, IPC, event-bus channel, persisted file, and visual surface in the current `ChatTile.tsx` (8,764 LOC, 5,344-line component, 83 useState, 43 useRef, 59 useEffect, 60 useCallback, 25 useMemo, 40 unique IPC channels). V2 must satisfy *all* of it before V1 is removed.

Source files in scope (12,372 LOC total):
- `src/renderer/src/components/ChatTile.tsx` (8,764)
- `src/renderer/src/components/chat/ChatComposer.tsx` (1,040)
- `src/renderer/src/components/chat/ChatComposerControls.tsx` (150)
- `src/renderer/src/components/chat/ChatComposerMenus.tsx` (349)
- `src/renderer/src/components/chat/PlanCard.tsx` (154)
- `src/renderer/src/components/chat/PlanPane.tsx` (137)
- `src/renderer/src/components/chat/PlanChip.tsx` (60)
- `src/renderer/src/components/chat/DiffView.tsx` (219)
- `src/renderer/src/components/chat/BlockNoteAffordance.tsx` (467)
- `src/renderer/src/components/chat/checkpointToolActions.ts` (72)
- `src/renderer/src/components/chat/dreamToolActions.ts` (9)
- `src/renderer/src/components/chatTileRuntimeState.ts` (25)
- `src/renderer/src/components/chatStreamingStore.ts` (76)
- `src/renderer/src/components/chatMessageSentStore.ts` (49)
- `src/renderer/src/components/chatSurfaceHostRpc.ts` (134)
- `src/renderer/src/components/shared/streamdown-utils.tsx` (667)

---

## 1. Public surface — Props (parent contract)

```ts
interface Props {
  tileId: string
  workspaceId: string
  workspaceDir: string
  width: number
  height: number
  reloadToken?: number
  settings?: AppSettings
  onChatModePreferenceChange?: (providerId: string, modeId: string) => void
  isConnected?: boolean
  isAutoConnected?: boolean
  connectedPeers?: DiscoveryPeer[]
}
```
V2 MUST keep this exact signature so canvas mounting in `App.tsx` doesn't change.

---

## 2. Provider/transport surface — what V2 must speak

### Builtin providers (`config/providers.ts`)
- `claude` — Claude Agent SDK, session resumption, adaptive thinking
- `codex` — Codex CLI subprocess
- `opencode` — OpenCode HTTP server (model list streamed via `chat:opencodeModels` IPC)
- `openclaw` — OpenClaw via OpenCode API (agent list via `chat:openclawAgents`)
- `hermes` — Hermes (planning surface)

Each has: `id, label, description, icon, kind: 'builtin', models: ModelOption[], transport`.

### Extension providers
Discovered dynamically; each has `kind: 'extension', transport: ExtensionChatTransportConfig`.

### Provider modes
`PROVIDER_MODES[providerId]` returns `ModeOption[]` (e.g. plan/build/etc). For extensions, single `EXTENSION_PROVIDER_MODE`.

### Thinking levels
`THINKING_OPTIONS = [{ id: 'none' | 'low' | 'medium' | 'adaptive' | 'high' | 'max' }]` with brain-icon signal-bar visualization (0–5 bars).

### Per-provider Mode preferences
`settings.chatProviderModes[providerId] = modeId` — persisted user preference, surfaced via `onChatModePreferenceChange(providerId, modeId)`.

---

## 3. Stream protocol — backend → renderer

Subscribe via `window.electron.stream.onChunk((event) => {...})`, filtered by `event.cardId === tileId`. Sequence guard: `event.sequence` must be > `lastJobSequenceRef.current` to apply.

Event types handled (in `case event.type`):
- `session` — `{ sessionId }` updates `setSessionId`
- `text` — `{ text }` appends to last assistant message's `content` and last `contentBlocks` text block (or pushes new text block)
- `thinking_start` — `{ thinkingId }` opens new ThinkingBlock + content-block ref
- `thinking` — `{ text, thinkingId? }` appends to thinking; synthesises one if start was missed
- `tool_start` — `{ toolId, toolName }` creates ToolBlock with status running, dedups by id
- `tool_input` — `{ toolId, text }` streams JSON input string
- `tool_use` — `{ toolId, toolName, toolInput }` finalises input, marks done
- `tool_summary` — `{ toolId, toolName, text, fileChanges, commandEntries }` attaches summary, files, commands
- `tool_permission_request` — `{ toolId, toolName, provider, title, description, blockedPath, workspaceDir }` opens ToolPermissionCard
- `tool_permission_resolved` — `{ toolId, decision: 'deny'|'never'|'once'|'session'|'today'|'forever' }` closes card; persists deny banner
- `tool_progress` — `{ toolName, elapsed }` updates elapsed time
- `block_stop` — closes any open thinking + last running tool
- `done` — `{ sessionId?, cost?, turns? }` finalises message, sets `isStreaming=false`, publishes `activity` to bus
- `error` — `{ error }` sets error content, finalises

V2: `useChat` from `@ai-sdk/react` consumes a `UIMessageChunk` stream. Custom `ChatTransport` must translate the above event types into the AI SDK `UIMessageChunk` protocol (`text-start`, `text-delta`, `text-end`, `reasoning-start`, `reasoning-delta`, `reasoning-end`, `tool-input-start`, `tool-input-delta`, `tool-input-available`, `tool-output-available`, `data-*`, `finish`, `error`). No main-process changes; the renderer-side transport bridges.

---

## 4. State inventory (83 useState)

Grouped by feature. Initial values shown only where non-trivial.

### 4.1 Conversation state
- `messages: ChatMessage[]` — live transcript; init from `initialRuntimeStateRef`
- `historicalMessages: ChatMessage[]` — paged-history prepend buffer
- `input: string` — composer draft
- `isStreaming: boolean`
- `sessionId: string | null` — provider session id (Claude SDK / OpenCode session)
- `jobId: string | null` — backend job id for resume/sequence-guard
- `jobSequence: number`
- `linkedSessionEntryId: string | null` — when this tile is hooked to a session-history entry
- `linkedSessionHint: SessionEntryHint | null`
- `preserveSessionSummary: boolean`
- `hasEarlierMessages: boolean` — paged-history flag
- `loadingEarlier: boolean`
- `earlierLoadError: string | null`
- `pendingToolPermissions: Map<string, ToolPermissionRequest>`
- `resolvedToolPermissions: Map<string, ToolPermissionDecision>` — only stores denies

### 4.2 Provider/model/mode/thinking
- `provider: string`
- `model: string`
- `mode: string`
- `thinking: string` — adaptive default
- `mcpEnabled: boolean`
- `disabledServers: Set<string>` — per-tile MCP server disable set
- `executionTarget: 'local' | 'cloud'`
- `cloudHostId: string | null`
- `executionHosts: ExecutionHostRecord[]`
- `localExecutionLabel: string` — "Local" / "Instant"
- `opencodeModels: ModelOption[]`
- `openclawAgents: ModelOption[]`
- `modelFilter: string` — model dropdown search

### 4.3 Composer auxiliary
- `attachments: PendingAttachment[]` — `{ path, kind: 'image'|'file' }[]`
- `isDropTarget: boolean` — drag-over highlight
- `acType: 'slash' | 'mention' | null` — autocomplete trigger
- `acQuery: string`
- `acIndex: number`
- `workspaceFiles: Array<{ path; relPath; name; depth }>` — workspace file index for `@` mentions
- `workspaceSkills: SkillDefinition[]` — discovered skills/commands for `/`
- `skillLocationsVersion: number` — cache-bust signal

### 4.4 Menus (8 menu visibility states)
- `showModelMenu`, `showProviderMenu`, `showInsertMenu`, `showModeMenu`, `showThinkingMenu`, `showLocationMenu`, `showBranchMenu`, `showContextMenu`

### 4.5 Queue
- `queuedTurns: QueuedChatTurn[]` — `{ id, content, preview, attachmentCount, createdAt, parentId? }[]`
- `draggingTurnId: string | null`
- `dragOverTurn: { id; mode: 'before'|'after'|'into' } | null`
- `queueCollapsed: boolean`

### 4.6 Voice / TTS
- `isDictating: boolean`
- `dictationText: string`
- `dictationError: string | null`
- `ttsState: TtsPlayerState` — synced from `ttsPlayer.subscribe`

### 4.7 Plan / todos
- `isPlanOpen: boolean`
- `planUpdatedAt: number | null`
- `planTodos` — read from `useTileTodos(tileId)` external store

### 4.8 Surface host (chat-surface extensions)
- `openChatSurfaces: ActiveChatSurface[]`
- `activeChatSurfaceId: string | null`
- `chatSurfaceMenu: ChatSurfaceMenuEntry[]`

### 4.9 Drawer / scroll / git
- `latestChangeDrawerExpanded: boolean`
- `latestChangeDrawerExpandedFiles: Record<string, boolean>`
- `latestCheckpointId: string | null`
- `isRestoringLatestCheckpoint: boolean`
- `restoringCheckpointId: string | null`
- `showScrollToLatest: boolean`
- `gitStatus: GitStatusSummary`
- `gitBranches: GitBranchSummary`
- `branchFilter: string`

### 4.10 Misc
- `peerContextVersion: number` — peer-context invalidation tick
- `mode/lastPushedModeRef` — guards re-emit of mode preference
- `toolCollapseTick: number` — tool-chip collapse animation tick

### 4.11 Refs (43)
Critical refs:
- `initialRuntimeStateRef` — bootstrap state from `chatTileRuntimeState`
- `messagesRef` — scroll container
- `textareaRef` — composer input
- `acRef` — autocomplete popup positioning
- `stickToBottomRef` — auto-scroll lock
- `lastScrollTopRef`, `showScrollToLatestRef`
- `pendingHistoryPrependRef` — `{ previousHeight, previousTop }` for paged scroll preservation
- `latestStateRef` — debounced persist source
- `persistTimerRef`
- `lastJobSequenceRef`, `resumedJobKeyRef`
- `toolCompletedAtRef: Map<toolId, ms>` — for live-collapse grace timer
- `recognitionRef` — Web Speech recognizer (Chromium)
- `transcribeJobRef` — voice transcription job id
- `voiceSettingsRef` — voice config snapshot
- `peerContextRef: Map<peerId, ctx>` — peer context snapshot
- `openChatSurfacesRef`, `activeChatSurfaceRef` — surface ref mirrors
- `pendingChatSurfaceActionResultsRef: Map<requestId, {resolve,reject}>` — RPC pending
- 8 `*MenuRef` refs for portal anchors (model, provider, insert, mode, thinking, location, branch, context)
- `latestGitWorkspaceKeyRef`
- `lastSeenDreamCompletionRef`, `dreamPollSeededRef`
- `toolStampInitialRunRef`
- `annotationComposerActiveRef`
- `prevQueuedCountRef` — queue-grew-this-tick detection
- `pagedLinkedHistoryEnabledRef` — render-stable read of paged mode
- `stateLoadedRef`, `requestedProviderOptionsRef`, `isFlushingQueuedTurnRef`
- `lastActivityAtRef` — for liveness indicator

---

## 5. IPC channels touched (40 unique)

### 5.1 chat
- `chat:send` — primary send pipeline, returns `{ jobId? }`
- `chat:steer` — mid-stream steering message
- `chat:stop` — cancel current generation
- `chat:clearSession` — clear server-side session
- `chat:setPermissionMode` — push agent permission mode
- `chat:resumeJob` — resume a known jobId on remount
- `chat:loadSessionHistory` — page older messages
- `chat:opencodeModels`, `chat:openclawAgents` — provider model lists
- `chat:onOpencodeModelsUpdated` — push subscription
- `chat:answerToolPermission` — respond to permission request
- `chat:answerUserQuestion` — respond to AskUserQuestion tool form
- `chat:selectFiles` — native file picker

### 5.2 stream
- `stream:onChunk` — single subscription, filtered by `cardId === tileId`

### 5.3 canvas
- `canvas:saveTileState`, `canvas:loadTileState` — persist per-tile state JSON
- `canvas:getSessionState` — for linked-session bootstrap
- `canvas:restoreCheckpoint` — restore tile + workspace to checkpoint

### 5.4 fs
- `fs:readDir` — used by skill discovery + workspace file index
- `fs:readFile` — recent-edit context, skill markdown read

### 5.5 git
- `git:status`, `git:branches`, `git:checkoutBranch`, `git:createBranch`

### 5.6 execution
- `execution:listHosts` — for cloud host menu
- `execution:resolveTarget` — resolves `settings.execution` to host

### 5.7 workspace
- `workspace:openFolder`, `workspace:addProjectFolder`

### 5.8 extensions
- `extensions:invoke` — surface action invoke
- `extensions:getSettings`, `extensions:setSettings` — surface settings persistence

### 5.9 system / tileContext / transcribe / window / bus
- `system:daemonSummary` — for dream poll seeding
- `tileContext:getAll` — peer-context fetch
- `transcribe:run` — voice transcription
- `window:openMiniChat` — open chat in detached mini window
- `bus:subscribe`, `bus:publish`

---

## 6. Event-bus channels

### Publishes
- `tile:${tileId}` / `tool_inventory` — `{ provider, model, mcpEnabled, tools, updatedAt }`
- `tile:${tileId}` / `skill_inventory` — `{ provider, model, skills, updatedAt }`
- `tile:${tileId}` / `activity` — `{ message, role }` on user-send + assistant-done + steer

### Subscribes
- Per-peer: `tile:${peer.peerId}` — receives peer state updates (peer-context tracking)
- `tile:${tileId}` (`chat:${tileId}:mcp` subscriber) — incoming MCP peer commands; injects peer messages into transcript with content-hash dedup

---

## 7. Persisted state shapes

### 7.1 In-memory runtime state
`chatTileRuntimeState` map keyed by tileId, holds `ChatTilePersistedState`:
```ts
{ messages, input, attachments, queuedTurns, provider, model, mcpEnabled, mode, thinking,
  agentMode, autoAgentMode, preserveSessionSummary, linkedSessionEntryId, linkedSessionHint,
  hasEarlierMessages, sessionId, jobId, jobSequence, cloudHostId, isStreaming, executionTarget }
```

### 7.2 Disk persistence (debounced 500ms via `persistTimerRef`)
Written via `canvas:saveTileState` → `~/.codesurf/workspaces/{id}/tiles/{tileId}.json`.

### 7.3 External stores referenced
- `chatStreamingStore` — `setChatStreaming(tileId, isStreaming)` for cross-tile awareness
- `chatMessageSentStore` — `recordChatMessageSent(...)` to promote thread in sidebar
- `tileTodosStore` — `setTileTodos / clearTileTodos / useTileTodos` for plan
- `chatTileRuntimeState` — `getChatTileRuntimeState / setChatTileRuntimeState / reviveChatTileRuntimeState / isChatTileRuntimeStateDisposed`

### 7.4 Skills/commands discovery roots
Via `CHAT_DEFAULT_SKILL_LOCATIONS` (overridable by `~/.codesurf/workspaces/{id}/.contex/customisation/locations-skills.json` and `locations-prompts.json`):
```
$HOME/.claude/commands
$WORKSPACE/.claude/commands
$HOME/.claude/skills
$WORKSPACE/.claude/skills
$HOME/.config/opencode/skills
$WORKSPACE/.opencode/skills
$WORKSPACE/.cursor/rules
$WORKSPACE/.continue/prompts
```

---

## 8. Effects (59 useEffects) — what fires when

Numbered as found in source. Annotated with concern.

| # | Line | Triggers | Concern |
|---|---|---|---|
| 1 | 2434 | `connectedPeers, peerContextVersion, workspaceId` | peer-context fetch via `tileContext.getAll` |
| 2 | 2468 | `connectedPeerSignature` | bus subscribe per peer for context updates |
| 3 | 2513 | `pagedLinkedHistoryEnabled` | mirror to ref |
| 4 | 2541 | `openChatSurfaces` | mirror to `openChatSurfacesRef` |
| 5 | 2547 | `activeChatSurface` | mirror to `activeChatSurfaceRef` |
| 6 | 2567 | once | runtime-state revival check |
| 7 | 2607 | mount | mark `stateLoadedRef` |
| 8 | 2611 | voice settings change | mirror to ref |
| 9 | 2660 | mount | `ttsPlayer.subscribe` |
| 10 | 2688 | `planTodos` | sync `setTileTodos`/`clearTileTodos` |
| 11 | 2692 | `planTodos` | bump `planUpdatedAt` |
| 12 | 2771 | `loadEarlierMessages` | mirror to ref |
| 13 | 2784 | `_workspaceDir` | workspace file index build (recursive readDir) |
| 14 | 3048 | `latestChangeDrawerFile` | drawer toggle handler closure |
| 15 | 3060 | various | latest checkpoint scan |
| 16 | 3191 | `workspaceId` | dream poll seeding |
| 17 | 3254 | mount | locations-changed listener |
| 18 | 3258 | mount | `ensureChatMdStyle()` |
| 19 | 3264 | locations event | bump skillLocationsVersion |
| 20 | 3277 | `_workspaceDir, skillLocationsVersion` | workspace skill discovery (multi-source) |
| 21 | 3390 | inventory deps | publish `tool_inventory` to bus |
| 22 | 3400 | inventory deps | publish `skill_inventory` to bus |
| 23 | 3411 | `provider` | OpenCode model push subscription |
| 24 | 3421 | `provider` | OpenCode/OpenClaw model fetch (one-shot per provider per tile) |
| 25 | 3441 | mount | `execution.listHosts` |
| 26 | 3453 | `settings.execution` | resolve target → label |
| 27 | 3480 | various | normalize-messages-for-memory pass |
| 28 | 3489 | paged-history overflow | move overflow into historical |
| 29 | 3504 | many | `latestStateRef` rebuild |
| 30 | 3539 | latestStateRef | debounced disk persist (500ms) |
| 31 | 3561 | mount | `setChatStreaming` cleanup on unmount |
| 32 | 3570 | various | `toolCompletedAtRef` stamping for collapse grace |
| 33 | 3606 | `messages` | runtime state mirror |
| 34 | 3627 | `messages, isStreaming` | toolCollapseTick scheduler |
| 35 | 3712 | `workspaceId, tileId, reloadToken` | `canvas.loadTileState` bootstrap |
| 36 | 3745 | `linkedSessionEntryId` | linked-session bootstrap |
| 37 | 3752 | `mode` | push mode preference back to parent (`onChatModePreferenceChange`) |
| 38 | 3762 | `tileId, mode` | `chat.setPermissionMode` push |
| 39 | 3776 | `provider` | provider model defaults |
| 40 | 3802 | various | git state load on workspace change |
| 41 | 3818 | `_workspaceDir` | git refresh interval |
| 42 | 3832 | `jobId` | `chat.resumeJob` reattach to backend |
| 43 | 3959 | various | menu close on outside click (8 menus) |
| 44 | 4069 | mount | mini-chat keyboard shortcuts |
| 45 | 4096 | various | `lastActivityAtRef` updates |
| 46 | 4168 | `_workspaceDir` | git workspace key sync |
| 47 | 4184 | various | scroll-to-latest visibility |
| 48 | 4257 | mount | scroll listener (handleMessagesScroll) |
| 49 | 4263 | various | useLayoutEffect: pin scrollTop=scrollHeight when sticky |
| 50 | 4368 | drag listeners | window-level dragend reset |
| 51 | 4532 | `tileId` | **stream:onChunk subscription (THE STREAM HANDLER)** |
| 52 | 4846 | `tileId` | bus subscription for incoming MCP peer commands |
| 53 | 4940 | various | dictation lifecycle |
| 54 | 5024 | various | chat-surface RPC `window message` listener |
| 55 | 5696 | autocomplete | refocus textarea after select |
| 56 | 5702 | mount | global keydown for queue/composer |
| 57 | 7558 | thinking timer | thinking-block elapsed update |
| 58 | 7568 | thinking timer | thinking-block complete time |
| 59 | 7760 | tool block | tool-block elapsed/expanded |

---

## 9. Callbacks (60 useCallbacks) — feature mapping

| Callback | Feature |
|---|---|
| `handleToolPermissionDecision` | tool permission: send via `chat.answerToolPermission` |
| `setChatSurfaceIframeRef`, `getChatSurfaceIframe`, `postToChatSurface`, `getChatSurfacePeerEntries` | chat-surface RPC plumbing |
| `setMessagesSafe` | safe setMessages (handles disposed runtime state) |
| `loadEarlierMessages` | paged history load older |
| `mergeDrawerFileChanges`, `toggleLatestChangeDrawerFile` | latest-change drawer |
| `restoreLatestCheckpoint`, `restoreCheckpointFromToolBlock` | checkpoint restore actions |
| `persistLatestState` | debounced disk save |
| `applyGitState`, `refreshGitState` | git state cache/load |
| `handleProjectFolderSwitch` | open folder picker → add to workspace |
| `handleBranchSelect`, `handleCreateBranch` | git branch operations |
| `handleProviderChange` | provider switch (resets to default model + mode) |
| `toggleMenu` | mutually-exclusive menu open/close |
| `toggleDictation` | voice push-to-talk start/stop |
| `isNearLatest`, `syncScrollToLatestVisibility`, `scrollToLatest` | scroll-to-latest button |
| `reviewLatestChanges` | open latest-change drawer |
| `handleMessagesWheel`, `handleMessagesKeyDown`, `handleMessagesScroll` | sticky-scroll release |
| `setAnnotationComposerActive`, `updateBlockNote`, `collectAllNotes`, `exportNotesToClipboard` | block notes (annotations on past messages/tools/thinking) |
| `focusComposer`, `syncComposerHeight` | composer focus + autosize |
| `addAttachments`, `openAttachmentPicker`, `removeAttachment` | attachment handling |
| `openChatSurface`, `openBuilderFromSketch`, `closeChatSurface` | chat-surface lifecycle |
| `handleTileDragOver`, `handleTileDragLeave`, `handleTileDrop` | tile-level drag/drop |
| `dispatchMessageContent` | the SEND PIPELINE — builds request, calls `chat.send`, optimistically updates messages |
| `logQueueEvent`, `flushQueueStateNow`, `reorderQueuedTurn`, `queueCurrentDraft`, `handleQueuedTurnSteer` | queued-turn queue management |
| `sendMessage` | composer Enter/Send → calls `dispatchMessageContent` or queues |
| `insertSteerMessageIntoStream` | mid-stream steering UI |
| `stopStreaming`, `clearConversation` | stop / clear |
| `selectAcItem`, `handleKeyDown`, `handleKeyUp`, `handleInputChange` | autocomplete + composer keyboard |
| `openMiniChat` | open this chat in mini window |
| `toggleFile` (sub-component) | file-change list expand |

---

## 10. Memos (25)

| Memo | Purpose |
|---|---|
| `peerToolNames` | tool name set from connectedPeers |
| `availableToolInventory` | published to bus (tool_inventory) |
| `availableSkillInventory` | published to bus (skill_inventory) |
| `connectedPeerSignature` | dep stabilization |
| `implicitPeerImageAttachments` | image peers auto-attach |
| `activeChatSurface` | current surface from id |
| `lastAssistantMessage` | for context dial |
| `renderedMessages` | paged + windowed (CHAT_RENDER_WINDOW=80) |
| `liveComposerActivityChip` | "Working" / "Thinking" chip above composer |
| `providerEntryById` | provider lookup map (builtin + extensions) |
| `contextWindowLimit`, `systemOverheadTokens` | context dial math |
| `readPathsSnapshot`, `readAttachmentPaths` | "model has read this image" tick logic |
| `conversationTokenEstimate`, `estimatedContextTokens` | context dial display |
| `remoteHosts` | for cloud host menu |
| `filteredBranches` | branch menu filtered |
| `fontCtxValue` | font context provider value |
| `fileChangeSummary` | drawer summary |
| (sub-component memos) | misc |

---

## 11. Visual surfaces — render tree

ChatTile's return tree (top → bottom):

```
<ChatDispatchCtx.Provider>
  <FontCtx.Provider>
    <AskUserQuestionContext.Provider>
      <CheckpointRestoreContext.Provider>
        <ToolPermissionProvider>
          <div.cs-chat-shell> [drag/drop]
            <div [horizontal split]>
              <div [transcript+composer column]>
                <div.chat-messages [scrollable, sticky]>
                  <div.cs-chat-message-stack>
                    {isStartScreen && <H1>What do you want to build today?</H1>}
                    {hiddenMessageCount > 0 && <BannerOlderHidden />}
                    {pagedLinkedHistoryEnabled && (loadingEarlier||error) && <LoadingPill />}
                    [rendered messages — see message render below]
                    {showScrollToLatest && <ScrollToLatestButton />}
                    {liveComposerActivityChip && <ActivityChip />}
                    {pendingToolPermissions for messages && <ToolPermissionCard />}
                {/* Latest-changes drawer */}
                {latestChangeDrawer && <ChatComposerDrawerFrame [reviewLatestChanges]>
                  [file change list with DiffView entries]
                </ChatComposerDrawerFrame>}
                {/* Queued turns drawer (parent + child indented) */}
                {queuedTurns && <ChatComposerDrawerFrame [queue]>
                  [draggable rows: queue item, dispatch button, delete button, send-now]
                </ChatComposerDrawerFrame>}
                {/* Composer */}
                <ChatComposerWrap>
                  <ChatComposerCard [drag highlight border]>
                    <ChatComposerAutocompletePopup />        — / and @ list
                    <ChatComposerVoiceStatus />              — dictating banner / TTS state
                    <ChatComposerSurfaceHost />              — sketch/builder iframe tabs
                    <ChatComposerAttachments />              — chip row of attachments
                    <ChatComposerInput />                    — autosize textarea
                    <ChatComposerPrimaryToolbar>
                      [InsertMenu (+) / ProviderPill (pre-conv) / ModelPill / ThinkingBtn]
                      [spacer]
                      [MaximizeBtn (mini chat) / LivenessIndicator / VoiceMicBtn / Send|StopBtn]
                    </ChatComposerPrimaryToolbar>
                  </ChatComposerCard>
                  <ChatComposerSecondaryToolbar>
                    [LocationMenu / BranchMenu / ProjectPathButton]
                    [ModeMenu / PlanChip / ContextUsageDial]
                  </ChatComposerSecondaryToolbar>
                </ChatComposerWrap>
              </div>
              {isPlanOpen && planTodos && <PlanPane [right-docked] />}
            </div>
          </div>
        </ToolPermissionProvider>
      </CheckpointRestoreContext.Provider>
    </AskUserQuestionContext.Provider>
  </FontCtx.Provider>
</ChatDispatchCtx.Provider>
```

### Message render (per message in `renderedMessages`)

For each message — three families:
- **User** — content + optional attachments badge + BlockNoteAffordance side="left"
- **Assistant prose** — ChatMarkdown(content) + optional InlineJSXPreviewBlock (jsx fenced) + BlockNoteAffordance side="right"
- **Assistant chip-only** — clustered with adjacent chip-only assistant messages into ONE chip-row inside one BlockNoteAffordance

Chip cluster contains:
- ThinkingBlockView (collapsible, "Thought for Xs", shimmer when active)
- ToolBlockView single (with name, input preview, summary, file changes, command output, status, elapsed, copy/expand)
- CollapsedToolGroup (same-name N tools collapsed)
- MixedToolGroup (mixed-name N tools collapsed)
- "Called N tools" live-collapse summary chip after grace period

Special tool blocks:
- AskUserQuestion → AskUserQuestionChip with form (radio/checkbox + Other freeform + preview)
- Checkpoint tools → restore action
- Dream tools (DREAM_TOOL_ID_PREFIX, DREAM_TOOL_NAME) → custom render
- File-change tool → DiffView per file with expand toggle

### Streaming indicators (active thinking, current activity)
- `liveComposerActivityChip` — "Working", "Thinking", or other shimmer label above composer
- `WorkingDots` — animated dot loader
- `ShimmerText` — shimmer animation for thinking labels
- `StreamingLivenessIndicator` — breathing dot + "Xs" counter when server quiet >2.5s

---

## 12. Composer toolbar surfaces (sub-components)

From `chat/ChatComposer.tsx` + `chat/ChatComposerControls.tsx` + `chat/ChatComposerMenus.tsx`:

| Component | Role |
|---|---|
| `ChatComposerWrap` | outer column wrapper |
| `ChatComposerCard` | rounded composer card (drag highlight border) |
| `ChatComposerAutocompletePopup` | / @ dropdown list |
| `ChatComposerVoiceStatus` | dictating banner + TTS playing banner |
| `ChatComposerSurfaceHost` | iframe tab strip for chat-surface extensions |
| `ChatComposerAttachments` | attachment chip row |
| `ChatComposerInput` | autosize textarea |
| `ChatComposerPrimaryToolbar` | top toolbar (model/provider/thinking/send) |
| `ChatComposerSecondaryToolbar` | bottom toolbar (location/branch/path/mode/plan/context) |
| `ChatComposerLocationMenu` | local/cloud + remote host picker |
| `ChatComposerBranchMenu` | git branch list + create-new |
| `ChatComposerProjectPathButton` | project path label, click to switch folder |
| `ChatComposerModeMenu` | mode picker (plan/build/etc) |
| `ChatComposerContextUsageDial` | context-window dial with hover popover |
| `ChatComposerDrawerFrame` | drawer container (queued turns, latest changes) |
| `ToolbarBtn`, `ToolbarPill`, `FooterPill` | small button atoms |
| `ComposerInsertMenu` | + menu: attach files, MCP servers toggle, peer tools, chat surfaces |
| `Dropdown`, `DropdownItem`, `MenuPortal` | menu primitives, anchor-positioned portal |
| `ModelDropdown` | model list with filter + provider icon + "noun" |
| `PlanCard` (chat/PlanCard.tsx) | full plan card render |
| `PlanPane` (chat/PlanPane.tsx) | right-docked pane with todos |
| `PlanChip` (chat/PlanChip.tsx) | toolbar chip toggling pane |
| `DiffView` (chat/DiffView.tsx) | unified diff with syntax highlighting |
| `BlockNoteAffordance` (chat/BlockNoteAffordance.tsx) | hover-affordance to add a sticky note to a message/tool/thinking |
| `JSXPreview*` (ai-elements/JSXPreview.tsx) | inline JSX preview rendering with theme bindings |
| `ToolPermission*` (ai-elements/ToolPermission.tsx) | permission-request card with accept/deny scopes |
| `ChatMarkdown`, `ShimmerText`, `WorkingDots` (shared/streamdown-utils) | markdown wrapper + animation primitives |

---

## 13. Keyboard / mouse interactions

### Composer textarea
- `Enter` (no shift) — send (or queue if streaming)
- `Shift+Enter` — newline
- `Esc` — close autocomplete popup
- `↑/↓` (with autocomplete open) — navigate suggestions
- `Enter` (with autocomplete open) — accept suggestion
- `Space` (held, empty input) — push-to-talk start
- `Space` (release while dictating) — stop dictation
- `/` at start or after whitespace — slash autocomplete
- `@` anywhere — mention autocomplete

### Messages container
- `tabIndex=-1`, capturing wheel/scroll/keydown to release sticky-scroll on user upward scroll/wheel
- `PageUp/PageDown` (when focused) — paged scroll, also releases sticky

### Drag / drop
- File drop on tile → attach
- File-reference drag from FileTile → attach
- Internal queued-turn drag (mime: `application/x-codesurf-queued-turn`) → reorder
- DragOver shows accent-tinted border

### Mini chat
- Cmd-Shift-M (or similar) — open mini chat (verify exact shortcut)

---

## 14. Sub-components rendered inside ChatTile (defined in same file)

- `ThinkingIcon` — brain + signal bars
- `AskUserQuestionForm` + `AskUserQuestionChip` — the AskUserQuestion tool render
- `ThinkingBlockView` — thinking chip (line 7542+)
- `ToolBlockView` — tool chip (line 7813)
- `CollapsedToolGroup` — same-name group chip (line 7918)
- `MixedToolGroup` — mixed-name group chip
- `ToolInputView` — line 8329 — pretty-print of tool input
- `StreamingLivenessIndicator` — breathing dot + Xs counter
- `InlineJSXPreviewBlock` — JSX fenced code rendered as live preview

---

## 15. Skill discovery + autocomplete (just added)

Already implemented (commit `9cad8a2`):
- `/` autocomplete merges built-in `CHAT_SLASH_COMMANDS` with `workspaceSkills` (skill `command || name` becomes `/<value>`)
- `@` autocomplete: connectedPeers files first, then bounded workspace file index (depth 4, 5k cap, skips heavy dirs, ranks basename-prefix > basename-contains > path-contains)
- Selecting `@<file>` auto-attaches the file to attachments

V2 must preserve the same UX: cursor-anchored popup, 40-result cap, ranking order.

---

## 16. Library stack — pivot to assistant-ui + tw-shimmer

### Decision (revised)
Originally planned: AI SDK `useChat` + AI Elements components. **Pivoted to assistant-ui as the runtime + primitive layer**, with AI Elements + shadcn retained for components assistant-ui doesn't ship, and tw-shimmer for shimmer effects. Reasoning: assistant-ui ships streaming, branching, edit, reload, copy, speak, feedback, suggestions, attachments, scroll-to-bottom, empty state, error state, edit composer, action bar — all primitives over a runtime context. Net much less glue code than wiring AI SDK + AI Elements directly.

### Packages to install for V2
- `@assistant-ui/react` — runtime + primitives (`ThreadPrimitive`, `MessagePrimitive`, `ComposerPrimitive`, `ActionBarPrimitive`, `BranchPickerPrimitive`, `ErrorPrimitive`, `AuiIf`)
- `@assistant-ui/react-markdown` — `MarkdownText` for assistant text parts
- `tw-shimmer` — Tailwind v4 plugin, replaces hand-rolled shimmer CSS

### Already installed (commit `14348a7`)
- `ai` v6, `@ai-sdk/react` v3 — kept; `ChatTransport` still useful as the inner adapter under assistant-ui's `useLocalRuntime` if we go that way, OR ignored if we use `useExternalStoreRuntime`
- AI Elements: `message`, `conversation`, `reasoning`, `tool`, `code-block`, `task`, `prompt-input`, `suggestion`, `sources`, `image`, `web-preview`, `inline-citation`, `chain-of-thought`, `artifact`, `shimmer`
- Shadcn primitives: `button`, `button-group`, `tooltip`, `separator`, `badge`, `carousel`, `collapsible`, `command`, `dialog`, `dropdown-menu`, `hover-card`, `input`, `input-group`, `scroll-area`, `select`, `spinner`, `textarea`

### V2 mapping plan (revised — assistant-ui-first)

| Bespoke (V1) | V2 replacement |
|---|---|
| `<div className="chat-messages">` + sticky scroll + `stickToBottomRef` + scroll-release logic | `ThreadPrimitive.Root` + `ThreadPrimitive.Viewport` + `ThreadPrimitive.ScrollToBottom` |
| Per-message render switch | `ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage, EditComposer }}` |
| Start screen / `What do you want to build` | `<AuiIf condition={s => s.thread.isEmpty}>` + `<ThreadWelcome>` |
| `ChatMarkdown` (streamdown wrapper) | `MarkdownText` from `@assistant-ui/react-markdown` (or AI Elements `Response` — both wrap streamdown) |
| `ThinkingBlockView` (single + clusters) | `Reasoning` + `ReasoningGroup` slots wired into `MessagePrimitive.Parts` |
| `ToolBlockView` switch on `block.name` | `tools={{ Read: ..., Bash: ..., TodoWrite: ..., Fallback: ToolFallback }}` slot map on `MessagePrimitive.Parts` |
| `CollapsedToolGroup`/`MixedToolGroup`/live-collapse | Custom slot inside `ToolFallback` OR a wrapping `MessagePrimitive` decorator that runs the same clustering logic |
| AskUserQuestion form | Custom tool component for tool name `AskUserQuestion`, slotted via `tools={{ AskUserQuestion: AskUserQuestionView }}` |
| Checkpoint tools | Custom tool slot |
| Dream tools | Custom tool slot |
| File-change tool / DiffView | Custom tool slot using existing `DiffView` |
| `WorkingDots` (CSS keyframes) | `tw-shimmer` `shimmer` class on text |
| `ShimmerText` | `<span className="shimmer">…</span>` (tw-shimmer) |
| `ensureShimmerStyles()` head injection | `@import "tw-shimmer"` in `index.css` |
| `StreamingLivenessIndicator` | `<AuiIf condition={s => s.thread.isRunning}>` + breathing dot + Xs counter (port the elapsed math) |
| `liveComposerActivityChip` | Same `AuiIf` pattern + tw-shimmer text |
| Code fences | `MarkdownText` auto-renders via streamdown plugins (cjk, code, math, mermaid) |
| `PlanCard` / `PlanPane` / `PlanChip` | `TodoWrite` tool slot renders the inline card; PlanPane stays as right-docked panel reading `useTileTodos`; PlanChip stays |
| `ChatComposerInput` autosize textarea | `ComposerPrimitive.Root` + `ComposerPrimitive.Input` (autosize built-in) |
| Send button | `ComposerPrimitive.Send` |
| Stop button | `ComposerPrimitive.Cancel` |
| `ChatComposerPrimaryToolbar` / `ChatComposerSecondaryToolbar` | Plain divs around `ComposerPrimitive.Root` — assistant-ui doesn't dictate toolbar shape |
| Edit message | `ComposerPrimitive.Root` inside `EditComposer` slot — wired by clicking `ActionBarPrimitive.Edit` |
| Copy / regenerate / speak / feedback | `ActionBarPrimitive.{Copy, Reload, Speak, FeedbackPositive, FeedbackNegative, ExportMarkdown}` — all built-in |
| Branch nav | `BranchPickerPrimitive.{Root, Previous, Next, Number, Count}` — built-in via `regenerate` |
| Suggestions (start screen + post-message) | `ThreadPrimitive.Suggestion prompt="…"` |
| `ChatComposerAttachments` + `addAttachments` + `openAttachmentPicker` + `removeAttachment` + drop overlay | `ComposerPrimitive.AttachmentDropzone` + `ComposerAttachments` + `ComposerAddAttachment` (registry-installed) |
| Per-tile drag-over highlight | `data-[dragging=true]` styles on the dropzone |
| Error message | `MessagePrimitive.Error` + `ErrorPrimitive.Root` |
| `ChatComposerAutocompletePopup` (`/` + `@`) | KEEP custom — cursor-anchored beats `Suggestion`; assistant-ui doesn't ship inline autocomplete |
| `Dropdown`/`DropdownItem`/`MenuPortal` | shadcn `dropdown-menu` (already installed) |
| `ToolbarPill`/`ToolbarBtn`/`FooterPill` | shadcn `Button` + `cn(...)` classnames |
| `ChatComposerLocationMenu`/`BranchMenu`/`ProjectPathButton`/`ModeMenu`/`ContextUsageDial` | KEEP — domain-specific, render around the assistant-ui composer |
| `ChatComposerVoiceStatus` (dictation/TTS state banner) | KEEP — domain-specific, render inside the composer above the textarea |
| `ChatComposerSurfaceHost` (sketch/builder iframe) | KEEP — domain-specific |
| `BlockNoteAffordance` | KEEP — domain-specific; wrap `MessagePrimitive.Root` |
| `ToolPermission*` | KEEP — domain-specific; render based on `pendingToolPermissions` state |
| `JSXPreview*` | KEEP — domain-specific; switch to assistant-ui `tools={{ JSXPreview: ... }}` slot if model emits as a tool, else inline detector on text parts |
| `DiffView` | KEEP — domain-specific |
| Sources / citations | `Sources` slot in `MessagePrimitive.Parts components` (assistant-ui pattern) — surface only if a provider emits source parts |
| Image generation | `Image` AI Elements (currently unused; surface only if model returns image part) |
| Web preview | `WebPreview` AI Elements (could replace surface-host iframe layer) |

### What gets DELETED at the end
- `ChatTile.tsx` (8,764 LOC)
- `chat/ChatComposer.tsx` (1,040)
- `chat/ChatComposerControls.tsx` (150)
- `chat/ChatComposerMenus.tsx` (349) — except portions kept for domain menus
- `chat/PlanCard.tsx` (154) — replaced by inline tool slot
- `shared/streamdown-utils.tsx` (667) — `MarkdownText` covers it; `tw-shimmer` covers shimmer; `ensureShimmerStyles` deleted
- `chatTileRuntimeState.ts` and stores stay; persistence still ours.

### What gets KEPT
- `chat/PlanPane.tsx`, `chat/PlanChip.tsx` — UI shells the assistant-ui slot wraps
- `chat/DiffView.tsx`
- `chat/BlockNoteAffordance.tsx`
- `chat/checkpointToolActions.ts`, `chat/dreamToolActions.ts`
- `ai-elements/ToolPermission.tsx`, `ai-elements/JSXPreview.tsx`
- All domain composer menus (location/branch/project-path/mode/context-usage) and `ChatComposerSurfaceHost`/`ChatComposerVoiceStatus` (rename/move into a `chat/v2/` folder)
- All cross-tile stores (`chatStreamingStore`, `chatMessageSentStore`, `tileTodosStore`, `chatTileRuntimeState`)
- Custom autocomplete popup (cursor-anchored)

---

## 17. Acceptance criteria (V1 → V2 cutover gates)

V2 cannot replace V1 until ALL of the following pass:

### Functional
- [ ] Send + receive a message (text → text response) — Claude provider
- [ ] Send + receive — Codex provider
- [ ] Send + receive — OpenCode provider
- [ ] Send + receive — OpenClaw provider
- [ ] Send + receive — extension provider (any installed)
- [ ] Stream cancellation via Stop button mid-response
- [ ] Mid-stream steering (insertSteerMessageIntoStream)
- [ ] Clear conversation resets sessionId, jobId, messages, attachments
- [ ] Resume on tile remount (jobId reattach)
- [ ] Linked-session bootstrap (open chat opens existing session entry)
- [ ] Paged history loading (older messages prepend without scroll jump)
- [ ] All 14 stream event types render correctly (table §3)
- [ ] Thinking block (open/close, elapsed counter, shimmer when active, "Thought for Xs")
- [ ] Tool block (running, done, summary, file changes, command entries, copy, expand, elapsed)
- [ ] Tool block clustering (same-name group, mixed group, live-collapse "Called N tools")
- [ ] AskUserQuestion form (single-select, multi-select, "Other" freeform, preview hover, submit)
- [ ] Tool permission request → 6 decision scopes (deny/never/once/session/today/forever)
- [ ] Latest-changes drawer (review + per-file expand + DiffView)
- [ ] Checkpoint restore (latest button + per-tool restore)
- [ ] BlockNote add/edit on user msg, assistant msg, tool, thinking, cluster
- [ ] BlockNote export to clipboard via `/export-notes`
- [ ] Plan/todos: PlanChip toggles PlanPane, todo list updates from TodoWrite tool emissions
- [ ] Surface host: open sketch surface, builder enhancement, iframe RPC (actions/context/getPeerContext/getAllPeerContext)
- [ ] Voice: push-to-talk (hold space), click mic, dictation transcript appears, error state, TTS auto-speak when settings enabled, barge-in via voice-status
- [ ] Attachments: drag/drop file, file-ref drop from FileTile, image vs file kind detection, remove, clear on send, peer image auto-attach, attachment picker via Insert (+) menu
- [ ] Autocomplete: `/` (built-in + skills), `@` (peers + workspace files), keyboard nav, cursor-anchored popup
- [ ] Slash commands: `/clear`, `/compact`, `/model`, `/mode`, `/help`, `/init`, `/export-notes`
- [ ] Queue: queue while streaming, drag-reorder (within and into parent-child), parent-child indent, send-now, delete, urgent/error highlight via `isUrgentQueuedContent`
- [ ] Mini chat: Maximize button opens detached window
- [ ] Provider switch (pre-conversation only)
- [ ] Model switch (mid-conversation OK)
- [ ] Mode switch persisted to settings.chatProviderModes per provider
- [ ] Thinking-level switch
- [ ] MCP enable/disable toggle
- [ ] Per-server MCP disable set
- [ ] Peer tools: connectedPeers tools surface in Insert menu
- [ ] Location menu: Local/Instant label, cloud hosts, remote host switch
- [ ] Branch menu: list, filter, create new, checkout (uncommitted changes guard)
- [ ] Project path button: click → openFolder + addProjectFolder
- [ ] Context usage dial: estimated tokens vs window limit, hover popover with breakdown
- [ ] Scroll: sticky-bottom default, release on user upward wheel/scroll/PageUp, re-stick on send, scroll-to-latest button when offscreen
- [ ] Inline JSX preview from `jsx`/`tsx`/`react` fenced code blocks
- [ ] System messages: memory-guard notice when truncating to char limit
- [ ] Session resume across remount (state persists via canvas.saveTileState)
- [ ] activity bus events fire on user-send, assistant-done, steer
- [ ] tool_inventory + skill_inventory bus events fire on dependency change
- [ ] Recent-edit context auto-attached for short edit-intent messages
- [ ] Block-notes context appended to outgoing newest user turn
- [ ] Memory-guard truncation (CHAT_MEMORY_*) — old tools trimmed, old summaries shortened, full message dropped if total exceeds char/count limits
- [ ] streamdown plugins: cjk, code (syntax highlight), math, mermaid all render

### Visual
- [ ] Side-by-side screenshots match V1 in: start screen, mid-stream, post-conversation, with-tools, with-thinking, with-plan, with-attachments, with-voice-recording, with-autocomplete-open, with-queue, with-error, with-tool-permission, with-ask-user-question, with-jsx-preview, with-diff-drawer, with-checkpoint-action
- [ ] All 8 toolbar menus render at correct anchor positions in MenuPortal
- [ ] Theme tokens preserved (`theme.chat.*`, `theme.surface.*`, `theme.accent.*`, `theme.status.*`, `theme.text.*`, `theme.border.*`, `theme.shadow.*`)
- [ ] Font CSS vars used (sans/mono/secondary, sizes, weights, line-heights)
- [ ] Width tokens preserved (`var(--cs-thread-content-max-width)`, `var(--cs-chat-composer-*)`)
- [ ] Drag-target visual highlight matches
- [ ] Streaming liveness dot animation matches
- [ ] Chip border/background tokens for thinking, tool, mixed-tool, collapsed-tool exact match

### Behavioral
- [ ] No regression in App.tsx canvas mounting (Props signature unchanged)
- [ ] No regression in cross-tile sync (`chatStreamingStore`, `chatMessageSentStore`, `tileTodosStore`, `chatTileRuntimeState`)
- [ ] Disposed runtime state guard — `setMessagesSafe` no-ops when state disposed
- [ ] 500ms persist debounce maintained (don't thrash disk on every keystroke)
- [ ] Sequence-guard preserved — out-of-order/duplicate stream events ignored
- [ ] Per-tile MCP server disable set preserved
- [ ] Memory-guard works (no OOM on a 100-message session with large tool outputs)

---

## 18. V2 build plan (revised — assistant-ui first)

### Phase 0 — Foundation
1. Install: `@assistant-ui/react`, `@assistant-ui/react-markdown`, `tw-shimmer`.
2. Add `@import "tw-shimmer";` to `src/renderer/src/index.css`.
3. Scaffold assistant-ui helper components via the registry (or hand-port from the example):
   - `components/assistant-ui/markdown-text.tsx` (uses streamdown plugins same as ours)
   - `components/assistant-ui/tool-fallback.tsx`
   - `components/assistant-ui/tooltip-icon-button.tsx`
   - `components/assistant-ui/reasoning.tsx`
   - `components/assistant-ui/sources.tsx`
   - `components/assistant-ui/attachment.tsx`
4. Add `settings.experimental?.chatTileV2: boolean` (default false). Branch on it where `<ChatTile>` is mounted (App.tsx canvas).
5. New file: `src/renderer/src/components/ChatTileV2.tsx` — skeleton with `<ThreadPrimitive.Root>` shell only, displays "V2".

### Phase 1 — Runtime adapter
We'll use `useExternalStoreRuntime` (gives us full control over messages array + dispatch) rather than `useLocalRuntime` which expects a single-shot `ChatModelAdapter.run(...)` async iterator. Reasons:
- We already own the optimistic message append, sequence-guard, persistence, queue, multi-provider routing.
- Stream events arrive via `window.electron.stream.onChunk` continuously across multiple provider sessions; `useExternalStoreRuntime` is the documented path for "I have my own state".
- Branch picker / regenerate / edit / reload still work via the runtime — they call `onNew`/`onEdit`/`onReload` callbacks we provide.

New file: `src/renderer/src/components/chat/v2/contexRuntime.ts`

```ts
export function useContexRuntime(props: Props) {
  // Owns: messages (V1 ChatMessage[] mapped to assistant-ui ThreadMessage[]),
  // status (running/idle/error), sessionId/jobId/jobSequence, attachments.
  // Wires window.electron.chat.send + stream.onChunk inside.
  return useExternalStoreRuntime({
    messages: mappedMessages,
    isRunning: status === 'running',
    onNew: async (message) => { /* dispatch via chat.send */ },
    onEdit: async (message) => { /* edit + resend from edit point */ },
    onReload: async (parentMessageId) => { /* regenerate */ },
    onCancel: async () => { /* chat.stop */ },
    convertMessage: chatMessageToThreadMessage,
    setMessages: (next) => { /* update our own state, normalizeMessagesForMemory */ },
    onAddAttachment: ..., onRemoveAttachment: ...,
  })
}
```

Internal stream-chunk → ThreadMessage Part mapping:
- `text` → `text` part with delta append
- `thinking_start/thinking/block_stop` → `reasoning` part with delta append
- `tool_start/tool_input/tool_use` → `tool-call` part with `argsText` streamed
- `tool_summary` → tool result + custom `data-tool-summary` part for `{ summary, fileChanges, commandEntries }`
- `tool_permission_request/resolved` → custom `data-tool-permission` part + side-channel state for ToolPermissionCard
- `done` → mark message non-streaming, fire `setStatus('idle')`
- `error` → `setStatus({ type: 'error', error })`

### Phase 2 — Hooks (extracted from V1, presentation-agnostic)
Pure-logic hooks. No UI:
1. `useWorkspaceSkills(workspaceDir)`
2. `useWorkspaceFiles(workspaceDir)`
3. `useChatAutocomplete({ skills, files, peers, workspaceDir, textareaRef })`
4. `useChatVoice({ enabled, onTranscript })`
5. `useChatPersistence({ tileId, workspaceId })` — `canvas.saveTileState`/`loadTileState` debounce + revival
6. `useChatPagedHistory({ ... })` — linked-session paging
7. `useChatQueue({ ... })` — queue + drag/drop reorder
8. `useChatGitState({ workspaceDir })`
9. `useChatExecution({ settings })`
10. `useChatPeerContext({ peers, workspaceId })`
11. `useChatSurfaces({ tileId })`
12. `useChatBlockNotes({ messages, dispatch })`

### Phase 3 — Compose ChatTileV2

Target ~600–900 LOC.

```tsx
function ChatTileV2(props: Props) {
  const persistence = useChatPersistence(props)
  const runtime = useContexRuntime({ ...props, persistence })
  const skills = useWorkspaceSkills(props.workspaceDir)
  const files = useWorkspaceFiles(props.workspaceDir)
  const ac = useChatAutocomplete({ skills, files, peers: props.connectedPeers ?? [] })
  const voice = useChatVoice({ enabled: props.settings?.voice?.enabled })
  const queue = useChatQueue({ runtime })
  const git = useChatGitState({ workspaceDir: props.workspaceDir })
  const exec = useChatExecution({ settings: props.settings })
  const peerCtx = useChatPeerContext({ peers: props.connectedPeers ?? [], workspaceId: props.workspaceId })
  const surfaces = useChatSurfaces({ tileId: props.tileId })
  const todos = useTileTodos(props.tileId)
  const notes = useChatBlockNotes({ runtime })
  const [planOpen, setPlanOpen] = useState(false)

  return (
    <AssistantRuntimeProvider runtime={runtime}>
    <ToolPermissionProvider cardId={props.tileId} {...permissionProps}>
      <ThreadPrimitive.Root className="cs-chat-shell flex h-full flex-col bg-background">
        <ThreadPrimitive.Viewport className="flex flex-1 flex-col overflow-y-auto px-4 pt-4">
          <AuiIf condition={s => s.thread.isEmpty}>
            <StartScreen />
          </AuiIf>

          <ThreadPrimitive.Messages
            components={{
              UserMessage,
              EditComposer,
              AssistantMessage: AssistantMessageView, // wraps BlockNoteAffordance
            }}
          />

          <ThreadPrimitive.ViewportFooter className="sticky bottom-0 flex flex-col gap-2 pb-4">
            <ThreadPrimitive.ScrollToBottom asChild>
              <ScrollToLatestButton />
            </ThreadPrimitive.ScrollToBottom>

            {queue.items.length > 0 && <QueueDrawer queue={queue} />}
            {latestChange && <LatestChangeDrawer changes={latestChange} />}

            <ComposerPrimitive.Root className="cs-composer-root">
              <ComposerPrimitive.AttachmentDropzone>
                <AutocompletePopup state={ac} />
                <VoiceStatusBanner voice={voice} />
                <SurfaceHost surfaces={surfaces} />
                <ComposerAttachments />
                <ComposerPrimitive.Input
                  ref={textareaRef}
                  onKeyDown={ac.handleKeyDown}
                  placeholder={voice.isDictating ? 'Listening...' : 'Message the agent, or use /commands and /skills'}
                  className="cs-composer-input"
                />
                <PrimaryToolbar>
                  <ComposerAddAttachment />
                  {messages.length === 0 && <ProviderPill ... />}
                  <ModelPill ... />
                  <ThinkingBtn ... />
                  <Spacer />
                  <MaximizeBtn onClick={openMiniChat} />
                  <AuiIf condition={s => s.thread.isRunning}>
                    <StreamingLivenessIndicator />
                  </AuiIf>
                  <VoiceMicBtn voice={voice} />
                  <AuiIf condition={s => !s.thread.isRunning}>
                    <ComposerPrimitive.Send asChild><SendButton /></ComposerPrimitive.Send>
                  </AuiIf>
                  <AuiIf condition={s => s.thread.isRunning}>
                    <ComposerPrimitive.Cancel asChild><StopButton /></ComposerPrimitive.Cancel>
                  </AuiIf>
                </PrimaryToolbar>
              </ComposerPrimitive.AttachmentDropzone>
              <SecondaryToolbar>
                <LocationMenu exec={exec} />
                <BranchMenu git={git} />
                <ProjectPathButton ... />
                <ModeMenu ... />
                {todos.length > 0 && <PlanChip active={planOpen} onClick={() => setPlanOpen(v => !v)} />}
                <ContextUsageDial ... />
              </SecondaryToolbar>
            </ComposerPrimitive.Root>
          </ThreadPrimitive.ViewportFooter>
        </ThreadPrimitive.Viewport>

        {planOpen && todos.length > 0 && <PlanPane todos={todos} onClose={() => setPlanOpen(false)} />}
      </ThreadPrimitive.Root>
    </ToolPermissionProvider>
    </AssistantRuntimeProvider>
  )
}
```

`AssistantMessageView`:
```tsx
function AssistantMessageView() {
  return (
    <BlockNoteAffordance side="right" {...notesProps}>
      <MessagePrimitive.Root data-role="assistant" className="cs-msg-assistant">
        <MessagePrimitive.Parts
          components={{
            Text: MarkdownText,
            Reasoning,
            ReasoningGroup,
            Source: Sources,
            tools: {
              by_name: {
                AskUserQuestion: AskUserQuestionView,
                TodoWrite: TodoWriteView,
                Read: ReadView,
                Edit: EditView,
                Bash: BashView,
                // checkpoint tools, dream tools, etc.
              },
              Fallback: ToolFallback, // current ToolBlockView render
            },
          }}
        />
        <MessageError />
        <AuiIf condition={s => s.thread.isRunning && s.message.content.length === 0}>
          <span className="shimmer text-muted-foreground">Thinking…</span>
        </AuiIf>
        <AssistantActionBar />  {/* copy / reload / speak / feedback */}
        <BranchPicker />
      </MessagePrimitive.Root>
    </BlockNoteAffordance>
  )
}
```

### Phase 4 — Cutover
1. All §17 acceptance items pass for V2.
2. Visual diff against V1 — no regressions in any of the 16 reference states.
3. Set `settings.experimental.chatTileV2 = true` as default.
4. Remove the flag and V1 in a single commit.
5. Delete (~10,000 LOC removed):
   - `ChatTile.tsx`
   - `chat/ChatComposer.tsx`
   - `chat/ChatComposerControls.tsx`
   - `chat/ChatComposerMenus.tsx` (or keep just `MenuPortal` + dropdown atoms used by domain menus)
   - `chat/PlanCard.tsx`
   - `shared/streamdown-utils.tsx` (`MarkdownText` + `tw-shimmer` cover it)
6. Keep:
   - `chat/PlanPane.tsx`, `chat/PlanChip.tsx`
   - `chat/DiffView.tsx`
   - `chat/BlockNoteAffordance.tsx`
   - `ai-elements/ToolPermission.tsx`, `ai-elements/JSXPreview.tsx`
   - `chatTileRuntimeState.ts`, `chatStreamingStore.ts`, `chatMessageSentStore.ts`, `chatSurfaceHostRpc.ts`
   - `chat/checkpointToolActions.ts`, `chat/dreamToolActions.ts`
   - All cross-tile stores

---

## 19. Open questions / risks

1. **Provider transports beyond Claude**: Codex/OpenCode/OpenClaw return data via `chat.send` but the chunk shapes may differ. Need to verify the renderer-side adapter stays provider-agnostic (today, main-process normalizes to one chunk shape — that should still hold). The adapter only sees normalized chunks.
2. **Branch nav**: V1 doesn't expose message branching UI. assistant-ui's `BranchPickerPrimitive` works automatically when `onReload`/regenerate is wired in `useExternalStoreRuntime`. Net new feature — **DECIDE: enable or skip in V2?**
3. **Edit message / regenerate**: assistant-ui's `ActionBarPrimitive.Edit` + `ActionBarPrimitive.Reload` give us message editing and turn regeneration for free, gated on `onEdit`/`onReload` callbacks. V1 has neither. **DECIDE: enable or skip?**
4. **Speak / feedback / export-markdown**: assistant-ui provides `ActionBarPrimitive.{Speak, FeedbackPositive, FeedbackNegative, ExportMarkdown}`. V1 has TTS via `useAutoSpeak` (auto-trigger on assistant turn) but no per-message Speak button, no feedback, no export. **DECIDE: surface them?**
5. **Sources / citations**: V1 doesn't render citations. assistant-ui has `Source` slot. **DECIDE: add or skip?**
6. **`useExternalStoreRuntime` vs `useLocalRuntime`**: V2 plan uses external store because we own state. Verify it supports streaming text deltas + tool-call deltas + reasoning deltas (not just final messages). If not, fall back to `useLocalRuntime` with a custom `ChatModelAdapter`.
7. **Memory-guard**: assistant-ui doesn't truncate messages. Must keep our `normalizeMessagesForMemory` running over our own state before mapping to assistant-ui ThreadMessages.
8. **Tool permission**: assistant-ui doesn't model human-in-the-loop tool approvals. Keep V1's `pendingToolPermissions` Map + `ToolPermissionCard` + `chat:answerToolPermission` IPC. Surface as a side-panel render based on state, not via assistant-ui primitives.
9. **AskUserQuestion**: tool slot for tool name `AskUserQuestion` — port the form into a tool component.
10. **Linked-session bootstrap**: very specific to Claude Agent SDK history shape; the persistence hook must support an `initialMessages` reload from `canvas.getSessionState` IPC before first user turn.
11. **Surface host RPC timeouts**: 10s pending-action timeout — must port verbatim.
12. **Codex/OpenClaw model fetch**: one-shot per provider per tile; V2 hook must guard against re-fetch.
13. **Cluster / live-collapse for tool chips**: assistant-ui renders one tool component per tool part; the V1 clustering of *consecutive chip-only assistant messages* into one wrapping row, plus the live-collapse-into-summary after grace period, has no direct primitive. Need a custom `Messages` component override that detects clusters at render time.
14. **`tw-shimmer` track-width measurement**: `shimmer-speed-{px/s}` requires JS measurement of element width into `--shimmer-track-width`. For dynamic streaming text, we'd resize-observe or just use `shimmer-duration-{ms}` (size-relative). Keep simple unless we hit a specific issue.
15. **Streamdown plugins**: `MarkdownText` from `@assistant-ui/react-markdown` may not include cjk/code/math/mermaid by default. Verify and pass plugins explicitly, matching what AI Elements `Response` does.

---

## 20. Definition of "exactly correct"

Per the user requirement "no features missing":
- Every checkbox in §17 ticked.
- Every IPC channel in §5 reached (instrument transport with assertion logs during dev).
- Every bus event in §6 published with same shape.
- Every persisted state field in §7 round-trips on remount.
- No new visual layout regressions vs V1 reference screenshots.

Confidence the inventory is complete: **HIGH** for top-level surfaces and IPC; **MEDIUM** for sub-component-internal behavior (each *View component has its own state/effects we'd need to drill into when porting). The first commit of V2 work should also produce reference screenshots from V1 to use as golden masters.

---

## 21. Architecture pivot — standalone web bundle loaded via webview/iframe

**Driver:** the same chat must be reusable across hosts (contex desktop tile, contex mini-window, codesurf-daemon web UI, future MCP-app-studio widget, *muxy Swift app via WKWebView*, future React Native shell, future Ink terminal shell). The host today is Electron renderer, but the user wants to replace muxy's native Swift chat with this same code.

### Layout

```
apps/
  chat-app/                          ← NEW standalone Vite + React + assistant-ui app
    package.json                     ← own deps: assistant-ui, ai, tw-shimmer, etc.
    vite.config.ts                   ← builds to apps/chat-app/dist/ as static assets
    index.html
    src/
      main.tsx                       ← React 19 root
      ChatApp.tsx                    ← top-level chat UI using assistant-ui primitives
      runtime/
        bridgeRuntime.ts             ← assistant-ui useExternalStoreRuntime backed by bridge
      hooks/                         ← portable hooks (no window.electron, no DOM-host coupling)
      components/
        assistant-ui/                ← MarkdownText, ToolFallback, etc.

packages/
  codesurf-chat-bridge/                ← NEW shared TS package: the host↔chat protocol
    package.json
    src/
      protocol.ts                    ← message shapes (request/response/event/stream chunk)
      client.ts                      ← used INSIDE chat-app: window.parent.postMessage wrapper
      host.ts                        ← used BY hosts: iframe.contentWindow.postMessage wrapper

src/renderer/src/components/
  ChatTileWebview.tsx                ← thin Electron host: <iframe> + bridge.host adapter
                                         translates bridge calls → window.electron.chat.* etc.
                                         (replaces ChatTile.tsx when feature flag on)
```

### Bridge protocol (host-agnostic; mirrors V1 IPC surface)

All messages pass via `postMessage`. Envelope:
```ts
type BridgeMessage =
  | { kind: 'request'; id: string; method: string; params?: unknown }
  | { kind: 'response'; id: string; ok: true; value: unknown }
  | { kind: 'response'; id: string; ok: false; error: string }
  | { kind: 'event'; channel: string; payload: unknown }       // host → chat (stream chunks, peer events)
  | { kind: 'subscribe'; channel: string }                      // chat → host (subscribe to channel)
  | { kind: 'unsubscribe'; channel: string }
  | { kind: 'ready'; protocolVersion: number }                  // chat → host on mount
```

Methods (host implements; same shape as today's `window.electron.chat.*` IPC):
- `chat.send` `→ { jobId? }`
- `chat.steer`, `chat.stop`, `chat.clearSession`, `chat.setPermissionMode`, `chat.resumeJob`
- `chat.loadSessionHistory`, `chat.opencodeModels`, `chat.openclawAgents`
- `chat.answerToolPermission`, `chat.answerUserQuestion`, `chat.selectFiles`
- `canvas.saveTileState`, `canvas.loadTileState`, `canvas.getSessionState`, `canvas.restoreCheckpoint`
- `fs.readDir`, `fs.readFile`
- `git.status`, `git.branches`, `git.checkoutBranch`, `git.createBranch`
- `execution.listHosts`, `execution.resolveTarget`
- `workspace.openFolder`, `workspace.addProjectFolder`
- `extensions.invoke`, `extensions.getSettings`, `extensions.setSettings`
- `system.daemonSummary`, `tileContext.getAll`, `transcribe.run`, `window.openMiniChat`

Channels (host pushes events to chat):
- `stream:${tileId}` → stream chunks (replaces `stream.onChunk`)
- `bus:${channel}:${subscriberId}` → event-bus events (replaces `bus.subscribe`)

### Host adapter (Electron / contex)

`ChatTileWebview.tsx` is ~100 LOC:
1. Render `<iframe src={chatBundleUrl}?tileId=...&workspaceId=... sandbox="allow-scripts allow-same-origin" />`.
2. On `message` event: if `kind === 'request'`, route `method` to the matching `window.electron.*` call, post back `response` with same `id`.
3. On chat `subscribe` `stream:${tileId}` → attach `window.electron.stream.onChunk` and forward chunks via `event` messages.
4. On chat `subscribe` `bus:${channel}:${subscriberId}` → attach `window.electron.bus.subscribe(...)` and forward.
5. Pass `workspaceDir`, `connectedPeers`, `settings`, `width`, `height`, `reloadToken` via postMessage when they change (chat re-renders).

### Bundle delivery

Two modes:
- **Dev**: chat-app runs on its own Vite dev server (e.g. `http://localhost:5174`); `ChatTileWebview` points iframe at that URL. Hot reload independent of host.
- **Prod**: chat-app builds to `apps/chat-app/dist/`; electron-vite copies/serves it; iframe loads via `file://` or a custom `contex://` protocol handler. Or serve via the daemon's HTTP server.

For muxy: muxy's Swift host implements the same bridge in `WKWebView` (Swift-side `WKScriptMessageHandler`); the `apps/chat-app/dist/` bundle is dropped into the Swift app's resources and loaded by the WebView. Zero TS code changes.

### What stays in the Electron renderer (apart from `ChatTileWebview.tsx`)

Everything else canvas-related stays. Other tiles (terminal, code editor, browser, kanban) are unchanged. Only `ChatTile.tsx` gets replaced by `ChatTileWebview.tsx` when the feature flag is on.

### Cutover gates (revised for webview path)

- [ ] All §17 acceptance items pass via the webview bridge round-trip
- [ ] Bridge round-trip latency for stream chunks ≤ 16ms (one frame)
- [ ] No crashes when iframe reloads mid-stream (resume via `chat.resumeJob`)
- [ ] Chat-app bundle size ≤ 1MB gzipped (acceptable for Swift WebView delivery)
- [ ] Theme tokens flow from host → chat via initial `theme` event so dark theme matches
- [ ] Font tokens flow same way (sans/mono/secondary, sizes, weights)
- [ ] Drag-drop file from outside the iframe still works (host catches, sends `attachments.add` event)
- [ ] Voice (mic permission) works in iframe context — may require host to grant `microphone` permission to the iframe origin
- [ ] All keyboard shortcuts work despite iframe focus boundaries
- [ ] Mini chat window loads the same bundle, talks to same host

### Phase 0 (revised) — do NOW

1. Create `apps/chat-app/` with Vite + React 19 + TypeScript scaffold. assistant-ui dependencies installed inside this package, NOT in root.
2. Create `packages/codesurf-chat-bridge/` with `protocol.ts`, `client.ts`, `host.ts`.
3. Create `src/renderer/src/components/ChatTileWebview.tsx` using the host bridge adapter.
4. Wire feature flag `settings.experimental?.chatTileWebview` (default false) at the canvas mount site.
5. Make a minimal echo path work end-to-end: type a message in webview chat → host receives via bridge → host echoes back via channel event → chat renders the response.
6. Commit. Verify by running app with flag on.

### Phase 1+

Same as before (assistant-ui runtime, hooks, etc.) but ALL inside `apps/chat-app/` — the Electron renderer no longer carries any of it.
