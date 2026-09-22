export type FooterTileEntry = {
  extId: string
  type: string
  label: string
  icon?: string
}

export type FooterExtensionEntrySummary = {
  id: string
  name: string
  icon?: string | null
  enabled: boolean
}

export type FooterExtensionAction = {
  id: string
  label: string
  icon?: string | null
  tileType: string
}

export function buildFooterExtensions(
  extensionTiles: FooterTileEntry[] = [],
  extensionEntries: FooterExtensionEntrySummary[] = [],
): FooterExtensionAction[] {
  const extensionTileById = new Map<string, FooterTileEntry>()
  for (const ext of extensionTiles) {
    if (!extensionTileById.has(ext.extId)) {
      extensionTileById.set(ext.extId, ext)
    }
  }

  const withEntries = extensionEntries.length > 0
    ? extensionEntries
      .filter(entry => entry.enabled !== false)
      .map((entry): FooterExtensionAction | null => {
        const tile = extensionTileById.get(entry.id)
        if (!tile?.type) return null
        const icon = tile.icon ?? entry.icon ?? undefined
        return {
          id: entry.id,
          label: entry.name,
          icon: icon ?? undefined,
          tileType: tile.type,
        }
      })
      .filter((entry): entry is FooterExtensionAction => entry !== null)
    : extensionTiles.map(ext => ({
      id: ext.extId,
      label: ext.label,
      icon: ext.icon,
      tileType: ext.type,
    }))

  return withEntries.filter((entry, index, list) => list.findIndex((other) => other.id === entry.id) === index)
}
