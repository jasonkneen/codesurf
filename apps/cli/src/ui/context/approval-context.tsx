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
import type { EditPrecheck, ToolCall } from "../../types/index";

interface PaymentApproval {
  toolName: string;
  url: string;
  description: string;
  security: string;
  securityLabel: string;
  securityUrl: string;
  amount: string;
  network: string;
  asset: string;
  /** Recipient address that will be paid (PaymentPrecheck.payTo). */
  payTo: string;
  approvalId?: string;
  selected: number;
}

interface EditApproval {
  toolName: "write_file" | "edit_file";
  approvalId: string;
  fallbackPath: string;
  precheck?: EditPrecheck;
  selected: number;
}

interface ToolApproval {
  toolName: string;
  approvalId: string;
  detail: string;
  riskLabel?: string;
  selected: number;
}

interface ApprovalCtx {
  pendingPaymentApproval: PaymentApproval | null;
  setPendingPaymentApproval: Dispatch<SetStateAction<PaymentApproval | null>>;
  pendingEditApproval: EditApproval | null;
  setPendingEditApproval: Dispatch<SetStateAction<EditApproval | null>>;
  pendingToolApproval: ToolApproval | null;
  setPendingToolApproval: Dispatch<SetStateAction<ToolApproval | null>>;
  activeToolCalls: ToolCall[];
  setActiveToolCalls: Dispatch<SetStateAction<ToolCall[]>>;
  pendingPaymentApprovalRef: RefObject<PaymentApproval | null>;
  pendingEditApprovalRef: RefObject<EditApproval | null>;
  pendingToolApprovalRef: RefObject<ToolApproval | null>;
}

const Ctx = createContext<ApprovalCtx | null>(null);

export function useApproval(): ApprovalCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useApproval must be used inside <ApprovalProvider>");
  return ctx;
}

/**
 * Wrap a state setter so a direct value is mirrored into its ref immediately.
 * The turn loop reads these refs (finishTurnProcessing holds the queue while
 * an approval is pending) from async code where the React commit — and so the
 * ref-sync effect — may not have run yet. Functional updates still sync via
 * the effect.
 */
export function mirrorToRef<T>(
  setState: Dispatch<SetStateAction<T | null>>,
  ref: RefObject<T | null>,
): Dispatch<SetStateAction<T | null>> {
  return (value) => {
    if (typeof value !== "function") ref.current = value;
    setState(value);
  };
}

export function ApprovalProvider({ children }: { children: ReactNode }) {
  const [pendingPaymentApproval, setPendingPaymentApprovalState] = useState<PaymentApproval | null>(null);
  const [pendingEditApproval, setPendingEditApprovalState] = useState<EditApproval | null>(null);
  const [pendingToolApproval, setPendingToolApprovalState] = useState<ToolApproval | null>(null);
  const [activeToolCalls, setActiveToolCalls] = useState<ToolCall[]>([]);

  const pendingPaymentApprovalRef = useRef<PaymentApproval | null>(null);
  const pendingEditApprovalRef = useRef<EditApproval | null>(null);
  const pendingToolApprovalRef = useRef<ToolApproval | null>(null);

  // State setters and refs are stable, so each wrapper is created once.
  const setPendingPaymentApproval = useMemo(
    () => mirrorToRef(setPendingPaymentApprovalState, pendingPaymentApprovalRef),
    [],
  );
  const setPendingEditApproval = useMemo(() => mirrorToRef(setPendingEditApprovalState, pendingEditApprovalRef), []);
  const setPendingToolApproval = useMemo(() => mirrorToRef(setPendingToolApprovalState, pendingToolApprovalRef), []);

  useEffect(() => {
    pendingPaymentApprovalRef.current = pendingPaymentApproval;
  }, [pendingPaymentApproval]);
  useEffect(() => {
    pendingEditApprovalRef.current = pendingEditApproval;
  }, [pendingEditApproval]);
  useEffect(() => {
    pendingToolApprovalRef.current = pendingToolApproval;
  }, [pendingToolApproval]);

  const value = useMemo<ApprovalCtx>(
    () => ({
      pendingPaymentApproval,
      setPendingPaymentApproval,
      pendingEditApproval,
      setPendingEditApproval,
      pendingToolApproval,
      setPendingToolApproval,
      activeToolCalls,
      setActiveToolCalls,
      pendingPaymentApprovalRef,
      pendingEditApprovalRef,
      pendingToolApprovalRef,
    }),
    [
      pendingPaymentApproval,
      setPendingPaymentApproval,
      pendingEditApproval,
      setPendingEditApproval,
      pendingToolApproval,
      setPendingToolApproval,
      activeToolCalls,
    ],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
