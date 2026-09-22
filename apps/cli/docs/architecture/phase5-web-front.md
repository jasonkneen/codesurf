# Phase 5 — Web Front (same components, DOM output)

**Status:** **P0–P3 complete.** Two parity scenes render in both hosts with every
non-border cell matching (§10); the markdown renderer is real (§11); the keyboard, viewport
and scrollbox hooks are real (§12); the composer is a real DOM `<textarea>` behind a
`TextareaRenderable` facade (§13); a curated live front at `?node=ws://host:port` drives
turns on a `codesurf node` without mounting the full TUI App (§14). **P4 HTTP `/files`
and `HostFiles` landed;** editor-open / async exists() remain.
**Date:** 2026-09-09 (P0 exit, markdown, input/scroll 2026-09-13, composer 2026-09-17)
**Depends on:** Phase 3 (hub + WS transport), mode-2 session streaming (`d743584`, `b5b8d96`)
**Goal:** build the CodeSurf TUI for the browser, reusing the existing React components
unchanged, rendering to DOM instead of a terminal.

---

## 1. Question

> Can we build this TUI for web so it uses the SAME components but renders as web components?

Yes. Not by running OpenTUI in a browser — by giving the existing component tree a second
host renderer. This document records the evidence, the options, the chosen path, and the
work.

---

## 2. Findings

### 2.1 OpenTUI itself cannot run in a browser

`@opentui/core@0.1.107` is a TypeScript layer over a **native Zig core**, loaded through
Bun FFI:

- runtime dep `bun-ffi-structs@0.1.2`
- optional platform deps `@opentui/core-{darwin,linux,win32}-{x64,arm64}@0.1.107`

There is no WASM or browser target. The upstream checkout at
`~/Documents/GitHub/opentui` has a `packages/web`, but it is the **Astro documentation
site**, not a renderer. Its `src/components/TuiSurface.astro` is a hand-written canvas
mock — hardcoded palette, fake syntax colours, a local `Renderer` class drawing
decorative cells. It renders no OpenTUI scene graph. No branch in that repo carries a
browser render target.

**Conclusion:** "same runtime, web output" is unavailable. "Same components, second host"
is the only real path.

### 2.2 The coupling surface is small

Measured across `src/ui` (105 `.tsx`, 106 `.ts`):

| Surface | Detail |
|---|---|
| Intrinsic tags | **7 total** — `box` 596, `text` 529, `span` 308, `b` 106, `scrollbox` 21, `markdown` 2, `u` 1 |
| `@opentui/react` imports | **4 symbols across 22 files** — `useTerminalDimensions` 11, `useRenderer` 4, `useKeyboard` 3, `flushSync` 2 |
| `@opentui/core` imports | ~17 symbols, **mostly types** — `TextareaRenderable` 24, `ScrollBoxRenderable` 15, `KeyEvent` 13, `PasteEvent` 5; value imports limited to `decodePasteBytes`, `parseKeypress`, `RGBA`, `SyntaxStyle`, `OptimizedBuffer`, `CliRenderer` |
| Node builtins in `src/ui` | 5 non-test leaf files — `markdown-links.ts`, `local-file-paths.ts`, `ai-output/image-viewer.tsx`, `ai-output/inline-image.tsx`, `layouts/*.tsx` |

That is the entire replacement contract. Everything else is plain React.

### 2.3 Layout semantics already match the web

OpenTUI lays out with `yoga-layout@3.2.1` — the same flexbox engine React Native uses.
`flexDirection`, `flexGrow`, `flexShrink`, `padding*`, `margin*`, `width`, `height`,
`alignItems`, `justifyContent` map 1:1 onto CSS flexbox. This is why the port is
tractable rather than a rewrite.

### 2.4 Widgets are already pure

Representative — `src/ui/ai-output/steps.tsx`:

```tsx
interface StepsProps {
  t: Theme
  steps: Step[]
  title?: string
  showProgress?: boolean
  expandedId?: string | null
  onToggle?: (id: string) => void
}
```

Theme in, data in, `box`/`text` out. No fs, no agent, no renderer handle. The
`ai-output/` widget family was deliberately written this way so `/showcase` could drive
it with fixtures.

