// ToggleSwitch — 4-cell binary switch glyph. Off side and on side each
// render two solid blocks, colored to match the track/knob convention.
// Ported from termcast's ui/controls/toggle-switch.tsx.
//
// Visual palette:
//   OFF:  [knob][knob][track][track]   (knob on the left)
//   ON:   [track][track][knob][knob]   (knob on the right)
//
// The same palette is used regardless of row selection — the unselected
// colors (border/textMuted/diffAddedFg) have adequate contrast against
// both `backgroundPanel` and `selectedBg`. Earlier we tried a darker
// "selected" variant that collapsed below WCAG AA on the lit-up row.
//
// `disabled` (e.g. protected extensions that can't be toggled) keeps the
// value-based color palette so on/off remains legible — only the fill
// glyph swaps from █ to ▒ to signal non-interactivity. Earlier we forced
// every cell to textMuted, which made protected-enabled rows visually
// read as "off" because the green knob disappeared.

import type { Theme } from "../theme";

interface ToggleSwitchProps {
  t: Theme;
  value: boolean;
  selected?: boolean;
  disabled?: boolean;
  onSelect?: () => void;
}

export function ToggleSwitch({ t, value, disabled = false, onSelect }: ToggleSwitchProps) {
  const trackColor = t.border;
  const knobOffColor = t.textMuted;
  const knobOnColor = t.diffAddedFg;

  const fill = disabled ? "▒" : "█";

  const cells = value
    ? [{ fg: trackColor }, { fg: trackColor }, { fg: knobOnColor }, { fg: knobOnColor }]
    : [{ fg: knobOffColor }, { fg: knobOffColor }, { fg: trackColor }, { fg: trackColor }];

  return (
    <box flexDirection="row" width={4} onMouseDown={disabled ? undefined : onSelect}>
      {cells.map((cell, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length cosmetic 4-cell track; index IS the identity
        <box key={index} width={1}>
          <text fg={cell.fg} wrapMode="none">
            <b>{fill}</b>
          </text>
        </box>
      ))}
    </box>
  );
}
