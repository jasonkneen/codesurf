// Sandbox picker render module.
//
// Owns the SANDBOX_ROWS table, the row + display types, and the read-only
// `SandboxPickerModal` render function. The host (app.tsx) owns the open/close
// state plus the keyboard handling — this module is purely presentational so
// that the sandbox screen extension (`sandbox-screen.tsx`) can hand it to the
// kernel as a `RegisteredScreen.render`.

import type { SandboxMode, SandboxSettings } from "../../utils/settings";
import { ListPicker } from "../controls/list-picker";
import type { Theme } from "../theme";

export interface SandboxRow {
  key: string;
  label: string;
  type: "toggle" | "text";
  placeholder?: string;
  getDisplay: (mode: SandboxMode, s: SandboxSettings) => string;
  getOptions?: () => string[];
  apply: (mode: SandboxMode, s: SandboxSettings, value: string) => { mode?: SandboxMode; settings?: SandboxSettings };
}

export const SANDBOX_ROWS: SandboxRow[] = [
  {
    key: "mode",
    label: "Mode",
    type: "toggle",
    getDisplay: (mode) => (mode === "shuru" ? "Shuru" : "Off"),
    getOptions: () => ["Off", "Shuru"],
    apply: (_mode, _s, value) => ({ mode: value === "Shuru" ? "shuru" : "off" }),
  },
  {
    key: "allowNet",
    label: "Network",
    type: "toggle",
    getDisplay: (_m, s) => (s.allowNet ? "On" : "Off"),
    getOptions: () => ["Off", "On"],
    apply: (_m, _s, value) => ({ settings: { allowNet: value === "On" } }),
  },
  {
    key: "allowedHosts",
    label: "Allowed hosts",
    type: "text",
    placeholder: "api.openai.com, registry.npmjs.org",
    getDisplay: (_m, s) => s.allowedHosts?.join(", ") || "(unrestricted)",
    apply: (_m, _s, value) => ({
      settings: {
        allowedHosts: value
          ? value
              .split(",")
              .map((h) => h.trim())
              .filter(Boolean)
          : undefined,
      },
    }),
  },
  {
    key: "ports",
    label: "Port forwards",
    type: "text",
    placeholder: "8080:80, 8443:443",
    getDisplay: (_m, s) => s.ports?.join(", ") || "(none)",
    apply: (_m, _s, value) => ({
      settings: {
        ports: value
          ? value
              .split(",")
              .map((p) => p.trim())
              .filter(Boolean)
          : undefined,
      },
    }),
  },
  {
    key: "cpus",
    label: "CPUs",
    type: "text",
    placeholder: "e.g. 4",
    getDisplay: (_m, s) => (s.cpus ? String(s.cpus) : "(default)"),
    apply: (_m, _s, value) => ({ settings: { cpus: value ? parseInt(value, 10) || undefined : undefined } }),
  },
  {
    key: "memory",
    label: "Memory (MB)",
    type: "text",
    placeholder: "e.g. 4096",
    getDisplay: (_m, s) => (s.memory ? String(s.memory) : "(default)"),
    apply: (_m, _s, value) => ({ settings: { memory: value ? parseInt(value, 10) || undefined : undefined } }),
  },
  {
    key: "diskSize",
    label: "Disk size (MB)",
    type: "text",
    placeholder: "e.g. 8192",
    getDisplay: (_m, s) => (s.diskSize ? String(s.diskSize) : "(default)"),
    apply: (_m, _s, value) => ({ settings: { diskSize: value ? parseInt(value, 10) || undefined : undefined } }),
  },
  {
    key: "from",
    label: "Checkpoint",
    type: "text",
    placeholder: "checkpoint name",
    getDisplay: (_m, s) => s.from || "(none)",
    apply: (_m, _s, value) => ({ settings: { from: value || undefined } }),
  },
];

export function getSandboxVisibleRows(mode: SandboxMode): SandboxRow[] {
  return mode === "shuru" ? SANDBOX_ROWS : SANDBOX_ROWS.slice(0, 1);
}

export interface SandboxPickerProps {
  t: Theme;
  currentMode: SandboxMode;
  settings: SandboxSettings;
  focusIndex: number;
  editing: string | null;
  editBuffer: string;
  width: number;
  height: number;
}

function bottomAlignedModalTop(height: number, panelHeight: number): number {
  return Math.max(2, Math.floor((height - panelHeight) / 2));
}

export function SandboxPickerModal({
  t,
  currentMode,
  settings,
  focusIndex,
  editing,
  editBuffer,
  width,
  height,
}: SandboxPickerProps) {
  const visibleRows = getSandboxVisibleRows(currentMode);
  const panelHeight = Math.min(visibleRows.length + 6, Math.floor(height * 0.6));
  const top = bottomAlignedModalTop(height, panelHeight);
  const overlayBg = "#000000cc" as string;

  return (
    <box
      position="absolute"
      left={0}
      top={0}
      width={width}
      height={height}
      alignItems="center"
      paddingTop={top}
      backgroundColor={overlayBg}
    >
      <box
        width={Math.min(64, width - 6)}
        height={panelHeight}
        backgroundColor={t.backgroundPanel}
        border
        borderStyle="rounded"
        borderColor={t.accent}
        paddingTop={1}
        paddingBottom={1}
        flexDirection="column"
      >
        <box flexShrink={0} flexDirection="row" justifyContent="space-between" paddingLeft={2} paddingRight={2}>
          <text fg={t.primary}>
            <b>{"Sandbox settings"}</b>
          </text>
          <text fg={t.textMuted}>{"esc"}</text>
        </box>
        <ListPicker
          t={t}
          items={visibleRows}
          selectedIndex={focusIndex}
          onSelectIndex={() => {
            /* selection driven by host key handler */
          }}
          getKey={(row) => row.key}
          bordered={false}
          marginBottom={0}
          maxVisibleItems={Math.max(1, visibleRows.length)}
          renderItem={({ item: row, selected }) => {
            const isEditing = editing === row.key;
            const display = row.getDisplay(currentMode, settings);
            return (
              <box backgroundColor={selected ? t.selectedBg : undefined} paddingLeft={2} paddingRight={2} width="100%">
                <box width="100%" flexDirection="row" justifyContent="space-between">
                  <text fg={selected ? t.selected : t.text}>{row.label}</text>
                  {isEditing ? (
                    <text fg={t.accent}>
                      {editBuffer || row.placeholder || ""}
                      {"_"}
                    </text>
                  ) : row.type === "toggle" ? (
                    <text fg={selected ? t.primary : t.textMuted}>
                      {"< "}
                      {display}
                      {" >"}
                    </text>
                  ) : (
                    <text fg={selected ? t.primary : t.textMuted}>{display}</text>
                  )}
                </box>
              </box>
            );
          }}
        />
        <box flexShrink={0} paddingLeft={2} paddingRight={2} paddingTop={1}>
          <text fg={t.textMuted}>
            {editing
              ? "type value  enter confirm  esc cancel"
              : "arrows navigate  left/right toggle  enter edit  esc close"}
          </text>
        </box>
      </box>
    </box>
  );
}
