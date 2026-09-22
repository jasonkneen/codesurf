# Refactoring & God-Files

This dimension audits structural maintainability: oversized files and functions, deep
single-component nesting, and multiple responsibilities fused into one unit that should be
several. It is distinct from the duplication dimension ([06](./06-duplication.md), copy-paste)
and the separation dimension ([07](./07-separation.md), package boundaries) — here the unit of
concern is the *file/component itself* and the concrete decomposition map that makes it
maintainable. The dominant theme is **a handful of mega-units that everything routes
through**: two ~7k/6.8k-LOC single React components (`App.tsx`, `ChatTile.tsx`) and a 4.2k-LOC
IPC module (`chat.ts`) that fuse framework IO, several streaming state machines, and dozens of
unrelated handlers behind one closure. The aggravating factor — called out in the project's
own `CLAUDE.md` ("heavy use of `useRef`… without stale closure issues") — is that these
components thread **mutable refs and mirror-state across every handler**, so the cohesive
regions can't be lifted out cleanly: that ref coupling is what turns most of these splits from
M into L. The good news is that the worst offenders already extract their *leaf* concerns
(both renderer god-files have a healthy module-scope layer of `React.memo` subcomponents); the
debt is concentrated in their giant inner bodies. Where a slice was already claimed by the
separation or duplication sections, this section owns the whole-file decomposition map and
cross-links the slice rather than re-deriving it.

## Findings

| ID | Title | Severity | Effort | Files |
| --- | --- | --- | --- | --- |
| refactor-01 | `App.tsx` is the entire canvas engine in one 7.3k-LOC / 264-hook component | High | L | `src/renderer/src/App.tsx` |
| refactor-02 | `ChatTile.tsx` inner component is a 4.9k-LOC streaming machine with a 62-`useState` blob | High | L | `src/renderer/src/components/ChatTile.tsx` |
| refactor-03 | `chat.ts` fuses five provider stream-runners + queues + daemon client in one IPC module | High | M | `src/main/ipc/chat.ts` |
| refactor-04 | `SettingsPanel.tsx` is one component with a ten-case `renderSection` switch, each case a full page | Medium | M | `src/renderer/src/components/SettingsPanel.tsx` |
| refactor-05 | `mcp-server.ts` routes 17 tools through one 550-LOC `handleTool` if/else dispatcher | Medium | M | `src/main/mcp-server.ts` |
| refactor-06 | `codesurfd.mjs` is a 62-branch sequential HTTP router with an inline HTML dashboard | Medium | M | `packages/codesurf-daemon/bin/codesurfd.mjs` |
| refactor-07 | `theme.ts` is large but cohesive — preset data plus one pure transform | Low | S | `src/renderer/src/theme.ts` |
| refactor-08 | `BrowserTile.tsx` fuses an Electrobun webview shim with the tile UI in one component | Low | M | `src/renderer/src/components/BrowserTile.tsx` |
| refactor-09 | `Sidebar.tsx` / `TileChrome.tsx` — long but already well-decomposed; residual main-component bulk | Low | M | `src/renderer/src/components/Sidebar.tsx`, `src/renderer/src/components/TileChrome.tsx` |

---

### refactor-01 — `App.tsx` is the entire canvas engine in one 7.3k-LOC / 264-hook component

**Severity:** high · **Effort:** L · **Category:** god-component / single-responsibility

**Problem.** `function App()` spans `src/renderer/src/App.tsx:1033-7287` — a single React
component holding the whole 2D canvas engine: viewport pan/zoom, tile drag/resize, group
movement, undo/redo, discovery-connection geometry, panel layout, workspace tabs, the tile-body
renderer, and a ~2000-line JSX tree. It contains **264** hook calls (44 `useState`, 55
`useRef`, 51 `useEffect`, plus ~81 inner `useCallback`/handlers). Every interaction — even a
pure pan that touches only `viewport.tx/ty` — re-runs this entire function body. This is the
component everything routes through; onboarding, change-risk, and review cost are all maximal
here. The project's own `CLAUDE.md` still describes `App.tsx` as "~1700 LOC" — the doc
under-describes the file by **4x**, which is itself an onboarding hazard.

