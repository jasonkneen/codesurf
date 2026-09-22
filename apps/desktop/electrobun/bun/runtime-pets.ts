/**
 * Lightweight pets handlers for the Electrobun Bun host.
 * Electron-free: scans ~/.codesurf/pets (and codex/hermes overlays) without
 * sharp/thumbnail generation. Enough for picker list + manifest load.
 */

import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { extname, join, resolve } from 'node:path'
import { CODESURF_HOME } from '../../src/main/paths.ts'
import { assertSafePathSegment, resolveInside } from '../../src/main/security/pathSegments.ts'

export type ElectrobunPetManifest = {
  id: string
  displayName: string
  description: string
  spritesheetPath: string
  bundleDir: string
  spritesheetMime: string
  installed: boolean
  category?: string
  sourceUrl?: string
}

const PRIMARY_PETS_DIR = join(CODESURF_HOME, 'pets')

function petsDirs(): string[] {
  return [
    PRIMARY_PETS_DIR,
    join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'pets'),
    join(process.env.HERMES_HOME ?? join(homedir(), '.hermes'), 'pets'),
  ]
}

function mimeFor(filePath: string): string {
  switch (extname(filePath).toLowerCase()) {
    case '.webp': return 'image/webp'
    case '.png': return 'image/png'
    default: return 'application/octet-stream'
  }
}

function loadBundle(bundleDir: string, installed: boolean): ElectrobunPetManifest | null {
  const manifestPath = join(bundleDir, 'pet.json')
  if (!existsSync(manifestPath)) return null
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
  for (const key of ['id', 'displayName', 'description', 'spritesheetPath'] as const) {
    if (typeof raw[key] !== 'string' || !(raw[key] as string).length) return null
  }
  let spritesheetPath = resolve(bundleDir, raw.spritesheetPath as string)
  if (!existsSync(spritesheetPath)) {
    for (const fallback of ['spritesheet.webp', 'spritesheet.png']) {
      const candidate = join(bundleDir, fallback)
      if (existsSync(candidate)) {
        spritesheetPath = candidate
        break
      }
    }
  }
  if (!existsSync(spritesheetPath)) return null
  return {
    id: raw.id as string,
    displayName: raw.displayName as string,
    description: raw.description as string,
    spritesheetPath,
    bundleDir,
    spritesheetMime: mimeFor(spritesheetPath),
    installed,
    category: typeof raw.category === 'string' ? raw.category : undefined,
    sourceUrl: typeof raw.sourceUrl === 'string' ? raw.sourceUrl : undefined,
  }
}

export function listPets(): ElectrobunPetManifest[] {
  const out: ElectrobunPetManifest[] = []
  const seen = new Set<string>()
  const installedDirs = new Set<string>()
  if (existsSync(PRIMARY_PETS_DIR)) {
    try {
      for (const entry of readdirSync(PRIMARY_PETS_DIR)) {
        if (entry.startsWith('.')) continue
        try {
          installedDirs.add(resolveInside(PRIMARY_PETS_DIR, assertSafePathSegment(entry, 'pet slug')))
        } catch { /* skip unsafe */ }
      }
    } catch { /* ignore */ }
  }

  for (const dir of petsDirs()) {
    if (!existsSync(dir)) continue
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.startsWith('.')) continue
      let bundleDir: string
      try {
        bundleDir = resolveInside(dir, assertSafePathSegment(entry, 'pet slug'))
      } catch {
        continue
      }
      let st
      try {
        st = statSync(bundleDir)
      } catch {
        continue
      }
      if (!st.isDirectory()) continue
      const meta = loadBundle(bundleDir, installedDirs.has(bundleDir))
      if (!meta || seen.has(meta.id)) continue
      seen.add(meta.id)
      out.push(meta)
    }
  }
  out.sort((a, b) => a.displayName.localeCompare(b.displayName))
  return out
}

export function getPetManifest(id: string): ElectrobunPetManifest | null {
  if (typeof id !== 'string' || !id) return null
  return listPets().find(p => p.id === id) ?? null
}

export function galleryLocal(): Array<{
  id: string
  displayName: string
  description: string
  category?: string
  installed: boolean
}> {
  return listPets().map(p => ({
    id: p.id,
    displayName: p.displayName,
    description: p.description,
    category: p.category,
    installed: p.installed,
  }))
}

export async function installPet(slug: string): Promise<{ ok: boolean, error?: string }> {
  let safe: string
  let bundleDir: string
  try {
    safe = assertSafePathSegment(slug, 'pet slug')
    bundleDir = resolveInside(PRIMARY_PETS_DIR, safe)
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Invalid pet slug' }
  }
  try {
    const encoded = encodeURIComponent(safe)
    const base = 'https://petdex.dev/api/pets'
    const manifestResp = await fetch(`${base}/${encoded}/manifest.json`, {
      signal: AbortSignal.timeout(15000),
    })
    if (!manifestResp.ok) return { ok: false, error: `Failed to fetch manifest (HTTP ${manifestResp.status})` }
    const manifest = await manifestResp.json() as Record<string, unknown>
    for (const key of ['id', 'displayName', 'description', 'spritesheetPath']) {
      if (typeof manifest[key] !== 'string' || !(manifest[key] as string).length) {
        return { ok: false, error: `Invalid manifest: missing ${key}` }
      }
    }
    mkdirSync(bundleDir, { recursive: true })
    const sheetResp = await fetch(`${base}/${encoded}/spritesheet.webp`, {
      signal: AbortSignal.timeout(60000),
    })
    if (!sheetResp.ok) return { ok: false, error: `Failed to fetch spritesheet (HTTP ${sheetResp.status})` }
    const sheetBuf = Buffer.from(await sheetResp.arrayBuffer())
    writeFileSync(join(bundleDir, 'spritesheet.webp'), sheetBuf)
    writeFileSync(join(bundleDir, 'pet.json'), JSON.stringify({
      id: manifest.id,
      displayName: manifest.displayName,
      description: manifest.description,
      spritesheetPath: 'spritesheet.webp',
      ...(typeof manifest.category === 'string' ? { category: manifest.category } : {}),
      ...(typeof manifest.sourceUrl === 'string' ? { sourceUrl: manifest.sourceUrl } : {}),
    }, null, 2))
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export function removePet(slug: string): { ok: boolean, error?: string } {
  let bundleDir: string
  try {
    bundleDir = resolveInside(PRIMARY_PETS_DIR, assertSafePathSegment(slug, 'pet slug'))
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Invalid pet slug' }
  }
  if (!existsSync(bundleDir)) return { ok: false, error: `Pet "${slug}" is not installed locally` }
  if (!existsSync(join(bundleDir, 'pet.json'))) return { ok: false, error: `"${slug}" is not a valid pet bundle` }
  try {
    rmSync(bundleDir, { recursive: true, force: true })
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export function spritesheetData(id: string): string | null {
  const manifest = getPetManifest(id)
  if (!manifest) return null
  try {
    const buf = readFileSync(manifest.spritesheetPath)
    const mime = manifest.spritesheetMime === 'image/png' ? 'image/png' : 'image/webp'
    return `data:${mime};base64,${buf.toString('base64')}`
  } catch {
    return null
  }
}
