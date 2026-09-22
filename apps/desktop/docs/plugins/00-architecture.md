# CodeSurf Plugin Platform — Architecture & Build Spec

> The implementation spec for rebuilding CodeSurf's extensibility platform. This is the
> source of truth for vocabulary, decisions, and sequencing. Third-party standards
> (MCP, MCP-UI, React, Electron, Monaco) are used by their real names.
>
> Status: **living spec.** Decisions below are made (so work can start) but marked
> where they're open to redline.

---

## 0. North star

Make CodeSurf plugins **piss-easy to write and incredibly powerful**: a plugin can
appear as a canvas view, a chat-composer surface, a footer item, a settings section,
a command/`/slash`, a layout preset, and/or an agent integration — declared as data
where possible, with a full programmatic escape hatch when needed — while **every
existing extension keeps working and gets better**, and the whole thing is consistent
and themable by default.

Three hard rules carried from the goal:
1. **No borrowed proprietary names.** Our own vocabulary throughout (§1). Third-party
   standards keep their names.
2. **Zero regression.** Today's `extension.json` + `ext:` IPC + `window.contex` bridge
   keep working byte-for-byte; v2 is additive/opt-in. The no-regression contract is
   spelled out in §13.
3. **Evolve in place.** New plugin surfaces build on CodeSurf's existing strengths
   (canvas engine, multi-provider chat + permission UX, peer/relay, daemon, MCP node
   bridge, Chrome sync/voice/generation).

---

## 1. Vocabulary (original — locked)

| Term | Meaning | Replaces / relation |
|---|---|---|
| **Plugin** | The unit of extensibility (user-facing). | Replaces user-facing "extension"; `extension.json` stays as the legacy/compat manifest. |
| **CodeSurf Plugin** | First-party / built-in capability shipped as a plugin. | The rewired built-ins (§7). |
| **Community Plugin** | Third-party installed plugin. | — |
| **Agent Plugin** | A plugin that contributes agent behaviour, tools, or a model provider. | New class (§ agent integration). |
| **`plugin.json`** | v2 manifest (superset of `extension.json`). | `extension.json` still loads. |
| **`definePlugin()`** | Typed programmatic entry from the SDK. | Industry-standard name; not proprietary. |
| **`@codesurf/plugin`** | The typed plugin SDK (host API types + `definePlugin` + `PluginContext`). | Our namespace. |
| **`@codesurf/ui`** | Default consistent component kit (fields, buttons, switches…) on the `--ct-*` tokens. | New (§8). |
| **`window.codesurf`** | Canonical bridge global. | `window.contex` kept as a permanent alias. |
| **Surface** | A place a plugin shows up: `view`, `composer`, `footer`, `panel`, `settings`, `menu`, `command`. | Generalises `chatSurfaces`. |
| **Contribution** | A declared capability in `contributes` (data) or registered at runtime (code). | Extends today's `contributes`. |
| **Slot** | Host mount point. `<Slot kind="footer"/>` + `useContributions('footer')`. | New host primitive. |
| **Command** | A named action; appears in the **Command Palette** and optionally as a `/slash`. | New. |
| **Capability** | A brokered host service a plugin requests and the user consents to (`relay`, `fs`, `network`, `shell`, `chat`, `daemon`, `chrome`, `secrets`). | Replaces the inert `permissions[]` + the hardcoded relay bridge. |
| **Plugin Store** | Per-plugin reactive, persisted, schema'd state. `ctx.store` / `usePluginState`. | Fills the "no durable store" gap. |
| **Capability Registry / Contribution Registry** | Host-side registries that collect contributions and resolve them into UI/commands/tools. | New. |
| **Render mode** | How a surface paints: `iframe` (sandboxed custom HTML), `component` (in-host React, trusted/built-in), `mcp-ui` (MCP-UI resources — the easy default). | Generalises `ui.mode`. |
| **Execution mode** | Trust/runtime of plugin logic: `iframe`, `node`, `worker`. | Orthogonal to render; replaces `safe`/`power` (kept as aliases). |
| **Plugin Dev Mode** | Run one plugin live in the real host with hot reload. | New (§ dev). |
| **Dev Sandbox** | A separate CodeSurf instance, **dashed border**, isolated user-data-dir, for testing a plugin in isolation. | New (§ dev). |
| **Plugin Studio** | The authoring experience itself, shipped as a first-party plugin (files + git + code view + live preview). | New (§ dev). |
| **Layout** | A saved arrangement of views (panel tree). Any full-screen arrangement/snap becomes one. | First-classes the existing `panelLayout`. |
| **Layout Preset** | A named, reusable layout a plugin can register/open (e.g. "Chat Workspace"). | New (§10). |

