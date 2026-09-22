// Resource counter indicator — compact `ext / cmd / tool` counts chip rendered
// on the LEFT side of the bottom-most footer line (where the keyboard hint
// text used to live, before the rework).
//
// Subscribes to the live extension registry via `usePlugins / useCommands /
// useTools`, and reads its visibility settings through the `getSetting` prop.
// Auto-hides when every "show.*" toggle is false.

import { Fragment } from "react";
import { useCommands, usePlugins, useTools } from "../../../plugins";

/** Narrow props — see the note on `ContextBarIndicatorProps`. */
export interface ResourceCounterIndicatorProps {
  getSetting: (key: string, fallback: boolean) => boolean;
}

export function ResourceCounterIndicator({ getSetting }: ResourceCounterIndicatorProps) {
  const extensions = usePlugins();
  const commands = useCommands();
  const tools = useTools();

  const showExtensions = getSetting("resourceCounter.show.extensions", true);
  const showCommands = getSetting("resourceCounter.show.commands", true);
  const showTools = getSetting("resourceCounter.show.tools", true);

  if (!showExtensions && !showCommands && !showTools) return null;

  const enabledExtIds = new Set(extensions.filter((e) => e.enabled).map((e) => e.manifest.id));
  const enabledCommands = commands.filter((c) => enabledExtIds.has(c.pluginId));
  const enabledTools = tools.filter((t) => enabledExtIds.has(t.pluginId));

  const parts: { label: string; value: string }[] = [];
  if (showExtensions) {
    parts.push({ label: "ext", value: `${enabledExtIds.size}/${extensions.length}` });
  }
  if (showCommands) {
    parts.push({ label: "cmd", value: String(enabledCommands.length) });
  }
  if (showTools) {
    parts.push({ label: "tool", value: String(enabledTools.length) });
  }

  // Render as `12/14 ext  ·  47 cmd  ·  31 tool` — no trailing separator
  // since this lives on the left side and the next siblings (sandbox, etc.)
  // own their own leading separators.
  return (
    <text fg="#909090" wrapMode="none">
      {parts.map((p, i) => (
        <Fragment key={p.label}>
          <span style={{ fg: "#cfcfcf" }}>{p.value}</span> {p.label}
          {i < parts.length - 1 ? "  ·  " : ""}
        </Fragment>
      ))}
    </text>
  );
}
