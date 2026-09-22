## Review

The plan covers the highest-impact findings from the review: arbitrary file serving, message spoofing, path traversal, untrusted browser bridge, and failing release checks.

## Gaps Accepted

- Full TypeScript cleanup is broad and likely pre-existing. It is tracked as improvement, not a hard acceptance gate for security fixes.
- Power extension trust UX is larger product work. This pass treats protocol/RPC/path hardening as the immediate risk reduction.

## Decision

Proceed with T1-T6. Keep changes minimal and verify with the repo checks.
