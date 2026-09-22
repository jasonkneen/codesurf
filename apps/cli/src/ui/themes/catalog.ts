// Theme catalog.
//
// Each theme is a full `Theme` object that can be swapped in at runtime. To
// keep definitions compact we derive most slots from a minimal palette
// (`base`, `panel`, `text`, `primary`, `accent`, `added`, `removed`, `muted`)
// and only override the few colors that need to differ.
//
// Adding a new theme: copy one of the existing entries, tweak the palette,
// and add it to THEMES below.

import type { Theme } from "../theme";
import { dark } from "../theme";

export type { Theme } from "../theme";

export interface ThemeDescriptor {
  id: string;
  name: string;
  description: string;
  kind: "dark" | "light";
  theme: Theme;
}

interface Palette {
  background: string;
  backgroundPanel: string;
  backgroundElement: string;
  border: string;
  borderActive: string;
  text: string;
  textMuted: string;
  textDim: string;
  primary: string;
  accent: string;
  subagentAccent: string;
  selected: string;
  selectedBg: string;
  addedBg: string;
  addedFg: string;
  addedLineNum: string;
  removedBg: string;
  removedFg: string;
  removedLineNum: string;
  contextBg: string;
  contextFg: string;
  /** Markdown/plan accent colours. */
  heading?: string;
  bold?: string;
  italic?: string;
  code?: string;
  codeBlockBg?: string;
  codeBlockFg?: string;
  link?: string;
  linkText?: string;
  hr?: string;
  listBullet?: string;
  planAccent?: string;
  queueBg?: string;
}

function fromPalette(p: Palette): Theme {
  return {
    background: p.background,
    backgroundPanel: p.backgroundPanel,
    backgroundElement: p.backgroundElement,
    border: p.border,
    borderActive: p.borderActive,
    text: p.text,
    textMuted: p.textMuted,
    textDim: p.textDim,
    primary: p.primary,
    accent: p.accent,
    subagentAccent: p.subagentAccent,
    selected: p.selected,
    selectedBg: p.selectedBg,
    diffAdded: p.addedBg,
    diffAddedFg: p.addedFg,
    diffAddedLineNum: p.addedLineNum,
    diffRemoved: p.removedBg,
    diffRemovedFg: p.removedFg,
    diffRemovedLineNum: p.removedLineNum,
    diffContext: p.contextBg,
    diffContextFg: p.contextFg,
    diffLineNumber: p.textDim,
    diffHeader: p.backgroundElement,
    diffHeaderFg: p.textMuted,
    diffSeparator: p.backgroundElement,
    diffSeparatorFg: p.textDim,
    mdHeading: p.heading ?? p.text,
    mdBold: p.bold ?? p.accent,
    mdItalic: p.italic ?? p.accent,
    // Inline-code color should follow the theme accent, not the green diff
    // addedFg. Themes that want a different code color still set `p.code`
    // explicitly; the fallback just stops assistant responses from rendering
    // green backticks on orange themes.
    mdCode: p.code ?? p.accent,
    mdCodeBlockBg: p.codeBlockBg ?? p.backgroundElement,
    mdCodeBlockFg: p.codeBlockFg ?? p.text,
    mdLink: p.link ?? p.accent,
    mdLinkText: p.linkText ?? p.accent,
    mdHr: p.hr ?? p.border,
    mdListBullet: p.listBullet ?? p.textMuted,
    planBorder: p.planAccent ?? p.accent,
    planTitle: p.planAccent ?? p.accent,
    planStepNum: p.planAccent ?? p.accent,
    planStepTitle: p.text,
    planStepDesc: p.textMuted,
    planStepFile: p.accent,
    planQuestionText: p.text,
    planOptionDefault: p.textMuted,
    planOptionSelected: p.planAccent ?? p.accent,
    planOptionCheck: p.addedFg,
    planInputBg: p.backgroundElement,
    planInputText: p.text,
    planHint: p.textDim,
    queueBg: p.queueBg ?? p.selectedBg,
    // Command palette themed from the active theme's accent/background so the
    // ctrl+k menu matches the theme instead of a fixed opencode peach bar.
    commandPaletteHeader: p.accent,
    commandPaletteSelectedBg: p.accent,
    commandPaletteSelectedFg: p.background,
  } as const;
}

// ── Built-in themes ────────────────────────────────────────────────────────

