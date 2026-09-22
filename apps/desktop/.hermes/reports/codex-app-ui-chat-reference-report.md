# Codex App reference pass for CodeSurf

Generated: 2026-05-01 09:53:37 BST

Scope:
- Reference: `/Users/jkneen/Documents/GitHub/codex-app`
- Recovered Codex desktop app: `/Users/jkneen/Documents/GitHub/codex-app/desktop/recovered/app-asar-extracted`
- Target: `/Users/jkneen/clawd/collaborator-clone`

This is an implementation-oriented report, not a visual mock. I focused on the side menu, chat/composer, mini-window, sessions, extensions/plugins/skills, git/diff/commit UX, icons/assets, and packaging/build lessons.

## TL;DR

Codex is not just a nicer stylesheet. The polish mostly comes from a few structural choices:

1. Tokenized layout instead of one-off inline sizes.
   - Codex defines tokens like `--spacing-token-sidebar`, `--spacing-token-button-composer`, `--codex-chat-font-size`, `--thread-content-max-width`, and then composes Tailwind utility classes around them.
   - CodeSurf has a theme object, but `ChatTile.tsx` and `Sidebar.tsx` still contain many local dimensions and one-off inline styles.

2. The sidebar is a thread/task manager, not a generic tile launcher.
   - Codex groups local/remote/project/worktree/pinned/projectless chats into a single navigational model.
   - CodeSurf already aggregates sessions from CodeSurf/Claude/Codex/Cursor/Hermes/OpenCode/etc., but the sidebar is broader and more manually composed.

3. The composer is a compact command surface.
   - Codex's composer footer uses container queries to collapse labels and preserve density in small windows.
   - CodeSurf already has a strong composer, queue drawer, change drawer, tool chips, model/provider pills, voice, attachments, and chat surfaces, but it is large and coded directly inside `ChatTile.tsx`.

4. The mini-window is an owned overlay manager.
   - Codex has a dedicated main-process thread overlay manager behind an `open-thread-overlay` message. It tracks owner window movement/focus/minimize, positions a transparent frameless window, can float, and syncs renderer state.
   - CodeSurf has no comparable overlay/mini-window manager yet.

5. Diffs are virtualized and treated as first-class review surfaces.
   - Codex has `thread-diff-virtualized`, dedicated diff chunks, git commit/rebase chunks, line/file thresholds, comment props, and worktree affordances.
   - CodeSurf has a good inline `DiffView`, but it is a simple parsed unified-diff renderer and Git IPC is basic.

6. Forge is not automatically faster than CodeSurf's electron-builder setup, but Codex uses Forge for package-time hooks, native unpacking, and Electron fuses. Those are worth copying as packaging hardening concepts.

## 1. Reference repo map: Codex app

### 1.1 Packaging and runtime shape

Key files:
- `/Users/jkneen/Documents/GitHub/codex-app/desktop/package.json`
- `/Users/jkneen/Documents/GitHub/codex-app/desktop/forge.config.ts`
- `/Users/jkneen/Documents/GitHub/codex-app/desktop/recovered/app-asar-extracted/package.json`
- `/Users/jkneen/Documents/GitHub/codex-app/desktop/recovered/app-asar-extracted/.vite/build/main-BnI_RVTn.js`
- `/Users/jkneen/Documents/GitHub/codex-app/desktop/recovered/app-asar-extracted/webview/assets/index-1LJShyXg.js`
- `/Users/jkneen/Documents/GitHub/codex-app/desktop/recovered/app-asar-extracted/webview/assets/index-CMhGK1g0.css`

Observed packaging:
- Local reconstruction package is `codex-desktop`, product `Codex`, version `26.415.20818`.
- Main points into recovered bundle: `recovered/app-asar-extracted/.vite/build/bootstrap.js`.
- Uses Electron `41.2.0`, Vite `8.0.3`, Electron Forge `7.11.1`.
- Native modules/resources: `better-sqlite3`, `node-pty`, bundled `codex` and `rg` binaries as extra resources.
- Forge config has:
  - `asar: true`
  - `AutoUnpackNativesPlugin`
  - `FusesPlugin`
  - makers for Squirrel, ZIP, DEB, AppImage
  - protocol scheme `codex://`
  - Linux icons from `desktop/assets/icons/codex-logo-{32,64,128,256,512}.png`

Important lesson:
- Forge is being used as a packaging orchestrator with hooks and fuses, not because it magically makes the renderer faster.
- The meaningful bits for CodeSurf are fuses, native unpack behavior, and extra-resource binary discipline.

### 1.2 Codex renderer chunks of interest

