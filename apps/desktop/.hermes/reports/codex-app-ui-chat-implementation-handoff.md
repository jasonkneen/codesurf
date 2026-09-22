# Codex-inspired CodeSurf implementation handoff

Generated: 2026-05-01 21:40:14 BST

Scope:
- Target repo: `/Users/jkneen/clawd/collaborator-clone`
- Reference report: `.hermes/reports/codex-app-ui-chat-reference-report.md`
- Implementation pass: controlled Codex-inspired UI/UX improvements, no feature removals.

## What changed

### 1. Layout token foundation

File: `src/renderer/src/index.css`

Added centralized CodeSurf/Codex-style CSS tokens for:
- Sidebar default/min/max width.
- Sidebar row radius and horizontal padding.
- Chat transcript content max width.
- Composer side inset/min width/control size/radius/footer gap.
- Mini chat default dimensions.

Also added shared class primitives:
- `.cs-chat-shell`
- `.cs-chat-message-stack`
- `.cs-chat-composer-wrap`
- `.cs-chat-composer-card`
- `.cs-chat-composer-primary-toolbar`
- `.cs-chat-composer-secondary-toolbar`
- `.cs-toolbar-pill-label`
- `.cs-footer-pill-label`
- `.cs-composer-path-label`
- `.cs-thread-row`
- `.cs-thread-row-active`
- `.cs-mini-chat-window`

These keep the current React implementation intact while moving the first layer of Codex-like density behavior into one place.

### 2. Chat composer polish

File: `src/renderer/src/components/ChatTile.tsx`

Changed the chat/composer shell to use the new class primitives and CSS variables:
- Transcript max width now follows `--cs-thread-content-max-width`.
- Composer width/min-width/insets now follow `--cs-chat-composer-*` tokens.
- Toolbar and footer pill labels now collapse responsively via container queries.
- Added a compact mini-window launcher button to the primary toolbar.

Kept existing provider/model/thinking/voice/send controls, tool permission flow, chat surfaces, attachments, streaming, history, and drawers intact.

### 3. Mini chat window

Files:
- `src/main/index.ts`
- `src/preload/index.ts`
- `src/renderer/src/env.d.ts`
- `src/electrobun/browser/electron-facade.ts`
- `src/renderer/src/App.tsx`
- `src/renderer/src/components/ChatTile.tsx`

Added a first-pass Codex-style mini chat window:
- Main process owns mini windows by `workspaceId:tileId` key.
- Reuses/focuses an existing mini window for the same chat instead of spawning duplicates.
- Positions beside the owner window and clamps inside the current display work area.
- Tracks owner close/minimize/restore/focus well enough for a lightweight floating companion.
- Uses a frameless always-on-top mini BrowserWindow with a custom titlebar.
- Loads the normal renderer with query params: `miniChat=1&workspaceId=...&tileId=...`.
- Renderer switches to a dedicated mini-chat shell that mounts the same `ChatTile` against the source tile state.
- Mini-chat mode is guarded so it does not persist main-window workspace tabs, change the global active workspace, force setup UI, or run canvas proximity/auto-agent logic.

This is intentionally not a one-off `window.open`; it is a main-process managed shell, matching the direction recommended in the reference pass.

### 4. Sidebar row polish

Files:
- `src/renderer/src/App.tsx`
- `src/renderer/src/components/Sidebar.tsx`
- `src/renderer/src/index.css`

Changed the default sidebar width from 280 to 300 and gave session rows Codex-like active/hover rail treatment through the new `.cs-thread-row` classes.

The existing archive, pin, unread, title generation, open-in-chat, open-in-app, and project grouping logic is preserved.

### 5. Sidebar mini-window affordance

Files:
- `src/renderer/src/components/Sidebar.tsx`
- `src/renderer/src/components/sidebar/session-actions.ts`
- `test/sidebar/session-actions.test.mjs`

