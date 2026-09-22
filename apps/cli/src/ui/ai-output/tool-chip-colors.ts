export interface ToolChipColorTheme {
  accent: string;
  background: string;
  text: string;
  textDim: string;
  textMuted: string;
}

export interface ToolChipColorOptions {
  /** Keep completed/collapsed chips visually quiet in the transcript. */
  dimToolChips: boolean;
  /** Expanded chips always use the existing accent treatment. */
  expanded: boolean;
}

export interface ToolChipColors {
  background: string;
  foreground: string;
}

/**
 * Resolve the shared colour treatment for individual and collated tool chips.
 * The feature flag controls only the collapsed state; expansion remains the
 * existing accent affordance regardless of the preference.
 */
export function resolveToolChipColors(
  theme: ToolChipColorTheme,
  { dimToolChips, expanded }: ToolChipColorOptions,
): ToolChipColors {
  if (expanded) {
    return { background: theme.accent, foreground: theme.background };
  }

  return dimToolChips
    ? { background: theme.textDim, foreground: theme.text }
    : { background: theme.textMuted, foreground: theme.background };
}
