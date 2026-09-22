// Sources — collapsible citation list with SourcesTrigger / SourcesContent
// slots and individual Source rows. Ported from termcast's ai-elements/
// sources. Uses a React context to share open/closed state between trigger
// and content so a single parent can own the toggle.

import { createContext, memo, type ReactNode, useContext, useState } from "react";
import type { Theme } from "../theme";

interface SourcesCtxShape {
  t: Theme;
  isOpen: boolean;
  setIsOpen: (v: boolean) => void;
}

const SourcesCtx = createContext<SourcesCtxShape | null>(null);

function useSourcesCtx(): SourcesCtxShape {
  const ctx = useContext(SourcesCtx);
  if (!ctx) {
    throw new Error("Sources sub-components must be rendered inside <Sources>.");
  }
  return ctx;
}

export function Sources({ t, children }: { t: Theme; children?: ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  return (
    <SourcesCtx.Provider value={{ t, isOpen, setIsOpen }}>
      <box flexDirection="column" paddingLeft={1} marginBottom={1}>
        {children}
      </box>
    </SourcesCtx.Provider>
  );
}

export function SourcesTrigger({ count, children }: { count: number; children?: ReactNode }) {
  const { t, isOpen, setIsOpen } = useSourcesCtx();
  const [hovered, setHovered] = useState(false);
  return (
    <box
      flexDirection="row"
      height={1}
      gap={1}
      onMouseMove={() => setHovered(true)}
      onMouseOut={() => setHovered(false)}
      onMouseDown={() => setIsOpen(!isOpen)}
    >
      {children ?? (
        <>
          <text fg={hovered ? t.accent : t.textMuted} wrapMode="none">
            {`Sources (${count})`}
          </text>
          <text fg={t.textMuted} wrapMode="none">
            {isOpen ? " ▲" : " ▼"}
          </text>
        </>
      )}
    </box>
  );
}

export function SourcesContent({ children }: { children?: ReactNode }) {
  const { isOpen } = useSourcesCtx();
  if (!isOpen) return null;
  return (
    <box flexDirection="column" paddingLeft={2}>
      {children}
    </box>
  );
}

export const Source = memo(function Source({
  href,
  title,
  children,
}: {
  href?: string;
  title?: string;
  children?: ReactNode;
}) {
  const { t } = useSourcesCtx();
  const [hovered, setHovered] = useState(false);
  const display = typeof children === "string" ? children : title;
  return (
    <box
      flexDirection="row"
      height={1}
      gap={1}
      onMouseMove={() => setHovered(true)}
      onMouseOut={() => setHovered(false)}
    >
      <text fg={t.textMuted} wrapMode="none">
        {"·"}
      </text>
      <text fg={hovered ? t.accent : t.text} wrapMode="none">
        {display ?? href ?? "Source"}
      </text>
      {href && (
        <text fg={t.textMuted} wrapMode="none">
          {` (${href})`}
        </text>
      )}
    </box>
  );
});
