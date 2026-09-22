| ID | Goal | Outputs | Acceptance Criteria | Dependencies |
| --- | --- | --- | --- | --- |
| T1 | Restrict custom protocol file access | `src/main/file-protocol.ts`, `src/main/extensions/protocol.ts` | Protocol handlers reject traversal/sensitive paths and only serve intended media/extension asset roots | None |
| T2 | Authenticate iframe RPC by source | `ExtensionTile.tsx`, `ChatTile.tsx` | Host ignores RPC/ready/action messages unless `event.source` matches the expected iframe window | None |
| T3 | Validate collab filesystem inputs | `src/main/ipc/collab.ts` and helpers if needed | `workspacePath`, `tileId`, and `filename` cannot escape intended `.contex`/`.collab` roots | None |
| T4 | Harden browser-tile untrusted content bridge | `BrowserTile.tsx` | Browser bridge is not injected for arbitrary remote pages and local-file navigation is blocked | None |
| T5 | Fix release gate failures where straightforward | tests/config/source files | `npm test` no longer fails on the known Electrobun default mismatch; typecheck is improved where changes introduce errors | T1-T4 |
| T6 | Verify and report | command outputs | Run `npm test` and `npm run typecheck`, report exact remaining failures if any | T1-T5 |