Banned tokens anywhere in our code/UI/package names: third-party competitor product
names, framework package scopes, CLI verbs, and replicated-DB names from other desktop
IDE shells. The third-party agent runtime we may depend on is published by an unrelated
author and is fine as a *dependency*, but it is surfaced in our UI under a neutral
CodeSurf label (see § agent integration).

---

## 2. The unlocking reframe — two orthogonal axes

Today `tier: 'safe' → ui.mode:'native'` and `power → custom` are conflated and the
`native` path is unimplemented. Split into two independent axes:

- **execution**: `iframe` (sandboxed, postMessage) · `node` (trusted Node; brokered
  child for non-bundled plugins by default) · `worker` (forces the brokered child)
- **render**: `iframe` (custom HTML in sandbox) · `component` (in-host React) · `mcp-ui` (MCP-UI resource, themed by us)

Back-compat aliases (absent v2 fields ⇒ derive from v1):
- `tier:'safe'` ⇒ `execution:'iframe'`
- `tier:'power'` ⇒ `execution:'node'`
- `ui.mode:'custom'`/absent ⇒ `render:'iframe'`
- `ui.mode:'native'` ⇒ `render:'mcp-ui'` (now real) for v2 plugins; v1 stays iframe.

This makes `{node, component}` (trusted in-bundle view) and `{iframe, mcp-ui}` (easy
themed UI in a sandbox) first-class — both impossible today.

---

## 3. Manifest superset (`plugin.json` ⊇ `extension.json`)

All v2 fields are **optional**; a manifest with none behaves exactly as today. (TS
types land in `src/shared/types.ts` — see Phase 0.)

```jsonc
{
  "id": "git",
  "name": "Git",
  "version": "1.0.0",
  "manifestVersion": 2,            // absent ⇒ legacy v1 path
  "kind": "codesurf",             // codesurf | community | agent
  "engines": { "codesurf": ">=0.1.0" },
  "execution": "node",            // iframe | node | worker  (alias: tier)
  "render": "component",          // iframe | component | mcp-ui  (alias: ui.mode)
  "capabilities": [               // consented at enable time; replaces inert permissions[]
    { "name": "fs", "reason": "read repo status" },
    { "name": "shell", "reason": "run git" }
  ],
  "dependsOn": ["code-index"],    // load order + typed access (codegen later)
  "contributes": {
    // v1 (unchanged): tiles, chatSurfaces, mcpTools, contextMenu, settings, actions, context
    "commands": [
      { "id": "git.commit", "title": "Git: Commit", "slash": "commit", "keybinding": "mod+k c", "run": { "method": "commit" } }
    ],
    "footer":         [ { "id": "git.status", "entry": "footer.html", "render": "mcp-ui", "position": "left" } ],
    "panels":         [ { "id": "git.tree", "title": "Source Control", "entry": "panel.html", "region": "right" } ],
    "settingsSections":[ { "id": "git", "title": "Git", "items": [ /* control union */ ] } ],
    "layoutPresets":  [ { "id": "git.review", "title": "Code Review", "layout": { /* panel tree */ } } ],
    "agentExtensions":[ { "path": "agent/guardrails.js" } ]   // shapes the agent runtime
  },
  "main": "main.js",              // execution entry (node/worker)
  "permissions": ["network"]       // legacy; mapped onto capabilities
}
```

Every contribution carries an optional `render` so a plugin can mix modes (e.g. an
`mcp-ui` footer + a `component` view).

---

## 4. Contribution registry + Slots (the centerpiece)

One generic host registry, instantiated per surface kind, fed by (a) declarative
`contributes` and (b) runtime `ctx.contribute(kind, spec)`; wiped on plugin reload and
re-collected. Host code consumes it:

```tsx
// host
const footerItems = useContributions('footer')        // reactive
<Slot kind="footer" />                                 // renders all, sorted by order
```

