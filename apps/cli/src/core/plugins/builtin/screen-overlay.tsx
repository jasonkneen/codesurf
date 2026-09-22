// Shared screen-overlay chrome for builtin screen extensions.
//
// Every full-screen overlay (editor, files, steer, doc-viewer) hand-rolled the
// same two boxes: a darkened full-terminal backdrop centering a rounded, themed
// panel. This factors that chrome into one component so each screen only
// declares its panel size and content.

import { useTerminalDimensions } from "@opentui/react";
import type { ReactNode } from "react";
import { useHostTheme } from "../host-theme";

/** Darkened backdrop colour drawn behind a screen overlay panel. */
export const SCREEN_OVERLAY_BG = "#000000cc";

export function ScreenOverlay({
  panelWidth,
  panelHeight,
  panelFlexDirection = "column",
  children,
}: {
  panelWidth: number;
  panelHeight: number;
  /** Panel content layout direction. Defaults to a vertical column. */
  panelFlexDirection?: "row" | "column";
  children: ReactNode;
}) {
  const t = useHostTheme();
  const { width, height } = useTerminalDimensions();
  return (
    <box
      position="absolute"
      left={0}
      top={0}
      width={width}
      height={height}
      alignItems="center"
      justifyContent="center"
      backgroundColor={SCREEN_OVERLAY_BG}
    >
      <box
        width={panelWidth}
        height={panelHeight}
        backgroundColor={t.backgroundPanel}
        border
        borderStyle="rounded"
        borderColor={t.accent}
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={2}
        paddingRight={2}
        flexDirection={panelFlexDirection}
      >
        {children}
      </box>
    </box>
  );
}
