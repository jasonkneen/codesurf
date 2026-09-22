# Daemon Skills

CodeSurf now resolves chat skills through the daemon instead of scanning skill roots directly in Electron main.

## Canonical roots

The daemon always inspects these CodeSurf-owned roots first:

- global: `~/.codesurf/skills`
- workspace: `<workspace>/.codesurf/skills`
- saved workspace custom skills: `<workspace>/.codesurf/customisation/skills.json`

## Compatibility roots

To preserve the existing skill browser/chat surfaces, the daemon also scans the same compatibility locations that ChatTile already exposed:

- `~/.claude/commands`
- `<workspace>/.claude/commands`
- `~/.claude/skills`
- `<workspace>/.claude/skills`
- `~/.config/opencode/skills`
- `<workspace>/.opencode/skills`
- `<workspace>/.cursor/rules`
- `<workspace>/.continue/prompts`

Workspace custom location files are respected too:

- `<workspace>/.codesurf/customisation/locations-skills.json`
- `<workspace>/.codesurf/customisation/locations-prompts.json`

If no custom location override exists, the compatibility defaults above are used.

## Daemon routes

The daemon exposes three skill routes:

- `GET /skills/list`
  - returns inspectable roots, metadata-only skill entries, and the current tile selection summary/prompt
  - accepts optional `workspaceId`, `workspaceDir`, and `cardId`
- `GET /skills/get`
  - returns a single skill with full content on demand
  - accepts `skillId` plus optional `workspaceId`, `workspaceDir`, and `cardId`
- `POST /skills/install`
  - installs a `.skill` archive into either the global or workspace CodeSurf root
  - body: `{ zipPath, scope?: 'global' | 'workspace', overwrite?: boolean, workspaceId?, workspaceDir?, cardId? }`

## Archive/install behavior

Daemon installs intentionally follow the same archive convention already used by `src/main/ipc/skills.ts`:

- `.skill` is treated as a zip archive
- archive contents should contain a top-level `<name>/SKILL.md`
- frontmatter `name:` and `description:` are parsed from `SKILL.md`
- `overwrite: true` replaces an existing installed folder

The difference is destination ownership:

- renderer `skills:install` keeps its existing Claude-oriented install flow
- daemon `/skills/install` writes into CodeSurf-owned roots under `.codesurf/skills`

## Prompt-side inclusion

When a tile has selected skills in `<workspace>/.contex/<tileId>/skills.json` (or legacy `.collab/<tileId>/skills.json`), the daemon builds an inspectable summary prompt like:

```md
## Included Skills
- @Workspace Helper [workspace] — Workspace-specific workflow.
- @/compact [command] — Compact conversation.
```

This is injected into Claude/Codex prompt assembly and surfaced through existing tool/status flows as an `Included Skills` chip.

That means both runtime and daemon-backed chat paths can show:

- a compact summary (`Included N skills: ...`)
- the exact outbound summary prompt in the chip details/input

## Selection model

Selections stay daemon-readable and file-backed:

- enabled ids come from `<workspace>/.codesurf/<tileId>/skills.json`
- ids match the existing UI inventory ids (`discovered-<absolute-path>`, saved custom ids, and `command:/...` built-ins)
- unresolved ids are reported in the daemon selection payload for inspection/debugging