**Evidence.**

- `src/renderer/src/App.tsx:1033` — `function App(): JSX.Element {`; the component body runs to
  the file end at `7287`.
- Hook density inside the component: 264 hook-call matches; `44` `const [x, setX]` `useState`
  pairs; `55` `useRef`s; `51` `useEffect`s.
- Cohesive regions that are physically interleaved inside the one body:
  - **Undo/redo** — history stacks declared at `App.tsx:1341` ("each entry is a full canvas
    snapshot"), snapshot-push guard at `1964`, the undo/redo region header at `3942`.
  - **Viewport / pan-zoom / wheel** — `handleCanvasMouseDown` (`2500`), the `onWheel` listener
    registered/torn-down every viewport change (`2977-2990`).
  - **Tile interaction** — `handleTileMouseDown` (`2651`), `handleResizeMouseDown` (`2711`).
  - **Discovery geometry** — ~30 module-scope helpers (`552-990`) plus `findDiscoveryMatch`
    consumers; see cross-link below.
  - **Tile-body renderer** — `renderTileBody` (`4045`), an inline closure redefined every
    render that `switch`es over every tile type and is invoked at `6242`, `6652`, `7153`.
  - **JSX tree** — the component's `return (` at `5279` runs ~2000 lines to `7287`.
- The coupling that makes extraction L: 55 `useRef`s are threaded across these handlers as
  shared mutable state — e.g. `panVelocityRef` (`1042`), `persistCanvasStateRef` (`1070`),
  `panelLayoutRef`/`activePanelIdRef`/`expandedTileIdRef` (`1072-1074`),
  `pasteTilesRef` (`1333`). Several are forward-declared placeholder refs
  (`useRef(() => {})`) populated later, a pattern that resists clean hook boundaries.

**Recommendation.** This is a multi-step decomposition, not a single move. Lift the cohesive
regions into custom hooks and child components, each owning its slice of state/refs:

1. `useUndoRedo(canvasState)` — the history stacks (`1341`), push guard (`1964`), and undo/redo
   handlers (`3942+`). Self-contained; the main coupling is the "don't push during
   undo/redo" flag, which becomes hook-internal. ~250 LOC moved.
2. `useViewport()` — pan/zoom/wheel state plus `handleCanvasMouseDown` (`2500`) and the
   `onWheel` registration (`2977`). Returns `viewport` + handlers; `panVelocityRef` becomes
   hook-internal. ~300 LOC moved.
3. `useTileInteraction()` — `handleTileMouseDown` (`2651`), `handleResizeMouseDown` (`2711`),
   and group-move recursion. The hardest split: it reads/writes the shared `dragState` refs and
   the tiles array, so it must take setters + a `tilesRef` as params. ~400 LOC moved.
4. `usePanelLayout()` — the workspace-tab + panel-tree state (`panelLayoutRef`,
   `activePanelIdRef`, `savedLayoutRef`, the `sanitizePanelLayout`/`replaceLeafInPanelTree`
   module helpers already at `131-173`). ~250 LOC moved.
5. Extract `renderTileBody` (`4045`) into a real `<TileBody type=… />` component file with the
   `switch` inside it, threading its closure deps (`workspace`, `settings`, `appFonts`,
   `negotiatedDiscoveryState`, and the tile callbacks) as props. This is the prerequisite for
   the perf-01 memoized-canvas work and removes the largest inline closure. ~600 LOC moved.

Order matters: do `useUndoRedo` and `usePanelLayout` first (lowest ref coupling), then
`useViewport`, then `useTileInteraction` last (highest coupling). Effort is **L** entirely
because of the ref-threading; the regions themselves are cohesive.

**See also:** The **discovery geometry helpers** embedded at `App.tsx:552-990` are owned by
cluster **C1** — [06-duplication.md → dup-02](./06-duplication.md) and
[07-separation.md → soc-01](./07-separation.md) own the "import the worker impl, delete the
inline copy" map (and the safe-to-delete dead `findDiscoveryConnections` at `630`). The
**memoized `<CanvasTile>`** that the `renderTileBody` extraction unblocks is owned by
[03-performance.md → perf-01](./03-performance.md) — do not re-propose it here. This finding
owns the rest of the whole-component decomposition.

---

### refactor-02 — `ChatTile.tsx` inner component is a 4.9k-LOC streaming machine with a 62-`useState` blob

**Severity:** high · **Effort:** L · **Category:** god-component / state-machine

**Problem.** `ChatTile.tsx` is ~6800 LOC, but its module-scope layer is actually healthy — it
already extracts ~20 leaf concerns as standalone functions and `React.memo` subcomponents
(`InsightBlock` `1184`, `ChatMessageContent` `1565`, `LargeTextBlock` `1235`, the diff blocks,
the markdown guards). The god-file is the **inner component**: `export function ChatTile(…)`
spans `1862-6799` (~4900 LOC) and carries the entire chat runtime — message list, the streaming
state machine, the send pipeline, queued turns, chat "surfaces"/tabs, provider/model selection,
permission prompts, and history pagination — as one flat hook soup. It holds **62** `useState`
declarations and 42 `useRef`s, several of which are *mirror refs* that shadow state to escape
stale closures (`isStreamingRef` `2267`, `openChatSurfacesRef` `2213`,
`pendingStreamTextRef` `2283`). That state blob is the core maintainability problem: any change
to streaming risks the surfaces logic and vice-versa.

**Evidence.**

- `src/renderer/src/components/ChatTile.tsx:1862` — the component opens; its body runs to
  `6799`. The component's main `return (` is at `5154`.
- `62` `const [x, setX] = useState` pairs and `42` `useRef`s inside the one component.
- Distinct, separable state machines tangled in the same body:
  - **Messages + streaming** — `messages` (`1947`), the flush refs `pendingStreamTextRef`
    (`2283`) / `pendingStreamFlushTimerRef` (`2284`) / `isStreamingRef` (`2267`).
  - **Send pipeline** — `sendMessage = useCallback(async …)` at `4783` (the single largest
    inner callback), plus `buildOutgoingMessageContent`/`buildRecentEditContext` helpers
    already at module scope (`442`, `569`).
  - **Chat surfaces / tabs** — `openChatSurfaces` (`2210`), `activeChatSurfaceId` (`2211`),
    `chatSurfaceMenu` (`2212`), mirror refs `openChatSurfacesRef` (`2213`) /
    `activeChatSurfaceRef` (`2219`) / `pendingChatSurfaceActionResultsRef` (`2222`).
  - **Queued turns** — `queuedTurns` (`2249`), `prevQueuedCountRef` (`2260`).
  - **Provider/model** — `provider` (`1975`), `model` (`1976`), `modelFilter` (`2204`),
    `thinking` (`2162`).
  - **History pagination** — `pendingHistoryPrependRef` (`2193`),
    `loadEarlierMessagesRef` (`2194`), `pagedLinkedHistoryEnabledRef` (`2265`).

**Recommendation.** Two coordinated moves:

1. **Collapse the state blob with `useReducer` + extracted hooks.** The 62 `useState`s are not
   62 independent atoms — they cluster into the five machines above. Extract
   `useChatStream()` (messages + the flush/streaming refs + the stream event reducer),
   `useChatSurfaces()` (the surfaces/tabs state + its mirror refs + the pending-action-result
   map), and `useQueuedTurns()`. Each hook owns its mirror refs internally, which is the whole
   point — the refs exist *only* because the state is read inside long-lived callbacks; moving
   state+ref+effect into one hook removes the shadow-ref hazard at its source.
2. **Lift the send/stream machine out of the render component.** `sendMessage` (`4783`) and the
   stream-event handling are pure-ish data flow that should live in `useChatStream`'s reducer +
   a thin `submit()` action, not as an inline `useCallback` closing over 30+ values.

The coupling that makes this **L** (not M) is identical to refactor-01: the mirror refs are
load-bearing precisely because the current code can't observe fresh state inside its callbacks.
The reducer extraction is what dissolves that — but it must be done per-machine, carefully, or
streaming regressions are likely.

**See also:** Streaming markdown re-parse cost is owned by
[03-performance.md → perf-07](./03-performance.md). The dead `InlineJSXPreviewBlock` /
`splitRenderableMessageSegments` / `JSXPreview` block (~250 LOC at `848-1070` / `773` / `1585`)
is owned by [06-duplication.md → dup-04](./06-duplication.md) — deleting it is the cheapest
single LOC reduction here, but that section owns the call. This finding owns the inner-component
decomposition.

---

### refactor-03 — `chat.ts` fuses five provider stream-runners + queues + daemon client in one IPC module

**Severity:** high · **Effort:** M · **Category:** god-module / multiple-responsibilities

**Problem.** `src/main/ipc/chat.ts` (4174 LOC) is the main-process chat hub, and it fuses at
least six distinct responsibilities into one file that imports `electron`, the Claude Agent SDK,
`child_process`, `http`, and `fs`: (a) five complete per-provider streaming runners, (b) two
pending-answer queue subsystems (tool permission + ask-user-question), (c) a hand-rolled daemon
HTTP client, (d) checkpoint helpers, (e) session-id persistence, and (f) the 13 `ipcMain.handle`
registrations. Each provider runner is a self-contained NDJSON/stream state machine, so the file
is really five state machines stacked in one module. This blocks unit testing (the whole module
pulls in Electron) and makes any provider change a 4k-LOC-file diff.

**Evidence.**

- The five provider runners, each a large stream-parser, all top-level in one file:
  `chatClaude` (`chat.ts:1824`, ~445 LOC to `2270`), `chatCodex` (`2604`), `chatOpencode`
  (`2881`, ~440 LOC to `3322`), `chatOpenclaw` (`3322`), `chatHermes` (`3473`).
- **Permission + ask-user queues** (`494-664`): `awaitToolPermissionAnswer` (`593`),
  `resolvePendingToolPermission` (`619`), `cancelPendingToolPermissionsForCard` (`632`), and the
  parallel ask-user-question set (`531`/`554`/`567`). Pure promise-registry logic with no
  Electron dependency.
- **Daemon HTTP client** (`709-1481`): `bufferHttpResponse` (`709`), `hostRequest` (`746`),
  `attachDaemonJobStream` (`1341`), `sendChatToDaemon` (`1399`), `resumeChatDaemonJob` (`1438`),
  `cancelChatDaemonJob` (`1468`).
- **Checkpoint helpers** (`328-425`): `buildCheckpointLabel` (`328`),
  `extractAnthropicCheckpointPaths` (`334`), `createRuntimeCheckpoint` (`367`),
  `allowToolWithCheckpoint` (`408`).
- **IPC surface**: 13 `ipcMain.handle` registrations from `chat:send` (`3664`) through
  `chat:opencodeModels` (`4161`).

**Recommendation.** Split by responsibility into `src/main/chat/`:

1. `providers/claude.ts`, `providers/codex.ts`, `providers/opencode.ts`,
   `providers/openclaw.ts`, `providers/hermes.ts` — one runner each. They share a small set of
   helpers (`sendStream` `160`, `sanitizeToolOutputText` `665`, the stream tool-name builders at
   `2286-2305`) which move to `providers/stream-shared.ts`. This is the bulk of the LOC and the
   highest-value split: each runner becomes independently readable and the file stops being a
   merge-conflict magnet.
2. `chat/pending-answers.ts` — the two promise-registry queues (`494-664`). These are pure and
   directly unit-testable once out of the Electron module.
3. `chat/daemon-client.ts` — the HTTP client block (`709-1481`).
4. `chat/checkpoints.ts` — the runtime-checkpoint helpers (`328-425`).
5. `chat.ts` shrinks to the `ipcMain.handle` wiring + dispatch to the provider modules.

Effort is **M** (not L like the renderer god-files) because these regions are already
function-bounded and pass data by argument rather than through shared component refs — the
coupling is mostly a shared `activeQueries`/`sendStream` surface that becomes an explicit module
import.

**See also:** The **prompt-convention block** (`819-1086`) is owned by cluster **C6** —
[07-separation.md → soc-02](./07-separation.md) owns extracting `prompt-conventions.ts` for
testability; do not re-propose that module here. The **daemon-side job lifecycle** these runners
drive (resume wedge, cancel, fan-out) is owned by [08-daemon.md](./08-daemon.md). The
hardcoded `OPEN_CODE_FALLBACK_MODELS` list (`1706`) is owned by
[06-duplication.md → dup-05](./06-duplication.md). This finding owns the provider-runner /
queue / client decomposition.

---

### refactor-04 — `SettingsPanel.tsx` is one component with a ten-case `renderSection` switch, each case a full page

**Severity:** medium · **Effort:** M · **Category:** god-component / mechanical-split

**Problem.** `SettingsPanel.tsx` (2305 LOC) is a single `export function SettingsPanel`
(`154-2305`) whose body is dominated by one `renderSection` `switch` where each `case` inlines a
complete settings page of 100–600 LOC. Adding or editing one settings area means scrolling past
nine unrelated ones and editing a 2.3k-LOC file. Unlike the renderer god-components above, this
one has **near-zero cross-case coupling** — each case reads/writes its own slice of the
`settings` object and shares only the top-level `settings`/`onSettingsChange` props. That makes
it this section's cleanest, fully-owned win: a mechanical extraction with no ref-threading risk.

**Evidence.**

- `src/renderer/src/components/SettingsPanel.tsx:154` — the single component; the section
  `switch` cases are inline:
  - `case 'general'` (`633`), `case 'daemon'` (`741`), `case 'canvas'` (`1115`),
    `case 'permissions'` (`1156`), `case 'providers'` (`1267`), `case 'voice'` (`1572`),
    `case 'browser'` (`1583`), `case 'tools'`/`case 'mcp'` (`1620-1621`),
    `case 'extensions'` (`1887`), then lazy-mounted `prompts`/`skills`/`agents` (`2134-2148`).
- The `providers` (`1267-1572`, ~300 LOC), `mcp` (`1621-1887`, ~265 LOC), and
  `extensions` (`1887-2134`, ~245 LOC) cases are each larger than many whole tile components.
- The pattern already exists for the right answer: `prompts`/`skills`/`agents`/`tools` are
  already `lazy()`-imported subsections from `CustomisationTile` (`13-16`) — the inline cases
  simply never got the same treatment.

**Recommendation.** Extract each `case` body into its own `<GeneralSection>`,
`<DaemonSection>`, `<ProvidersSection>`, `<McpSection>`, `<ExtensionsSection>`, etc.,
co-located under `components/settings/`, each receiving `{ settings, onSettingsChange,
workspacePath }`. `SettingsPanel` keeps only the chrome (nav rail, section routing) and renders
the active section. Follow the existing `lazy()` pattern for the heavy ones so the settings
panel also stops eagerly bundling every section. Because the cases don't share mutable state,
this is a low-risk **M** — the only real work is volume and verifying each case's prop closure.
No sibling section owns this file; it is fully in this section's lane.

---

### refactor-05 — `mcp-server.ts` routes 17 tools through one 550-LOC `handleTool` if/else dispatcher

**Severity:** medium · **Effort:** M · **Category:** god-function / dispatcher

**Problem.** `src/main/mcp-server.ts` (2165 LOC) mixes the HTTP server, the tool catalog, the
kanban/canvas read helpers, and one giant tool-dispatch function. `handleTool` (`1142-1692`,
~550 LOC) is a single `async function` that `if`/`switch`es over every MCP tool name and inlines
each tool's full implementation. Adding a tool means growing this one function; the tool logic,
argument coercion, and event-bus side effects are all fused at one indentation level. It is the
hardest part of the file to read and test in isolation.

**Evidence.**

- `src/main/mcp-server.ts:1142` — `async function handleTool(name, args)`; runs to `1692`.
- The catalog is already declarative and separate — `getAllTools` (`252`) builds the tool list,
  `getExtensionTools` (`248`) merges extension-contributed tools — so the *schema* layer is
  clean; only the *execution* layer is monolithic.
- Image-edit tools were already partly lifted: `executeImageEditTool` (`1013`) and
  `runGeminiImageEdit` (`954`) live outside `handleTool`, proving the extraction pattern works
  and just wasn't applied to the other 15 tools.
- Side-effecting helpers `handleTool` calls inline: `pushSSE` (`917`),
  `publishPeerCommand` (`943`), `setTileContextFromMcp` (`144`).

**Recommendation.** Convert `handleTool` from a 550-LOC if/else into a **handler map**: a
`Record<toolName, (args, ctx) => Promise<string>>` where each entry is a small exported function
grouped by domain — `tools/canvas.ts`, `tools/kanban.ts`, `tools/peer.ts`, `tools/image.ts`
(the image handlers already exist and just get registered). `handleTool` becomes a 10-line
lookup + dispatch. The `ctx` object carries the shared side-effect helpers (`pushSSE`,
`publishPeerCommand`, `setTileContextFromMcp`) so handlers stay testable. This mirrors the
already-declarative catalog layer and removes the file's single worst function.

**See also:** The MCP server's **missing auth** on `POST /inject` and the world-readable token
file are owned by [10-holes.md → risk-02 / risk-03](./10-holes.md) — that is a security
concern, not a structural one; do **not** fold auth into the dispatcher refactor. This finding
covers only the `handleTool` decomposition.

---

### refactor-06 — `codesurfd.mjs` is a 62-branch sequential HTTP router with an inline HTML dashboard

**Severity:** medium · **Effort:** M · **Category:** god-module / inline-template

**Problem.** `packages/codesurf-daemon/bin/codesurfd.mjs` (3868 LOC) is the daemon entry point,
and structurally it has two god-shapes. First, its HTTP layer is one `createServer` callback
(`2809-3786`) containing **~62 sequential** `if (method === … && url.pathname === …)` branches —
a linear scan with no routing table, where adding an endpoint means inserting another `if` into a
1000-line function. Second, `renderDashboardHtml` (`1080-~1530`) is a ~450-LOC template literal
embedding the dashboard's full HTML, CSS (`<style>` `1089-1327`), and client JS
(`<script>` `1365-1513`) inline in the daemon source. Both make the file hard to navigate and
impossible to lint/format the embedded assets.

**Evidence.**

- `packages/codesurf-daemon/bin/codesurfd.mjs:2809` — `const server = createServer(async (req,
  res) => {`; the handler body holds the full route ladder.
- Representative consecutive branches: `/dashboard` (`2819`), `/dashboard/api/jobs` (`2824`),
  `/dashboard/api/job` (`2839`), `/agent-kanban/board` (`2865`), `/health` (`2892`),
  `/permissions/grant` (`2908`), `/checkpoint/create` (`2997`), `/dreaming/run` (`3075`),
  `/skills/list` (`3111`) — ~62 such `if` blocks in one function.
- `renderDashboardHtml` (`1080`) returns a template literal: inline `<style>` (`1089-1327`),
  inline `<script>` (`1365-1513`).

**Recommendation.** Structural-only changes (defer all job/lifecycle behavior to 08-daemon):

1. Replace the `if`-ladder with a small dispatch table keyed by `` `${method} ${pathname}` `` (or
   a tiny matcher for the `startsWith` cases like `/permissions/:id` at `2942`). Each route's
   body moves to a named `handleX(req, res, ctx)` function; the `createServer` callback becomes a
   lookup + 404 fallback. This makes the route surface greppable and shrinks the mega-callback.
2. Move `renderDashboardHtml`'s embedded HTML/CSS/JS to a sibling asset file (e.g.
   `dashboard.html` + `dashboard.css` + `dashboard.client.js`) read at startup, so the dashboard
   front-end is editable/lintable separately from the daemon logic.

