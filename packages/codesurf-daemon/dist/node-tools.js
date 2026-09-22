export const NODE_TOOL_SCOPE_PREFIX = 'tool:';
export const CODESURF_MCP_TOOL_PREFIX = 'mcp__codesurf__';
export const NODE_MCP_TOOLSETS = {
    terminal: [
        {
            name: 'terminal_send_input',
            description: 'Send raw input text to a terminal tile for command execution.',
            inputSchema: {
                type: 'object',
                properties: {
                    tile_id: { type: 'string', description: 'Target terminal tile id' },
                    input: { type: 'string', description: 'Text to send into the terminal' },
                    enter: { type: 'boolean', description: 'Whether to append a newline after the input (default true)' },
                },
                required: ['tile_id', 'input'],
            },
        },
        {
            name: 'terminal_clear',
            description: 'Clear the terminal screen for a connected terminal tile.',
            inputSchema: {
                type: 'object',
                properties: {
                    tile_id: { type: 'string', description: 'Target terminal tile id' },
                },
                required: ['tile_id'],
            },
        },
    ],
    browser: [
        {
            name: 'browser_navigate',
            description: 'Navigate a browser tile to a URL.',
            inputSchema: {
                type: 'object',
                properties: {
                    tile_id: { type: 'string', description: 'Target browser tile id' },
                    url: { type: 'string', description: 'Destination URL or search query' },
                },
                required: ['tile_id', 'url'],
            },
        },
        {
            name: 'browser_reload',
            description: 'Reload the current page in a browser tile.',
            inputSchema: {
                type: 'object',
                properties: {
                    tile_id: { type: 'string', description: 'Target browser tile id' },
                },
                required: ['tile_id'],
            },
        },
        {
            name: 'browser_back',
            description: 'Navigate one step back in a browser tile history.',
            inputSchema: {
                type: 'object',
                properties: {
                    tile_id: { type: 'string', description: 'Target browser tile id' },
                },
                required: ['tile_id'],
            },
        },
        {
            name: 'browser_forward',
            description: 'Navigate one step forward in a browser tile history.',
            inputSchema: {
                type: 'object',
                properties: {
                    tile_id: { type: 'string', description: 'Target browser tile id' },
                },
                required: ['tile_id'],
            },
        },
        {
            name: 'browser_set_mode',
            description: 'Switch a browser tile between desktop and mobile viewport mode.',
            inputSchema: {
                type: 'object',
                properties: {
                    tile_id: { type: 'string', description: 'Target browser tile id' },
                    mode: { type: 'string', enum: ['desktop', 'mobile'], description: 'Viewport mode' },
                },
                required: ['tile_id', 'mode'],
            },
        },
    ],
    chat: [
        {
            name: 'chat_send_message',
            description: 'Send a short message to a peer chat tile to synchronize context or ask a direct follow-up.',
            inputSchema: {
                type: 'object',
                properties: {
                    tile_id: { type: 'string', description: 'Target chat tile id' },
                    message: { type: 'string', description: 'Message to send to the peer chat tile' },
                },
                required: ['tile_id', 'message'],
            },
        },
        {
            name: 'chat_acknowledge',
            description: 'Acknowledge receipt of a peer chat message or task handoff.',
            inputSchema: {
                type: 'object',
                properties: {
                    tile_id: { type: 'string', description: 'Target chat tile id' },
                    note: { type: 'string', description: 'Acknowledgment text (short)' },
                },
                required: ['tile_id', 'note'],
            },
        },
    ],
    kanban: [
        {
            name: 'kanban_set_status',
            description: 'Broadcast a kanban tile progress or status update.',
            inputSchema: {
                type: 'object',
                properties: {
                    tile_id: { type: 'string', description: 'Target kanban tile id' },
                    message: { type: 'string', description: 'Status note' },
                },
                required: ['tile_id', 'message'],
            },
        },
        {
            name: 'kanban_create_card',
            description: 'Create a new card on a connected kanban tile.',
            inputSchema: {
                type: 'object',
                properties: {
                    tile_id: { type: 'string', description: 'Target kanban tile id' },
                    title: { type: 'string', description: 'Card title' },
                    description: { type: 'string', description: 'Short description' },
                    instructions: { type: 'string', description: 'Detailed instructions' },
                    column_id: { type: 'string', description: 'Target column id' },
                    agent: { type: 'string', description: 'Agent id' },
                    model: { type: 'string', description: 'Model id' },
                    tools: { type: 'array', items: { type: 'string' }, description: 'Tool ids' },
                    file_refs: { type: 'array', items: { type: 'string' }, description: 'File paths' },
                    card_refs: { type: 'array', items: { type: 'string' }, description: 'Dependent card ids/titles' },
                    color: { type: 'string', description: 'Card accent color' },
                },
                required: ['tile_id', 'title'],
            },
        },
        {
            name: 'kanban_update_card',
            description: 'Update an existing card on a connected kanban tile.',
            inputSchema: {
                type: 'object',
                properties: {
                    tile_id: { type: 'string', description: 'Target kanban tile id' },
                    card_id: { type: 'string', description: 'Card id to update' },
                    title: { type: 'string' },
                    description: { type: 'string' },
                    instructions: { type: 'string' },
                    column_id: { type: 'string' },
                    agent: { type: 'string' },
                    model: { type: 'string' },
                    tools: { type: 'array', items: { type: 'string' } },
                    file_refs: { type: 'array', items: { type: 'string' } },
                    card_refs: { type: 'array', items: { type: 'string' } },
                    color: { type: 'string' },
                    launched: { type: 'boolean' },
                },
                required: ['tile_id', 'card_id'],
            },
        },
        {
            name: 'kanban_move_card',
            description: 'Move a card to another column on a connected kanban tile.',
            inputSchema: {
                type: 'object',
                properties: {
                    tile_id: { type: 'string', description: 'Target kanban tile id' },
                    card_id: { type: 'string', description: 'Card id' },
                    column_id: { type: 'string', description: 'Destination column id' },
                },
                required: ['tile_id', 'card_id', 'column_id'],
            },
        },
        {
            name: 'kanban_pause_card',
            description: 'Pause a running card on a connected kanban tile.',
            inputSchema: {
                type: 'object',
                properties: {
                    tile_id: { type: 'string', description: 'Target kanban tile id' },
                    card_id: { type: 'string', description: 'Card id' },
                },
                required: ['tile_id', 'card_id'],
            },
        },
        {
            name: 'kanban_delete_card',
            description: 'Delete a card from a connected kanban tile.',
            inputSchema: {
                type: 'object',
                properties: {
                    tile_id: { type: 'string', description: 'Target kanban tile id' },
                    card_id: { type: 'string', description: 'Card id' },
                },
                required: ['tile_id', 'card_id'],
            },
        },
        {
            name: 'kanban_create_column',
            description: 'Create a new column/list on a connected kanban tile.',
            inputSchema: {
                type: 'object',
                properties: {
                    tile_id: { type: 'string', description: 'Target kanban tile id' },
                    title: { type: 'string', description: 'Column title' },
                    column_id: { type: 'string', description: 'Optional explicit column id' },
                },
                required: ['tile_id', 'title'],
            },
        },
        {
            name: 'kanban_rename_column',
            description: 'Rename a column/list on a connected kanban tile.',
            inputSchema: {
                type: 'object',
                properties: {
                    tile_id: { type: 'string', description: 'Target kanban tile id' },
                    column_id: { type: 'string', description: 'Column id' },
                    title: { type: 'string', description: 'New title' },
                },
                required: ['tile_id', 'column_id', 'title'],
            },
        },
        {
            name: 'kanban_delete_column',
            description: 'Delete a column/list and its cards from a connected kanban tile.',
            inputSchema: {
                type: 'object',
                properties: {
                    tile_id: { type: 'string', description: 'Target kanban tile id' },
                    column_id: { type: 'string', description: 'Column id' },
                },
                required: ['tile_id', 'column_id'],
            },
        },
    ],
    note: [
        {
            name: 'note_append_context',
            description: 'Append text to a note tile. Adds to the end of existing content.',
            inputSchema: {
                type: 'object',
                properties: {
                    tile_id: { type: 'string', description: 'Target note tile id' },
                    snippet: { type: 'string', description: 'Text snippet to append' },
                },
                required: ['tile_id', 'snippet'],
            },
        },
        {
            name: 'note_read_content',
            description: 'Read the current content of a note tile.',
            inputSchema: {
                type: 'object',
                properties: {
                    tile_id: { type: 'string', description: 'Target note tile id' },
                },
                required: ['tile_id'],
            },
        },
        {
            name: 'note_write_content',
            description: 'Replace the entire content of a note tile.',
            inputSchema: {
                type: 'object',
                properties: {
                    tile_id: { type: 'string', description: 'Target note tile id' },
                    content: { type: 'string', description: 'New content for the note' },
                },
                required: ['tile_id', 'content'],
            },
        },
    ],
    code: [
        {
            name: 'code_open_file',
            description: 'Open or re-focus a specific file path in a connected code tile.',
            inputSchema: {
                type: 'object',
                properties: {
                    tile_id: { type: 'string', description: 'Target code tile id' },
                    file_path: { type: 'string', description: 'File path to open' },
                },
                required: ['tile_id', 'file_path'],
            },
        },
    ],
    file: [
        {
            name: 'file_open_context',
            description: 'Send a context hint to a file tile to surface related paths.',
            inputSchema: {
                type: 'object',
                properties: {
                    tile_id: { type: 'string', description: 'Target file tile id' },
                    context: { type: 'string', description: 'Context hint or search phrase' },
                },
                required: ['tile_id', 'context'],
            },
        },
    ],
    image: [
        {
            name: 'image_annotate',
            description: 'Send an annotation note related to a visible image tile.',
            inputSchema: {
                type: 'object',
                properties: {
                    tile_id: { type: 'string', description: 'Target image tile id' },
                    note: { type: 'string', description: 'Annotation note text' },
                },
                required: ['tile_id', 'note'],
            },
        },
        {
            name: 'image_edit_request',
            description: 'Edit a connected image tile through the configured image provider. On success the canvas replaces the image source; on failure the tool returns the provider/setup error.',
            inputSchema: {
                type: 'object',
                properties: {
                    tile_id: { type: 'string', description: 'Target image tile id' },
                    prompt: { type: 'string', description: 'Edit instruction, e.g. "add a caption at the bottom"' },
                    provider: { type: 'string', description: 'Preferred image provider, e.g. gemini, openai, local' },
                    model: { type: 'string', description: 'Preferred image model, e.g. gemini-2.5-flash-image' },
                    mask_path: { type: 'string', description: 'Optional mask image path for inpainting/edit regions' },
                    output_path: { type: 'string', description: 'Optional desired output file path' },
                },
                required: ['tile_id', 'prompt'],
            },
        },
        {
            name: 'image_generate_variation',
            description: 'Generate a provider-backed variation of a connected image tile. On success the canvas replaces the image source; on failure the tool returns the provider/setup error.',
            inputSchema: {
                type: 'object',
                properties: {
                    tile_id: { type: 'string', description: 'Target image tile id' },
                    prompt: { type: 'string', description: 'Optional direction for the variation' },
                    provider: { type: 'string', description: 'Preferred image provider, e.g. gemini, openai, local' },
                    model: { type: 'string', description: 'Preferred image model, e.g. gemini-2.5-flash-image' },
                    output_path: { type: 'string', description: 'Optional desired output file path' },
                },
                required: ['tile_id'],
            },
        },
        {
            name: 'image_replace_source',
            description: 'Replace the visible source file for a connected image tile after an image edit or variation has been written to disk.',
            inputSchema: {
                type: 'object',
                properties: {
                    tile_id: { type: 'string', description: 'Target image tile id' },
                    file_path: { type: 'string', description: 'Absolute path to the replacement image file' },
                    note: { type: 'string', description: 'Optional note describing the edit that produced this file' },
                },
                required: ['tile_id', 'file_path'],
            },
        },
    ],
    universal: [
        {
            name: 'tile_context_get',
            description: 'Read context entries from a tile. Agents can read any tile context across workspaces.',
            inputSchema: {
                type: 'object',
                properties: {
                    tile_id: { type: 'string', description: 'The tile ID to read context from' },
                    workspace_id: { type: 'string', description: 'The workspace ID (optional; uses first workspace if omitted)' },
                    tag: { type: 'string', description: 'Filter by tag prefix (e.g., "ctx:design"; optional)' },
                },
                required: ['tile_id'],
            },
        },
        {
            name: 'tile_context_set',
            description: 'Write a context entry to a tile. Agents can write to any tile context across workspaces.',
            inputSchema: {
                type: 'object',
                properties: {
                    tile_id: { type: 'string', description: 'The tile ID to write context to' },
                    workspace_id: { type: 'string', description: 'The workspace ID (optional; uses first workspace if omitted)' },
                    key: { type: 'string', description: 'Context key (e.g., "ctx:design:palette")' },
                    value: { description: 'Context value (any JSON-serializable value)' },
                },
                required: ['tile_id', 'key', 'value'],
            },
        },
    ],
};
const EXTENSION_PLACEHOLDER_TOOLS = [];
export function getTileNodeTools(tileType) {
    if (tileType.startsWith('ext:'))
        return EXTENSION_PLACEHOLDER_TOOLS;
    return NODE_MCP_TOOLSETS[tileType] ?? [];
}
export function getAllNodeToolNames(tileType) {
    return getTileNodeTools(tileType).map(tool => tool.name);
}
export function getNodeToolSchemaByName(name) {
    for (const tools of Object.values(NODE_MCP_TOOLSETS)) {
        const match = tools.find(tool => tool.name === name);
        if (match)
            return match;
    }
    return undefined;
}
export function getAllNodeTools() {
    const out = [];
    for (const tools of Object.values(NODE_MCP_TOOLSETS)) {
        out.push(...tools);
    }
    return out;
}
export function getPeerBridgeNodeTools() {
    const out = [];
    for (const [scope, tools] of Object.entries(NODE_MCP_TOOLSETS)) {
        if (scope === 'universal')
            continue;
        out.push(...tools);
    }
    return out;
}
export function withCapabilityPrefix(toolName) {
    return `${NODE_TOOL_SCOPE_PREFIX}${toolName}`;
}
export function stripCapabilityPrefix(raw) {
    if (raw.startsWith(NODE_TOOL_SCOPE_PREFIX))
        return raw.slice(NODE_TOOL_SCOPE_PREFIX.length);
    return raw;
}
export function toCodesurfMcpToolName(toolName) {
    return `${CODESURF_MCP_TOOL_PREFIX}${toolName}`;
}
export function normalizeNodeToolName(raw) {
    let name = stripCapabilityPrefix(raw);
    if (name.startsWith(CODESURF_MCP_TOOL_PREFIX))
        name = name.slice(CODESURF_MCP_TOOL_PREFIX.length);
    return name;
}
export function getDisconnectedPeerBridgeMcpToolNames(negotiatedTools = []) {
    const negotiated = new Set(Array.from(negotiatedTools, normalizeNodeToolName));
    return getPeerBridgeNodeTools()
        .filter(tool => !negotiated.has(tool.name))
        .map(tool => toCodesurfMcpToolName(tool.name))
        .sort();
}
export function buildPeerCommandPayload(tileId, command, payload = {}) {
    return {
        ...payload,
        tileId,
        cardId: tileId,
        command,
    };
}