Relevant recovered bundle files:
- Main renderer: `webview/assets/index-1LJShyXg.js`
- Main CSS: `webview/assets/index-CMhGK1g0.css`
- Composer atoms: `webview/assets/composer-atoms-BnKIUgCZ.js`
- Conversation navigation: `webview/assets/use-start-new-conversation-CUWJoSWJ.js`
- Local conversation navigation: `webview/assets/use-navigate-to-local-conversation-DAfXkkEP.js`
- Plugins: `webview/assets/plugins-page-9Js_NIEN.js`, `plugins-cards-grid-hdUvgrsp.js`, `plugins-settings-CQ6yiHqf.js`
- Skills: `webview/assets/skills-page-DxIC0Zkj.js`, `skills-settings-D6nUe80E.js`
- Diff: `webview/assets/diff-CB8cQKT6.js`, `diff-CsR6BvSU.js`, `diff-view-mode-g3nVipZy.js`
- Git/worktree: `git-commit-QH-GCswc.js`, `git-rebase-DXNcvmq8.js`, `git-settings-BsDNVBpA.js`, `worktree-CVwAJ8O1.js`, `worktree-paths-BYSgSjz-.js`, `worktrees-settings-page-CtXuCxv2.js`, `gitGraph*.js`

The renderer is minified/hashed, so this should be treated as a behavioral/style reference rather than a clean copy source.

### 1.3 Codex side menu / thread manager

Evidence in `index-1LJShyXg.js`:
- Routes include `/local/:conversationId`.
- Sidebar command strings include:
  - `sidebarElectron.newThread` -> `New chat`
  - `sidebarElectron.recentChats` -> `Chats`
  - `sidebarElectron.pinnedThreads` -> `Pinned`
  - `sidebarElectron.renameThread` -> `Rename chat`
  - `sidebarElectron.archiveThread` -> `Archive chat`
  - `sidebarElectron.markThreadUnread` -> `Mark as unread`
  - `threadHeader.openInMiniWindow` -> `Open in mini window`
  - `threadHeader.copySessionId`, `threadHeader.copyAppLink`, `threadHeader.copyWorkingDirectory`
- State/local storage key observed: `sidebar-workspace-filter-v2`.
- Sidebar data model distinguishes local, remote, cloud, and pending-worktree tasks.
- It tracks unread/needs-attention and active status:
  - `hasUnreadTurn`
  - `pendingWorktree.needsAttention`
  - `resumeState === 'resuming' | 'needs_resume' | 'resumed'`
  - last turn `status === 'inProgress'`
- It supports pinned thread ordering via app-server messages:
  - `set-thread-pinned`
  - `set-pinned-threads-order`
- It has chat search in the command menu:
  - `codex.commandMenu.searchChats`
  - `codex.commandMenu.chatSearchPlaceholder`
  - `Pinned chats` and `Recent chats` groups
- It groups by project/workspace roots and remote host labels, with pending worktrees in the same list model.

Liftable pattern:
- Treat the sidebar's chat list as a single normalized `ThreadListItem` layer with `kind`, `env`, `status`, `attention`, `pinned`, `group`, and `source`, rather than rendering each source directly.
- Add first-class pinned/read/archived state on top of CodeSurf's aggregated sessions.
- Move search into command menu-style mode rather than only inline filtering.

### 1.4 Codex chat/composer layout

Evidence in `index-CMhGK1g0.css`:
- Layout tokens:
  - `--spacing-token-sidebar: clamp(240px,300px,min(520px,calc(100vw - 320px)))`
  - `--spacing-token-button-composer: calc(var(--spacing)*7)` => 28px if spacing is 4px
  - `--spacing-token-button-composer-sm: calc(var(--spacing)*5)`
  - `--spacing-token-button-composer-gap: var(--spacing)`
  - `--codex-chat-font-size`
  - `--codex-chat-code-font-size`
  - `--thread-content-max-width`
- Composer footer is responsive via container queries:
  - `.composer-footer { container: composer-footer / inline-size }`
  - hides `.composer-footer__label--sm`, `.composer-footer__label--xs`, secondary label, and chevron at width breakpoints.
- Electron/compact-window selectors:
  - `[data-codex-window-type=electron]`
  - `.compact-window`
  - `[data-codex-window-type=electron].compact-window body,[data-codex-window-type=electron].compact-window { background: 0 0 }`
- Scroll behavior classes:
  - `.scroll-contain { overscroll-behavior: contain; overflow: auto }`
  - `.scrollbar-stable { scrollbar-gutter: stable }`
  - `.hide-scrollbar { scrollbar-width: none; -ms-overflow-style: none }`