**See also:** [08-daemon.md](./08-daemon.md) owns everything about what these routes *do* — job
fan-out, shutdown orphaning, the SSE resume wedge, artifact growth. This finding covers **only**
the file's structural shape (the router ladder and the inline dashboard template), not the
lifecycle behavior. The duplicated FS/JSON helpers at the top of this file
(`ensureDir` `48`, `atomicWriteJson` `60`, etc.) are owned by
[06-duplication.md → dup-03](./06-duplication.md).

---

### refactor-07 — `theme.ts` is large but cohesive — preset data plus one pure transform

**Severity:** low · **Effort:** S · **Category:** large-but-cohesive

**Problem.** `theme.ts` is 3047 LOC, which flags it as a god-file by size, but the honest read
is that ~2400 of those lines are **cohesive preset data**, not tangled logic. The `THEMES`
record (`547-~2900`) is 13 `defineTheme({…})` declarations — flat, declarative color tables with
near-zero branching. The only real *logic* is `applyContrast` (`177-399`, a ~220-LOC pure
transform) and `defineTheme` (`399-509`). Change-risk is therefore low despite the LOC: editing
one theme can't break another, and the math is isolated. This is a low-severity finding
precisely because LOC overstates the maintainability cost here.

**Evidence.**

- `src/renderer/src/theme.ts:547` — `const THEMES: Record<string, AppTheme> = {`; `13`
  `defineTheme(` calls spanning to ~`2900` (e.g. `forest-dark` at `2546`).
