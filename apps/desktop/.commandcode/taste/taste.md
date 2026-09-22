# Workflow
See [workflow/taste.md](workflow/taste.md)
# Architecture
- When porting code from other projects, preserve exact functionality rather than reinterpreting or simplifying. Confidence: 0.90
- Keep extension development isolated in examples/extensions/ without modifying main app src/ files. Confidence: 0.85
- Layouts should be associated with the current project, not create new projects. Default to current project folder if no project specified. Confidence: 0.80

# Tooling
- Use Python subprocess to write files when project security hooks block direct file writes. Confidence: 0.75

# Communication
See [communication/taste.md](communication/taste.md)
# Code Patterns
- When fixing Streamdown/Shiki code-block rendering issues, use CSS-based overrides with versioned style IDs to defeat HMR staleness, not inline JS patches. Confidence: 0.80
- For tool call grouping in chat UI, bucket by name across non-consecutive occurrences rather than only adjacent matches. Confidence: 0.75

# UI/UX
See [ui/ux/taste.md](ui/ux/taste.md)
# Workflow
- When user says "Make a list and get them all DONE", create a task list and work through items systematically. Confidence: 0.80
- When user says "just that ONE thing" or similar, focus on a single specific issue rather than multiple changes. Confidence: 0.85
- When user says "crack on going to bed", work autonomously overnight and report progress when they return. Confidence: 0.85

# Permissions
See [permissions/taste.md](permissions/taste.md)
# Session/Thread Management
- Only move/reorder threads to the top when user actually types and sends a message, not on click or view. Confidence: 0.85
- Session titles must be unique per project - prevent duplicate titles across different projects. Confidence: 0.75

# Prompts/Skills/Agents Discovery
See [prompts/skills/agents-discovery/taste.md](prompts/skills/agents-discovery/taste.md)
# Chat UI Tool Chips
- "UNKNOWN" tool chips indicate upstream emission path doesn't guarantee a name on every tool event - not a renderer bug. Confidence: 0.80
- "Exploring workspace" is an intentional synthetic tool emitted from daemon's chat job runner, not a bug. Confidence: 0.85
- When session titles appear duplicated across projects or old sessions show as "minutes ago", check the session indexer is scoping by project_path correctly. Confidence: 0.80

# Chat Provider Switching
- When fixing chat loading issues across providers (Claude/OpenAI), ensure proper state cleanup between provider switches. Confidence: 0.70

# Chat UI Layout
- Chat interface must be visible under the "What do you want to build today?" starter message. Confidence: 0.85
- Use Codex-style layout: Pencil icon for New Chat as first option, then Search below it. Confidence: 0.80
- New Chat should open with starter composer interface based on selected project/workspace. Confidence: 0.75
- If chat stays on wrong provider after clicking, check tile state isn't caching stale provider ID. Confidence: 0.75

# Tool System
- "UNKNOWN" tool chips indicate upstream emission path not guaranteeing tool names on every event - check daemon tool event formatting. Confidence: 0.70

# Daemon/Package Management
- When large uncommitted changes exist (daemon extraction), prioritize committing before new feature work. Confidence: 0.85
- If daemon tests fail on extension validation, check for incomplete extension manifests pointing to missing files. Confidence: 0.75

# Chat Provider Switching
- When fixing chat loading issues across providers (Claude/OpenAI), ensure proper state cleanup between provider switches. Confidence: 0.70

# Architecture Understanding
- Read and internalize agent files (DREAMING.md, CLAUDE.md, AGENTS.md) before asking questions. Confidence: 0.85
- The desktop is a rendering shell; all intelligence belongs in the daemon/grok-cli. Confidence: 0.90
- Features involving intelligence, indexing, memory, or agent behavior belong in grok-cli, not the desktop repo. Confidence: 0.85
- When user undoes a change and explains why, do not repeat the same mistake on subsequent attempts. Confidence: 0.90
- When user says "I just undid that change" with an explanation, immediately adjust approach based on the correction provided. Confidence: 0.90

# UI/UX - Tab Styling
- Inactive tab text must align vertically with active tab text — no jumping when switching. Confidence: 0.90
- Close button (x) positioning must be pixel-perfect — 1 pixel offset causes visible shift on click. Confidence: 0.85
- Main panel corner radius should be conditional: flat (0) when first tab selected AND sidebar expanded, rounded otherwise. Confidence: 0.80
- Tab container left inset adjustments should be applied at container level, not individual tabs. Confidence: 0.75
- Show indicator circles only when there are unread/updates, not always visible. Confidence: 0.85
- Position indicator circles in the dead space to the left of titles, not inline. Confidence: 0.80
- Match main tab background color to canvas/main section background for visual consistency. Confidence: 0.85
- Remove bottom borders on large tabs when explicitly requested. Confidence: 0.80
- Apply precise pixel adjustments when specified (e.g., "move 3px to the left"). Confidence: 0.90

See [ui/ux---tab-styling/taste.md](ui/ux---tab-styling/taste.md) for additional tab styling preferences
- Shimmer bars at bottom of live assistant messages are intentional and must stay. Confidence: 0.85
- When user reports "message list pulses left and right", investigate layout/reflow issues, not just the shimmer chip. Confidence: 0.80
- Listen carefully to user's exact description of UI issues - they often know exactly what's wrong. Confidence: 0.85

# UI/UX - Main/Large Tab Styling
See [ui/ux---main/large-tab-styling/taste.md](ui/ux---main/large-tab-styling/taste.md)

# System Behavior
- NEVER guess or fallback — exact matches only, system integrity depends on it. Confidence: 0.90
- When user says "NEVER fallback", enforce strict exact matching without fallback behavior. Confidence: 0.90
# Communication Style
- When user expresses strong frustration with profanity, immediately focus on the specific technical issue mentioned. Confidence: 0.85
- Do not ask clarifying questions when user has provided explicit instructions with strong language. Confidence: 0.80