- Command menu styling is `cmdk`-style: blurred dropdown, tokenized border/background, list max-height, hidden scrollbars.

Evidence in `index-1LJShyXg.js`:
- The app sets document metadata:
  - `document.documentElement.dataset.codexWindowType = 'electron'`
  - `document.documentElement.dataset.windowType = 'electron'`
  - `document.documentElement.dataset.codexOs = ...`
  - adds `compact-window` class when initial route/debug conditions demand it.
- Chat actions include open mini window, copy deeplink, rename/archive, add/edit automation, mark unread.
- Composer footer has environment/worktree/branch/model-type controls and collapses labels for small width.

Liftable pattern:
- Extract CodeSurf composer into a component tree with a tokenized layout:
  - `ChatComposerShell`
  - `ComposerPrimaryInput`
  - `ComposerFooter`
  - `ComposerFooterPill`
  - `ComposerDrawerStack`
  - `PromptCommandMenu`
- Keep CodeSurf's stronger functionality, but make the chrome Codex-like: denser, more tokenized, width-responsive, less inline-style sprawl.

### 1.5 Codex mini-window / overlay

Evidence in main bundle `.vite/build/main-BnI_RVTn.js`:
- Renderer sends `open-thread-overlay`.
- Main handles it by calling `this.threadOverlayManager.open(webContents, { hostId, conversationId, title })`.
- Overlay manager stores overlay state keyed by owner/conversation.
- Session payload includes:
  - `sessionId`
  - `conversationId`
  - `target`
  - `anchorState`
  - `body`
  - `cwd`
  - optional `attachedImages`
  - `placementStrategy`
  - `screenshot`
- It tracks owner window move/resize/focus/show/restore/blur/hide/minimize and hides/repositions accordingly.
- It can transfer conversation IDs.
- It exposes `thread-overlay-set-always-on-top`.
- Window options use frameless transparent overlay settings:
  - `frame: false`
  - `transparent: true`
  - `hasShadow`
  - `resizable`
  - `minimizable: false`
  - `maximizable: false`
  - `fullscreenable: false`
  - `skipTaskbar: true`
  - optional `alwaysOnTop: true`
  - darwin `type: 'panel'`

Liftable pattern:
- Add a CodeSurf main-process `MiniChatWindowManager`, not just `window.open`.
- It should own lifecycle, route, state transfer, always-on-top, and owner-window visibility.
- Renderer can open with `window.electron.chat.openMini({ workspaceId, tileId, sessionEntryId, sessionId })`.
- Mini renderer route can load a focused `ChatTile` shell without canvas chrome.

### 1.6 Codex plugins and skills

Evidence in plugin/skill chunks:
- Plugin page strings:
  - `Plugins make Codex work your way.`
  - `Search plugins`
  - `Install plugin`, `Enable plugin`, `Disable plugin`, `Uninstall plugin`, `Try in Chat`
  - `Finish setting up {pluginName}`
  - per-plugin capability/about modal sections
- Skills page strings:
  - `Teach Codex reusable workflows with Skills.`
  - `Skills`, `Search skills`, `My Skills`
  - `New skill`
  - `Refresh to use new skill(s)`
  - `Recommended` and `Installed`
- Main bundle copies bundled skills into `~/.codex/skills/local` and calls app-server `skills/list` with `forceReload: true`.
- Main bundle has internal plugin download/install machinery and app/server-mediated plugin state.

Liftable pattern:
- CodeSurf already has a more flexible extension manifest system. Do not replace it with Codex's app-server-centric plugin design.
- Instead lift the gallery UX:
  - separate `Installed`, `Available`, `Recommended`, `Disabled` sections
  - capability/about panel
  - `Try in Chat` CTA for chat surfaces/extensions
  - explicit safe/power badges
  - refresh/reload action after installing skills

### 1.7 Codex git/diff/commit UX

Evidence in bundles:
- Dedicated chunks exist for `git-commit`, `git-rebase`, `git-settings`, `gitGraph`, `worktree`, and `diff-view-mode`.
- Inline thread diff uses `thread-diff-virtualized` and a diff renderer with `viewType='unified'`, `stickyHeader`, `defaultOpen`, `loadFullContent`, and `allowCommentDrafts` props.
- It uses thresholds around 25 files and 2000 changed lines before switching behavior.
- Diff CSS tokens include:
  - `--diffs-font-family`
  - `--diffs-font-size`
  - `--diffs-line-height`
  - git added/deleted color overrides from VSCode tokens
