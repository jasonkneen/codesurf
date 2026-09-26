import type { ModelMessage } from "ai";
import { getHostServices } from "../../core/plugins";
import { disposeProviderSession } from "../../core/plugins/model-runtime";
import { normalizeModelId } from "../../grok/models";
import type { SessionEndHookInput } from "../../hooks/types";
import {
  buildChatEntries,
  getSessionTotalTokens,
  loadTranscript,
  loadTranscriptState,
  SessionStore,
} from "../../storage/index";
import type { AgentMode, ChatEntry, SessionInfo, SessionSnapshot, WorkspaceInfo } from "../../types/index";

interface SessionLifecycleState {
  sessionStartHookFired: boolean;
  session: SessionInfo | null;
  messages: ModelMessage[];
  messageSeqs: Array<number | null>;
  sessionStore: SessionStore | null;
  workspace: WorkspaceInfo | null;
  mode: AgentMode;
  modelId: string;
  modelAdapterId: string | undefined;
  fireHook(input: SessionEndHookInput): Promise<unknown>;
  resetProgressiveContext(): void;
}

function st(self: object): SessionLifecycleState {
  return self as unknown as SessionLifecycleState;
}

// biome-ignore lint/suspicious/noExplicitAny: TS mixin base constraint must accept any[] (TS2545).
type MixinConstructor = new (...args: any[]) => object;

export function SessionLifecycleMixin<TBase extends MixinConstructor>(Base: TBase) {
  return class SessionLifecycle extends Base {
    clearHistory(): void {
      this.startNewSession();
    }

    startNewSession(): SessionSnapshot | null {
      const s = st(this);
      if (s.sessionStartHookFired) {
        const endInput: SessionEndHookInput = {
          hook_event_name: "SessionEnd",
          session_id: s.session?.id,
          cwd: getHostServices().bash.cwd(),
        };
        s.fireHook(endInput).catch(() => {});
        s.sessionStartHookFired = false;
      }
      s.resetProgressiveContext();
      if (!s.sessionStore) {
        s.messages = [];
        s.messageSeqs = [];
        return null;
      }
      s.sessionStore = new SessionStore(getHostServices().bash.cwd());
      s.workspace = s.sessionStore.getWorkspace();
      s.session = s.sessionStore.createSession(s.modelId, s.mode, getHostServices().bash.cwd());
      s.messages = [];
      s.messageSeqs = [];
      return this.getSessionSnapshot();
    }

    resumeSession(id: string): SessionSnapshot {
      const s = st(this);
      if (!s.sessionStore) {
        throw new Error("Session persistence is disabled for this agent.");
      }
      if (s.sessionStartHookFired) {
        const endInput: SessionEndHookInput = {
          hook_event_name: "SessionEnd",
          session_id: s.session?.id,
          cwd: getHostServices().bash.cwd(),
        };
        s.fireHook(endInput).catch(() => {});
        s.sessionStartHookFired = false;
      }
      if (s.session) {
        void disposeProviderSession(s.session.id).catch(() => {});
      }
      s.resetProgressiveContext();
      const next = s.sessionStore.getRequiredSession(id);
      s.session = next;
      s.workspace = s.sessionStore.getWorkspace();
      s.mode = next.mode;
      const nextModelId = normalizeModelId(next.model) || s.modelId;
      if (nextModelId !== s.modelId) {
        s.modelAdapterId = undefined;
      }
      s.modelId = nextModelId;
      const transcript = loadTranscriptState(next.id);
      s.messages = transcript.messages;
      s.messageSeqs = transcript.seqs;
      s.sessionStore.touchSession(next.id, getHostServices().bash.cwd());
      s.session = s.sessionStore.getRequiredSession(next.id);
      const snapshot = this.getSessionSnapshot();
      if (!snapshot) {
        throw new Error(`Failed to load snapshot for session "${id}".`);
      }
      return snapshot;
    }

    listSessions(options: { limit?: number; scope?: "local" | "global" } = {}): SessionInfo[] {
      return st(this).sessionStore?.listSessions(options) ?? [];
    }

    renameSession(id: string, title: string | null): SessionInfo | null {
      const s = st(this);
      if (!s.sessionStore) return null;
      s.sessionStore.setTitle(id, title);
      const refreshed = s.sessionStore.getSessionById(id);
      if (s.session && s.session.id === id && refreshed) {
        s.session = refreshed;
      }
      return refreshed;
    }

    deleteSession(id: string): void {
      const s = st(this);
      if (!s.sessionStore) return;
      s.sessionStore.deleteSession(id);
      if (s.session && s.session.id === id) {
        this.startNewSession();
      }
    }

    getSessionInfo(): SessionInfo | null {
      return st(this).session;
    }

    getSessionId(): string | null {
      return st(this).session?.id || null;
    }

    getSessionTitle(): string | null {
      return st(this).session?.title || null;
    }

    /**
     * Re-read this session's transcript from the store. A turn run on an
     * attached server node writes to the same saved session from another
     * process, so the in-memory copy is stale until reloaded.
     */
    reloadTranscript(): void {
      const s = st(this);
      if (!s.session || !s.sessionStore) return;
      const transcript = loadTranscriptState(s.session.id);
      s.messages = transcript.messages;
      s.messageSeqs = transcript.seqs;
      s.session = s.sessionStore.getSessionById(s.session.id) ?? s.session;
    }

    getChatEntries(): ChatEntry[] {
      const s = st(this);
      if (!s.session) return [];
      return buildChatEntries(s.session.id);
    }

    getSessionSnapshot(): SessionSnapshot | null {
      const s = st(this);
      if (!s.session || !s.workspace) return null;
      return {
        workspace: s.workspace,
        session: s.session,
        messages: loadTranscript(s.session.id),
        entries: buildChatEntries(s.session.id),
        totalTokens: getSessionTotalTokens(s.session.id),
      };
    }
  };
}