Added the next Codex-inspired mini-window burst after dogfooding confirmed the chat toolbar mini window worked well:
- Clicking any sidebar session now promotes the thread immediately in UI memory before opening, matching Codex/Cursor thread-list behavior without mutating persisted `updatedAt`.
- Tile-backed session rows now show a hover action for `Open mini window`.
- Tile-backed session context menus now include `Open Mini Window`.
- The mini affordance calls the existing `window.electron.window.openMiniChat({ workspaceId, tileId, title })` IPC path, so it reuses the main-process owned mini-window manager instead of creating another popup path.
- Row action width accounting was updated so the mini button does not collide with checkpoint or archive actions.
- Added/updated tests for the wider row-action rail.

Intentional constraint: sidebar mini-window opening is currently limited to sessions that already have a concrete `tileId`. That keeps the pass safe and avoids silently creating layout tiles for historical/external sessions just to pop them out. A future burst can add a deliberate "open into chat, then pop out" path if desired.

### 6. Composer controls extraction

Files:
- `src/renderer/src/components/ChatTile.tsx`
- `src/renderer/src/components/chat/ChatComposerControls.tsx`

Started the behavior-preserving `ChatTile` breakup with the lowest-risk composer seam:
- Moved `ToolbarBtn`, `ToolbarPill`, and `FooterPill` out of the ~9k-line `ChatTile.tsx` file.
- Kept the public JSX usage and props unchanged.
- Preserved the Codex-style CSS class hooks on toolbar/footer pill labels.
- Removed now-unused toolbar text/chevron constants and the no-longer-needed `Lock` icon import from `ChatTile.tsx`.

This is intentionally not a composer redesign yet. It is the first safe extraction layer so the prompt area, menus, drawer controls, and footer can be split in later small commits without changing behavior.

### 7. Composer menu/dropdown extraction

Files:
- `src/renderer/src/components/ChatTile.tsx`
- `src/renderer/src/components/chat/ChatComposerMenus.tsx`

Continued the behavior-preserving `ChatTile` breakup by moving menu/dropdown primitives into a dedicated file:
- Moved `MenuPortal`, `Dropdown`, `DropdownItem`, and `ModelDropdown` out of `ChatTile.tsx`.
- Kept existing JSX call sites in `ChatTile.tsx` intact by importing the extracted components.
- Preserved menu portal positioning, click/mousedown propagation stops, model filtering, active/hover states, and selection handlers.
- Kept menu typography on the same app font context as the extracted toolbar/footer controls via `useAppFonts()`; this also avoids relying on chat-root CSS variable inheritance for portaled menu DOM.

This remains a refactor-only step. Prompt/drawer behavior was not redesigned.

### 8. Composer insert menu extraction

Files:
- `src/renderer/src/components/ChatTile.tsx`
- `src/renderer/src/components/chat/ChatComposerMenus.tsx`

Moved the `+` insert menu into the same composer menu module:
- Moved `ComposerInsertMenu` and its local `MCPIcon` out of `ChatTile.tsx`.
- Moved the `ChatSurfaceMenuEntry` type into `ChatComposerMenus.tsx` and imported it back into `ChatTile.tsx`.
- Kept the existing attachment action, MCP enable/disable action, per-server enable/disable list, peer-tool read-only rows, chat-surface rows, hover styling, and submenu open/close behavior intact.
- Passed `renderChatSurfaceIcon` into the extracted component so the broader chat-surface icon mapping stays centralized in `ChatTile.tsx` and the menu extraction does not drag unrelated icon logic with it.
- Removed now-unused `Paperclip` and `MCPServerEntry` imports from `ChatTile.tsx`.

This is still a foundation/refactor burst, not a UX redesign.

### 9. Composer shell extraction

Files:
- `src/renderer/src/components/ChatTile.tsx`
- `src/renderer/src/components/chat/ChatComposer.tsx`

