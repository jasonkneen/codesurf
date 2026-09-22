/** Event severity / category, plus domain-specific tile event names */
export type BusEventType =
  | 'progress'    // task progress update (percent, status text)
  | 'activity'    // log entry (terminal output, agent action)
  | 'task'        // task lifecycle (created, started, completed, failed)
  | 'notification'// alert / toast from any source
  | 'ask'         // agent asking for human input
  | 'answer'      // human responding to an ask
  | 'data'        // arbitrary structured data payload
  | 'system'      // internal bus events (subscribe, unsubscribe, error)
  | 'tool_inventory'   // chat tile tool catalog snapshot
  | 'skill_inventory'  // chat tile skill catalog snapshot
  | 'tool_start'       // tool invocation started
  | 'tool'             // tool invocation finished
  | 'file'             // file reference / open
  | 'file_activity'    // file edit activity
  | 'note'             // contextual note
  | 'browser.evidence.snapshot'
  | 'browser.page_health'
  | 'browser.evidence'
  | 'extension-crashed'   // broker: power extension child process crashed unexpectedly

/** A single event on the bus */
export interface BusEvent {
  id: string
  channel: string          // e.g. "tile:abc123", "workspace:global", "agent:xyz"
  type: BusEventType
  source: string           // who published — tile ID, MCP tool name, "browser:postMessage", etc.
  timestamp: number
  payload: Record<string, unknown>
}

/** Subscription handle */
export interface BusSubscription {
  id: string
  channel: string          // supports wildcards: "tile:*", "*"
  subscriberId: string     // who subscribed — usually a tile ID
}

/** Channel metadata (optional, for UI display) */
export interface ChannelInfo {
  name: string             // human-readable label
  channel: string          // bus channel pattern
  unread: number           // unread event count for badge
  lastEvent?: BusEvent     // most recent event
}
