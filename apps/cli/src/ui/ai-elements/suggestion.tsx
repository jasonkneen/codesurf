// Suggestion — clickable pill suggestions, rendered in a horizontal wrap
// container. Ported from termcast's ai-elements/suggestion. Hover state is
// local; click fires the provided callback with the suggestion text.

import { memo, type ReactNode, useState } from "react";
import type { Theme } from "../theme";

export function Suggestions({
  t,
  children,
  onDismiss,
}: {
  /** Theme is only required when {@link onDismiss} is provided — the close
   *  pill needs theme colors. Optional otherwise so existing callsites that
   *  don't want a close affordance stay terse. */
  t?: Theme;
  children?: ReactNode;
  /** When provided, renders a trailing ✕ pill that fires this callback. */
  onDismiss?: () => void;
}) {
  return (
    <box
      flexDirection="row"
      flexWrap="wrap"
      alignSelf="stretch"
      gap={1}
      paddingLeft={1}
      paddingRight={1}
      paddingBottom={1}
    >
      {children}
      {onDismiss && t ? <SuggestionDismiss t={t} onDismiss={onDismiss} /> : null}
    </box>
  );
}

const SuggestionDismiss = memo(function SuggestionDismiss({ t, onDismiss }: { t: Theme; onDismiss: () => void }) {
  const [hovered, setHovered] = useState(false);
  return (
    <box
      flexDirection="row"
      flexGrow={0}
      flexShrink={0}
      paddingLeft={2}
      paddingRight={2}
      border
      borderStyle="rounded"
      borderColor={hovered ? t.accent : t.border}
      onMouseMove={() => setHovered(true)}
      onMouseOut={() => setHovered(false)}
      onMouseDown={() => onDismiss()}
    >
      <text fg={hovered ? t.accent : t.textDim} wrapMode="none">
        ✕
      </text>
    </box>
  );
});

export const Suggestion = memo(function Suggestion({
  t,
  suggestion,
  onClick,
  children,
}: {
  t: Theme;
  suggestion: string;
  onClick?: (suggestion: string) => void;
  children?: ReactNode;
}) {
  const [hovered, setHovered] = useState(false);
  const label = typeof children === "string" ? children : suggestion;
  return (
    <box
      flexDirection="row"
      flexGrow={0}
      flexShrink={0}
      paddingLeft={2}
      paddingRight={2}
      border
      borderStyle="rounded"
      borderColor={hovered ? t.accent : t.border}
      onMouseMove={() => setHovered(true)}
      onMouseOut={() => setHovered(false)}
      onMouseDown={() => onClick?.(suggestion)}
    >
      <text fg={hovered ? t.accent : t.text} wrapMode="none">
        {label}
      </text>
    </box>
  );
});