const dracula = fromPalette({
  background: "#282a36",
  backgroundPanel: "#21222c",
  backgroundElement: "#44475a",
  border: "#44475a",
  borderActive: "#bd93f9",
  text: "#f8f8f2",
  textMuted: "#6272a4",
  textDim: "#44475a",
  primary: "#f8f8f2",
  accent: "#bd93f9",
  subagentAccent: "#8be9fd",
  selected: "#f8f8f2",
  selectedBg: "#44475a",
  addedBg: "#1a3a1a",
  addedFg: "#50fa7b",
  addedLineNum: "#3a6a3a",
  removedBg: "#3a1a1a",
  removedFg: "#ff5555",
  removedLineNum: "#6a3a3a",
  contextBg: "#21222c",
  contextFg: "#b8b8b2",
  bold: "#ffb86c",
  italic: "#f1fa8c",
  code: "#50fa7b",
  link: "#8be9fd",
  linkText: "#ff79c6",
  planAccent: "#f1fa8c",
});

const nord = fromPalette({
  background: "#2e3440",
  backgroundPanel: "#3b4252",
  backgroundElement: "#434c5e",
  border: "#434c5e",
  borderActive: "#4c566a",
  text: "#eceff4",
  textMuted: "#8b95a7",
  textDim: "#4c566a",
  primary: "#eceff4",
  accent: "#88c0d0",
  subagentAccent: "#a3be8c",
  selected: "#eceff4",
  selectedBg: "#434c5e",
  addedBg: "#3b4252",
  addedFg: "#a3be8c",
  addedLineNum: "#4a6a4a",
  removedBg: "#3b4252",
  removedFg: "#bf616a",
  removedLineNum: "#6a4a4a",
  contextBg: "#3b4252",
  contextFg: "#d8dee9",
  bold: "#ebcb8b",
  italic: "#d08770",
  code: "#a3be8c",
  link: "#81a1c1",
  linkText: "#8fbcbb",
  planAccent: "#ebcb8b",
});

const tokyonight = fromPalette({
  background: "#1a1b26",
  backgroundPanel: "#1e2030",
  backgroundElement: "#222436",
  border: "#737aa2",
  borderActive: "#9099b2",
  text: "#c8d3f5",
  textMuted: "#828bb8",
  textDim: "#3b4261",
  primary: "#c8d3f5",
  accent: "#82aaff",
  subagentAccent: "#c099ff",
  selected: "#c8d3f5",
  selectedBg: "#283457",
  addedBg: "#20303b",
  addedFg: "#4fd6be",
  addedLineNum: "#1b2b34",
  removedBg: "#37222c",
  removedFg: "#c53b53",
  removedLineNum: "#2d1f26",
  contextBg: "#1e2030",
  contextFg: "#828bb8",
  bold: "#ff966c",
  italic: "#ffc777",
  code: "#c3e88d",
  link: "#82aaff",
  linkText: "#86e1fc",
  planAccent: "#ffc777",
});

const oneDark = fromPalette({
  background: "#282c34",
  backgroundPanel: "#21252b",
  backgroundElement: "#353b45",
  border: "#393f4a",
  borderActive: "#61afef",
  text: "#abb2bf",
  textMuted: "#5c6370",
  textDim: "#3e4451",
  primary: "#dcdfe4",
  accent: "#61afef",
  subagentAccent: "#56b6c2",
  selected: "#dcdfe4",
  selectedBg: "#3e4451",
  addedBg: "#2c382b",
  addedFg: "#98c379",
  addedLineNum: "#283427",
  removedBg: "#3a2d2f",
  removedFg: "#e06c75",
  removedLineNum: "#36292b",
  contextBg: "#21252b",
  contextFg: "#abb2bf",
  bold: "#d19a66",
  italic: "#e5c07b",
  code: "#98c379",
  link: "#61afef",
  linkText: "#56b6c2",
  planAccent: "#e5c07b",
});

const solarizedDark = fromPalette({
  background: "#002b36",
  backgroundPanel: "#073642",
  backgroundElement: "#073642",
  border: "#073642",
  borderActive: "#586e75",
  text: "#839496",
  textMuted: "#586e75",
  textDim: "#586e75",
  primary: "#fdf6e3",
  accent: "#268bd2",
  subagentAccent: "#2aa198",
  selected: "#fdf6e3",
  selectedBg: "#073642",
  addedBg: "#073642",
  addedFg: "#859900",
  addedLineNum: "#073642",
  removedBg: "#073642",
  removedFg: "#dc322f",
  removedLineNum: "#073642",
  contextBg: "#073642",
  contextFg: "#93a1a1",
  bold: "#cb4b16",
  italic: "#b58900",
  code: "#859900",
  link: "#2aa198",
  linkText: "#6c71c4",
  planAccent: "#b58900",
});