- Main app-server handlers include `apply-patch`, Git/worktree repository detection, and worktree launch modes like `fork-conversation` and `create-stable-worktree`.

Liftable pattern:
- Promote CodeSurf diffs from inline message decorations into a review surface:
  - collapsible changed-files drawer remains
  - add dedicated side/pane/extension for full diff review
  - virtualize large diffs
  - branch/worktree header context in composer
  - commit/revert/stage actions with explicit permission gates

### 1.8 Codex assets/icons

Available assets:
- `/desktop/assets/icons/codex-logo-source.png`
- `/desktop/assets/icons/codex-logo-{32,64,128,256,512}.png`
- Recovered app icons under `webview/apps/`, including:
  - `cursor.png`, `vscode.png`, `vscode-insiders.png`, `xcode.png`, `zed.png`, `windsurf.png`, `warp.png`, `terminal.png`, `iterm2.png`, `ghostty.png`, JetBrains icons, Android Studio, Finder/File Explorer, etc.
- One SVG: `webview/apps/webstorm.svg`

Conclusion:
- Codex does not ship a clean general-purpose icon library. Most UI icons are compiled inline SVG components/classes in the bundle.
- CodeSurf already uses `lucide-react` plus custom provider icons, which is cleaner.
- The most liftable thing is not the literal icons, but the icon treatment:
  - 14-16px strokes in the sidebar
  - 20px nav/action icons
  - 28px circular composer buttons
  - muted rest state, full foreground active/hover state
  - provider/source icons in list rows
- If licensing is acceptable, the app icons in `webview/apps/` could be useful for detected external app badges. Do not replace every CodeSurf icon with extracted Codex SVG from minified bundles.

## 2. CodeSurf current map

### 2.1 Packaging

Key files:
- `/Users/jkneen/clawd/collaborator-clone/package.json`
- `/Users/jkneen/clawd/collaborator-clone/electron.vite.config.ts`

Observed:
- Product: `CodeSurf`, package `codesurf`, main `dist-electron/main/index.js`.
- Build tool: `electron-vite` for main/preload/renderer, then `electron-builder` for packages.
- Electron `^41.3.0`, React `^19.2.4`, TypeScript `^5.9.3`, Vite `^7.3.1`.
- Native rebuild: `electron-rebuild -f -o better-sqlite3` and `node-pty`.
- Packaged `asar: true`, `asarUnpack` includes `better-sqlite3`, `node-pty`, `sharp`.
- Extra resources include bundled extensions.
- File association for `.skill` is already present.

Comparison:
- CodeSurf is already close to Codex in Electron version and native module needs.
- Missing Forge-like fuses/hardening. But no need to migrate away from electron-builder unless packaging hooks become a blocker.

### 2.2 Main window and window infrastructure

Key file:
- `/Users/jkneen/clawd/collaborator-clone/src/main/index.ts`

Observed:
- `createWindow()` creates one full app window at 1400x900, min 900x600.
- `titleBarStyle: hiddenInset` on macOS; frame on non-macOS.
- `webviewTag: true`, sandbox false, contextIsolation true, nodeIntegration false.
- It has multi-window list/focus broadcasts and fresh-window tracking.
- `setWindowOpenHandler` denies new windows and opens safe external URLs.
- No mini/overlay manager exists yet.

### 2.3 Sidebar / side menu

Key files:
- `/Users/jkneen/clawd/collaborator-clone/src/renderer/src/components/Sidebar.tsx`
- `/Users/jkneen/clawd/collaborator-clone/src/renderer/src/components/sidebar/ui.tsx`
- `/Users/jkneen/clawd/collaborator-clone/src/renderer/src/components/sidebar/utils.tsx`
- `/Users/jkneen/clawd/collaborator-clone/src/renderer/src/components/sidebar/types.ts`
- `/Users/jkneen/clawd/collaborator-clone/src/renderer/src/components/sidebar/session-filters.ts`

Observed strengths:
- Rich enough to represent workspaces, projects, sessions, resources, extensions, windows, and settings.
- Sessions are normalized through sidebar types and helpers.
- Session titles get cleaned and hard-capped in `formatSessionTitleForSidebar()`.
- Supports nested related sessions through `buildNestedSessionList()`.
- Provider/source icons are centralized in `SESSION_SOURCE_ICONS` and reuse CodeSurf/Claude/Codex/Cursor/Hermes/OpenCode icons.
- Tile/resource icons are mostly custom inline SVGs.

