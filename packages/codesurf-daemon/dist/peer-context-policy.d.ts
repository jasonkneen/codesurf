/**
 * Provider-bound peer context policy.
 *
 * Peer discovery originates in the renderer (or a remote daemon caller), so
 * every field must be treated as untrusted at the final provider boundary.
 * This package-local module is the canonical policy shared by every host and
 * the daemon runtime. Every field is bounded at the provider boundary.
 */
import { type ContextualPromptFragment } from './contextual-fragments.js';
export declare const PEER_CONTEXT_LIMITS: Readonly<{
    readonly peers: 16;
    readonly peerIdBytes: 128;
    readonly peerTypeBytes: 64;
    readonly toolsPerPeer: 48;
    readonly toolNameBytes: 128;
    readonly actionsPerPeer: 24;
    readonly actionNameBytes: 128;
    readonly actionDescriptionBytes: 512;
    readonly contextEntriesPerPeer: 32;
    readonly contextKeyBytes: 128;
    readonly contextValueBytes: 1024;
    readonly contextNodesPerValue: 128;
    readonly contextDepth: 6;
    readonly containerEntries: 32;
    readonly collectionInspectionEntries: 256;
    readonly peerRenderedBytes: 256;
    readonly promptRenderedBytes: 1000;
}>;
export interface BoundedPeerAction {
    name: string;
    description: string;
}
export interface BoundedPeerContextEntry {
    key: string;
    value: string;
}
export interface BoundedPeerContext {
    peerId: string;
    peerType: string;
    tools: string[];
    actions: BoundedPeerAction[];
    contextEntries: BoundedPeerContextEntry[];
    notices: string[];
}
export interface PeerContextPolicyMetadata {
    originalPeerCount: number;
    includedPeerCount: number;
    omittedPeerCount: number;
    malformedPeerCount: number;
    truncatedFieldCount: number;
    omittedFieldCount: number;
    renderedPeerCount: number;
    renderedBytes: number;
    promptTruncated: boolean;
}
export interface PeerContextPolicyResult {
    peers: BoundedPeerContext[];
    fragment: ContextualPromptFragment<'peer-context-policy'> | undefined;
    metadata: PeerContextPolicyMetadata;
}
export declare function buildPeerContextPrompt(value: unknown): PeerContextPolicyResult;