- The logic surface is small and pure: `applyContrast` (`177`), `defineTheme` (`399`),
  `hexToRgb` (`509`), `normalizePanelSurfaceTheme` (`517`); the rest is registry plumbing
  (`registerCustomTheme` `3011`, `getThemeById` `3035`).

**Recommendation.** Keep it low-priority. The mechanical win is to move the `THEMES` data into a
`theme-presets.ts` data module and lift `applyContrast` into `theme-contrast.ts`, leaving
`theme.ts` as the registry/API — which shrinks the apparent god-file to its actual logic without
risk. But the **exact module split (`theme-contrast.ts` + `theme-presets.ts`) and the
`colorMath` testability gap are already specified by
[07-separation.md → soc-06](./07-separation.md)** — defer the module names and the test
recommendation there. This section's only addition: the dominant mass is *data*, so the size
does not justify more than a low-severity, S-effort cosmetic split.

---

### refactor-08 — `BrowserTile.tsx` fuses an Electrobun webview shim with the tile UI in one component

**Severity:** low · **Effort:** M · **Category:** mixed-concerns

**Problem.** `BrowserTile.tsx` (2137 LOC) carries two unrelated responsibilities in one file:
(a) a sizable Electrobun-webview compatibility shim that monkey-patches a `<webview>` element to
emulate the Electron `WebContentsView` API (`loadURL`, `canGoBack`, `executeJavaScript`,
`insertCSS`, devtools, partition wiring), and (b) the `BrowserTile` component itself — the
toolbar, navigation state, and peer integration. The shim is imperative DOM/runtime-detail code;
the component is React UI. They have no reason to share a file.