### 2.5 What "the showcase" actually is

Two separate things were being conflated:

1. **`/showcase`** — `src/ui/ai-output/showcase.tsx` (354 lines). An in-TUI gallery of
   ~25 widgets driven by `makeExample*` fixture factories, backend-free. It has **never**
   had a web build; `git log --all -i --grep=showcase` shows no such work.
2. **`src/ui/ai-elements/*`** — TUI ports of Vercel AI Elements
   (`~/Documents/GitHub/ai-elements`). **This is the divergence.** Upstream ships 36
   components (`artifact`, `task`, `tool`, `plan`, `prompt-input`, `context`,
   `inline-citation`, `web-preview`, …). We ported 9 — `code-block`, `conversation`,
   `loader`, `message`, `reasoning`, `shimmer`, `sources`, `streaming-response`,
   `suggestion` — then wrote TUI-native widgets in `ai-output/` instead of tracking
   upstream. The fork is one-directional and has never been synced.

So there is no prior dual-render implementation. `/showcase` is the *harness* for one,
which is likely the memory.

---

## 3. Options considered

### A — DOM host shim

A second host for the same component tree. Vite aliases `@opentui/react` to a local shim
exposing an identical JSX runtime and hook set; `box` becomes a flex `div`, `text`/`span`
inline elements, `scrollbox` an `overflow:auto` div.

- Components change: **zero**
- Output: real DOM, selectable, themeable, responsive
- Cost: ~400–700 LOC of shim + the three hard parts in §6

### B — PTY + terminal emulator

Run the real TUI headless under a PTY, stream bytes over WS, render with
`ghostty-web`/xterm.js in the browser. Prior art in `~/Documents/GitHub/TUIXY`
(`ghostty-web` + `node-pty` + `ws` + an `opentui-host/`).

- Components change: **zero**
- Output: a canvas terminal — no DOM, no text selection, no CSS, no responsive layout
- Verdict: good for a remote-session demo, wrong for a web product

### C — A, wired to the mesh

Mode 2 already split the front plane from the engine: `SessionStreamServer`/`Client` over
an `op:"session"` WS channel (`src/relay/session-stream.ts`), `--connect ws://<node>`
driving turns remotely. A browser is simply another front. No new protocol is needed —
only a DOM renderer for the front.

**Chosen: C, built as A first.** Ship the renderer against fixtures, then attach it to a
node.

---

## 4. Architecture

```
                 src/ui/**  (unchanged React components)
                      |
        +-------------+--------------+
        |                            |
  @opentui/react              src/ui-web/opentui-dom
  (Zig core, FFI)             (JSX runtime + hooks -> DOM)
        |                            |
    terminal                      browser
        |                            |
        +----------- ws ------------+
                      |
          src/relay/session-stream.ts
                      |
              codesurf node (engine)
```

Selection is build-time. The terminal build is untouched; the web build swaps two module
specifiers.

### 4.1 Proposed layout

```
src/ui-web/
  opentui-dom/
    jsx-runtime.ts        # jsx/jsxs/Fragment -> DOM element factories
    jsx-dev-runtime.ts
    elements.tsx          # box, text, span, b, u, scrollbox, markdown
    props-to-style.ts     # yoga/opentui props -> CSS (the core mapping)
    cells.css             # cell grid: monospace, ch width, fixed line-height
    theme-to-vars.ts      # Theme -> CSS custom properties
    hooks/
      use-terminal-dimensions.ts   # ResizeObserver -> { width, height } in CELLS
      use-keyboard.ts              # DOM KeyboardEvent -> opentui KeyEvent
      use-renderer.ts              # renderer-handle stub / capability shims
      flush-sync.ts                # re-export react-dom flushSync
    core-shim/
      index.ts            # RGBA, SyntaxStyle, parseKeypress, decodePasteBytes
      textarea.ts         # TextareaRenderable-compatible DOM adapter
      scrollbox.ts        # ScrollBoxRenderable-compatible DOM adapter
  markdown/
    web-markdown.tsx      # streaming markdown -> DOM (replaces <markdown>)
  showcase/
    main.tsx              # mounts ShowcaseModal with fixtures
    index.html
vite.web.config.ts        # aliases + entry
```

