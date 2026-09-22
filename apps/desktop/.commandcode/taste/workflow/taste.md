# Workflow
- Follow the 30-minute heartbeat cycle: read SOUL.md, MEMORY.md, HEARTBEAT.md, pick one unchecked item, do the work, mark done, append findings to MEMORY.md. Confidence: 0.85
- When user says "crack on", continue working autonomously without asking for clarification. Confidence: 0.85
- When porting code from other projects, preserve exact functionality rather than reinterpreting or simplifying. Confidence: 0.90
- When user expresses frustration about incomplete implementations (e.g., "why the FUCK are you doing stubs", "what did you think?"), immediately switch from analysis to implementation mode. Confidence: 0.85
- When Electron main-process changes are made (IPC handlers, daemon changes), explicitly tell user to restart with `npm run dev` since electron-vite doesn't hot-reload main. Confidence: 0.80
- Test autonomously without asking the user to verify — check logs, use MCP tools, verify end-to-end yourself. Confidence: 0.85