Moved the presentational composer frame into a dedicated module:
- Added `ChatComposerWrap`, `ChatComposerCard`, `ChatComposerPrimaryToolbar`, and `ChatComposerSecondaryToolbar`.
- Preserved the existing DOM class hooks: `.cs-chat-composer-wrap`, `.cs-chat-composer-card`, `.cs-chat-composer-primary-toolbar`, and `.cs-chat-composer-secondary-toolbar`.
- Preserved inline layout styles, child order, JSX nesting, menu refs, textarea handlers, attachment/chat-surface slots, and footer/action controls.
- Kept state ownership in `ChatTile.tsx`; this was a shell/frame extraction only, not a prompt behavior redesign.

The next safe extraction point is to move one content section at a time, starting with the autocomplete/draft-status surfaces or attachment strip, rather than passing the entire composer state into one giant new component.

### 10. Composer attachment strip extraction

Files:
- `src/renderer/src/components/ChatTile.tsx`
- `src/renderer/src/components/chat/ChatComposer.tsx`

Moved the attachment preview strip into the composer module:
- Added `ChatComposerAttachment` and `ChatComposerAttachments`.
- Preserved image/file preview layout, basename display, remove button behavior, theme colors, and exact monospace font selection by passing `fontMono` from `ChatTile.tsx`.
- Kept attachment state and `removeAttachment` ownership in `ChatTile.tsx`; the extracted component is presentational plus one callback.
- Left message-render attachment UI in `ChatTile.tsx` untouched; this extraction is only for pending composer attachments.

The next safe extraction point is likely the autocomplete popup or dictation/TTS composer banners.

### 11. Composer voice status extraction

Files:
- `src/renderer/src/components/ChatTile.tsx`
- `src/renderer/src/components/chat/ChatComposer.tsx`

Moved the dictation/TTS status banners into the composer module:
- Added `ChatComposerVoiceStatus`.
- Preserved the dictation recording indicator, dictation error rendering, interim transcript text, TTS speaking indicator, queued-count label, and stop button behavior.
- Kept voice/VAD/TTS state ownership in `ChatTile.tsx`; the extracted component receives state and an `onStopVoicePlayback` callback.
- Kept per-message TTS playback controls in message rendering untouched; this extraction is only for composer-level status banners.

The next safe extraction point is likely the autocomplete popup or chat-surface host strip.

### 12. Composer autocomplete extraction

Files:
- `src/renderer/src/components/ChatTile.tsx`
- `src/renderer/src/components/chat/ChatComposer.tsx`

Moved the `/` and `@` autocomplete popup into the composer module:
- Added `ChatComposerAutocompleteItem` and `ChatComposerAutocompletePopup`.
- Preserved the mention helper text, active-row highlighting, hover selection, mouse-down selection, popup ref wiring, and item value/description typography.
- Kept autocomplete state, filtering, keyboard navigation, text replacement, connected-file attachment behavior, and textarea focus/cursor restoration in `ChatTile.tsx`.
- Removed now-unused local dropdown color aliases from `ChatTile.tsx`; extracted popup reads the same theme values directly.

The next safe extraction point is likely the chat-surface host strip.

### 13. Composer chat-surface host extraction

Files:
- `src/renderer/src/components/ChatTile.tsx`
- `src/renderer/src/components/chat/ChatComposer.tsx`

Moved the chat-surface tab/iframe host strip above the composer textarea into the composer module:
- Added `ChatComposerSurface` and `ChatComposerSurfaceHost`.
- Preserved surface tab rendering, active tab styling, close buttons, iframe refs, iframe sandbox attributes, active-surface visibility, and `Enhance → Builder` affordance.
- Kept chat-surface state, active-surface selection, surface opening/closing, iframe ref ownership, RPC/message handling, peer context/actions, payload flushing, and `renderChatSurfaceIcon` ownership in `ChatTile.tsx`.
- Removed the now-unused local `dropdownBorder` alias from `ChatTile.tsx`; the extracted host reads the same theme value directly.

