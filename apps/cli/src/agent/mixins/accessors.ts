import { getHostServices, setKernelMode } from "../../core/plugins";
import { disposeProviderSession, warmProviderSession } from "../../core/plugins/model-runtime";
import { normalizeModelId } from "../../grok/models";
import type { SessionStore } from "../../storage/index";
import type { AgentMode, SessionInfo } from "../../types/index";
import {
  getModeSpecificModelSelection,
  normalizeModelAdapterId,
  type SandboxMode,
  type SandboxSettings,
} from "../../utils/settings";

/** Plain base the mixins extend; Agent is the only concrete subclass. */
export class AgentMixinBase {}

/** State the accessor methods read/write. A module-scoped helper narrows the
 *  Agent to this shape so its real private fields stay private (no public method). */
interface AgentAccessorState {
  modelId: string;
  modelAdapterId: string | undefined;
  mode: AgentMode;
  planContext: string | null;
  apiKey: string | null;
  baseURL: string | null;
  sessionStore: SessionStore | null;
  session: SessionInfo | null;
}

function st(self: object): AgentAccessorState {
  return self as unknown as AgentAccessorState;
}

// biome-ignore lint/suspicious/noExplicitAny: TS mixin base constraint must accept any[] (TS2545).
type MixinConstructor = new (...args: any[]) => object;

export function AccessorsMixin<TBase extends MixinConstructor>(Base: TBase) {
  return class Accessors extends Base {
    getModel(): string {
      return st(this).modelId;
    }
    getModelAdapterId(): string | undefined {
      return st(this).modelAdapterId;
    }
    setModel(model: string, adapterId?: string): void {
      const s = st(this);
      s.modelId = normalizeModelId(model);
      s.modelAdapterId = normalizeModelAdapterId(adapterId);
      if (s.sessionStore && s.session) {
        s.sessionStore.setModel(s.session.id, s.modelId);
        s.session = s.sessionStore.getRequiredSession(s.session.id);
      }
      if (s.session) {
        void warmProviderSession(s.session.id, s.modelId, s.modelAdapterId);
      }
    }
    getMode(): AgentMode {
      return st(this).mode;
    }
    getSandboxMode(): SandboxMode {
      return getHostServices().bash.getSandboxMode();
    }
    setSandboxMode(mode: SandboxMode): void {
      getHostServices().bash.setSandboxMode(mode);
    }
    getSandboxSettings(): SandboxSettings {
      return getHostServices().bash.getSandboxSettings();
    }
    setSandboxSettings(settings: SandboxSettings): void {
      getHostServices().bash.setSandboxSettings(settings);
    }
    setMode(mode: AgentMode): void {
      const s = st(this);
      if (mode !== s.mode) {
        s.mode = mode;
        const modeSelection = getModeSpecificModelSelection(mode);
        if (modeSelection) {
          s.modelId = modeSelection.model;
          s.modelAdapterId = modeSelection.adapterId;
        }
        if (s.sessionStore && s.session) {
          s.sessionStore.setMode(s.session.id, mode);
          s.sessionStore.setModel(s.session.id, s.modelId);
          s.session = s.sessionStore.getRequiredSession(s.session.id);
        }
      }
      setKernelMode(mode);
    }
    setPlanContext(ctx: string | null): void {
      st(this).planContext = ctx;
    }
    hasApiKey(): boolean {
      return !!st(this).apiKey;
    }
    setApiKey(apiKey: string, baseURL = st(this).baseURL ?? undefined): void {
      const s = st(this);
      s.apiKey = apiKey;
      s.baseURL = baseURL || null;
      if (s.session) {
        void disposeProviderSession(s.session.id).catch(() => {});
      }
    }
    getCwd(): string {
      return getHostServices().bash.cwd();
    }
  };
}