const gruvbox = fromPalette({
  background: "#282828",
  backgroundPanel: "#3c3836",
  backgroundElement: "#504945",
  border: "#665c54",
  borderActive: "#ebdbb2",
  text: "#ebdbb2",
  textMuted: "#928374",
  textDim: "#504945",
  primary: "#fbf1c7",
  accent: "#83a598",
  subagentAccent: "#8ec07c",
  selected: "#fbf1c7",
  selectedBg: "#3c3836",
  addedBg: "#32302f",
  addedFg: "#b8bb26",
  addedLineNum: "#2a2827",
  removedBg: "#322929",
  removedFg: "#fb4934",
  removedLineNum: "#2a2222",
  contextBg: "#3c3836",
  contextFg: "#d5c4a1",
  bold: "#fe8019",
  italic: "#d3869b",
  code: "#fabd2f",
  link: "#8ec07c",
  linkText: "#b8bb26",
  planAccent: "#fabd2f",
});

const githubLight = fromPalette({
  background: "#ffffff",
  backgroundPanel: "#f6f8fa",
  backgroundElement: "#f0f3f6",
  border: "#d0d7de",
  borderActive: "#0969da",
  text: "#24292f",
  textMuted: "#57606a",
  textDim: "#8c959f",
  primary: "#0969da",
  accent: "#0969da",
  subagentAccent: "#8250df",
  selected: "#24292f",
  selectedBg: "#d0d7de",
  addedBg: "#dafbe1",
  addedFg: "#1a7f37",
  addedLineNum: "#1a7f37",
  removedBg: "#ffebe9",
  removedFg: "#cf222e",
  removedLineNum: "#cf222e",
  contextBg: "#f6f8fa",
  contextFg: "#57606a",
  bold: "#bc4c00",
  italic: "#9a6700",
  code: "#bf3989",
  codeBlockBg: "#f6f8fa",
  codeBlockFg: "#24292f",
  link: "#0969da",
  linkText: "#1b7c83",
  planAccent: "#9a6700",
});

// Ported from termcast's `opencode.json` (the sst/opencode theme).
const opencode = fromPalette({
  background: "#0a0a0a",
  backgroundPanel: "#141414",
  backgroundElement: "#1e1e1e",
  border: "#484848",
  borderActive: "#606060",
  text: "#eeeeee",
  textMuted: "#808080",
  textDim: "#3c3c3c",
  primary: "#fab283",
  accent: "#9d7cd8",
  subagentAccent: "#56b6c2",
  selected: "#fab283",
  selectedBg: "#1e1e1e",
  addedBg: "#20303b",
  addedFg: "#4fd6be",
  addedLineNum: "#1b2b34",
  removedBg: "#37222c",
  removedFg: "#c53b53",
  removedLineNum: "#2d1f26",
  contextBg: "#141414",
  contextFg: "#828bb8",
  heading: "#9d7cd8",
  bold: "#f5a742",
  italic: "#e5c07b",
  code: "#7fd88f",
  codeBlockBg: "#0a0a0a",
  codeBlockFg: "#eeeeee",
  link: "#fab283",
  linkText: "#56b6c2",
  planAccent: "#e5c07b",
});

// Ported from termcast's `nerv.json` (the default termcast theme).
// Orange on deep grey — very different from default dark.
const nerv = fromPalette({
  background: "#181818",
  backgroundPanel: "#1f1f1f",
  backgroundElement: "#282828",
  border: "#333333",
  borderActive: "#E89500",
  text: "#FFFFFF",
  textMuted: "#999999",
  textDim: "#606060",
  primary: "#E89500",
  accent: "#FFAA15",
  subagentAccent: "#44DD66",
  selected: "#FFAA15",
  selectedBg: "#333333",
  addedBg: "#1A2B1E",
  addedFg: "#2BBD50",
  addedLineNum: "#162518",
  removedBg: "#37222c",
  removedFg: "#F7768E",
  removedLineNum: "#2d1f26",
  contextBg: "#181818",
  contextFg: "#cccccc",
  heading: "#E89500",
  bold: "#FFAA15",
  italic: "#FFBB50",
  code: "#44DD66",
  codeBlockBg: "#282828",
  codeBlockFg: "#FFFFFF",
  link: "#2BBD50",
  linkText: "#FFAA15",
  planAccent: "#FFAA15",
  queueBg: "#282828",
});