### 4.2 The cell grid

The whole TUI reasons in character cells — `Math.min(Math.max(60, width - 4), width)`,
`marginTop={1}`, `border={["top"]}`. That arithmetic must keep working, so the browser
gets a real cell:

- horizontal unit: `1ch` under a monospace font with a known advance width
- vertical unit: a fixed `line-height` (one "row")
- `useTerminalDimensions()` returns `{ width, height }` in **cells**, derived from a
  `ResizeObserver` on the mount node divided by the measured cell size

Every existing width/height computation then holds without edits.

### 4.3 Prop mapping

`props-to-style.ts` is the load-bearing module:

| OpenTUI prop | CSS |
|---|---|
| `flexDirection`, `flexGrow`, `flexShrink`, `alignItems`, `justifyContent` | identical flexbox properties |
| `width` / `height` (number) | `calc(N * 1ch)` / `calc(N * var(--row))` |
| `padding*` / `margin*` (cells) | same conversion |
| `fg` / `bg` | `color` / `background-color` |
| `border={["top","left"]}` + `borderColor` | per-edge `border-*` using box-drawing-equivalent 1px rules, or a `::before` glyph strategy for exact parity |
| `wrapMode="none"` | `white-space: pre; overflow: hidden` |
| `<b>` / `<u>` | `font-weight` / `text-decoration` |

---

## 5. Phases

### P0 — Spike: `/showcase` in a browser (exit criterion for the whole idea)

Render `ShowcaseModal` in Chrome with **zero edits to any existing component**. It is the
ideal first target: ~25 widgets, pure fixture data, no agent, no fs, no WS.

- `jsx-runtime` + `elements` + `props-to-style` + `cells.css` + `theme-to-vars`
- `useTerminalDimensions` via `ResizeObserver`
- `useKeyboard` minimal (Esc, arrows, Enter)
- `<markdown>` stubbed to `<pre>`

**Exit:** side-by-side screenshots — terminal vs browser — of every showcase section, with
layout differences enumerated and either fixed or recorded.

### P1 — Renderer completeness

- full `props-to-style` incl. border edges and the box-drawing parity decision
- `scrollbox` adapter with a `ScrollBoxRenderable`-shaped ref
- `web-markdown.tsx` — streaming markdown with the same trailing-whitespace and
  incremental-tail semantics as `src/ui/markdown.tsx`
- `useKeyboard` full parity: DOM `KeyboardEvent` -> `KeyEvent` (`name`, `ctrl`, `meta`,
  `shift`, `sequence`), plus paste

### P2 — Composer — DONE (2026-09-17)

`TextareaRenderable` DOM adapter (24 call sites) — cursor, selection, multiline,
programmatic value, paste. Landed in `src/ui-web/opentui-dom/textarea.tsx` with
jsdom tests in `textarea.test.tsx` (19). See §13.

### P3 — Attach to the mesh — DONE (2026-09-17)

Curated live front, not the full TUI App (`Agent` / fs / telegram / `setImmediate`
paint loop stay on the node). `?node=ws://host:port` mounts `LiveApp`; optional
`?session=<id>` reattaches. Uses `SessionStreamClient` + `createRemoteSessionTurn`
(the same pair as mode-2 headless fronts). Transcript is a pure reducer over
`StreamChunk` (`src/ui-web/live/transcript.ts`).

**Exit:** `bun run web:live-smoke` boots an echo `EngineNode`, opens the live page in
headless Chrome, types, submits, and asserts `echo:hello` arrived. Protocol also
covered by `session-stream.test.ts`.

### P4 — Node-coupled leaves — HTTP FILES (2026-09-17)

`HostFiles` (`src/ui/host-files.ts`, aliased on web to `src/ui-web/host-files.ts`)
is the services boundary. Terminal: `file://` + `existsSync` + OS viewer. Web:
`http://node/files?path=` + `window.open`.

The node serves `GET /files?path=` on the same port as WS (`src/relay/file-server.ts`).
Paths must resolve under cwd or tmpdir; traversal is 403. CORS is `*`.

