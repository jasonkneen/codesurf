// Wallet picker render module.
//
// Owns the WALLET_ROWS table, the row + display types, and the read-only
// `WalletPickerModal` render function. The host (app.tsx) owns the open/close
// state plus the keyboard handling — this module is purely presentational so
// that the wallet screen extension (`wallet-screen.tsx`) can hand it to the
// kernel as a `RegisteredScreen.render`.

import type { PaymentChain, PaymentSettings } from "../../utils/settings";
import { ListPicker } from "../controls/list-picker";
import type { Theme } from "../theme";

export interface WalletDisplayInfo {
  address: string | null;
  ethBalance: string | null;
  usdcBalance: string | null;
}

export interface WalletRow {
  key: string;
  label: string;
  type: "toggle" | "readonly";
  getDisplay: (settings: Required<PaymentSettings>, info: WalletDisplayInfo) => string;
  getOptions?: () => string[];
  apply?: (settings: Required<PaymentSettings>, value: string) => Partial<PaymentSettings>;
}

export const WALLET_ROWS: WalletRow[] = [
  {
    key: "enabled",
    label: "Payments",
    type: "toggle",
    getDisplay: (s) => (s.enabled ? "enabled" : "disabled"),
    getOptions: () => ["enabled", "disabled"],
    apply: (_s, v) => ({ enabled: v === "enabled" }),
  },
  {
    key: "chain",
    label: "Chain",
    type: "toggle",
    getDisplay: (s) => s.chain,
    getOptions: () => ["base-sepolia", "base"] as PaymentChain[],
    apply: (_s, v) => ({ chain: v as PaymentChain }),
  },
  {
    key: "autoApprove",
    label: "Auto-approve",
    type: "toggle",
    getDisplay: (s) => (s.approval.autoApprove ? "on" : "off"),
    getOptions: () => ["off", "on"],
    apply: (s, v) => ({ approval: { ...s.approval, autoApprove: v === "on" } }),
  },
  {
    key: "address",
    label: "Address",
    type: "readonly",
    getDisplay: (_s, info) => info.address ?? "No wallet",
  },
  {
    key: "eth",
    label: "ETH",
    type: "readonly",
    getDisplay: (_s, info) => info.ethBalance ?? "...",
  },
  {
    key: "usdc",
    label: "USDC",
    type: "readonly",
    getDisplay: (_s, info) => info.usdcBalance ?? "...",
  },
];

export interface WalletPickerProps {
  t: Theme;
  settings: Required<PaymentSettings>;
  walletInfo: WalletDisplayInfo;
  focusIndex: number;
  width: number;
  height: number;
}

function bottomAlignedModalTop(height: number, panelHeight: number): number {
  return Math.max(2, Math.floor((height - panelHeight) / 2));
}

export function WalletPickerModal({ t, settings, walletInfo, focusIndex, width, height }: WalletPickerProps) {
  const panelHeight = Math.min(WALLET_ROWS.length + 6, Math.floor(height * 0.6));
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
            <b>{"Wallet & Payments"}</b>
          </text>
          <text fg={t.textMuted}>{"esc"}</text>
        </box>
        <ListPicker
          t={t}
          items={WALLET_ROWS}
          selectedIndex={focusIndex}
          onSelectIndex={() => {
            /* selection driven by host key handler */
          }}
          getKey={(row) => row.key}
          bordered={false}
          marginBottom={0}
          maxVisibleItems={Math.max(1, WALLET_ROWS.length)}
          renderItem={({ item: row, selected }) => {
            const display = row.getDisplay(settings, walletInfo);
            return (
              <box backgroundColor={selected ? t.selectedBg : undefined} paddingLeft={2} paddingRight={2} width="100%">
                <box width="100%" flexDirection="row" justifyContent="space-between">
                  <text fg={selected ? t.selected : t.text}>{row.label}</text>
                  {row.type === "toggle" ? (
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
          <text fg={t.textMuted}>{"arrows navigate  left/right toggle  esc close"}</text>
        </box>
      </box>
    </box>
  );
}
