import type { DaemonChatJobEvent } from './types.js';
export declare const DAEMON_SSE_LIMITS: Readonly<{
    maxFrameBytes: number;
    maxWireBytes: number;
    maxEventPayloadBytes: number;
    maxErrorBodyBytes: number;
    maxStringBytes: number;
    maxArrayItems: 128;
    maxQuestions: 16;
    maxQuestionOptions: 32;
}>;
export type DaemonSseLimitKind = 'frame' | 'wire' | 'event-payload' | 'string' | 'array';
export declare class DaemonSseLimitError extends Error {
    readonly kind: DaemonSseLimitKind;
    readonly actual: number;
    readonly limit: number;
    constructor(kind: DaemonSseLimitKind, actual: number, limit: number);
}
export declare class DaemonChatEventValidationError extends Error {
    constructor(message: string);
}
export interface ParsedSseJsonBuffer<T> {
    events: T[];
    errors: Error[];
    remaining: string;
}
export interface ParseSseJsonBufferOptions {
    maxFrameBytes?: number;
}
export interface BoundedSseJsonDecoderOptions extends ParseSseJsonBufferOptions {
    maxWireBytes?: number;
}
export declare function parseSseJsonBuffer<T = unknown>(buffer: string, options?: ParseSseJsonBufferOptions): ParsedSseJsonBuffer<T>;
/** Incremental UTF-8 SSE decoder with per-frame and whole-stream wire limits. */
export declare class BoundedSseJsonDecoder<T = unknown> {
    private readonly decoder;
    private readonly maxFrameBytes;
    private readonly maxWireBytes;
    private remaining;
    private wireBytes;
    private finished;
    constructor(options?: BoundedSseJsonDecoderOptions);
    push(chunk: Uint8Array): ParsedSseJsonBuffer<T>;
    finish(): ParsedSseJsonBuffer<T>;
    private append;
}
/** Drains a small HTTP diagnostic body and cancels the stream once capped. */
export declare function readBoundedResponseDiagnostic(response: Response, maxBytes?: number): Promise<string>;
export interface SanitizeDaemonChatJobEventOptions {
    expectedJobId?: string;
}
/**
 * Copies only renderer/CLI-supported daemon fields into a fresh plain object.
 * In particular, host-authored trust/provenance flags are never accepted from
 * SSE, and nested arrays are reconstructed from their documented fields.
 */
export declare function sanitizeDaemonChatJobEvent(value: unknown, options?: SanitizeDaemonChatJobEventOptions): DaemonChatJobEvent;
export interface DaemonChatEventBudgetOptions extends SanitizeDaemonChatJobEventOptions {
    maxEventPayloadBytes?: number;
}
/** Whole-turn budget for sanitized, model-visible daemon event payloads. */
export declare class DaemonChatEventBudget {
    private readonly options;
    private readonly maxEventPayloadBytes;
    private eventPayloadBytes;
    constructor(options?: DaemonChatEventBudgetOptions);
    sanitize(value: unknown): DaemonChatJobEvent;
    consume(event: DaemonChatJobEvent): DaemonChatJobEvent;
    accept(value: unknown): DaemonChatJobEvent;
}
