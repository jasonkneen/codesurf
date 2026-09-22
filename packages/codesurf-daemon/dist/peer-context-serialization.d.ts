/** Safe, deterministic serialization primitives for untrusted prompt context. */
export interface ContextSerializationLimits {
    containerEntries: number;
    depth: number;
    nodes: number;
}
export declare function compareText(left: string, right: string): number;
export declare function toWellFormedText(value: string): string;
export declare function utf8Bytes(value: string): number;
export declare function utf8Prefix(value: string, maxBytes: number): string;
export declare function singleLine(value: string): string;
export declare function readDataProperty(value: object, key: PropertyKey): {
    ok: true;
    value: unknown;
} | {
    ok: false;
};
export declare function safeKeys(value: object): string[] | null;
export declare function safeSerializeContextValue(value: unknown, limits: ContextSerializationLimits): string;
