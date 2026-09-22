import type { JSX } from 'react'
import type { Persona } from '../../../shared/types'
import { DEFAULT_PERSONAS, overlayPersonas } from '../../../shared/agentModes'

// ─── Shared Persona source ────────────────────────────────────────────────────
// The built-in personas + the parse/overlay/inherit logic now live in the
// dependency-free src/shared/agentModes.ts so the Electron main process (the
// authoritative SEND-time resolver) and the renderer share ONE source of truth.
// This file keeps the renderer-only concerns: the icon/palette JSX and the
// window.electron.fs-backed loader used for DISPLAY. BACK-COMPAT: the persisted
// override store is still `${workspace}/.codesurf/customisation/agents.json`.
//
// NOTE: loadPersonas below is DISPLAY-only now. The SEND path no longer trusts
// it — main re-resolves the selected agentId authoritatively (see
// src/main/chat/agent-mode-resolver.ts). Its lenient "missing/parse-error →
// built-ins" behaviour is therefore safe to keep (it never widens an enforced
// permission), and changing it would churn the existing load-race tests.

export { DEFAULT_PERSONAS }

export const AGENT_COLORS = ['#3568ff', '#56c288', '#f5a623', '#e57399', '#b368c9', '#00acd7', '#ff7b72', '#8f96a0']

export const AGENT_ICONS: Record<string, JSX.Element> = {
  robot: <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><rect x="2" y="4" width="10" height="8" rx="2" stroke="currentColor" strokeWidth="1.2" /><circle cx="5" cy="8" r="1" fill="currentColor" /><circle cx="9" cy="8" r="1" fill="currentColor" /><path d="M7 1v3M5 1h4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" /></svg>,
  help: <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="7" r="6" stroke="currentColor" strokeWidth="1.2" /><path d="M5.5 5.5a1.5 1.5 0 012.8.8c0 1-1.3 1.2-1.3 2.2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" /><circle cx="7" cy="10.5" r="0.5" fill="currentColor" /></svg>,
  map: <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M1 3l4-1.5 4 1.5 4-1.5v9.5l-4 1.5-4-1.5L1 12.5V3z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" /><path d="M5 1.5v10M9 3.5v10" stroke="currentColor" strokeWidth="1.2" /></svg>,
  star: <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 1l1.8 3.6L13 5.2l-3 2.9.7 4.1L7 10.3 3.3 12.2l.7-4.1-3-2.9 4.2-.6L7 1z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" /></svg>,
  bolt: <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7.5 1L3 8h4l-.5 5L11 6H7l.5-5z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" /></svg>,
}

export function getAgentIcon(name: string | undefined): JSX.Element {
  return AGENT_ICONS[name ?? ''] ?? AGENT_ICONS.robot
}

function agentsDataDir(workspacePath: string): string {
  return `${workspacePath}/.codesurf/customisation`
}

/**
 * Load the selectable personas for a workspace: the built-in personas merged with
 * any user-authored personas persisted in agents.json (filename retained for
 * back-compat). Mirrors the merge CustomisationTile applies on mount (built-ins
 * first, overlay persisted entries by id, drop ephemeral `discovered-*` scan
 * results which are never persisted, resolve `extends` inheritance).
 * Auto-discovered personas are intentionally NOT scanned here — the selector
 * lists exactly what agents.json names.
 */
export async function loadPersonas(workspacePath: string): Promise<Persona[]> {
  const file = `${agentsDataDir(workspacePath)}/agents.json`
  try {
    const stat = await window.electron.fs.stat(file).catch(() => null)
    if (!stat) return [...DEFAULT_PERSONAS]
    const raw = await window.electron.fs.readFile(file)
    return overlayPersonas(JSON.parse(raw))
  } catch {
    return [...DEFAULT_PERSONAS]
  }
}

/** @deprecated Renamed to {@link loadPersonas}; retained as an alias. */
export const loadAgentModes = loadPersonas
