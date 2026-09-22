export interface ChatCliSession {
    key: string;
    provider: string;
    model: string;
    workspaceDir: string;
    /** Selected Persona id ('' = no persona). Part of the identity so resume never
     *  crosses a persona change. */
    agentId: string;
    sessionId: string | null;
    jobId: string | null;
    lastSequence: number;
    updatedAt: string;
}
export interface ChatCliSessionStore {
    version: 1;
    activeKey: string | null;
    sessions: Record<string, ChatCliSession>;
}
export interface ChatCliSessionIdentity {
    provider: string;
    model: string;
    workspaceDir: string;
    /** Selected Persona id ('' = no persona). */
    agentId?: string | null;
}
export declare function chatCliSessionStorePath(homeDir: string): string;
export declare function normalizeChatCliSessionIdentity(identity: ChatCliSessionIdentity): {
    provider: string;
    model: string;
    workspaceDir: string;
    agentId: string;
};
export declare function chatCliSessionKey(identity: ChatCliSessionIdentity): string;
export declare function readChatCliSessionStore(homeDir: string): ChatCliSessionStore;
export declare function writeChatCliSessionStore(homeDir: string, store: ChatCliSessionStore): void;
export declare function readChatCliSession(homeDir: string, identity: ChatCliSessionIdentity): ChatCliSession | null;
export declare function upsertChatCliSession(homeDir: string, session: Omit<ChatCliSession, 'key' | 'updatedAt' | 'agentId'> & {
    key?: string;
    updatedAt?: string;
    agentId?: string | null;
}): ChatCliSession;
export declare function clearChatCliSession(homeDir: string, identity: ChatCliSessionIdentity): void;
