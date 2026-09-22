export type ToolSchema = {
    type: string;
    properties: Record<string, {
        type: string;
        description?: string;
        enum?: string[];
        items?: {
            type: string;
        };
    }>;
    required?: string[];
};
export type NodeMCPTool = {
    name: string;
    description: string;
    inputSchema: {
        type: 'object';
        properties: Record<string, any>;
        required?: string[];
    };
};
export declare const NODE_TOOL_SCOPE_PREFIX = "tool:";
export declare const CODESURF_MCP_TOOL_PREFIX = "mcp__codesurf__";
export declare const NODE_MCP_TOOLSETS: Record<string, NodeMCPTool[]>;
export declare function getTileNodeTools(tileType: string): NodeMCPTool[];
export declare function getAllNodeToolNames(tileType: string): string[];
export declare function getNodeToolSchemaByName(name: string): NodeMCPTool | undefined;
export declare function getAllNodeTools(): NodeMCPTool[];
export declare function getPeerBridgeNodeTools(): NodeMCPTool[];
export declare function withCapabilityPrefix(toolName: string): string;
export declare function stripCapabilityPrefix(raw: string): string;
export declare function toCodesurfMcpToolName(toolName: string): string;
export declare function normalizeNodeToolName(raw: string): string;
export declare function getDisconnectedPeerBridgeMcpToolNames(negotiatedTools?: Iterable<string>): string[];
export declare function buildPeerCommandPayload(tileId: string, command: string, payload?: Record<string, unknown>): Record<string, unknown>;