Gaps versus Codex:
- Sidebar is still visually busier and broader than Codex's thread-focused rail.
- Pinned/read/attention states are less prominent than Codex's row model.
- Search/filter exists, but not as polished as Codex's command-menu chat search.
- Session actions exist, but can be made more Codex-like: row context menu with rename/archive/pin/copy/open-mini/fork.

### 2.4 Chat

Key file:
- `/Users/jkneen/clawd/collaborator-clone/src/renderer/src/components/ChatTile.tsx`

Observed strengths:
- Very feature-rich: Claude/Codex/OpenCode/OpenClaw/Hermes provider modes, thinking, tool blocks, MCP peers, extensions/chat surfaces, queued turns, voice dictation, TTS, attachments, plan pane, block notes, change drawer, checkpoints, branch/workspace/footer controls.
- Message list auto-pinning logic explicitly disables `overflowAnchor` to avoid streaming judder.
- Tool/thinking chips are grouped and progressively collapsed.
- Latest change drawer already tucks above composer and renders file stats and inline diff.
- Queue drawer already collapses and nests above composer.
- Chat surfaces can mount extension iframes above composer.

Gaps versus Codex:
- `ChatTile.tsx` is ~9,600 lines and holds too much UI state/rendering directly.
- Composer is functional but visually heavy. Codex's feels more like a compact command surface.
- CodeSurf uses a textarea; Codex appears to have richer prompt/editor tokens and prompt drop zones.
- Responsive collapse is manual; Codex uses container-query CSS for footer controls.
- Mini-window path does not exist.

### 2.5 Chat extension surfaces

Key files:
- `/Users/jkneen/clawd/collaborator-clone/src/main/extensions/registry.ts`
- `/Users/jkneen/clawd/collaborator-clone/src/main/ipc/extensions.ts`
- `/Users/jkneen/clawd/collaborator-clone/src/renderer/src/hooks/useExtensions.ts`
- `/Users/jkneen/clawd/collaborator-clone/src/renderer/src/components/ExtensionsGallery.tsx`
- `/Users/jkneen/clawd/collaborator-clone/src/renderer/src/components/chatSurfaceHostRpc.ts`

Observed strengths:
- Extension manifests support tiles, chat surfaces, MCP tools, context menu, settings, actions.
- Extension registry supports bundled, global, workspace, and catalog extension dirs.
- Catalog extensions default disabled and only activate power-tier code after user enables them.
- Chat surfaces are already a first-class contribution type and mount in the composer area.
- Basic chat-surface RPC supports payload, tile metadata, theme colors, workspace path, settings, and extension invocation.
- VSIX install is present.

Gaps versus Codex:
- Gallery is simpler than Codex plugins/skills pages.
- Extension cards do not surface capabilities as well as Codex plugin cards.
- There is no separate Skills marketplace/library UX matching Codex's `Skills` page; CodeSurf has skills infrastructure but not the same polished install/try flow.

### 2.6 Sessions/conversations

Key files:
- `/Users/jkneen/clawd/collaborator-clone/src/main/session-sources.ts`
- `/Users/jkneen/clawd/collaborator-clone/src/shared/session-types.ts`
- `/Users/jkneen/clawd/collaborator-clone/src/main/ipc/canvas.ts`
- `/Users/jkneen/clawd/collaborator-clone/src/preload/index.ts`

Observed strengths:
- Aggregated session sources include `codesurf`, `claude`, `codex`, `cursor`, `hermes`, `openclaw`, `opencode`.
- CodeSurf scans runtime tile states, daemon/job stores, and external session files.
- It already has cache controls around external session listing and full-state cache.
- Preload exposes `canvas:listSessions`, `renameSession`, `archiveSession`, `generateSessionTitle`, `loadSessionState`, `loadSessionPage`.
- Sidebar builds nested session list by `relatedGroupId` and `nestingLevel`.

Gaps versus Codex:
- Codex app-server exposes chat mutation/search as a cohesive conversation service: archive, rename, mark unread, pin, set pinned order, search threads, start/fork worktree conversations.
- CodeSurf has aggregated read/import, but not an app-wide thread state layer with pinned/read/attention/search indices independent of source files.

### 2.7 Git/diff

Key files:
- `/Users/jkneen/clawd/collaborator-clone/src/main/ipc/git.ts`
- `/Users/jkneen/clawd/collaborator-clone/src/renderer/src/components/chat/DiffView.tsx`
- `/Users/jkneen/clawd/collaborator-clone/src/renderer/src/components/ChatTile.tsx`

Observed strengths:
- Git IPC handles status, branches, checkout branch, create branch.
- Chat composer footer already exposes location and branch menus.
- Change drawer renders last file changes and has undo/checkpoint hooks.
- `DiffView` parses unified diffs into rows with old/new gutters, add/delete/hunk/meta colors, horizontal scroll, max 480px height, and `maxLines` collapse default 300.