**Evidence.**

- `src/renderer/src/components/BrowserTile.tsx:176-281` — the webview shim: it overrides
  `webview.loadURL` (`240`), `getURL` (`246`), `isLoading` (`250`), `openDevTools` (`256`),
  `insertCSS` (`257`), `executeJavaScript` (`261`), and sets the per-tile partition (`281`).
- `export function BrowserTile(…)` begins at `841`; `ToolbarButton` is already a separate
  module-scope component (`738`), showing the file's leaf UI is partly factored already.
- 71 hook calls in the file, concentrated in the main component.

**Recommendation.** Move the webview-shim block (`176-281`) into a framework-free helper module
`browser/electrobun-webview.ts` exporting a single `adaptElectrobunWebview(el, { tileId, src })`
function. `BrowserTile.tsx` imports it and keeps only the React UI + navigation state. This is a
clean concern-split (imperative runtime adapter vs. declarative component) with modest coupling —
the shim closes over a few local callbacks that become explicit parameters. Low severity because
the file is not on a hot change path, but the split materially improves readability of both
halves.

---

### refactor-09 — `Sidebar.tsx` / `TileChrome.tsx` — long but already well-decomposed; residual main-component bulk

**Severity:** low · **Effort:** M · **Category:** large-but-structured

**Problem.** Both files exceed 1.6k LOC and so register as god-files by size, but both have
**good internal structure already** — the bulk of their leaf concerns are extracted as
module-scope subcomponents. The residual debt is only the long main component plus, for
`TileChrome`, a cluster of drawer panels that could move to their own directory. Calling these
out honestly: they are low severity and partial wins, not the high-leverage targets above.

