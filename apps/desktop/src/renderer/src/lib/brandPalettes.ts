import type { ThemeMode } from '../theme'

export const DARK_BRAND_PALETTES = [
        ['#8bd5ff', '#6db8ff', '#7ee7c8', '#6db8ff', '#8bd5ff', '#7ee7c8'],
        ['#ffd166', '#ff9f1c', '#ff6b6b', '#c77dff', '#7bdff2', '#72efdd'],
        ['#f8fafc', '#cbd5e1', '#94a3b8', '#38bdf8', '#22c55e', '#f59e0b'],
        ['#ffadad', '#ffd6a5', '#fdffb6', '#caffbf', '#9bf6ff', '#bdb2ff'],
        ['#e879f9', '#a78bfa', '#60a5fa', '#34d399', '#fbbf24', '#fb7185'],
        ['#f5f5f5', '#e5e5e5', '#d4d4d4', '#fafafa', '#e5e7eb', '#ffffff'],
        ['#9ca3af', '#6b7280', '#4b5563', '#d1d5db', '#9ca3af', '#6b7280'],
        ['#ffffff', '#ffffff', '#ffffff', '#ffffff', '#ffffff', '#ffffff'],
        ['#000000', '#000000', '#000000', '#000000', '#000000', '#000000'],
] as const

export const LIGHT_BRAND_PALETTES = [
        ['#67b8ff', '#4aa3ff', '#8bd5ff', '#4aa3ff', '#67b8ff', '#8bd5ff'],
        ['#8a2b06', '#c2410c', '#b91c1c', '#7c3aed', '#0369a1', '#0f766e'],
        ['#111827', '#374151', '#6b7280', '#2563eb', '#059669', '#d97706'],
        ['#9f1239', '#c2410c', '#ca8a04', '#15803d', '#0f766e', '#4338ca'],
        ['#be185d', '#9333ea', '#2563eb', '#0891b2', '#16a34a', '#ea580c'],
        ['#404040', '#525252', '#737373', '#a3a3a3', '#d4d4d4', '#171717'],
        ['#111111', '#000000', '#1f2937', '#374151', '#4b5563', '#6b7280'],
        ['#ffffff', '#ffffff', '#ffffff', '#ffffff', '#ffffff', '#ffffff'],
        ['#000000', '#000000', '#000000', '#000000', '#000000', '#000000'],
] as const

export function getBrandPalettes(mode: ThemeMode) {
  return mode === 'dark' ? DARK_BRAND_PALETTES : LIGHT_BRAND_PALETTES
}
