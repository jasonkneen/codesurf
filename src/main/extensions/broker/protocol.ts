/**
 * Broker IPC contract — Phase 1a (types only, no behaviour change).
 *
 * Defines the message protocol between the main process (broker host) and a
 * child `utilityProcess` running extension code. Reuses the JSON-RPC 2.0
 * framing already established in `src/main/owl/runtime.ts` (JsonRpcPeer),
 * which provides newline-delimited message transport with partial-buffer
 * reassembly and error envelopes.
 *
 * NOTHING imports this file yet beyond its own types. No behaviour changes.
 * Next steps: Phase 1b (capability proxy in child process) and Phase 1c
 * (utilityProcess host) will import and implement these contracts.
 */

// ── Primitive types (shared with OWL JSON-RPC layer) ────────────────────────

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }
export type JsonObject = { [key: string]: JsonValue }

// ── Error codes ──────────────────────────────────────────────────────────────

/**
 * Broker-level error codes surfaced in `BrokerErrorResponse.error.code`.
 * Negative values follow the JSON-RPC 2.0 reserved range convention.
 */
export type BrokerErrorCode =
  | 'capability-denied'   // extension called a capability it was not granted
  | 'capability-unknown'  // capability name not registered in main
  | 'method-unknown'      // broker lifecycle/control method not found
  | 'invalid-params'      // malformed request params
  | 'host-crashed'        // the extension host process crashed unexpectedly
  | 'deactivated'         // extension has been deactivated; call rejected
  | 'internal-error'      // unclassified broker-side error

/** Numeric codes map for BrokerErrorCode (JSON-RPC-style) */
export const BROKER_ERROR_CODES: Record<BrokerErrorCode, number> = {
  'capability-denied': -32001,
  'capability-unknown': -32002,
  'method-unknown': -32603,
  'invalid-params': -32602,
  'host-crashed': -32003,
  'deactivated': -32004,
  'internal-error': -32000,
}

// ── JSON-RPC envelope types ──────────────────────────────────────────────────

/** Base request envelope (child → main for capability calls; main → child for lifecycle). */
export interface BrokerRequest {
  jsonrpc: '2.0'
  id: number
  method: string
  params: JsonObject
}

export interface BrokerSuccessResponse {
  jsonrpc: '2.0'
  id: number
  result: JsonValue
}

export interface BrokerErrorResponse {
  jsonrpc: '2.0'
  id: number
  error: {
    code: number
    message: string
    data?: { brokerCode: BrokerErrorCode }
  }
}

export type BrokerResponse = BrokerSuccessResponse | BrokerErrorResponse

// ── Lifecycle messages (main → child) ───────────────────────────────────────

/**
 * `broker.activate` — sent by main to child immediately after the utilityProcess
 * starts. The child runs `extension.activate(ctx)` and replies with a result.
 */
export interface ActivateParams extends JsonObject {
  /** Extension manifest id. */
  extensionId: string
  /** Absolute path to the extension's main entry file. */
  entryPath: string
  /** Granted capability keys (subset of ExtensionContext surface). */
  grantedCapabilities: string[]
  /** Extension settings (manifest defaults merged with persisted values). */
  settings: JsonObject
  /** Initial plugin-store state. */
  storeState: JsonObject
  /**
   * Active workspace directory at activation time, or null when none is open.
   * Required (not optional) because `ActivateParams extends JsonObject`, whose
   * index signature is `JsonValue` — an optional property widens to include
   * `undefined`, which is not a `JsonValue`. Senders pass explicit null.
   */
  workspacePath: string | null
}

export interface ActivateResult extends JsonObject {
  /** Whether activation succeeded. */
  activated: boolean
}

/**
 * `broker.deactivate` — sent by main when the extension is being unloaded or
 * the app is quitting. The child calls the cleanup function returned by activate.
 */
export interface DeactivateParams extends JsonObject {
  extensionId: string
  /** Reason for deactivation (quit | update | disable | error). */
  reason: string
}

export interface DeactivateResult extends JsonObject {
  deactivated: boolean
}

// ── Capability-call messages (child → main) ──────────────────────────────────

