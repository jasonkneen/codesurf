// Two-tier name-based chip collation for the ChatTile tool-chip row.
//
// Ported from grok-cli's `deriveChipDisplay` (src/ui/ai-output/
// tool-calls-collation.ts) and adapted to contex's `ToolBlock` model.
//
//   Tier 1 — group by tool name. When a single tool has CHIP_GROUP_THRESHOLD
//            (3) or more `done` chips, those merge into one `3×READ ✓` chip.
//            Tools below the threshold stay as individual chips.
//   Tier 2 — mega collapse. When CHIP_MEGA_THRESHOLD (3) or more tier-1 group
//            chips would otherwise render, they roll up into one `N×TOOLS ✓`
//            chip whose count is the sum of the grouped chips.
//
// Status escapes: `running` and `error` chips never collapse — the user must
// always see the spinner / red ✗. Same for loose `done` chips (count below the
// per-tool threshold).
//
// Click any group/mega chip to explode it back to its parts (inline, in the
// same wrapping row): mega → its tier-1 group chips; group → its individual
// chips. The summary chip stays visible (with `expanded: true`) as the
// re-collapse target.
//
// Unlike grok-cli, contex clusters also interleave `thinking` chips (which
// grok-cli has no equivalent of). Those now get their own single summary chip
// when numerous, so long reasoning/tool sessions don't produce a wall of `1S`
// thought chips.

import type { ToolBlock, ThinkingBlock } from '../../../../shared/chat-types'
import { normalizeToolName } from '../../../../shared/tool-normalization.ts'

export const CHIP_GROUP_THRESHOLD = 3
export const CHIP_MEGA_THRESHOLD = 3

export const MEGA_ID = '__mega'
export const THINKING_GROUP_ID = '__thinking'
export const GROUP_ID_PREFIX = '__group:'

/** Source chip slots fed into collation, in chronological order. */
export type ClusterChip =
  | { kind: 'thinking'; key: string; block: ThinkingBlock }
  | { kind: 'tool'; key: string; block: ToolBlock; isLive: boolean }

/** Output display items the chip row should render, in order. */
export type ChipDisplayItem =
  | { kind: 'thinking'; key: string; block: ThinkingBlock }
  | {
      kind: 'thinking-group'
      id: string
      key: string
      blocks: ThinkingBlock[]
      expanded: boolean
    }
  | { kind: 'tool-single'; key: string; block: ToolBlock; isLive: boolean }
  | {
      kind: 'tool-group'
      id: string
      key: string
      toolName: string
      blocks: ToolBlock[]
      /** True when exploded — its individual chips follow it in the list. */
      expanded: boolean
    }
  | {
      kind: 'tool-mega'
      id: string
      key: string
      blocks: ToolBlock[]
      groupCount: number
      /** True when exploded — its tier-1 group chips follow it in the list. */
      expanded: boolean
    }

/**
 * collateClusterChips — pure function turning a flat cluster chip list plus the
 * caller's expansion state into the ordered list the chip row should render.
 *
 * Ordering contract (adapted from grok-cli for codesurf's interleaved layout):
 *   1. Done `thinking` chips, grouped as `N×THOUGHT` at the same threshold
 *      as tools, or loose in chronological order below that threshold
 *   2. Mega chip OR tier-1 group chips (first-seen-tool-name order)
 *   3. Loose done tool chips, in chronological order
 *   4. Running tool chips, in chronological order
 *   5. Errored tool chips, in chronological order
 *
 * "Summary first, live action last" keeps the spinner and any new errors
 * visible at the right edge while bulk history compresses on the left.
 */