The next safe extraction point is likely the remaining composer footer/drawer control grouping, after a focused live dogfood pass of surfaces/menus/autocomplete.

### 14. Composer project path control extraction

Files:
- `src/renderer/src/components/ChatTile.tsx`
- `src/renderer/src/components/chat/ChatComposer.tsx`

Moved the footer project path / switch-folder button into the composer module:
- Added `ChatComposerProjectPathButton`.
- Preserved the folder icon, path label, `.cs-composer-path-label` class hook, disabled cloud-state behavior, hover color behavior, title text, and click target styling.
- Kept the actual switch-folder behavior in `ChatTile.tsx` via `handleProjectFolderSwitch`, including folder picker, workspace project-folder registration, assistant status message append, and warning logs.
- Removed the now-unused `Folder` icon import from `ChatTile.tsx`; the icon now lives with the extracted project-path control.

The next safe extraction point is likely one of the remaining footer clusters: location menu, branch menu, mode chip, or context usage dial.

### 15. Composer context usage dial extraction

Files:
- `src/renderer/src/components/ChatTile.tsx`
- `src/renderer/src/components/chat/ChatComposer.tsx`

Moved the footer context-window dial and popup into the composer module:
- Added `ChatComposerContextUsageDial`.
- Preserved the 28×28 hit-box, 18×18 conic-gradient dial, inner dot, portal anchoring, context percentage/tokens copy, system-overhead note, compacting note, typography, and theme styling.
- Kept the context menu ref and menu-open state in `ChatTile.tsx`, so outside-click/Escape handling still uses the same shared menu ref array.
- Passed `NON_SELECTABLE_UI_STYLE` into the extracted component to avoid moving the broader chat UI constant.
- Fixed the extracted ref prop as `React.RefObject<HTMLDivElement | null>` after independent review caught React 19 ref nullability.

The next safe extraction point is likely one of the remaining footer clusters: location menu, branch menu, or mode chip.

### 16. Composer location menu extraction

Files:
- `src/renderer/src/components/ChatTile.tsx`
- `src/renderer/src/components/chat/ChatComposer.tsx`

Moved the footer local/cloud execution-target menu into the composer module:
- Added `ChatComposerLocationMenu`.
- Moved the local/cloud project SVG icons with the extracted visual component.
- Preserved the footer pill, `Continue in` header, local row, cloud row, remote-daemon section, active states, remote host URL sublabels, rate-limits placeholder, portal anchoring, and theme styling.
- Kept execution-target state and cloud-host mutation in `ChatTile.tsx` via explicit callbacks, so the extracted component stays presentational.
- Kept `locationMenuRef` owned by `ChatTile.tsx`, so shared outside-click/Escape handling still uses the same `menuRefs` array.

The next safe extraction point is likely the remaining footer mode chip.

### 17. Composer branch menu extraction

Files:
- `src/renderer/src/components/ChatTile.tsx`
- `src/renderer/src/components/chat/ChatComposer.tsx`

Moved the footer git branch menu into the composer module:
- Added `ChatComposerBranch` and `ChatComposerBranchMenu`.
- Moved the branch SVG icon with the extracted visual component.
- Preserved the footer pill, current-branch/project fallback label, branch search input, Enter-to-create behavior, repository path header, branches section, current-branch active state, uncommitted-file sublabel, no-git/no-match empty states, create-and-checkout button, portal anchoring, hover styling, and theme styling.
- Kept git state, branch filtering, branch creation, branch checkout, refresh behavior, and `branchMenuRef` ownership in `ChatTile.tsx`, so shared outside-click/Escape handling still uses the same `menuRefs` array.

The footer extraction pass is now effectively complete; the next safe step is live dogfooding before starting prompt/drawer UX polish.

### 18. Composer mode menu extraction

Files:
- `src/renderer/src/components/ChatTile.tsx`
- `src/renderer/src/components/chat/ChatComposer.tsx`