/**
 * `broker.capability` — the child proxy calls this whenever extension code
 * invokes a ctx.xxx method. Main validates against `grantedCapabilities` before
 * executing.
 *
 * Example: `ctx.bus.publish('tile:123', 'focus', {})` becomes:
 *   method: 'broker.capability'
 *   params: { capability: 'bus', method: 'publish', args: ['tile:123', 'focus', {}] }
 */
export interface CapabilityCallParams extends JsonObject {
  /** Top-level capability name (bus | mcp | ipc | settings | store | relayHost). */
  capability: string
  /** Method name within the capability (e.g. 'publish', 'registerTool'). */
  method: string
  /** Positional arguments serialised as a JSON array. */
  args: JsonValue[]
}

export interface CapabilityCallResult extends JsonObject {
  /** Serialised return value of the capability method call. */
  returnValue: JsonValue
}

// ── Event-emit messages (child → main, notification, no id) ─────────────────

/**
 * `broker.event` — child emits a bus event originating from extension code
 * (e.g. bus.subscribe callback invoking bus.publish on its own behalf).
 * No response expected; this is a one-way notification.
 */
export interface BrokerEventNotification {
  jsonrpc: '2.0'
  method: 'broker.event'
  params: {
    channel: string
    type: string
    payload: JsonObject
  }
}

// ── Store-update push (main → child, notification) ───────────────────────────

/**
 * `broker.storeUpdate` — main broadcasts store state changes to the child so
 * the extension's `store.get()` always returns fresh data without round-tripping.
 */
export interface BrokerStoreUpdateNotification {
  jsonrpc: '2.0'
  method: 'broker.storeUpdate'
  params: {
    extensionId: string
    state: JsonObject
  }
}

// ── Reverse-RPC messages (main → child for registered callbacks) ─────────────

/**
 * `broker.invokeTool` — main calls the child to invoke an MCP tool handler
 * registered by the extension via ctx.mcp.registerTool.
 */
export interface InvokeToolParams extends JsonObject {
  /** The registration id returned at registerTool time. */
  registrationId: string
  /** Tool call arguments. */
  args: JsonObject
}

export interface InvokeToolResult extends JsonObject {
  /** String result from the tool handler. */
  result: string
}

/**
 * `broker.invokeIpc` — main calls the child to invoke an IPC handler registered
 * via ctx.ipc.handle.
 */
export interface InvokeIpcParams extends JsonObject {
  /** Fully qualified channel name (ext:{id}:{channel}). */
  channel: string
  /** Arguments to the handler. */
  args: JsonValue[]
}

export interface InvokeIpcResult extends JsonObject {
  returnValue: JsonValue
}

/**
 * `broker.busEvent` — main pushes a bus event to a subscriber registered in
 * the child via ctx.bus.subscribe.
 */
export interface BusEventParams extends JsonObject {
  /** The subscription id returned from ctx.bus.subscribe in the child. */
  subscriptionId: string
  /** The serialised bus event payload. */
  event: JsonObject
}

// ── Type guard helpers ───────────────────────────────────────────────────────

export function isBrokerRequest(msg: unknown): msg is BrokerRequest {
  return (
    typeof msg === 'object' && msg !== null &&
    (msg as BrokerRequest).jsonrpc === '2.0' &&
    typeof (msg as BrokerRequest).id === 'number' &&
    typeof (msg as BrokerRequest).method === 'string'
  )
}

export function isBrokerResponse(msg: unknown): msg is BrokerResponse {
  return (
    typeof msg === 'object' && msg !== null &&
    (msg as BrokerResponse).jsonrpc === '2.0' &&
    typeof (msg as BrokerResponse).id === 'number' &&
    ('result' in (msg as object) || 'error' in (msg as object))
  )
}

export function isBrokerNotification(msg: unknown): msg is BrokerEventNotification | BrokerStoreUpdateNotification {
  return (
    typeof msg === 'object' && msg !== null &&
    (msg as BrokerEventNotification).jsonrpc === '2.0' &&
    !('id' in (msg as object)) &&
    typeof (msg as BrokerEventNotification).method === 'string'
  )
}

export function isBrokerErrorResponse(res: BrokerResponse): res is BrokerErrorResponse {
  return 'error' in res
}