Vite aliases `inline-image.tsx` to `src/ui-web/inline-image.tsx` (`<img src=/files>`),
so the live front never loads `bun:ffi` / `sharp`.

---

## 6. Known hard parts

Named honestly up front:

1. **`<markdown>`** — OpenTUI's incremental tree-sitter markdown renderable has no DOM
   twin. Only 2 call sites, but it renders the entire transcript, including streaming
   partial code fences and tables. Needs a real web implementation, not a shim.
2. **`TextareaRenderable`** — imperative cursor/selection API behind a ref, 24 usages.
   Needs a DOM adapter presenting the same interface.
3. **Raw input paths** — `parseKeypress` / `decodePasteBytes` decode terminal byte
   sequences. Worse, per MEMORY: `React.preventDefault()` does not stop
   `prependInputHandler` / `stdin.on("data")`, so several surfaces listen to raw stdin
   directly. Those have no DOM analogue and must route through the shim explicitly.
   Audit every input surface separately.
4. **`OptimizedBuffer` / `renderBefore` / `renderAfter`** — direct draw hooks in
   `fps-overlay` and `inline-image`. Drop them on web or back them with a canvas overlay.
5. **Border fidelity** — the TUI draws box-drawing glyphs on the cell grid. CSS 1px
   borders sit *between* cells. Either accept the difference or render borders as glyph
   rows. Decide in P0, because it affects every panel.
6. **Perf** — MEMORY records that `streamContent` in the top-level `App` (311 hooks) plus
   per-token `setImmediate` commits are the real terminal redraw cost. The DOM host will
   inherit that shape; measure before optimising.

---

## 7. Ancillary finding: ai-elements divergence

Separate from the renderer work, and worth its own decision:

`src/ui/ai-elements/*` forked from Vercel AI Elements and never synced — 9 of 36
components ported, the rest replaced by TUI-native widgets under `ai-output/`. Once a DOM
host exists, the obvious question is whether the TUI ports should converge back onto the
upstream component set (shared props, two renderers) or stay a deliberate fork.

**Recommendation:** stay forked. The TUI widgets encode cell-grid layout decisions that
have no upstream equivalent, and the DOM host makes the fork renderable on web anyway —
which was the only real argument for converging.

---

## 8. Effort

| Phase | Scope | Rough size |
|---|---|---|
| P0 | spike, showcase renders | ~400–700 LOC, 1 day |
| P1 | renderer completeness + web markdown | 2–3 days |
| P2 | composer adapter | 2 days |
| P3 | mesh attach | 1 day (protocol already exists) |
| P4 | node-coupled leaves | 1 day |

No estimate is load-bearing until P0 lands. P0 is the honest go/no-go.

---

## 9. Open decisions

- [x] **Border strategy** — decided; see §10.2
- [x] **Bundler** — Vite, via `vite.web.config.mjs`. It does not replace the `tsc` build;
      the terminal build is untouched and the web build is a separate entry.
- [ ] Does the web front ship in this repo or as a separate package under `packages/`
- [x] **Surface** — P3 is a curated transcript + composer, not the full TUI App.
      `useTurnEngine` pulls Agent, telegram, approvals, and a `setImmediate` paint
      loop browsers do not have. The wire protocol is reused; the 311-hook App is not.

---

## 10. P0 exit — result (2026-09-13)

### 10.1 How it is measured

`bun run parity` renders each **scene module** — declared once in
`scripts/parity/scenes.mjs` — through both hosts and compares the results:

| | |
|---|---|
| `scripts/parity/capture-terminal.tsx` | real OpenTUI host (Zig core, yoga) → `.parity/<scene>.terminal.txt` |
| `scripts/parity/capture-browser.mjs` | headless Chrome over CDP → `.parity/<scene>.browser.txt` |
| `scripts/parity/compare.mjs` | cell-by-cell comparison |

Three choices matter here:

- **One scene, two hosts.** If each side had its own copy of the tree, a difference in the
  output would not say whether the renderers disagreed or the scenes did.
