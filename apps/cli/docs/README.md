# CodeSurf Docs

Everything that didn't fit in the README, organized.

## Architecture
- **[architecture/mesh.html](./architecture/mesh.html)** — interactive, Mermaid-rendered architecture: mode spectrum (serverless vs. wire front), the relay mesh, control/data planes. Open in a browser.
- **[architecture/mesh.md](./architecture/mesh.md)** — the same architecture as plain markdown.
- **[architecture/phase3-hub-protocol.md](./architecture/phase3-hub-protocol.md)** — Phase 2/3/4 build record: hub, presence, WS transport, engine node, jobs, fleet telemetry, tracing, reaping, mode-2 streaming.
- **[architecture/phase2-relay-steward.md](./architecture/phase2-relay-steward.md)** — the relay + steward design slate and driving requirements.
- **[architecture/phase1-agent-gateway.md](./architecture/phase1-agent-gateway.md)**, **[phase0-daemon-merge.md](./architecture/phase0-daemon-merge.md)**, **[v0.md](./architecture/v0.md)** — earlier phases and the v0 spec.

## User guides
- **[user/cli.md](./user/cli.md)** — commands, flags, and run modes (serverless vs. `--connect`).
- **[user/ptc.md](./user/ptc.md)** — Programmatic Tool Calls: presentation modes and how to test them.
- **[user/config.md](./user/config.md)** — settings: chip aliases, model, retention, and the rest.

## Relay / mesh protocol
- **[relay/protocol.md](./relay/protocol.md)** — the versioned wire format: relay envelope ops + the `session` streaming channel.

## Assessments & archive
- [recommendations/](./recommendations/) — dated code reviews and baselines.
- [superpowers/](./superpowers/) — older design specs and session notes.
- [archive/](./archive/) — superseded plans.
