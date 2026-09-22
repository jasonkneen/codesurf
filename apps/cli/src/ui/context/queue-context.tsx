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
import type { QueuedSubmission } from "../hooks/queue-submissions.js";

interface QueueCtx {
  queuedMessages: QueuedSubmission[];
  setQueuedMessages: Dispatch<SetStateAction<QueuedSubmission[]>>;
  queueFocusId: string | null;
  setQueueFocusId: Dispatch<SetStateAction<string | null>>;
  queueFocusIdRef: RefObject<string | null>;
  queuedMessagesRef: RefObject<QueuedSubmission[]>;
  nextQueueIdRef: RefObject<number>;
}

const Ctx = createContext<QueueCtx | null>(null);

export function useQueue(): QueueCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useQueue must be used inside <QueueProvider>");
  return ctx;
}

export function QueueProvider({ children }: { children: ReactNode }) {
  const [queuedMessages, setQueuedMessages] = useState<QueuedSubmission[]>([]);
  const [queueFocusId, setQueueFocusId] = useState<string | null>(null);
  const queueFocusIdRef = useRef<string | null>(null);
  const queuedMessagesRef = useRef<QueuedSubmission[]>([]);
  const nextQueueIdRef = useRef(0);

  const value = useMemo<QueueCtx>(
    () => ({
      queuedMessages,
      setQueuedMessages,
      queueFocusId,
      setQueueFocusId,
      queueFocusIdRef,
      queuedMessagesRef,
      nextQueueIdRef,
    }),
    [queuedMessages, queueFocusId],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