- **Character grids, not screenshots.** A TUI's truth is which glyph landed in which cell.
  `src/ui-web/parity/dom-grid.ts` projects the rendered DOM back onto a cell grid by
  measuring every glyph with a `Range` — per-glyph because a wrapped `<text>` is one node
  spanning several rows, and only per-glyph rects say where each row began. A pixel diff
  of a monospace layout would report font hinting.
- **Cell-wise, not `diff(1)`.** `diff` aligns whole lines, so a bordered panel whose every
  row starts with `│` reads as 13 deleted and 13 inserted lines even when every glyph
  inside is in the same cell. That is exactly what it did on the first run.

**Result: both scenes at 0 differing cells** — `widgets` 6,790 cells on a 97×70 grid (210
border cells reported separately per §10.2), `markdown` 2,800 cells on 70×40. Verified as a
real check, not a vacuous one: shifting a single row two cells right makes it report 79
differing cells and exit non-zero.

### 10.2 Border decision — reserve the cell, paint a rule

**A terminal border is made of characters, so it occupies a cell on every edge it draws.**
A CSS `border` sits *between* cells and occupies none. Using one would make every bordered
panel two columns wider and two rows taller on web than in the terminal, and every
`width - 2` in the component tree would quietly stop agreeing with what is drawn — which
is the premise the whole port rests on.

So `props-to-style.ts` **reserves the cell with padding** and paints the rule as a
background layer through its centre. Geometry is identical to the terminal; the glyphs are
not, because box-drawing characters would only matter if the web target were trying to
*look* like a terminal rather than to *lay out* like one. `compare.mjs` therefore treats
"terminal box-drawing glyph, browser space" as expected and everything else as a
difference. Pinned by `props-to-style.test.ts`.

### 10.3 Two bugs the harness caught

1. **The web bundle hung with a blank page and a silent console.** `Text` rendered
   `<span>`, and the shim's JSX runtime maps the tag `span` back to `Text` — for ever.
   React's work loop builds fibers iteratively, so there was no stack overflow and no
   error to see. Fixed with a `/** @jsxImportSource react */` pragma in `elements.tsx`:
   host DOM tags must use React's runtime, and only the tree under `src/ui` goes through
   the mapping one.
2. **Below 61 rows the terminal host does not clip or scroll — it compresses.** Rows
   shrink to fit, some to zero height while still being drawn, so two text rows composite
   into one cell row (at 60 rows, `ApprovalCard`'s title shows through its summary's
   spaces). CSS flexbox overflows instead, so comparing at a compressed height would
   report the terminal's own overflow behaviour as a DOM-host failure. `PARITY_ROWS` is 70
   for that reason and `parity.test.ts` pins it.

Three smaller layout rules came out of the same loop, all now in `props-to-style.test.ts`:
`white-space: pre-wrap` by default (HTML collapses the literal spaces the tree aligns
columns with), `backgroundColor` accepted alongside `bg` (the spelling every widget
actually uses), and `<text>` as a block-level layout participant distinct from the inline
`<span>`.

### 10.4 What this does *not* establish

The `widgets` scene is five pure `ai-output/` widgets and the `markdown` scene is one
document. Between them they exercise box/text/span/b, flexbox, cell arithmetic, borders,
panel chrome and the markdown renderer — **not** `TextareaRenderable`, `scrollbox`
scrolling, raw input, or `OptimizedBuffer`. Those remain P2 per §6, and each should get its
own scene here rather than a claim that earlier work covered it.

---

## 11. Markdown renderer (P1, 2026-09-13)

§6.1 called `<markdown>` the hard part that needs a real implementation rather than a
shim, because it is an incremental tree-sitter renderable with no DOM twin and it renders
the entire transcript. It is now implemented and measured: the `markdown` parity scene is
at **0 differing cells across 2,800**, including the table, fenced code, both list kinds,
the blockquote and the link.

### 11.1 Shape

- `src/ui-web/markdown/parse.ts` — markdown → a **line model**, pure and testable
- `src/ui-web/markdown/web-markdown.tsx` — line model → DOM

The model is *lines*, not a nested element tree. The terminal lays markdown out row by row
on a cell grid, so a model shaped the same way can be compared against it row by row. A
conventional AST would render fine and be impossible to check — which is the whole reason
the earlier `<pre>` stub survived as long as it did.