export function collateClusterChips(
  chips: ClusterChip[],
  explodedGroups: ReadonlySet<string>,
): ChipDisplayItem[] {
  const thinking: Extract<ClusterChip, { kind: 'thinking' }>[] = []
  const running: Extract<ClusterChip, { kind: 'tool' }>[] = []
  const errors: Extract<ClusterChip, { kind: 'tool' }>[] = []
  const done: Extract<ClusterChip, { kind: 'tool' }>[] = []

  for (const c of chips) {
    if (c.kind === 'thinking') thinking.push(c)
    else if (c.block.status === 'running') running.push(c)
    else if (c.block.status === 'error') errors.push(c)
    else done.push(c)
  }

  // Bucket done chips by canonical group key — Map insertion order preserves
  // first-seen-tool order for deterministic group placement while letting
  // provider-native variants collapse together.
  const doneByTool = new Map<string, Extract<ClusterChip, { kind: 'tool' }>[]>()
  for (const c of done) {
    const key = c.block.groupKey ?? normalizeToolName(c.block.name).groupKey
    const list = doneByTool.get(key)
    if (list) list.push(c)
    else doneByTool.set(key, [c])
  }

  // Split into "groupable" (>= per-tool threshold) and "loose" (below).
  const groupable: { groupKey: string; toolName: string; chips: Extract<ClusterChip, { kind: 'tool' }>[] }[] = []
  const looseIds = new Set<string>()
  for (const [groupKey, list] of doneByTool) {
    if (list.length >= CHIP_GROUP_THRESHOLD) {
      const first = list[0].block
      groupable.push({
        groupKey,
        toolName: first.displayName ?? normalizeToolName(first.name).displayName,
        chips: list,
      })
    } else {
      for (const c of list) looseIds.add(c.block.id)
    }
  }

  const items: ChipDisplayItem[] = []

  // 1. Done thinking chips lead the row. Collapse noisy reasoning runs into
  // a controlled summary chip, with inline expansion back to the individual
  // elapsed-time chips so their per-block content remains inspectable.
  const thinkingGroupActive = thinking.length >= CHIP_GROUP_THRESHOLD
  const thinkingGroupExploded = thinkingGroupActive && explodedGroups.has(THINKING_GROUP_ID)
  if (thinkingGroupActive) {
    items.push({
      kind: 'thinking-group',
      id: THINKING_GROUP_ID,
      key: `thinking-${thinking[0].key}`,
      blocks: thinking.map(t => t.block),
      expanded: thinkingGroupExploded,
    })
    if (thinkingGroupExploded) {
      for (const t of thinking) items.push({ kind: 'thinking', key: t.key, block: t.block })
    }
  } else {
    for (const t of thinking) items.push({ kind: 'thinking', key: t.key, block: t.block })
  }

  const megaActive = groupable.length >= CHIP_MEGA_THRESHOLD
  const megaExploded = megaActive && explodedGroups.has(MEGA_ID)

  if (megaActive) {
    const blocks = groupable.flatMap(g => g.chips.map(c => c.block))
    items.push({
      kind: 'tool-mega',
      id: MEGA_ID,
      key: `mega-${groupable[0].chips[0].key}`,
      blocks,
      groupCount: groupable.length,
      expanded: megaExploded,
    })
  }

  if (!megaActive || megaExploded) {
    for (const g of groupable) {
      const groupId = `${GROUP_ID_PREFIX}${g.groupKey}`
      const groupExploded = explodedGroups.has(groupId)
      items.push({
        kind: 'tool-group',
        id: groupId,
        key: `group-${g.groupKey}-${g.chips[0].key}`,
        toolName: g.toolName,
        blocks: g.chips.map(c => c.block),
        expanded: groupExploded,
      })
      if (groupExploded) {
        for (const c of g.chips) {
          items.push({ kind: 'tool-single', key: c.key, block: c.block, isLive: c.isLive })
        }
      }
    }
  }

  // Loose done chips, preserving original chronological order.
  for (const c of done) {
    if (looseIds.has(c.block.id)) {
      items.push({ kind: 'tool-single', key: c.key, block: c.block, isLive: c.isLive })
    }
  }
  for (const c of running) items.push({ kind: 'tool-single', key: c.key, block: c.block, isLive: c.isLive })
  for (const c of errors) items.push({ kind: 'tool-single', key: c.key, block: c.block, isLive: c.isLive })

  return items
}
