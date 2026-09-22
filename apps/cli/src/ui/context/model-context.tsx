import {
  createContext,
  type Dispatch,
  type ReactNode,
  type RefObject,
  type SetStateAction,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Agent } from "../../agent/agent";
import type { ContextBreakdown } from "../../core/plugins";
import { getHostServices as kernelGetHostServices } from "../../core/plugins";
import { permissionModeKeyForAdapter, readPermissionModeSnapshot } from "../../core/plugins/permission-mode";
import { DEFAULT_MODEL, getModelInfo, MODELS, normalizeModelId } from "../../grok/models";
import type { ReasoningEffort } from "../../types/index";
import { type AgentMode, MODES } from "../../types/index";
import {
  loadPaymentSettings,
  loadUserSettings,
  type PaymentSettings,
  type SandboxMode,
  type SandboxSettings,
} from "../../utils/settings";
import { CLAUDE_AGENT_SETTING_DEFAULTS, CLAUDE_AGENT_SETTING_KEYS, preferredAdapterIdForModel } from "../app-helpers";
import type { WalletDisplayInfo } from "../screens/wallet-picker";
import { getStreamContent } from "../stream-store";

/**
 * Live map of every `*.permissionMode` setting key → current value.
 * Consumers resolve the active adapter via `permissionModeKeyForAdapter`.
 * `claude` / `codesurf` aliases keep older call sites working.
 */
export interface PermissionSnapshot {
  byKey: Record<string, string>;
  claude: string;
  codesurf: string;
}

function buildPermissionSnapshot(services: ReturnType<typeof kernelGetHostServices>): PermissionSnapshot {
  const byKey = readPermissionModeSnapshot(services.settings);
  return {
    byKey,
    claude: byKey[CLAUDE_AGENT_SETTING_KEYS.permission] ?? CLAUDE_AGENT_SETTING_DEFAULTS.permission,
    codesurf: byKey[permissionModeKeyForAdapter("codesurf.daemon")] ?? CLAUDE_AGENT_SETTING_DEFAULTS.permission,
  };
}

interface ModelCtx {
  model: string;
  setModel: Dispatch<SetStateAction<string>>;
  modelAdapterId: string | undefined;
  setModelAdapterId: Dispatch<SetStateAction<string | undefined>>;
  mode: AgentMode;
  setModeState: Dispatch<SetStateAction<AgentMode>>;
  sandboxMode: SandboxMode;
  setSandboxModeState: Dispatch<SetStateAction<SandboxMode>>;
  sandboxSettings: SandboxSettings;
  setSandboxSettingsState: Dispatch<SetStateAction<SandboxSettings>>;
  recapsEnabled: boolean;
  setRecapsEnabledState: Dispatch<SetStateAction<boolean>>;
  walletSettings: Required<PaymentSettings>;
  setWalletSettings: Dispatch<SetStateAction<Required<PaymentSettings>>>;
  walletDisplayInfo: WalletDisplayInfo;
  setWalletDisplayInfo: Dispatch<SetStateAction<WalletDisplayInfo>>;
  hasApiKey: boolean;
  setHasApiKey: Dispatch<SetStateAction<boolean>>;
  reasoningEffortByModel: Record<string, ReasoningEffort>;
  setReasoningEffortByModel: Dispatch<SetStateAction<Record<string, ReasoningEffort>>>;
  permissionModeSnapshot: PermissionSnapshot;
  modeInfoRef: RefObject<(typeof MODES)[number]>;
  activeModelAdapterIdRef: RefObject<string | null>;
  contextStatsRef: RefObject<ContextBreakdown>;
  contextBreakdownRef: RefObject<ContextBreakdown>;
}

const Ctx = createContext<ModelCtx | null>(null);

export function useModel(): ModelCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useModel must be used inside <ModelProvider>");
  return ctx;
}

