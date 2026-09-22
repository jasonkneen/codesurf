import type { ScrollBoxRenderable } from "@opentui/core";
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
import type { ChatEntry, Plan, SubagentStatus } from "../../types/index";
import type { AgentRosterEntry } from "../ai-output/agent-roster";
import type { PlanUpdateData } from "../ai-output/plan-update";
import type { QuestionnaireTab } from "../ai-output/questionnaire-tabs";
import type { ActiveTurnState, PasteBlock } from "../app-helpers";
import { initialPlanQuestionsState as makePlanQuestionsState, type PlanQuestionsState } from "../plan";

interface ConversationStateCtx {
  messages: ChatEntry[];
  setMessages: Dispatch<SetStateAction<ChatEntry[]>>;
  isProcessing: boolean;
  setIsProcessing: Dispatch<SetStateAction<boolean>>;
  justStopped: boolean;
  setJustStopped: Dispatch<SetStateAction<boolean>>;
  justStoppedTimerRef: RefObject<ReturnType<typeof setTimeout> | null>;
  todoPlan: PlanUpdateData | null;
  setTodoPlan: Dispatch<SetStateAction<PlanUpdateData | null>>;
  showTodoPanel: boolean;
  setShowTodoPanel: Dispatch<SetStateAction<boolean>>;
  pendingQuestionnaire: { tabs: QuestionnaireTab[]; title?: string } | null;
  setPendingQuestionnaire: Dispatch<SetStateAction<{ tabs: QuestionnaireTab[]; title?: string } | null>>;
  agentRoster: AgentRosterEntry[];
  setAgentRoster: Dispatch<SetStateAction<AgentRosterEntry[]>>;
  shellMode: boolean;
  setShellMode: Dispatch<SetStateAction<boolean>>;
  liveTurnSourceLabel: string | null;
  setLiveTurnSourceLabel: Dispatch<SetStateAction<string | null>>;
  sessionTitle: string | null;
  setSessionTitle: Dispatch<SetStateAction<string | null>>;
  sessionId: string | null;
  setSessionId: Dispatch<SetStateAction<string | null>>;
  sessionRecap: string | null;
  setSessionRecap: Dispatch<SetStateAction<string | null>>;
  activePlan: Plan | null;
  setActivePlan: Dispatch<SetStateAction<Plan | null>>;
  expandedMessages: Set<number>;
  setExpandedMessages: Dispatch<SetStateAction<Set<number>>>;
  activeSubagent: SubagentStatus | null;
  setActiveSubagent: Dispatch<SetStateAction<SubagentStatus | null>>;
  pqs: PlanQuestionsState;
  setPqs: Dispatch<SetStateAction<PlanQuestionsState>>;
  suggestionsDismissedAtLength: number | null;
  setSuggestionsDismissedAtLength: Dispatch<SetStateAction<number | null>>;
  pasteBlocks: PasteBlock[];
  setPasteBlocks: Dispatch<SetStateAction<PasteBlock[]>>;
  pasteCounterRef: RefObject<number>;
  pasteBlocksRef: RefObject<PasteBlock[]>;
  scrollRef: RefObject<ScrollBoxRenderable | null>;
  transcriptAutoFollowRef: RefObject<boolean>;
  contentAccRef: RefObject<string>;
  reasoningAccRef: RefObject<string>;
  startTimeRef: RefObject<number>;
  /** Start timestamp per in-flight tool call id (see hooks/tool-timing.ts). */
  toolStartTimesRef: RefObject<Map<string, number>>;
  isProcessingRef: RefObject<boolean>;
  shellModeRef: RefObject<boolean>;
  activeRunIdRef: RefObject<number>;
  interruptedRunIdRef: RefObject<number | null>;
  /** Runs whose optimistic rows were never persisted (see hooks/turn-ownership.ts). */
  cancelledRunIdsRef: RefObject<Set<number>>;
  activeTurnRef: RefObject<ActiveTurnState | null>;
  processedInitial: RefObject<boolean>;
}

const Ctx = createContext<ConversationStateCtx | null>(null);

export function useConversationState(): ConversationStateCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useConversationState must be used inside <ConversationStateProvider>");
  return ctx;
}