Moved the footer mode chip/menu into the composer module:
- Added `ChatComposerModeOption` and `ChatComposerModeMenu`.
- Moved the visual footer pill + mode dropdown rendering into `ChatComposer.tsx`.
- Preserved the ShieldCheck icon, mode label/color, active menu state, dropdown rows, row sublabels, active-mode highlighting, portal anchoring, and selection/close behavior.
- Kept mode state, `modeMenuRef`, `toggleMenu('mode')`, and `setMode(...)` ownership in `ChatTile.tsx`, so shared outside-click/Escape handling still uses the same `menuRefs` array.

This completes the low-risk footer-cluster extraction sequence: project path, context dial, location menu, branch menu, and mode menu are now all out of `ChatTile.tsx` while their state/refs remain owned by `ChatTile.tsx`.

### 19. Composer drawer frame and first prompt polish

Files:
- `src/renderer/src/components/ChatTile.tsx`
- `src/renderer/src/components/chat/ChatComposer.tsx`
- `src/renderer/src/index.css`

Started the actual Codex-inspired prompt/drawer polish pass with the safest shared chrome seam:
- Added `ChatComposerDrawerFrame` to centralize the drawer shell used by the latest-changes drawer and queued-message drawer.
- Replaced duplicated inline drawer chrome in `ChatTile.tsx` while preserving drawer widths, stacking, expanded/collapsed queue behavior, latest-change expansion, file rows, queued-turn actions, and existing state ownership.
- Added joined/collapsed drawer classes so stacked drawers can share one visual language without changing the queue/change logic.
- Added subtle Codex-like drawer blur/top highlight and composer focus/placeholder CSS under the existing `.cs-chat-composer-*` class hooks.
- Kept all prompt controls, provider/model/thinking menus, insert menu, footer controls, dictation/TTS, chat surfaces, attachments, send/stop behavior, and drawer actions intact.

This is intentionally a first polish seam, not a broad prompt rewrite. The next visual step can tighten the command surface/control density now that the drawer frame is centralized.

### 20. Composer input extraction and final command-surface polish

Files:
- `src/renderer/src/components/ChatTile.tsx`
- `src/renderer/src/components/chat/ChatComposer.tsx`
- `src/renderer/src/index.css`

Finished this Codex-inspired chat/composer cleanup phase with one last safe seam around the actual prompt textarea:
- Added `ChatComposerInput` to move the textarea chrome out of `ChatTile.tsx` while preserving the existing `textareaRef`, value, placeholder, change/key handlers, rows, padding, fonts, min-height, resize/overflow behavior, and text color.
- Kept input state, slash/mention autocomplete behavior, keyboard handling, send flow, dictation placeholder, and textarea resize/focus logic in `ChatTile.tsx`.
- Added `.cs-chat-composer-input` as a stable styling hook for caret color, selection color, and scrollbar behavior.
- Added a subtle primary-toolbar seam to reinforce the compact Codex-like command-surface stack without moving or hiding any controls.

This closes the low-risk composer extraction/polish pass. The chat surface is now split into presentational slots for controls, menus, attachments, voice status, autocomplete, surface tabs, footer controls, drawers, and input while the risky stateful behavior remains in `ChatTile.tsx`.

## Verification

Commands run from `/Users/jkneen/clawd/collaborator-clone` after the final composer input / command-surface polish burst:

```bash
npm run build
npm test
git diff --check
git diff --cached --check
```

Results:
- `npm run build`: passed.
- `npm test`: passed, 177 tests, 0 failures.
- `git diff --check`: passed.
- `git diff --cached --check`: passed before committing the code extraction.
- Static source dogfood assertions for `ChatComposerInput`, textarea wiring, and composer CSS hooks: passed.
- Static scan of added lines for common secret/injection patterns: no findings.
- Independent review: passed; no security concerns or logic errors for the `ChatComposerInput` / command-surface polish burst.
- Reviewer also ran `git diff --cached --check`; a project-wide `tsc --noEmit` still has unrelated pre-existing errors, with no new staged error attributed to this change.