// Vercel / Geist palette (matches opencode's vercel.json). Pure-black canvas
// with Geist-blue primary, purple accent, amber/teal/pink markdown roles.
const vercel = fromPalette({
  background: "#000000",
  backgroundPanel: "#1a1a1a",
  backgroundElement: "#292929",
  border: "#1f1f1f",
  borderActive: "#454545",
  text: "#ededed",
  textMuted: "#878787",
  textDim: "#636363",
  primary: "#0070f3",
  accent: "#8e4ec6",
  subagentAccent: "#52a8ff",
  selected: "#ffffff",
  selectedBg: "#292929",
  addedBg: "#0b1d0f",
  addedFg: "#63c46d",
  addedLineNum: "#0f2613",
  removedBg: "#2a1314",
  removedFg: "#ff6166",
  removedLineNum: "#3c1618",
  contextBg: "#000000",
  contextFg: "#878787",
  heading: "#bf7af0",
  bold: "#f75590",
  italic: "#f2a700",
  code: "#63c46d",
  codeBlockBg: "#1a1a1a",
  codeBlockFg: "#ededed",
  link: "#52a8ff",
  linkText: "#0ac7ac",
  planAccent: "#8e4ec6",
  queueBg: "#1a1a1a",
});

const solarizedLight = fromPalette({
  background: "#fdf6e3",
  backgroundPanel: "#eee8d5",
  backgroundElement: "#eee8d5",
  border: "#eee8d5",
  borderActive: "#93a1a1",
  text: "#657b83",
  textMuted: "#93a1a1",
  textDim: "#c2b994",
  primary: "#002b36",
  accent: "#268bd2",
  subagentAccent: "#2aa198",
  selected: "#002b36",
  selectedBg: "#c9c2a4",
  addedBg: "#eee8d5",
  addedFg: "#586e13",
  addedLineNum: "#eee8d5",
  removedBg: "#eee8d5",
  removedFg: "#dc322f",
  removedLineNum: "#eee8d5",
  contextBg: "#eee8d5",
  contextFg: "#586e75",
  bold: "#cb4b16",
  italic: "#b58900",
  code: "#859900",
  codeBlockBg: "#eee8d5",
  codeBlockFg: "#002b36",
  link: "#2aa198",
  linkText: "#6c71c4",
  planAccent: "#b58900",
});

// ── Additional themes (expanded catalog) ─────────────────────────────────

const catppuccin = fromPalette({
  background: "#1e1e2e",
  backgroundPanel: "#181825",
  backgroundElement: "#313244",
  border: "#45475a",
  borderActive: "#f5c2e7",
  text: "#cdd6f4",
  textMuted: "#a6adc8",
  textDim: "#585b70",
  primary: "#cdd6f4",
  accent: "#cba6f7",
  subagentAccent: "#94e2d5",
  selected: "#cdd6f4",
  selectedBg: "#313244",
  addedBg: "#1e2a1e",
  addedFg: "#a6e3a1",
  addedLineNum: "#2a3a2a",
  removedBg: "#2a1e1e",
  removedFg: "#f38ba8",
  removedLineNum: "#3a2a2a",
  contextBg: "#181825",
  contextFg: "#bac2de",
  bold: "#fab387",
  italic: "#f9e2af",
  code: "#a6e3a1",
  link: "#89b4fa",
  linkText: "#74c7ec",
  planAccent: "#f9e2af",
});

const rosePine = fromPalette({
  background: "#191724",
  backgroundPanel: "#1f1d2e",
  backgroundElement: "#26233a",
  border: "#403d52",
  borderActive: "#eb6f92",
  text: "#e0def4",
  textMuted: "#908caa",
  textDim: "#6e6a86",
  primary: "#e0def4",
  accent: "#c4a7e7",
  subagentAccent: "#9ccfd8",
  selected: "#e0def4",
  selectedBg: "#26233a",
  addedBg: "#1a2a1a",
  addedFg: "#9ccfd8",
  addedLineNum: "#2a3a2a",
  removedBg: "#2a1a1a",
  removedFg: "#eb6f92",
  removedLineNum: "#3a2a2a",
  contextBg: "#1f1d2e",
  contextFg: "#908caa",
  bold: "#f6c177",
  italic: "#ebbcba",
  code: "#9ccfd8",
  link: "#c4a7e7",
  linkText: "#f6c177",
  planAccent: "#f6c177",
});

const monokai = fromPalette({
  background: "#272822",
  backgroundPanel: "#1e1f1c",
  backgroundElement: "#3e3d32",
  border: "#75715e",
  borderActive: "#f92672",
  text: "#f8f8f2",
  textMuted: "#75715e",
  textDim: "#49483e",
  primary: "#f8f8f2",
  accent: "#f92672",
  subagentAccent: "#a6e22e",
  selected: "#f8f8f2",
  selectedBg: "#3e3d32",
  addedBg: "#1a2a1a",
  addedFg: "#a6e22e",
  addedLineNum: "#2a3a2a",
  removedBg: "#2a1a1a",
  removedFg: "#f92672",
  removedLineNum: "#3a2a2a",
  contextBg: "#1e1f1c",
  contextFg: "#aeaeae",
  bold: "#fd971f",
  italic: "#e6db74",
  code: "#a6e22e",
  link: "#66d9ef",
  linkText: "#ae81ff",
  planAccent: "#fd971f",
});

