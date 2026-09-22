export interface CanvasAuthoritativePeer {
    peerId: string;
    peerType: string;
    tools: string[];
}
/** Resolve host-validated functional topology; persisted canvas is not a model trust root. */
export declare function resolveAuthoritativeCanvasPeers(canvas: unknown, tileIdValue: unknown): CanvasAuthoritativePeer[];
export declare function getAuthoritativeNegotiatedPeerTools(peers: readonly CanvasAuthoritativePeer[], mcpEnabled: boolean | undefined): string[] | undefined;
/** Keep caller observations only for peer IDs already proven by the canvas. */
export declare function selectAuthorizedPeerObservations(value: unknown, authoritativePeers: readonly CanvasAuthoritativePeer[]): unknown[];