Scope names (`markup.heading`, `markup.bold`, `code`, …) are the terminal's own, so both
hosts colour from the single `SyntaxStyle` that `src/ui/markdown.tsx` already builds from
the theme. That required `core-shim.ts` to stop being a stub: `RGBA.fromHex` and
`SyntaxStyle.fromStyles` now carry real values, and `RGBA.toString()` emits CSS. Without
that, `src/ui/markdown.tsx` would have **thrown** on the web build the moment it was
reached — `RGBA.fromHex` did not exist.

### 11.2 Deliberate quirk-matching

The terminal renderable **drops the blank line before a blockquote** — always, verified
after both a paragraph and a list — while keeping the one after it and the separators
around every other block. That is inconsistent and is not CommonMark.

`parse.ts` matches it anyway, with a comment saying so and a test pinning it. The two
fronts render the same transcript for the same user; a blank line present in one and
absent in the other is a visible difference between them, and "we are more correct than
the terminal" is not worth that. The moment the terminal's behaviour changes, the test
fails and points at the decision.

### 11.3 Three bugs this round

1. **Every table one cell too narrow.** `clientWidth` is an integer, so a box of 69 cells
   at 8.036px measures 554 instead of 554.48 and floors to 68. Fixed by measuring with
   `getBoundingClientRect()` and rounding.
2. **The `widgets` scene captured blank** once a second scene existed. The capture polled
   for `window.__codesurfParity` and treated its presence as "ready" — but `web/main.tsx`
   installs it at module scope right after `createRoot().render()`, and React renders
   concurrently, so the hook is reachable a tick before the DOM is populated. The race was
   always there; the second scene just changed the timing enough to lose it. The capture
   now waits for content that is both non-empty and stable across two reads, which also
   covers the markdown renderer's measure-then-reflow.
3. **A zero-width space is a glyph.** Blank lines were padded with `​` to stop empty
   divs collapsing; the grid capture faithfully recorded it in column 1 of every blank row.
   `min-height: var(--row)` does the job without putting a character on the grid.

### 11.4 Not covered

`normalizeMarkdownLocalFileLinks` / `parseLocalFileLinkSegments` in `src/ui/markdown.tsx`
take a different path when `onOpenFileLink` is supplied — clickable local-file links,
rendered as `box`/`text` rather than `<markdown>`. That path already goes through the DOM
host and needs no markdown work, but it has no parity scene and its click behaviour is
untested on web. Syntax highlighting *inside* fenced code blocks is also not implemented:
the terminal applies a tree-sitter grammar per language, and the web renderer paints code
blocks in one colour.

---

## 12. Input and scrolling (P1, 2026-09-13)

The remaining P1 items from §5. Both were nominally "done" in P0 and both were wrong in
ways that fail silently.

### 12.1 The hooks were the wrong shape

Three of the four symbols in §2.2 were stubs that could never have worked:

| Symbol | Was | Now |
|---|---|---|
| `useKeyboard` | took **no handler** and returned a ref -- the real signature is `(handler, options?) => void`, so every subscription in the tree was a no-op | listens on `window` in the capture phase, delivering `WebKeyEvent` |
| `useTerminalDimensions` | looked for `#codesurf-web-root`, an id that does not exist, and so returned a hardcoded **80x24 for ever** | measures the mount root against a measured cell |
| `flushSync` | called the function and returned -- not React's | re-exports `react-dom`'s |

The `flushSync` one mattered most. `src/ui/hooks/use-flushed-keyboard.ts` exists *because*
without a synchronous commit the TUI rendered one keypress behind; a pass-through would
have reproduced that exact bug on web, silently, and it is the kind of thing that gets
diagnosed as "the web front feels laggy".

None of these would have thrown. That is the point: a hook with the wrong shape does not
fail loudly, it just never fires.

### 12.2 Key translation

`src/ui-web/opentui-dom/keys.ts` maps a DOM `KeyboardEvent` onto OpenTUI's `ParsedKey`.
Two details are load-bearing:

- **Names are the terminal's, not the DOM's.** `Enter` -> `"return"`, because 38 call sites
  compare against `"return"`. Arrows lose their `Arrow` prefix; space is `"space"`.
  Printable keys are lowercased with shift carried separately, since `key.name === "x"`
  must match whether or not shift is held.
