export declare const MAX_PERSONA_DOCUMENT_BYTES: number;
export declare const MAX_PERSONA_COUNT = 128;
export declare const MAX_PERSONA_ID_BYTES = 64;
export declare const MAX_PERSONA_PROMPT_BYTES: number;
export declare const MAX_PERSONA_INHERITANCE_DEPTH = 8;
export declare const MAX_PERSONA_TOOLS = 128;
export type ChatPolicyErrorCode = 'CHAT_WORKSPACE_REQUIRED' | 'CHAT_WORKSPACE_UNKNOWN' | 'CHAT_WORKSPACE_MISMATCH' | 'CHAT_PERSONA_INVALID' | 'CHAT_PERSONA_DENIED' | 'CHAT_PERSONA_PROVIDER_UNSUPPORTED';
export declare class ChatPolicyError extends Error {
    readonly code: ChatPolicyErrorCode;
    constructor(code: ChatPolicyErrorCode, message: string);
}
export interface PolicyPersonaBinding {
    provider?: string;
    model?: string;
}
export interface PolicyPersona {
    id: string;
    name: string;
    description: string;
    systemPrompt: string;
    tools: string[] | null;
    icon: string;
    color: string;
    isBuiltin: boolean;
    defaultNextMode?: string;
    defaultBinding?: PolicyPersonaBinding;
    extends?: string;
    skills?: string[];
    source?: string;
}
export declare const DEFAULT_PERSONAS: PolicyPersona[];
export declare function overlayAuthoritativePersonas(document: unknown): PolicyPersona[];
export declare const AGENT_MODE_RESOLUTION_DENIED_ERROR = "The selected agent could not be verified against the workspace agent definitions. Refusing to launch rather than fall back to looser permissions.";
export declare function resolveAuthoritativePersona(options: {
    agentId: unknown;
    workspaceRoot: unknown;
}): Promise<{
    ok: true;
    agentMode: PolicyPersona | null;
} | {
    ok: false;
    error: string;
}>;
export declare function listAuthoritativePersonas(workspaceRoot: unknown): Promise<PolicyPersona[]>;
export declare function bindChatRequestToWorkspace<T extends Record<string, unknown>>(request: T, workspace: {
    id: string;
    path: string;
}): Promise<T & {
    workspaceId: string;
    workspaceDir: string;
}>;
export declare function assertProviderPersonaEnforceable(providerValue: unknown, persona: PolicyPersona | null): void;
export declare function codexExecPermissionArgs(modeValue: unknown): string[];
export declare function stripUntrustedPrivilegedChatContext<T extends Record<string, unknown>>(request: T): T;
