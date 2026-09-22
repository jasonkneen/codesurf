import { useRenderer } from "@opentui/react";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { HostToast } from "../../core/plugins";
import { copyTextToHostClipboard } from "../../utils/host-clipboard";
import { getCompactTuiSelectionText } from "../terminal-selection-text";

export interface ToastEntry extends HostToast {
  id: number;
}

interface ToastCtx {
  toasts: ToastEntry[];
  pushToast: (toast: HostToast) => void;
  copyFlashId: number;
  showCopyBanner: () => void;
  copyTuiSelectionToHost: () => boolean;
  handleRootMouseUp: () => void;
}

const Ctx = createContext<ToastCtx | null>(null);

export function useToast(): ToastCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useToast must be used inside <ToastProvider>");
  return ctx;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const renderer = useRenderer();
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  const [copyFlashId, setCopyFlashId] = useState(0);
  const nextToastIdRef = useRef(1);

  const pushToast = useCallback((toast: HostToast) => {
    const id = nextToastIdRef.current++;
    const timeout = toast.timeoutMs ?? 4000;
    setToasts((prev) => [...prev, { ...toast, id }]);
    if (timeout > 0) {
      setTimeout(() => {
        setToasts((prev) => prev.filter((entry) => entry.id !== id));
      }, timeout);
    }
  }, []);

  const showCopyBanner = useCallback(() => {
    setCopyFlashId((n) => n + 1);
  }, []);

  const copyTuiSelectionToHost = useCallback((): boolean => {
    if (!renderer.hasSelection) return false;
    const sel = renderer.getSelection();
    const text = sel ? getCompactTuiSelectionText(sel) : "";
    if (!text) return false;
    renderer.copyToClipboardOSC52(text);
    copyTextToHostClipboard(text);
    renderer.clearSelection();
    showCopyBanner();
    return true;
  }, [renderer, showCopyBanner]);

  const handleRootMouseUp = useCallback(() => {
    copyTuiSelectionToHost();
  }, [copyTuiSelectionToHost]);

  useEffect(() => {
    if (copyFlashId === 0) return;
    const id = setTimeout(() => setCopyFlashId(0), 2000);
    return () => clearTimeout(id);
  }, [copyFlashId]);

  const value = useMemo<ToastCtx>(
    () => ({
      toasts,
      pushToast,
      copyFlashId,
      showCopyBanner,
      copyTuiSelectionToHost,
      handleRootMouseUp,
    }),
    [toasts, pushToast, copyFlashId, showCopyBanner, copyTuiSelectionToHost, handleRootMouseUp],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