- **`sequence` is not optional.** Several paths compare `key.sequence` against raw terminal
  bytes (`"\u001b"` for escape, `"/"` to open the slash menu). A key event carrying only a
  name silently breaks those -- they are the escape and mode-switch paths, so it would
  present as "escape doesn't work" rather than as a missing field.

`preventDefault` forwards to the DOM event, or the browser also acts: Tab moves focus out
of the app and space scrolls the page underneath the handler.

### 12.3 Scrollbox: cells, not pixels

`<scrollbox>`'s ref is reached through in several places -- `sb.scrollTo(sb.scrollHeight)`
to pin the transcript to the tail, `sb.scrollTop` / `sb.viewport.height` in `message-list`
to decide whether the user has scrolled away from it.

**OpenTUI measures scroll in cells; the DOM measures it in pixels.** Forwarding the numbers
unconverted would be wrong by the row height -- and silently, because every value involved
is a plausible-looking number. `scrollTo(scrollHeight)` would scroll one sixteenth of the
way and the transcript would simply stop following the stream.

Every value crossing the boundary is converted. The conversion lives in
`makeScrollBoxHandle`, separate from the component, so it can be tested against known
dimensions -- jsdom does not lay out, so a test against a really-rendered `<div>` would
assert against zeroes and pass regardless.

### 12.4 Still open

`TextareaRenderable` landed as P2 (§13). Neither the keyboard, the scrollbox, nor the
composer has a parity scene: all three are behavioural rather than visual, and the harness
compares static grids. Their tests are unit tests, which is weaker evidence than the
markdown and widget scenes have.

### 13. Composer (P2, 2026-09-17)

A real DOM `<textarea>` behind a `TextareaRenderable`-shaped ref, in
`src/ui-web/opentui-dom/textarea.tsx`.

- **Facade** (`makeTextareaHandle`): `plainText`, `setText`/`clear`/`insertText`,
  `cursorOffset` (clamped), `logicalCursor` (row/col for history-Up), `focus`/`blur`,
  `requestRender` as an explicit no-op. Programmatic mutation fires `onContentChange`
  so typeahead stays fresh after history recall.
- **Keys**: `keyBindings` matched with *exact* modifiers (`Enter` submits, `Shift+Enter`
  is a newline, modal editors that omit the shift binding keep the browser default).
  A key already `preventDefault`ed by a window-capture handler (typeahead accepting
  Enter) is not also submitted.
- **Paste**: `WebPasteEvent` carries UTF-8 clipboard bytes; `decodePasteBytes` is a real
  `TextDecoder` (the previous stub returned `""` and would have dropped every web paste).
  `preventDefault` reaches the DOM event so raw text does not land next to a paste-block
  token.
- **Cells, not pixels**: `onMouseMove`/`onMouseOut` convert via `rowHeight`/`cellWidth`
  from the scrollbox module — `useComposerImageHover` maps `event.x - target.x` as columns.
- **Vitest JSX**: the root vitest transform aliases `@opentui/react/jsx-runtime` to a stub
  that returns `{type, props, key}` objects. Host DOM tags and the jsdom tests use
  `createElement` from `react` so they actually mount. 19 tests in `textarea.test.tsx`.

### 14. Live front (P3, 2026-09-17)

`?node=ws://127.0.0.1:3948` mounts `src/ui-web/live/app.tsx` instead of a parity scene.

- **Protocol:** the same `SessionStreamClient` + `createRemoteSessionTurn` pair mode-2
  headless fronts use. Vite bundles it (43 modules, ~244 kB). Global `WebSocket`, no `ws`.
- **Transcript:** `applyChunk` folds StreamChunks into a discriminated entry list
  (user / assistant / tool / error / status). Not `useTurnEngine`.
- **Exit:** `bun run web:live-smoke` boots an echo `EngineNode`, opens the live page in
  headless Chrome, types, submits, and asserts `echo:hello` arrived. Parity scenes stay
  at 0 differing cells.

P4 (node-coupled leaves) is untouched.