const everforest = fromPalette({
  background: "#2d353b",
  backgroundPanel: "#232a2e",
  backgroundElement: "#343f44",
  border: "#475258",
  borderActive: "#a7c080",
  text: "#d3c6aa",
  textMuted: "#859289",
  textDim: "#475258",
  primary: "#d3c6aa",
  accent: "#a7c080",
  subagentAccent: "#83c092",
  selected: "#d3c6aa",
  selectedBg: "#343f44",
  addedBg: "#1a2a1a",
  addedFg: "#a7c080",
  addedLineNum: "#2a3a2a",
  removedBg: "#2a1a1a",
  removedFg: "#e67e80",
  removedLineNum: "#3a2a2a",
  contextBg: "#232a2e",
  contextFg: "#9da9a0",
  bold: "#dbbc7f",
  italic: "#e69875",
  code: "#a7c080",
  link: "#7fbbb3",
  linkText: "#d699b6",
  planAccent: "#dbbc7f",
});

export const THEMES: ThemeDescriptor[] = [
  {
    id: "dark",
    name: "Dark",
    description: "Default monochrome dark theme.",
    kind: "dark",
    theme: dark,
  },
  {
    id: "nerv",
    name: "Nerv",
    description: "Orange-on-black. Default termcast palette.",
    kind: "dark",
    theme: nerv,
  },
  {
    id: "opencode",
    name: "OpenCode",
    description: "Peach + purple. sst/opencode's signature palette.",
    kind: "dark",
    theme: opencode,
  },
  {
    id: "vercel",
    name: "Vercel",
    description: "Pure black canvas with Geist-blue, purple, and amber accents.",
    kind: "dark",
    theme: vercel,
  },
  {
    id: "dracula",
    name: "Dracula",
    description: "Classic purple-pink dark theme.",
    kind: "dark",
    theme: dracula,
  },
  {
    id: "nord",
    name: "Nord",
    description: "Cool, arctic blue-gray palette.",
    kind: "dark",
    theme: nord,
  },
  {
    id: "tokyonight",
    name: "Tokyo Night",
    description: "Tokyo at night — blue/purple neon.",
    kind: "dark",
    theme: tokyonight,
  },
  {
    id: "one-dark",
    name: "One Dark",
    description: "Atom's beloved dark theme.",
    kind: "dark",
    theme: oneDark,
  },
  {
    id: "solarized-dark",
    name: "Solarized Dark",
    description: "Ethan Schoonover's precision color palette.",
    kind: "dark",
    theme: solarizedDark,
  },
  {
    id: "gruvbox",
    name: "Gruvbox",
    description: "Retro, warm, eye-friendly dark theme.",
    kind: "dark",
    theme: gruvbox,
  },
  {
    id: "github-light",
    name: "GitHub Light",
    description: "GitHub.com's light theme.",
    kind: "light",
    theme: githubLight,
  },
  {
    id: "solarized-light",
    name: "Solarized Light",
    description: "Solarized, light variant.",
    kind: "light",
    theme: solarizedLight,
  },
  {
    id: "catppuccin",
    name: "Catppuccin",
    description: "Soothing pastel dark theme.",
    kind: "dark",
    theme: catppuccin,
  },
  {
    id: "rose-pine",
    name: "Rose Pine",
    description: "Elegant dark theme with warm accents.",
    kind: "dark",
    theme: rosePine,
  },
  {
    id: "monokai",
    name: "Monokai",
    description: "Classic vibrant dark theme.",
    kind: "dark",
    theme: monokai,
  },
  {
    id: "everforest",
    name: "Everforest",
    description: "Low-contrast green-tinted dark theme.",
    kind: "dark",
    theme: everforest,
  },
];

export const DEFAULT_THEME_ID = "dark";

export function getTheme(id: string | null | undefined): Theme {
  if (!id) return dark;
  const entry = THEMES.find((t) => t.id === id);
  return entry?.theme ?? dark;
}

export function findThemeDescriptor(id: string | null | undefined): ThemeDescriptor | undefined {
  if (!id) return undefined;
  return THEMES.find((t) => t.id === id);
}
