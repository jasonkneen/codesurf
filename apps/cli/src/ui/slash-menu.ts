export interface SlashMenuItem {
  id: string;
  label: string;
  description?: string;
  aliases?: string[];
}

export const SLASH_MENU_ITEMS: SlashMenuItem[] = [
  { id: "exit", label: "exit", description: "Quit the CLI" },
  { id: "help", label: "help", description: "Show available commands" },
  { id: "remote-control", label: "remote-control", description: "Remote control" },
  { id: "agents", label: "agents", description: "Manage custom sub-agents" },
  { id: "schedule", label: "schedule", description: "View scheduled runs" },
  { id: "mcp", label: "mcp", description: "Manage MCP servers" },
  { id: "sandbox", label: "sandbox", description: "Select shell sandbox mode" },
  { id: "wallet", label: "wallet", description: "Wallet and payment settings" },
  { id: "models", label: "models", description: "Select a model", aliases: ["model", "mode"] },
  { id: "recaps", label: "recaps", description: "Turn session recaps on/off", aliases: ["recap", "summary"] },
  { id: "new", label: "new session", description: "Start a new session" },
  { id: "commit-push", label: "commit & push", description: "Commit and push" },
  { id: "commit-pr", label: "commit & pr", description: "Commit and open PR" },
  { id: "review", label: "review", description: "Review recent changes" },
  { id: "verify", label: "verify", description: "Run local verification" },
  { id: "skills", label: "skills", description: "Manage skills" },
  { id: "flags", label: "flags", description: "Toggle feature flags", aliases: ["feature-flags", "featureflags"] },
  { id: "btw", label: "btw", description: "Ask a side question without interrupting" },
  { id: "feedback", label: "feedback", description: "Rate the last turn (up/down or 0–1)" },
  { id: "update", label: "update", description: "Update codesurf to the latest version" },
];

export function filterSlashMenuItems(items: SlashMenuItem[], query: string): SlashMenuItem[] {
  const normalized = normalizeSlashSearchQuery(query);
  if (!normalized) return items;

  return items
    .map((item, index) => ({ item, index, score: scoreSlashMenuItem(item, normalized) }))
    .filter((entry) => entry.score !== Number.POSITIVE_INFINITY)
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .map((entry) => entry.item);
}

export function filterVisibleSlashItems(items: SlashMenuItem[], query: string): SlashMenuItem[] {
  const normalized = normalizeSlashSearchQuery(query);
  const matches = items.filter((item) => {
    if (normalized === "ui" && (item.id === "quit" || item.id === "exit")) return false;
    if (!normalized) return true;
    return item.label.toLowerCase().includes(normalized) || (item.description ?? "").toLowerCase().includes(normalized);
  });
  if (!normalized) return matches;
  // Enter runs the first row, so the command the user typed has to be it.
  // Array.prototype.sort is stable: rows with the same rank keep menu order.
  return matches.sort((a, b) => visibleSlashRank(a, normalized) - visibleSlashRank(b, normalized));
}

function visibleSlashRank(item: SlashMenuItem, needle: string): number {
  const label = item.label.toLowerCase();
  if (label === needle) return 0;
  if (label.startsWith(needle)) return 1;
  if (label.includes(needle)) return 2;
  return 3;
}

function normalizeSlashSearchQuery(query: string): string {
  return query.trim().replace(/^\/+/, "").toLowerCase();
}

function scoreSlashMenuItem(item: SlashMenuItem, query: string): number {
  const commandFields = [item.id, item.label, ...(item.aliases ?? [])].flatMap(tokenizeSearchText);
  const descriptionFields = item.description ? tokenizeSearchText(item.description) : [];

  const commandScore = scoreFields(commandFields, query, 0);
  const descriptionScore = scoreFields(descriptionFields, query, 3);
  return Math.min(commandScore, descriptionScore);
}

function scoreFields(fields: string[], query: string, offset: number): number {
  for (const field of fields) {
    if (field === query || `/${field}` === query) return offset;
  }
  for (const field of fields) {
    if (field.startsWith(query) || `/${field}`.startsWith(query)) return offset + 1;
  }
  for (const field of fields) {
    if (field.includes(query) || `/${field}`.includes(query)) return offset + 2;
  }
  return Number.POSITIVE_INFINITY;
}

function tokenizeSearchText(value: string): string[] {
  const normalized = value.toLowerCase();
  const tokens = normalized.split(/[^a-z0-9]+/).filter(Boolean);
  return [normalized, ...tokens];
}
