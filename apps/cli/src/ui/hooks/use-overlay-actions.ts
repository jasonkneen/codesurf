import type { KeyEvent } from "@opentui/core";
import { useCallback } from "react";
import { useBtw } from "../context/btw-context.js";
import { useModalVisibility } from "../context/modal-context.js";
import { useRunningAgents } from "../context/running-agents-context.js";

export function useOverlayActions(closeAgentModal: () => void, closeAgentsPopup: () => void) {
  const { showQuitConfirmRef, setShowQuitConfirm } = useModalVisibility();
  const { agentModalIdRef, showAgentsPopupRef, agentsFooterFocusedRef, setAgentsFooterFocused } = useRunningAgents();
  const { btwStateRef, btwAbortRef, setBtwStateSync } = useBtw();

  return useCallback(
    (key?: KeyEvent) => {
      if (showQuitConfirmRef.current) {
        setShowQuitConfirm(false);
        key?.preventDefault();
        key?.stopPropagation();
        return true;
      }
      if (agentModalIdRef.current !== null) {
        closeAgentModal();
        key?.preventDefault();
        key?.stopPropagation();
        return true;
      }
      if (showAgentsPopupRef.current) {
        closeAgentsPopup();
        key?.preventDefault();
        key?.stopPropagation();
        return true;
      }
      if (agentsFooterFocusedRef.current) {
        setAgentsFooterFocused(false);
        key?.preventDefault();
        key?.stopPropagation();
        return true;
      }
      if (btwStateRef.current) {
        btwAbortRef.current?.abort();
        btwAbortRef.current = null;
        setBtwStateSync(null);
        key?.preventDefault();
        key?.stopPropagation();
        return true;
      }
      return false;
    },
    [
      closeAgentModal,
      closeAgentsPopup,
      setBtwStateSync,
      btwAbortRef,
      btwStateRef,
      showQuitConfirmRef,
      setShowQuitConfirm,
      agentsFooterFocusedRef,
      setAgentsFooterFocused,
      agentModalIdRef,
      showAgentsPopupRef,
    ],
  );
}