export function ConversationStateProvider({ agent, children }: { agent: Agent; children: ReactNode }) {
  const [messages, setMessages] = useState<ChatEntry[]>(() => agent.getChatEntries());
  const [isProcessing, setIsProcessing] = useState(false);
  const [justStopped, setJustStopped] = useState(false);
  const justStoppedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [todoPlan, setTodoPlan] = useState<PlanUpdateData | null>(null);
  const [showTodoPanel, setShowTodoPanel] = useState(false);
  const [pendingQuestionnaire, setPendingQuestionnaire] = useState<{
    tabs: QuestionnaireTab[];
    title?: string;
  } | null>(null);
  const [agentRoster, setAgentRoster] = useState<AgentRosterEntry[]>([]);
  const [shellMode, setShellMode] = useState(false);
  const [liveTurnSourceLabel, setLiveTurnSourceLabel] = useState<string | null>(null);
  const [sessionTitle, setSessionTitle] = useState<string | null>(() => agent.getSessionTitle());
  const [sessionId, setSessionId] = useState<string | null>(() => agent.getSessionId());
  const [sessionRecap, setSessionRecap] = useState<string | null>(() => agent.getSessionRecap());
  const [activePlan, setActivePlan] = useState<Plan | null>(null);
  const [expandedMessages, setExpandedMessages] = useState<Set<number>>(() => new Set());
  const [activeSubagent, setActiveSubagent] = useState<SubagentStatus | null>(null);
  const [pqs, setPqs] = useState<PlanQuestionsState>(makePlanQuestionsState());
  const [suggestionsDismissedAtLength, setSuggestionsDismissedAtLength] = useState<number | null>(null);
  const [pasteBlocks, setPasteBlocks] = useState<PasteBlock[]>([]);

  const pasteCounterRef = useRef(0);
  const pasteBlocksRef = useRef<PasteBlock[]>([]);
  const scrollRef = useRef<ScrollBoxRenderable | null>(null);
  const transcriptAutoFollowRef = useRef(true);
  const contentAccRef = useRef("");
  const reasoningAccRef = useRef("");
  const startTimeRef = useRef(0);
  const toolStartTimesRef = useRef<Map<string, number>>(new Map());
  const isProcessingRef = useRef(false);
  const shellModeRef = useRef(false);
  const activeRunIdRef = useRef(0);
  const interruptedRunIdRef = useRef<number | null>(null);
  const cancelledRunIdsRef = useRef<Set<number>>(new Set());
  const activeTurnRef = useRef<ActiveTurnState | null>(null);
  const processedInitial = useRef(false);

  useEffect(() => {
    shellModeRef.current = shellMode;
  }, [shellMode]);

  const value = useMemo<ConversationStateCtx>(
    () => ({
      messages,
      setMessages,
      isProcessing,
      setIsProcessing,
      justStopped,
      setJustStopped,
      justStoppedTimerRef,
      todoPlan,
      setTodoPlan,
      showTodoPanel,
      setShowTodoPanel,
      pendingQuestionnaire,
      setPendingQuestionnaire,
      agentRoster,
      setAgentRoster,
      shellMode,
      setShellMode,
      liveTurnSourceLabel,
      setLiveTurnSourceLabel,
      sessionTitle,
      setSessionTitle,
      sessionId,
      setSessionId,
      sessionRecap,
      setSessionRecap,
      activePlan,
      setActivePlan,
      expandedMessages,
      setExpandedMessages,
      activeSubagent,
      setActiveSubagent,
      pqs,
      setPqs,
      suggestionsDismissedAtLength,
      setSuggestionsDismissedAtLength,
      pasteBlocks,
      setPasteBlocks,
      pasteCounterRef,
      pasteBlocksRef,
      scrollRef,
      transcriptAutoFollowRef,
      contentAccRef,
      reasoningAccRef,
      startTimeRef,
      toolStartTimesRef,
      isProcessingRef,
      shellModeRef,
      activeRunIdRef,
      interruptedRunIdRef,
      cancelledRunIdsRef,
      activeTurnRef,
      processedInitial,
    }),
    [
      messages,
      isProcessing,
      justStopped,
      todoPlan,
      showTodoPanel,
      pendingQuestionnaire,
      agentRoster,
      shellMode,
      liveTurnSourceLabel,
      sessionTitle,
      sessionId,
      sessionRecap,
      activePlan,
      expandedMessages,
      activeSubagent,
      pqs,
      suggestionsDismissedAtLength,
      pasteBlocks,
    ],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
