import {
  createContext,
  type Dispatch,
  type ReactNode,
  type RefObject,
  type SetStateAction,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";
import type { DelegationRun } from "../../types/index";
import type { RunningAgentRow } from "../running-agents";

interface RunningAgentsCtx {
  runningDelegations: DelegationRun[];
  setRunningDelegations: Dispatch<SetStateAction<DelegationRun[]>>;
  agentsFooterFocused: boolean;
  setAgentsFooterFocused: Dispatch<SetStateAction<boolean>>;
  agentsFooterFocusedRef: RefObject<boolean>;
  showAgentsPopup: boolean;
  setShowAgentsPopup: Dispatch<SetStateAction<boolean>>;
  showAgentsPopupRef: RefObject<boolean>;
  agentsPopupIndex: number;
  setAgentsPopupIndex: Dispatch<SetStateAction<number>>;
  agentsPopupIndexRef: RefObject<number>;
  agentModalId: string | null;
  setAgentModalId: Dispatch<SetStateAction<string | null>>;
  agentModalIdRef: RefObject<string | null>;
  agentModalSnapshot: RunningAgentRow | null;
  setAgentModalSnapshot: Dispatch<SetStateAction<RunningAgentRow | null>>;
  agentModalOutput: string | null;
  setAgentModalOutput: Dispatch<SetStateAction<string | null>>;
  agentModalLoading: boolean;
  setAgentModalLoading: Dispatch<SetStateAction<boolean>>;
  agentsNow: number;
  setAgentsNow: Dispatch<SetStateAction<number>>;
  runningAgentRowsRef: RefObject<RunningAgentRow[]>;
}

const Ctx = createContext<RunningAgentsCtx | null>(null);

export function useRunningAgents(): RunningAgentsCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useRunningAgents must be used inside <RunningAgentsProvider>");
  return ctx;
}

export function RunningAgentsProvider({ children }: { children: ReactNode }) {
  const [runningDelegations, setRunningDelegations] = useState<DelegationRun[]>([]);
  const [agentsFooterFocused, setAgentsFooterFocused] = useState(false);
  const agentsFooterFocusedRef = useRef(false);
  const [showAgentsPopup, setShowAgentsPopup] = useState(false);
  const showAgentsPopupRef = useRef(false);
  const [agentsPopupIndex, setAgentsPopupIndex] = useState(0);
  const agentsPopupIndexRef = useRef(0);
  const [agentModalId, setAgentModalId] = useState<string | null>(null);
  const agentModalIdRef = useRef<string | null>(null);
  const [agentModalSnapshot, setAgentModalSnapshot] = useState<RunningAgentRow | null>(null);
  const [agentModalOutput, setAgentModalOutput] = useState<string | null>(null);
  const [agentModalLoading, setAgentModalLoading] = useState(false);
  const [agentsNow, setAgentsNow] = useState(() => Date.now());
  const runningAgentRowsRef = useRef<RunningAgentRow[]>([]);

  const value = useMemo<RunningAgentsCtx>(
    () => ({
      runningDelegations,
      setRunningDelegations,
      agentsFooterFocused,
      setAgentsFooterFocused,
      agentsFooterFocusedRef,
      showAgentsPopup,
      setShowAgentsPopup,
      showAgentsPopupRef,
      agentsPopupIndex,
      setAgentsPopupIndex,
      agentsPopupIndexRef,
      agentModalId,
      setAgentModalId,
      agentModalIdRef,
      agentModalSnapshot,
      setAgentModalSnapshot,
      agentModalOutput,
      setAgentModalOutput,
      agentModalLoading,
      setAgentModalLoading,
      agentsNow,
      setAgentsNow,
      runningAgentRowsRef,
    }),
    [
      runningDelegations,
      agentsFooterFocused,
      showAgentsPopup,
      agentsPopupIndex,
      agentModalId,
      agentModalSnapshot,
      agentModalOutput,
      agentModalLoading,
      agentsNow,
    ],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