Gaps versus Codex:
- No staging/commit/rebase UI.
- No virtualized diff renderer for huge diffs.
- No full review pane or comments.
- Git IPC is intentionally small; Codex has deeper app-server/GitManager/worktree integration.

## 3. What to take, ranked

### P0 — Do these first

#### P0.1 Tokenize CodeSurf chat/sidebar layout with Codex-style dimensions

Create a small token module or CSS file and gradually route ChatTile/Sidebar through it.

Suggested initial tokens:
- `--cs-sidebar-width: clamp(240px, 300px, min(520px, calc(100vw - 320px)))`
- `--cs-chat-font-size`
- `--cs-chat-code-font-size`
- `--cs-thread-content-max-width`
- `--cs-composer-button-size: 28px`
- `--cs-composer-button-size-sm: 20px`
- `--cs-composer-radius: 14px`
- `--cs-composer-footer-gap: 4px`

Target files:
- `src/renderer/src/components/ChatTile.tsx`
- `src/renderer/src/components/Sidebar.tsx`
- `src/renderer/src/components/sidebar/ui.tsx`
- `src/renderer/src/theme.ts`

Why:
- This gives immediate visual alignment without deep architecture risk.

#### P0.2 Extract the composer/drawer stack out of `ChatTile.tsx`

Recommended extraction boundaries:
- `components/chat/ChatTranscript.tsx`
- `components/chat/ChatComposer.tsx`
- `components/chat/ComposerFooter.tsx`
- `components/chat/ComposerDrawerStack.tsx`
- `components/chat/ComposerInsertMenu.tsx` if not already separate
- `components/chat/ChatSurfaceTray.tsx`

Keep behavior exactly the same first. No visual redesign until extraction compiles.

Why:
- The user specifically asked whether the whole chat interface could become a plugin/extension. Today it cannot cleanly because chat is too entangled. Extraction is the prerequisite.

#### P0.3 Implement Codex-style mini chat window manager

Add main-process manager:
- `src/main/chat-mini-window-manager.ts`

Add IPC:
- `chat:openMiniWindow`
- `chat:closeMiniWindow`
- `chat:focusMiniWindow`
- `chat:setMiniWindowAlwaysOnTop`

Initial options:
- frameless
- transparent
- skipTaskbar
- resizable
- min size around 420x520
- darwin panel type if practical
- owner-window lifecycle sync: close/hide/minimize owner => hide mini; owner move/resize can optionally reposition

Renderer route:
- Use `?surface=mini-chat&workspaceId=...&tileId=...&sessionEntryId=...`
- Render `ChatTile` inside a minimal shell, not the canvas.

Why:
- This is one of the clearest high-value lifts from Codex.

### P1 — High value after P0

#### P1.1 Sidebar thread row polish

Adopt Codex row model:
- active row with subtle selection fill
- rest/hover action slot on the right
- left attention/pin indicator slot
- source/environment icon with consistent 14px sizing
- title + meta line density
- right-click context menu: open, open mini, rename, archive, pin/unpin, copy session id, copy path/deeplink

Target files:
- `src/renderer/src/components/Sidebar.tsx`
- `src/renderer/src/components/sidebar/ui.tsx`
- `src/renderer/src/components/sidebar/utils.tsx`

#### P1.2 Add pinned/read/attention overlay state for aggregated sessions

Create a small session metadata store separate from source files:
- `~/.codesurf/session-overrides.json` or better, existing SQLite DB if ready.

Fields:
- `sessionEntryId`
- `pinned: boolean`
- `pinnedOrder: number | null`
- `readAt: number | null`
- `archived: boolean`
- `customTitle: string | null`
- `lastOpenedAt`

Why:
- Codex's sidebar feels polished because state like pinned/unread/archived is first-class even when conversations come from multiple origins.

#### P1.3 Command-menu chat search

Add a command-menu mode that searches sessions with grouped results:
- Pinned chats
- Recent chats
- Source groups: CodeSurf / Claude / Codex / Cursor / OpenCode / Hermes
- Current project first

Use existing `canvas:listSessions` plus local metadata. Add a searchable summary index later.

#### P1.4 Improve Extensions Gallery toward Codex plugin/skills UX

Changes:
- Tabs/sections: Installed, Available, Recommended, Disabled.
- Cards show contributed capabilities: tiles, chat surfaces, MCP tools, settings, actions.
- Add `Try in Chat` for chat-surface extensions.
- Add skill library pane with `New skill`, `Refresh skills`, `Installed`, `Recommended`.