**Evidence.**

- `Sidebar.tsx` (2598 LOC) already extracts `SessionSidebarIndicator` (`133`),
  `SessionSidebarRow` (`198`), `SidebarTextDialog` (`416`), `SidebarSearchPalette` (`634`),
  `SidebarTopItem` (`776`) at module scope; the residual is the main
  `export function Sidebar` (`836-2598`, ~1760 LOC, 99 hook calls).
- `TileChrome.tsx` (1696 LOC) already extracts its drawer panels as separate components —
  `TasksPanel` (`297`), `ToolsPanel` (`478`), `SkillsPanel` (`560`), `ContextPanel` (`635`),
  `MessagePanel` (`699`), and the `DrawerPanel` shell (`746`); the main
  `export function TileChrome` starts at `1010`.

**Recommendation.** Lower priority than refactor-01..06. For `TileChrome`, relocate the
already-separated panels (`TasksPanel`/`ToolsPanel`/`SkillsPanel`/`ContextPanel`/`MessagePanel`)
into a `components/chrome/` directory and import them — pure file-organization, near-zero risk,
shrinks the file's apparent size without behavior change. For `Sidebar`, the main component's
session-list state and search/palette logic are the only further extraction candidates
(`useSidebarSessions`), but that overlaps the perf work
([03-performance.md → perf-05 / perf-06](./03-performance.md), which owns the broadcast and
virtualization angle) — coordinate rather than duplicate. Note `TileChrome` is also the
unmemoized component on the canvas pan hot path, but that memoization is owned by
[03-performance.md → perf-01](./03-performance.md).

