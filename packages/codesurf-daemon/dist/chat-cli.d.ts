import type { DaemonChatJobRequest } from './types.js';
import { type ChatCliSession } from './chat-session-store.js';
import { type PersonaModelSeed } from './persona-model-binding.js';
interface ChatCliRunOptions {
    appDir?: string;
    homeDir?: string;
    getAppVersion?: () => string;
}
interface ParsedChatArgs {
    help: boolean;
    listPersonas: boolean;
    provider: string | null;
    model: string | null;
    mode: string | null;
    /** Selected Persona id (from --persona / --agent), null when unset. */
    persona: string | null;
    workspaceDir: string;
    resume: boolean;
    newSession: boolean;
    message: string | null;
}
interface ResolvedChatArgs extends ParsedChatArgs {
    provider: string;
    model: string;
    mode: string;
    /** Resolved Persona id ('' = no persona). Sent as request.agentId. */
    agentId: string;
}
export declare function parseChatArgs(argv: string[]): ParsedChatArgs;
/**
 * Resolve provider/model/mode with the model-precedence ladder:
 *   1. explicit --provider/--model  (wins)
 *   2. the selected persona's soft defaultBinding (personaSeed; best-effort)
 *   3. the saved session for THIS identity (provider/model/workspace AND persona)
 *   4. built-in defaults
 *
 * `agentId` (the selected persona) is resolved here and threaded into the session
 * identity so resume never crosses a persona change: the saved session is only
 * inherited when its agentId matches the currently-selected persona.
 */
export declare function resolveChatArgs(parsed: ParsedChatArgs, homeDir: string, personaSeed?: PersonaModelSeed | null): ResolvedChatArgs;
/**
 * Build the daemon start request for a turn. SECURITY: this sends ONLY the
 * persona id (`agentId`) and NEVER an `agentMode`. The daemon resolves the
 * persona's tools/permissions authoritatively from trusted local sources; a
 * CLI-supplied `agentMode` would be exactly the trusted-payload injection vector
 * the daemon refuses, so this function must never set it.
 */
export declare function buildStartRequest(params: {
    args: ResolvedChatArgs;
    prior: ChatCliSession | null;
    message: string;
    workspaceId: string;
}): DaemonChatJobRequest;
export declare function runCodesurfChatCli(argv: string[], options?: ChatCliRunOptions): Promise<number>;
export {};