Keep current manifest architecture; just improve the surface.

### P2 — Deeper git/diff parity

#### P2.1 Replace or augment `DiffView` with virtualized diff rendering

Current `DiffView` is good for small patches, but Codex treats diff as a scale-sensitive surface.

Add:
- file-level virtualization
- row-level virtualization for >300 lines
- thresholds like Codex: e.g. summarize if file count >25 or changed lines >2000
- sticky file headers
- per-file collapse/expand
- full review pane route/tile

Target:
- `src/renderer/src/components/chat/DiffView.tsx`
- `src/renderer/src/components/chat/ReviewPane.tsx` (new)

#### P2.2 Add commit/revert/stage UI as a Git extension first

Use CodeSurf's extension system rather than hardcoding into ChatTile:
- `bundled-extensions/git-review`
- contributes a tile and/or chat surface
- actions: stage, unstage, commit, revert, open diff

Main IPC expansion:
- `git:diff`
- `git:stage`
- `git:unstage`
- `git:commit`
- `git:restore`
- `git:worktrees`

Keep destructive ops permission-gated.

### P3 — Packaging hardening

#### P3.1 Keep electron-builder, add fuses/hardening if possible

Do not migrate to Electron Forge purely because Codex uses it. CodeSurf's current builder setup is fine.

Worth adopting:
- Electron fuses equivalent in electron-builder pipeline or a post-pack script:
  - disable RunAsNode
  - disable NODE_OPTIONS env var
  - disable node CLI inspect args
  - enable cookie encryption if relevant
  - only load app from asar after package stability
- Continue explicit native unpack for `better-sqlite3`, `node-pty`, `sharp`.
- Review extraResources so bundled extensions are deterministic.

## 4. About extracting Codex's whole chat interface as a CodeSurf extension

Recommendation: do not extract Codex's whole chat UI wholesale.

Reasons:
- The Codex renderer is minified and tightly coupled to its app-server, route atoms, query cache, Electron host messages, theme tokens, and feature gates.
- The most useful pieces are patterns and contracts, not source files.
- CodeSurf's chat has more multi-provider and extension-specific capabilities than Codex's thread UI. Replacing it would lose functionality.

Better route:
1. Extract CodeSurf's own chat UI into clean internal modules.
2. Define a stable `ChatSurfaceProvider` / `ChatRuntimeAdapter` interface.
3. Make chat chrome swappable by style/theme/layout presets.
4. Let extensions contribute composer panels/chat surfaces/tool panes, not own the entire chat runtime.

Potential API shape:

```ts
export interface ChatShellExtension {
  id: string
  label: string
  contributes: {
    composerPanels?: ComposerPanelContribution[]
    messageDecorators?: MessageDecoratorContribution[]
    transcriptOverlays?: TranscriptOverlayContribution[]
    footerPills?: FooterPillContribution[]
  }
}
```

Use this to make `Sketch`, `Builder`, `Git Review`, `Prompt Library`, and future skill/plugin UIs feel native without letting them fork chat state.

## 5. Icon plan

Do not replace all CodeSurf icons with extracted Codex icons.

Recommended icon cleanup:
- Keep provider icons in `components/icons/providerIcons`.
- Keep lucide for generic actions, but standardize sizes/strokes:
  - sidebar source icons: 14px
  - sidebar section/resource/tile icons: 16px
  - header/action icons: 16-20px
  - composer circular buttons: 28px outer / 14-16px inner
- Introduce `IconSlot` component to normalize opacity, size, active/hover colors.
- Optional: use recovered app icons in `webview/apps/` only for detected external-app badges, if licensing is acceptable.
- Do not use Codex logo assets for CodeSurf branding.

## 6. Suggested small controlled implementation bursts

### Burst 1: Codex token/style foundation

Files:
- `src/renderer/src/styles/codex-inspired-tokens.css` or `src/renderer/src/chatLayoutTokens.ts`
- small imports in `App.tsx` or renderer root
- adjust Sidebar width + composer button sizes

Acceptance:
- Build passes.
- No behavior changes.
- Sidebar/composer visibly denser and more Codex-like.

### Burst 2: ComposerFooter extraction + container query collapse

Files:
- `src/renderer/src/components/chat/ComposerFooter.tsx`
- `src/renderer/src/components/chat/ComposerPill.tsx`
- `ChatTile.tsx` import only

Acceptance:
- Existing location/model/thinking/branch/provider controls work.
- Footer labels hide cleanly under narrow widths.
- No chat sending regression.