---

## Quick wins

- **refactor-04 (M, but mechanical):** Extract the `SettingsPanel` `renderSection` cases into
  one `<XSection>` component each under `components/settings/`. Near-zero cross-case coupling
  makes this the lowest-risk decomposition in this section despite the volume.
- **refactor-01 step (S within L):** Lift `useUndoRedo` out of `App.tsx` first — the undo/redo
  region (`1341`/`1964`/`3942+`) has the least ref coupling of the App regions and is a safe,
  self-contained first cut that immediately shrinks the god-component.
- **refactor-03 partial (S within M):** Move the two pending-answer queues (`chat.ts:494-664`)
  into `chat/pending-answers.ts` — they are pure promise registries with no Electron dependency,
  so the move is risk-free and makes them unit-testable immediately.
- **refactor-06 dashboard (S):** Pull `renderDashboardHtml`'s inline HTML/CSS/JS
  (`codesurfd.mjs:1080-1530`) out to sibling asset files read at startup — a self-contained edit
  that makes the dashboard front-end lintable and removes ~450 LOC from the daemon source.
- **refactor-07 (S):** Split `theme.ts` preset data into `theme-presets.ts` (per the module
  names already specified in [07-separation.md → soc-06](./07-separation.md)) — cosmetic, since
  the mass is cohesive data.
