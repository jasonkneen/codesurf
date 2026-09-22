import {
  createContext,
  type ReactNode,
  type RefObject,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";
import type { BtwState } from "../components/btw-overlay";

interface BtwCtx {
  btwState: BtwState | null;
  setBtwState: (state: BtwState | null) => void;
  setBtwStateSync: (state: BtwState | null) => void;
  dismissBtw: () => void;
  btwStateRef: RefObject<BtwState | null>;
  btwAbortRef: RefObject<AbortController | null>;
}

const Ctx = createContext<BtwCtx | null>(null);

export function useBtw(): BtwCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useBtw must be used inside <BtwProvider>");
  return ctx;
}

export function BtwProvider({ children }: { children: ReactNode }) {
  const [btwState, setBtwState] = useState<BtwState | null>(null);
  const btwAbortRef = useRef<AbortController | null>(null);
  const btwStateRef = useRef<BtwState | null>(null);

  const setBtwStateSync = useCallback((state: BtwState | null) => {
    btwStateRef.current = state;
    setBtwState(state);
  }, []);

  const dismissBtw = useCallback(() => {
    btwAbortRef.current?.abort();
    btwAbortRef.current = null;
    setBtwStateSync(null);
  }, [setBtwStateSync]);

  const value = useMemo<BtwCtx>(
    () => ({
      btwState,
      setBtwState: setBtwStateSync,
      setBtwStateSync,
      dismissBtw,
      btwStateRef,
      btwAbortRef,
    }),
    [btwState, setBtwStateSync, dismissBtw],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