`<Slot>` renders each contribution by its `render` mode: `component` inline in the host
tree, `iframe` through the existing `ExtensionTile`/`window.contex` path, `mcp-ui`
through the MCP-UI renderer (§8). **New view/tile types appear with zero `App.tsx`
edits** — the closed `TileType` union is retired in favour of registry lookup (built-ins
migrate incrementally; the union stays valid throughout — §7).

Surface→host-region map:
- `view` → canvas tile (+ 3 auto command-palette rows: open / replace / split)
- `composer` → chat area above the input (today's `chatSurfaces`, generalised)
- `footer` → status bar item
- `panel` → left/right/bottom region
- `settings` → a settings section
- `menu` → canvas/tile context menu
- `command` → Command Palette + optional `/slash`

### Commands, palette, shortcuts (point 3)
A single `ContributionRegistry` powers three sibling registries — **commands**
(real closures, palette overlay on the existing unused `cmdk` `command.tsx`),
**shortcuts** (register/rebind/reset, persisted, `when`-scoped), **settings**
(section/item control union). `/slash` commands route through the same command
registry from the composer. Every command is optionally agent-callable, so the human
palette and the agent share one registry.

---

## 5. Plugin Store, events, RPC, hooks

- **Plugin Store** — `ctx.store` + `usePluginState(selector)`: a per-plugin reactive
  JSON store persisted at `~/.codesurf/plugin-state/<id>.json`, optional zod schema,
  change-broadcast over the existing event bus to every renderer. Fixes the confirmed
  "Builder history not persisted" class of bug. **Decision: extend the event bus +
  this store; do NOT adopt a full replicated DB** (heavy, fights our file-based model).
- **Typed events / RPC** — typed channels layered over the existing bus; `ctx.peer(id)`
  typed RPC unifying the two current host routers.
- **Host hooks** — **named, typed extension points** (`defineHostHook` +
  `ctx.hooks.wrap/before/after`) instead of arbitrary AOP. Covers the real cases (wrap
  composer, decorate a tool-call) refactor-safely; no fragile build transform.

---

## 6. Capabilities + consent (surpass — both reference & us are weak here)

Host services register **named capabilities** with a risk level; a plugin declares the
ones it wants; the user **consents at enable/install time**; and the broker returns a
scoped handle to CodeSurf APIs. The relay surface is the broker's first consumer.
Non-bundled `node` execution flows through a utility-process child by default rather
than raw `require()` into main, and `worker` forces that brokered path.

This boundary gates CodeSurf APIs only. The child retains ambient Node.js access to
filesystem, process, network, environment, and package APIs. The utility process
provides crash isolation, not an OS security sandbox; removing ambient Node access
requires a future confinement boundary.

---

## 7. Built-ins as plugins (point 7)

Built-ins become **CodeSurf Plugins** (`kind:'codesurf'`, `execution:'node'` where
needed, `render:'component'`) registered through the same contribution registry —
**migrated one at a time**. The `TileType` union and the `App.tsx` render switch stay
valid throughout; each built-in flips to a self-registering `component` contribution
behind a no-regression check. No big-bang. End state: "add a new tile type" is as easy
for a built-in as for a community plugin.

---

## 8. UI consistency + MCP-UI (points 8 & 9)

- **`@codesurf/ui`** — a default component kit (Field, Button, Switch, Select, Input,
  Tabs, etc.) styled on the existing `--ct-*` tokens + `data-ct-mode`. Plugins get
  consistent, themed controls **for free**; override only to customise. This is how
  "I can put together UIs easily" holds across plugins.
- **MCP-UI as the default UI substrate** — adopt the third-party `@mcp-ui/client`
  (`AppRenderer`/`UIResourceRenderer`) + `@mcp-ui/server` (`createUIResource`).
  `render:'mcp-ui'` lets a plugin describe UI as **MCP-UI resources** (HTML / remote-DOM
  / external URL) that the host renders in a sandboxed iframe with our theme + UI kit
  injected. This is the "piss-easy" path: declare UI as data, get a consistent themed
  result, no bundler.
  - Custom UIs (`render:'iframe'` / `'component'`) layer on top for full control.
  - **Built-ins stay `component`** with thin MCP-UI-compatible wrappers so they sit in
    the same slots as community plugins.
  - MCP-UI's tool/action callbacks bridge to our command + capability system.

---

## 9. Agent integration (the in-process coding-agent runtime)

Integrate the third-party agent runtime (published by an unrelated author — allowed as
a dependency) **in-process** as a new chat provider, **alongside** the existing five
(claude/codex/opencode/openclaw/hermes), never replacing them. Surfaced in our UI under
a **neutral CodeSurf label** (no third-party brand in the UI; provider id internal).

Wiring, streaming mitigation, and sequencing are covered in phase **P5** (§12). Key
non-negotiables: load via dynamic `import()` (zero boot cost for non-users);
suffix-delta extraction + microtask-coalesced flush (the runtime emits a full snapshot
per token); bridge our tools/peers in-process (the runtime has no MCP client); reuse our
existing tool-permission UX via its tool-call hook. Plugins shape agent behaviour via
`contributes.agentExtensions` (guardrails, custom tools) and our `Agent Plugin` class.

---

## 10. Layouts as a first-class, reusable feature (point 10)

Build on the existing `panelLayout` (PanelNode tree), `expandedTileId`,
`expandLayoutGroupId`, `expandedCanvasGroupId`, `isLayoutVariantWorkspace`, and the
`PanelLayout` component.

- **Double-click a view** → full-screen it; other views in the same arrangement are
  reachable as **tabs**.
- **Snap/arrange views together** → the arrangement **becomes a Layout** automatically
  (a named panel tree), promotable to a **Layout Preset**.
- **Layout Presets** are registerable by plugins and openable by users/agents, e.g. a
  "Chat Workspace" preset = sessions left · chat centre · git right. Opening a preset
  instantiates the named views into the panel tree.
- Presets are data (`contributes.layoutPresets`) referencing view kinds from the
  contribution registry, so any plugin's views can participate.

---

## 11. Developer experience (points 4 & 5)

- **Plugin Dev Mode** — `codesurf plugin dev <dir>` runs the plugin in the **real** host
  bridge with hot reload (kills the current drift between the static harness and the
  real `ExtensionTile` bridge — one source of truth).
- **Dev Sandbox** — launches a separate CodeSurf instance with a **dashed border** and
  an isolated `--user-data-dir`, so a plugin (or a whole workspace) is tested in a clean
  playground without touching the user's data.
- **Plugin Studio** — the authoring surface shipped *as a first-party plugin*: composes
  the file, git, and code-view plugins + a live preview Slot + a "Run in Dev / Open
  Sandbox" control. Dogfoods the whole platform.
- **SDK + CLI** — `@codesurf/plugin` (typed `definePlugin`, generated `window.codesurf`
  types) + `codesurf plugin new|dev|build|package`. Scaffold emits a working `plugin.json`
  + entry + types. Hand-written JSON+HTML plugins still work with no SDK.

---

## 12. Phased roadmap (build order)

Each phase is independently shippable and carries a **no-regression guard**. Front-loads
the additive substrate, then the centerpiece, then power, then polish.

| Phase | Goal | Key changes | No-regression guard |
|---|---|---|---|
| **P0 Foundations** | Additive substrate. | Manifest superset (v2 optional fields) in `types.ts`; execution⟂render axes + v1 aliases; **fix `ctx.settings.get`** + add `set`/`getAll`; manifest normalisation derives axes from `tier`/`ui.mode`. | All current `extension.json` load via the exact current path; bundled+example plugins run untouched; typecheck clean. |
| **P1 Capabilities** | Brokered, consented host services. | Capability registry + `ctx.use()`; consent UI in the gallery; relay = first capability (verbatim methods); map `permissions[]`→capabilities. | relay-suite keeps working via alias until it opts in. |
| **P2 Contributions + Slots + Palette + Shortcuts** | Open slot model + command palette + rebindable shortcuts + `/slash`. | `useContributions`/`<Slot>`; one registry → commands/shortcuts/settings; palette overlay on `command.tsx`; composer slash menu. | Built-ins keep `App.tsx` rendering; `TileType` union stays valid; migration opt-in. |
| **P3 Store + events + hooks** | Durable reactive state, typed comms, named hooks. | `~/.codesurf/plugin-state/<id>.json` store + `usePluginState`; typed event channels + `ctx.peer()`; `defineHostHook`. | Bus + ring buffer + tile-context preserved; existing chains flow. |
| **P4 UI kit + MCP-UI** | Consistent themed UI + the easy `mcp-ui` path. | `@codesurf/ui`; `render:'mcp-ui'` via `@mcp-ui/client`; theme+kit injection; action→command/capability bridge. | iframe + component renders unchanged; built-ins wrap compatibly. |
| **P5 Agent runtime** | In-process agent provider + agent plugins. | New provider `case` in `chat.ts` (neutral label); streaming mitigation; in-process tool/peer bridge; `agentExtensions`. | Existing 5 providers + session files untouched; non-users load nothing. |
| **P6 Layouts** | First-class reusable layouts. | Auto-layout on snap/arrange; fullscreen+tabs; `layoutPresets`; open-preset action. | Existing panel layout / groups / saved templates intact. |
| **P7 Authoring loop** | SDK + CLI + Dev Mode + Dev Sandbox + Plugin Studio. | `@codesurf/plugin` + `codesurf plugin` CLI; dev-child with dashed border + isolated data dir; Plugin Studio plugin. | Hand-written plugins + `/build-extensions` skill still work. |
| **P8 Plugins rename + built-in rewire + marketplace** | User-facing "Plugins"; built-ins as plugins; real catalog. | Gallery → "Plugins"; incremental built-in migration; remote catalog + install pipeline (download→verify→validate→place→hot-reload→consent). | Each migrated built-in passes its capability checklist; legacy ids preserved. |
| **P9 Onboarding + auto-update** | Parity, mapped to our surfaces. | Welcome/recents/project palette; per-plugin + app update over existing `electron-updater`. | Workspace mgmt + theme + agent-setup extended, not replaced. |

---

## 13. No-regression contract

Nothing in the headline capability set below may regress; each phase's guard proves it.
Headline: the canvas engine,
everything-is-a-tile, the 5 chat providers + permission UX, peer/relay, daemon/detached
jobs, MCP server + node bridge, Chrome sync/voice/generation/dreaming/local-proxy, and
the foreign-format adapters all keep working and get **better** by gaining the new slot,
store, capability, and UI systems.

---

## 14. Security — current trust posture and roadmap

### Current posture (as of this writing)

Non-bundled `power`/`node` extensions run in an Electron utility-process child by
default. This keeps a plugin crash out of the Electron main process, but the child is
**not a security sandbox**. Extension code retains ambient Node.js access to
filesystem, process spawning, networking, environment variables, and arbitrary
package imports. Treat enabling POWER code as equivalent to installing a native
application.

The capability system gates calls from that child into brokered **CodeSurf APIs**.
For example, a plugin must receive the appropriate grant before it can invoke the
CodeSurf canvas, relay, or host-filesystem surface. Capability grants do not intercept
or confine direct Node built-ins such as `node:fs` and `node:child_process`.

Bundled POWER extensions still use the legacy in-main `require()` path. The
`CODESURF_POWER_BROKER=0` compatibility escape hatch also forces the legacy path for
all POWER extensions. A manifest with `execution: "worker"` forces the brokered child
even for a bundled extension.

**Activation gates** (the current mitigations):

| Scope | Default | Requires explicit user opt-in? |
|---|---|---|
| bundled (shipped with the app) | enabled | no |
| global (`~/.codesurf/extensions/`) | enabled | no |
| catalog (gallery entries) | **disabled** | yes — gallery "Add" / enable |
| workspace (`.contex/extensions/` in a cloned repo) | **disabled** | yes — explicit enable, persisted |

The workspace default-off is the critical protection: any project a user clones can
ship `.contex/extensions/` but none of those power scripts will execute unless the
user explicitly enables each one. Opt-ins, disabled extension IDs, and capability
grants are committed together in the versioned
`~/.codesurf/extension-security-state.json` document.

Security warnings identify POWER activation and the selected runtime path in the
main-process log. A separate warning is emitted when the user opts in.

### Planned improvement — real confinement

The brokered child and main-process capability policy are valuable containment layers:
they isolate crashes and prevent ungranted CodeSurf API calls. They do not make
untrusted Node.js safe. Real confinement requires removing ambient Node built-ins or
placing the child inside an OS-enforced sandbox with a deliberately narrow IPC
surface. Until that lands, explicit enablement, source review, and the
workspace/catalog default-off gates remain the primary trust controls.
