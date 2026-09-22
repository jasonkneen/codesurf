import React from 'react'
import { Bot, Bug, ClipboardCheck, Folder, GitBranch, Globe, History, Layers3, MessageSquare, Package, Pencil, Puzzle, Settings, Sparkles, TerminalSquare, Wrench } from 'lucide-react'

export function renderExtensionIcon(icon?: string | null, size = 12): React.ReactNode {
  const raw = String(icon ?? '').trim()
  if (!raw) return <Puzzle size={size} />

  const normalized = raw.toLowerCase()
  const namedIcons: Record<string, React.ComponentType<{ size?: number }>> = {
    sparkles: Sparkles,
    pencil: Pencil,
    folder: Folder,
    'git-branch': GitBranch,
    wrench: Wrench,
    globe: Globe,
    bot: Bot,
    package: Package,
    puzzle: Puzzle,
    settings: Settings,
    'message-square': MessageSquare,
    terminal: TerminalSquare,
    history: History,
    'layers-3': Layers3,
    bug: Bug,
    'clipboard-check': ClipboardCheck,
  }
  const Icon = namedIcons[normalized]
  if (Icon) return <Icon size={size} />

  const looksLikeTextToken = /^[a-z0-9-]+$/i.test(raw)
  if (!looksLikeTextToken) {
    return <span style={{ fontSize: size, lineHeight: 1 }}>{raw}</span>
  }

  return <Puzzle size={size} />
}