## Git state notes

The implementation work has been committed locally in small controlled bursts:
- `939cf61 feat: add Codex-inspired chat mini window polish`
- `dd07bc5 refactor: extract chat composer controls`
- `f7d5ea5 docs: update Codex-inspired implementation handoff`
- `ecf9b7f refactor: extract chat composer menus`
- `7e895e6 docs: note chat composer menu extraction`
- `656fafb refactor: extract chat insert menu`
- `e88b6f5 docs: note chat insert menu extraction`
- `0141c91 refactor: extract chat composer shell`
- `5135c2b docs: note chat composer shell extraction`
- `5dd605c refactor: extract chat composer attachments`
- `ffb1280 docs: note chat composer attachment extraction`
- `56784a0 refactor: extract chat composer voice status`
- `e661874 docs: note chat composer voice status extraction`
- `2bb022a refactor: extract chat composer autocomplete`
- `38b475b docs: note chat composer autocomplete extraction`
- `2fa4048 refactor: extract chat surface host`
- `df14ceb docs: note chat surface host extraction`
- `00b9296 refactor: extract chat project path control`
- `72d0a93 docs: note chat project path extraction`
- `4fe26f3 refactor: extract chat context usage dial`
- `b9c979f docs: note chat context dial extraction`
- `664daf1 refactor: extract chat location menu`
- `0dd504c docs: note chat location menu extraction`
- `967ec93 refactor: extract chat branch menu`
- `7813a8f docs: note chat branch menu extraction`
- `70908ff refactor: extract chat mode menu`
- `1931256 docs: note chat mode menu extraction`
- `1892ce5 refactor: extract chat composer drawer frame`
- `b8530d9 docs: note chat drawer polish`
- `3362bdc refactor: extract chat composer input`
- `docs: note chat composer input extraction`

Upstream check:
- Ran `git fetch origin` after the mini-window/sidebar commit.
- Current branch is `main` and was observed as ahead of `origin/main` with no behind marker.
- No push was performed.

Outstanding unrelated local files still present in the working tree:
- `.codesurf/DREAMING.md` — modified before this pass; review separately before committing.
- `.mcp.json` — local environment/config change; review separately before committing.
- `bundled-extensions/livekit-rooms/tiles/index.html` — pre-existing/external local change; left unstaged.
- `bundled-extensions/livekit-rooms/tiles/room/index.html` — pre-existing/external local change; left unstaged.
- `examples/extensions/livekit-rooms/tiles/index.html` — pre-existing/external local change; left unstaged.
- `examples/extensions/livekit-rooms/tiles/room/index.html` — pre-existing/external local change; left unstaged.
- `.tmp/` — untracked local temp directory; left unstaged.

## Recommended next burst

1. Live dogfood the extracted attachment/shell/menu/voice/autocomplete/chat-surface host/project-path/context-dial/location-menu/branch-menu/mode-menu/drawer/input path in the running app: type `/`, type `@`, use arrow keys/Enter/Escape, click autocomplete rows, attach/remove files, open the `+` menu, toggle MCP, open a chat surface, switch/close surface tabs, verify `Enhance → Builder`, switch project folder from the footer path button, open the context dial popup, switch local/cloud/remote execution target from the location menu, use provider/model/thinking/branch/mode menus, trigger dictation/TTS banners, expand/collapse queued messages and latest-change drawers, type/select/scroll in the prompt input, and send/stop a message.
2. Treat the Codex-inspired chat/composer extraction phase as closed unless dogfood reveals a regression; next user-visible product work should move to the Git Review extension/diff virtualization pass from the reference report.
3. Add a deliberate "open historical/external session into chat, then pop out" flow only if the sidebar mini action should work for sessions with no `tileId`.
4. Continue deeper plugins/skills-library UX as a separate feature burst after Git Review, not mixed into the composer cleanup.
