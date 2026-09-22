import type { ModelMessage } from "ai";
import { getHostServices } from "../../core/plugins";
import type { NotificationHookInput } from "../../hooks/types";
import { appendMessages } from "../../storage/index";
// Direct, not via the storage barrel: suites that stub the barrel wholesale
// must still build the real message shape.
import { systemReminderMessage } from "../../storage/transcript-view";
import type { SessionInfo, SubagentStatus } from "../../types/index";
import type { DelegationManager, DelegationNotification } from "./../delegations";

interface NotificationsState {
  subagentStatusListeners: Set<(status: SubagentStatus | null) => void>;
  activeSubagentRunKey: string | null;
  delegations: DelegationManager;
  isProcessingTurn: boolean;
  pendingApprovalId: string | null;
  session: SessionInfo | null;
  pendingBackgroundNotifications: Array<{ sessionId: string | null; message: string }>;
  messages: ModelMessage[];
  messageSeqs: Array<number | null>;
  fireHook(input: NotificationHookInput): Promise<unknown>;
}

function st(self: object): NotificationsState {
  return self as unknown as NotificationsState;
}

function endsWithApprovalResponse(messages: ModelMessage[]): boolean {
  const last = messages[messages.length - 1];
  return (
    last?.role === "tool" &&
    Array.isArray(last.content) &&
    last.content.some((part) => part.type === "tool-approval-response")
  );
}

// biome-ignore lint/suspicious/noExplicitAny: TS mixin base constraint must accept any[] (TS2545).
type MixinConstructor = new (...args: any[]) => object;

export function NotificationsMixin<TBase extends MixinConstructor>(Base: TBase) {
  return class Notifications extends Base {
    onSubagentStatus(listener: (status: SubagentStatus | null) => void): () => void {
      const s = st(this);
      s.subagentStatusListeners.add(listener);
      return () => {
        s.subagentStatusListeners.delete(listener);
      };
    }

    /**
     * Broadcast the inline sub-agent status.
     *
     * There is one visible slot, but sub-agents can run concurrently (the model
     * may emit several `task` calls in a single step and the ai-sdk executes them
     * in parallel). The slot is therefore keyed by run: a run only clears the
     * status if it is the one currently displayed, so the FIRST of N to finish no
     * longer blanks the indicator while the others are still working.
     */
    emitSubagentStatus(status: SubagentStatus | null, runKey?: string): void {
      const s = st(this);
      if (status === null) {
        if (runKey !== undefined && s.activeSubagentRunKey !== runKey) return;
        s.activeSubagentRunKey = null;
      } else if (runKey !== undefined) {
        s.activeSubagentRunKey = runKey;
      }
      for (const listener of s.subagentStatusListeners) {
        listener(status);
      }
    }

    async consumeBackgroundNotifications(): Promise<string[]> {
      const s = st(this);
      try {
        const notifications = await s.delegations.consumeNotifications();
        if (s.isProcessingTurn) {
          this.queueBackgroundNotifications(notifications);
          return notifications.map((notification) => notification.message);
        }
        this.deliverBackgroundNotifications(notifications);
        return notifications.map((notification) => notification.message);
      } catch {
        return [];
      }
    }

    /**
     * Turn-boundary delivery, called by the turn owner itself right before the
     * user message is appended. `isProcessingTurn` is already true there, so
     * this deliberately bypasses the queue check: queued entries for this
     * session and anything that arrived since land in `this.messages` and are
     * visible to the model on THIS turn. The UI-timer path
     * (`consumeBackgroundNotifications`) queues instead while a turn is live.
     */
    async drainBackgroundNotifications(): Promise<void> {
      const s = st(this);
      try {
        const fresh = await s.delegations.consumeNotifications();
        this.deliverBackgroundNotifications(fresh);
      } catch {
        // Notifications are best-effort; never break a turn over them.
      }
    }

    /** Hold notifications for the next turn boundary, firing their hooks now. */
    queueBackgroundNotifications(fresh: DelegationNotification[]): void {
      const s = st(this);
      for (const notification of fresh) {
        s.pendingBackgroundNotifications.push({
          sessionId: s.session?.id ?? null,
          message: notification.message,
        });
        const notifInput: NotificationHookInput = {
          hook_event_name: "Notification",
          message: notification.message,
          session_id: s.session?.id,
          cwd: getHostServices().bash.cwd(),
        };
        s.fireHook(notifInput).catch(() => {});
      }
    }

    deliverBackgroundNotifications(fresh: DelegationNotification[]): void {
      const s = st(this);
      // A turn parked on an approval ends in an unanswered tool call. Anything
      // appended now would sit between that call and its result — whether the
      // user approves or moves on — and providers reject that shape. Hold
      // them; the next user turn settles the approval first, then drains. The
      // same goes for an approval answered but not yet continued: the SDK only
      // acts on a response that is still the last message.
      if (s.pendingApprovalId || endsWithApprovalResponse(s.messages)) {
        this.queueBackgroundNotifications(fresh);
        return;
      }
      const sessionId = s.session?.id ?? null;
      for (const entry of s.pendingBackgroundNotifications.splice(0)) {
        // Queued for a conversation that is no longer current (session switch
        // or reset while the turn was in flight): it belongs to that transcript,
        // not to this one.
        if (entry.sessionId !== sessionId) continue;
        this.appendBackgroundNotification(entry.message);
      }
      for (const notification of fresh) {
        this.appendBackgroundNotification(notification.message);
        const notifInput: NotificationHookInput = {
          hook_event_name: "Notification",
          message: notification.message,
          session_id: s.session?.id,
          cwd: getHostServices().bash.cwd(),
        };
        s.fireHook(notifInput).catch(() => {});
      }
    }

    appendBackgroundNotification(text: string): void {
      const s = st(this);
      // A `<system-reminder>` user turn, not `role: "system"`: see
      // `systemReminderMessage`. Persisted in the same shape, so a reload
      // rebuilds exactly the history the live session sent.
      const message = systemReminderMessage(text);
      s.messages.push(message);
      s.messageSeqs.push(s.session ? (appendMessages(s.session.id, [message])[0] ?? null) : null);
    }
  };
}