### Burst 3: Drawer stack extraction

Files:
- `src/renderer/src/components/chat/ComposerDrawerStack.tsx`
- Move latest-change drawer, queue drawer, active thinking/liveness drawer into stack.

Acceptance:
- Queue collapse/expand works.
- Latest changes expand/collapse works.
- Drawer tucking remains visually aligned above composer.

### Burst 4: Mini chat window skeleton

Files:
- `src/main/chat-mini-window-manager.ts`
- `src/main/ipc/chat-mini.ts` or in `chat.ts`
- `src/preload/index.ts`
- renderer mini route/shell

Acceptance:
- From a chat tile/sidebar row, open a mini window for the same session.
- Window is frameless, compact, resizable, and can be closed/focused.
- No duplicated session state corruption.

### Burst 5: Sidebar row polish and actions

Files:
- `src/renderer/src/components/sidebar/ThreadRow.tsx` (new)
- `Sidebar.tsx`
- session metadata store IPC if needed

Acceptance:
- Rows have Codex-like density and action slots.
- Right-click menu exposes open mini, rename, archive, pin/unpin, copy ID/path.
- Pinned section works.

### Burst 6: Extensions/Skills gallery polish

Files:
- `ExtensionsGallery.tsx`
- optional `SkillsGallery.tsx`

Acceptance:
- Extension cards show capabilities and `Try in Chat` where relevant.
- Installed/Available sections are clear.
- Safe/power extension status is obvious.

### Burst 7: Git Review extension

Files:
- `bundled-extensions/git-review/extension.json`
- `bundled-extensions/git-review/index.html/js`
- `src/main/ipc/git.ts` additions

Acceptance:
- Git review tile/surface lists changed files and renders virtualized diffs.
- Stage/commit actions are permission-gated.
- Chat change drawer can open full review.

## 7. Concrete file-by-file recommendation table

| Area | CodeSurf file(s) | Codex reference | Recommendation |
|---|---|---|---|
| Sidebar width/density | `Sidebar.tsx`, `sidebar/ui.tsx` | `index-CMhGK1g0.css` token sidebar clamp | Replace local sizing with tokenized clamp and denser rows |
| Sidebar row model | `Sidebar.tsx`, `sidebar/types.ts`, `sidebar/utils.tsx` | `index-1LJShyXg.js` local/remote/pending-worktree/pinned model | Add normalized `ThreadListItem` and row actions |
| Chat composer | `ChatTile.tsx` | `composer-footer` CSS + `composer-atoms` chunk | Extract composer/footer and use container queries |
| Prompt/editor area | `ChatTile.tsx` textarea | Codex prompt drop tokens, command menu | Add Codex-style command palette + future rich prompt editor |
| Message list | `ChatTile.tsx` | hidden/stable scroll CSS, thread content width | Keep auto-pin, add scroll tokens and stable gutter option |
| Change drawer | `ChatTile.tsx`, `DiffView.tsx` | `thread-diff-virtualized`, diff chunks | Preserve drawer, add virtualized full review |
| Mini window | no equivalent | main `threadOverlayManager`, `open-thread-overlay` | Add dedicated mini chat manager |
| Extensions | `extensions/registry.ts`, `ExtensionsGallery.tsx` | plugins/skills pages | Keep registry, upgrade gallery UX |
| Sessions | `session-sources.ts`, `canvas.ts` | app-server conversation service | Add session override/index layer for pinned/read/archive/search |
| Git | `ipc/git.ts` | git/worktree/diff/commit chunks | Expand Git IPC and ship as extension first |
| Packaging | `package.json`, `electron.vite.config.ts` | `forge.config.ts` | Keep builder; adopt fuses/native-resource lessons |

## 8. Risks and cautions

- Codex source is recovered/minified. Do not copy chunks wholesale into CodeSurf; use it as a behavioral/style reference.
- CodeSurf chat is more capable than Codex in multi-agent/provider terms. Avoid replacing CodeSurf's runtime with Codex assumptions.
- Mini-window work touches session identity and persistence. It should be implemented as a separate shell over the same session, not a duplicate chat tile with a fresh session.
- Git commit/revert actions must be permission-gated and ideally branch/worktree-aware.
- CSS token migration should be incremental; avoid rewriting `ChatTile.tsx` and `Sidebar.tsx` in one giant pass.

## 9. Recommended next action

Start with Burst 1 + Burst 2 only:
1. Add CodeSurf layout tokens inspired by Codex.
2. Extract and restyle the composer footer with container-query collapse.
3. Commit that as one controlled burst.

Then do mini-window skeleton as a separate burst.
