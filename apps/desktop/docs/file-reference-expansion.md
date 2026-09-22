# File Reference Expansion

CodeSurf can expand workspace-local file references inside chat turns before the request is sent to a local or daemon-backed model.

Supported inputs
- Inline `@path/to/file.ts` references inside the user message body
- Explicit `@file:path/to/file.ts` and `@path:path/to/file.ts` forms
- Existing `Attached file paths:` blocks emitted by the chat attachment UI

How it works
- References are resolved relative to the active workspace root
- Files must stay inside the workspace after path resolution
- Expanded paths are shown relative to the workspace root
- CodeSurf appends a `Referenced workspace files` section with the file contents to the outgoing prompt
- The chat stream emits a `Workspace File References` tool card summarizing which files were expanded

Safety rules
- Missing or invalid references fail the turn instead of silently leaking or misreading files
- References that resolve outside the workspace root are rejected
- Directories are rejected
- Binary files are rejected
- Large files are truncated to the first 16 KiB per referenced file
- Cloud execution never injects host-only absolute workspace paths into the expanded prompt

Daemon route
`POST /file-references/expand`

Request body
```json
{
  "workspaceId": "optional-workspace-id",
  "workspaceDir": "/optional/fallback/path",
  "executionTarget": "local",
  "message": "Review @src/main/ipc/chat.ts"
}
```

Response shape
```json
{
  "changed": true,
  "message": "expanded prompt text",
  "references": [
    {
      "source": "@src/main/ipc/chat.ts",
      "displayPath": "src/main/ipc/chat.ts",
      "byteCount": 1234,
      "truncated": false
    }
  ],
  "summaryText": "Expanded 1 workspace file reference: src/main/ipc/chat.ts",
  "inputText": "- @src/main/ipc/chat.ts → src/main/ipc/chat.ts (1.2 KiB)"
}
```

Notes
- The main-process chat flow keeps persisted runtime session history unchanged; expansion is only applied to the prepared outbound turn.
- Daemon-backed local and cloud routes both use the same expansion path so the chat/tool/status UI stays consistent.
