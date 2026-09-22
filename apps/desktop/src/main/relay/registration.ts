/** True while Relay Suite (or any code path) has registered relay:* IPC handlers. */
let relayHostActive = false
let relayHostGeneration = 0

export function setRelayHostActive(value: boolean): void {
  if (relayHostActive === value) return
  relayHostActive = value
  relayHostGeneration += 1
}

export function isRelayHostActive(): boolean {
  return relayHostActive
}

export function captureRelayHostGeneration(): number | null {
  return relayHostActive ? relayHostGeneration : null
}

export function isRelayHostGenerationActive(generation: number): boolean {
  return relayHostActive && relayHostGeneration === generation
}
