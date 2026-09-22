// Extension status-indicator chips. Extracted from app.tsx so layout modules
// can render them without importing the god file. Reads the live extension
// registry via `useStatusIndicators`.

import { Fragment } from "react";
import { getHostServices as kernelGetHostServices } from "../../core/plugins";
import { useStatusIndicators } from "../../core/plugins/registry";
import type { Theme } from "../theme";

export function PluginStatusIndicators({
  placement = "input-footer",
  trailingSeparator,
  t,
}: {
  placement?: "input-footer" | "mode-line" | "mode-line-left";
  /** Rendered after the chips, but only when at least one chip is present, so
   *  this group separates cleanly from the next footer element (e.g. the
   *  context bar) without indenting when the group is empty (e.g. voice off). */
  trailingSeparator?: string;
  t?: Theme;
}) {
  const indicators = useStatusIndicators();
  const services = kernelGetHostServices();
  // Default placement is "input-footer" so existing extensions (e.g. voice)
  // keep their slot when they don't specify one.
  const filtered = indicators.filter((ind) => (ind.placement ?? "input-footer") === placement);
  if (filtered.length === 0) return null;
  return (
    <>
      {filtered.map((ind) => (
        <Fragment key={`${ind.pluginId}.${ind.id}`}>{ind.render({ services })}</Fragment>
      ))}
      {trailingSeparator ? (
        <text fg={t?.textMuted ?? "#7280a0"} wrapMode="none">
          {trailingSeparator}
        </text>
      ) : null}
    </>
  );
}
