import { getMatchingHooks, loadHooksConfig } from "./config.js";
import type { HooksConfig } from "./types.js";

const HOOK_COUNT_CACHE_TTL_MS = 2_000;

let cachedConfig: { loadedAt: number; config: HooksConfig } | null = null;
const toolHookCountCache = new Map<string, number>();
const eventHookCountCache = new Map<string, number>();

function getCachedHooksConfig(): HooksConfig {
  const now = Date.now();
  if (!cachedConfig || now - cachedConfig.loadedAt > HOOK_COUNT_CACHE_TTL_MS) {
    cachedConfig = { loadedAt: now, config: loadHooksConfig() };
    toolHookCountCache.clear();
    eventHookCountCache.clear();
  }
  return cachedConfig.config;
}

/** Count configured PreToolUse + PostToolUse hooks that would run for a tool. */
export function countHooksForTool(toolName: string): number {
  try {
    const cached = toolHookCountCache.get(toolName);
    if (cached !== undefined) return cached;
    const config = getCachedHooksConfig();
    const pre = getMatchingHooks(config, "PreToolUse", toolName).length;
    const post = getMatchingHooks(config, "PostToolUse", toolName).length;
    const count = pre + post;
    toolHookCountCache.set(toolName, count);
    return count;
  } catch {
    return 0;
  }
}

/** Count configured hooks for a lifecycle event (e.g. UserPromptSubmit). */
export function countHooksForEvent(eventName: string): number {
  try {
    const cached = eventHookCountCache.get(eventName);
    if (cached !== undefined) return cached;
    const config = getCachedHooksConfig();
    const count = getMatchingHooks(config, eventName as never, undefined).length;
    eventHookCountCache.set(eventName, count);
    return count;
  } catch {
    return 0;
  }
}
