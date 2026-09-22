import { type ContextualPromptFragment } from './contextual-fragments.js';
export declare const CHAT_CONTEXT_LIMITS: Readonly<{
    readonly aggregateBytes: 10000;
    readonly personaBytes: 800;
    readonly memoryBytes: 800;
    readonly skillsBytes: 800;
    readonly outputConventionBytes: 800;
    readonly insightConventionBytes: 800;
    readonly activityConventionBytes: 800;
    readonly asyncBytes: 800;
    readonly peerBytes: 1000;
    readonly roomBytes: 800;
    readonly fileReferenceBytes: 800;
    readonly recentEditBytes: 800;
    readonly blockNotesBytes: 800;
}>;
/** Exact payload budgets after the composer's mandatory framing is counted. */
export declare const CHAT_CONTEXT_BODY_LIMITS: Readonly<{
    readonly roomBytes: number;
    readonly fileReferenceBytes: number;
    readonly recentEditBytes: number;
    readonly blockNotesBytes: number;
}>;
export type ChatContextFragmentKind = 'persona' | 'memory' | 'skills' | 'output-convention' | 'insight-convention' | 'activity-convention' | 'async' | 'peer' | 'room' | 'file-reference' | 'recent-edit' | 'block-notes';
export interface ChatContextComposerInput {
    persona?: unknown;
    memory?: unknown;
    skills?: unknown;
    outputConvention?: unknown;
    insightConvention?: unknown;
    activityConvention?: unknown;
    async?: unknown;
    peer?: unknown;
    room?: unknown;
    fileReferences?: unknown;
    recentEdit?: unknown;
    blockNotes?: unknown;
}
export interface ComposedChatContextFragment extends ContextualPromptFragment<'chat-context-composer'> {
    kind: ChatContextFragmentKind;
    placement: 'system' | 'user';
    trust: 'host' | 'untrusted-data';
    precedence: number;
    originalBytes: number;
    includedBytes: number;
    truncated: boolean;
}
export interface ComposedChatContext {
    systemPrompt: string | undefined;
    userSuffix: string | undefined;
    fragments: readonly ComposedChatContextFragment[];
    metadata: {
        aggregateBytes: number;
        maxAggregateBytes: number;
        truncatedFragmentCount: number;
    };
}
/**
 * Compose every model-visible host context source in stable-to-volatile order.
 * Room traffic and expanded file contents remain explicitly untrusted user
 * data; providers must append `userSuffix` to the latest user turn rather than
 * moving it into a system prompt.
 */
export declare function composeChatContext(input: ChatContextComposerInput): ComposedChatContext;