export function ModelProvider({
  agent,
  initialHasApiKey,
  children,
}: {
  agent: Agent;
  initialHasApiKey: boolean;
  children: ReactNode;
}) {
  const [hasApiKey, setHasApiKey] = useState(initialHasApiKey);
  const [model, setModel] = useState(agent.getModel());
  const [modelAdapterId, setModelAdapterId] = useState<string | undefined>(() => agent.getModelAdapterId());
  const [sandboxMode, setSandboxModeState] = useState<SandboxMode>(agent.getSandboxMode());
  const [mode, setModeState] = useState<AgentMode>(agent.getMode());
  const [sandboxSettings, setSandboxSettingsState] = useState<SandboxSettings>(() => agent.getSandboxSettings());
  const [recapsEnabled, setRecapsEnabledState] = useState(() => agent.getRecapsEnabled());
  const [walletSettings, setWalletSettings] = useState<Required<PaymentSettings>>(() => loadPaymentSettings());
  const [walletDisplayInfo, setWalletDisplayInfo] = useState<WalletDisplayInfo>({
    address: null,
    ethBalance: null,
    usdcBalance: null,
  });
  const [reasoningEffortByModel, setReasoningEffortByModel] = useState<Record<string, ReasoningEffort>>(() =>
    Object.fromEntries(
      Object.entries(loadUserSettings().reasoningEffortByModel ?? {}).map(([modelId, effort]) => [
        normalizeModelId(modelId),
        effort,
      ]),
    ),
  );

  const kernelServices = kernelGetHostServices();
  const [permissionModeSnapshot, setPermissionModeSnapshot] = useState<PermissionSnapshot>(() =>
    buildPermissionSnapshot(kernelServices),
  );

  useEffect(() => {
    const sync = () => setPermissionModeSnapshot(buildPermissionSnapshot(kernelServices));
    // Subscribe to every known permission-mode key so the footer and modal
    // update when /permissions (or any provider settings editor) writes.
    const keys = new Set([
      ...Object.keys(readPermissionModeSnapshot(kernelServices.settings)),
      CLAUDE_AGENT_SETTING_KEYS.permission,
      permissionModeKeyForAdapter("codesurf.daemon"),
      permissionModeKeyForAdapter("grok.cli"),
      permissionModeKeyForAdapter("anthropic.agent-sdk-claude-skills"),
    ]);
    const unsubs = [...keys].map((key) => kernelServices.settings.subscribe(key, sync));
    sync();
    return () => {
      for (const unsub of unsubs) unsub();
    };
  }, [kernelServices]);

  const modeInfoRef = useRef<(typeof MODES)[number]>(MODES[0]);
  const activeModelAdapterIdRef = useRef<string | null>(null);

  const modelInfo = getModelInfo(model);
  const contextWindow = modelInfo?.contextWindow ?? kernelServices.models.get(model)?.contextWindow ?? 200_000;
  const contextBreakdown = agent.getContextBreakdown(contextWindow, getStreamContent());
  const contextStatsRef = useRef<ContextBreakdown>(contextBreakdown);
  contextStatsRef.current = contextBreakdown;
  const contextBreakdownRef = useRef<ContextBreakdown>(contextBreakdown);
  contextBreakdownRef.current = contextBreakdown;

  const value = useMemo<ModelCtx>(
    () => ({
      model,
      setModel,
      modelAdapterId,
      setModelAdapterId,
      mode,
      setModeState,
      sandboxMode,
      setSandboxModeState,
      sandboxSettings,
      setSandboxSettingsState,
      recapsEnabled,
      setRecapsEnabledState,
      walletSettings,
      setWalletSettings,
      walletDisplayInfo,
      setWalletDisplayInfo,
      hasApiKey,
      setHasApiKey,
      reasoningEffortByModel,
      setReasoningEffortByModel,
      permissionModeSnapshot,
      modeInfoRef,
      activeModelAdapterIdRef,
      contextStatsRef,
      contextBreakdownRef,
    }),
    [
      model,
      modelAdapterId,
      mode,
      sandboxMode,
      sandboxSettings,
      recapsEnabled,
      walletSettings,
      walletDisplayInfo,
      hasApiKey,
      reasoningEffortByModel,
      permissionModeSnapshot,
    ],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export { DEFAULT_MODEL, MODELS, normalizeModelId, preferredAdapterIdForModel };
