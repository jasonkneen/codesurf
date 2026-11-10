import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { SessionStatus } from "../../relay/host";
import { type RemoteFront, SessionStreamClient } from "../../relay/session-stream";
import { openRemoteFront, type SessionPlacement } from "../../server/attach";
import { discoverServerCandidates, realCwd } from "../../server/candidates";
import { choosePickerAction, type ServerCandidate } from "../../server/scope";
import { rememberKnownServer } from "../../utils/settings";
import type { RuntimeMode } from "../app-helpers";
import { useToast } from "./toast-context";

export interface ServerModeValue {
  remoteFront: RemoteFront | null;
  /** What the footer shows: the attached server, or serverless. */
  runtimeMode: RuntimeMode;
  /** Attach to a node URL (connect + create a session); null on failure. */
  attach: (url: string) => Promise<RemoteFront | null>;
  /** Attach to a discovered server, remember it as used, and report the outcome. */
  connect: (server: ServerCandidate) => Promise<boolean>;
  /** Detach and close the client; turns fall back to the local agent. */
  detach: () => void;
  /** Servers found when `/server` last ran (ranked, eligible first). */
  candidates: ServerCandidate[];
  /** The folder eligibility is judged against (realpath of the TUI's folder). */
  cwd: string;
  /** Whether the server picker is showing. */
  pickerOpen: boolean;
  /** `/server`: connect straight to the one usable server, else open the picker. */
  openPicker: () => void;
  closePicker: () => void;
  /** Live sessions on the attached node (refreshed via listSessions). */
  sessions: SessionStatus[];
  refreshSessions: () => Promise<void>;
  /** Attach to an existing session on a node (resume). */
  resume: (url: string, sessionId: string) => Promise<RemoteFront | null>;
}

const DEFAULT: ServerModeValue = {
  remoteFront: null,
  runtimeMode: { kind: "local" },
  attach: async () => null,
  connect: async () => false,
  detach: () => {},
  candidates: [],
  cwd: "",
  pickerOpen: false,
  openPicker: () => {},
  closePicker: () => {},
  sessions: [],
  refreshSessions: async () => {},
  resume: async () => null,
};
const Ctx = createContext<ServerModeValue>(DEFAULT);

/**
 * Make `next` the current front, closing the client it replaces. Attaching or
 * resuming used to drop the previous SessionStreamClient without closing it,
 * leaking its socket and leaving it subscribed to the old session.
 */
export function replaceRemoteFront(
  currentRef: { current: RemoteFront | null },
  next: RemoteFront | null,
): RemoteFront | null {
  const previous = currentRef.current;
  currentRef.current = next;
  if (previous && previous.client !== next?.client) previous.client.close();
  return next;
}

function serverTitle(server: Pick<ServerCandidate, "name" | "url">): string {
  return server.name ? `${server.name} (${server.url})` : server.url;
}

export function ServerModeProvider({
  children,
  initial,
  initialName,
  placement,
}: {
  children: ReactNode;
  initial?: RemoteFront | null;
  /** Name of the server `initial` is attached to, for the footer. */
  initialName?: string;
  /** Folder and sandbox mode new remote sessions run with (the TUI's own). */
  placement?: SessionPlacement;
}) {
  const { pushToast } = useToast();
  const [remoteFront, setRemoteFront] = useState<RemoteFront | null>(initial ?? null);
  const remoteFrontRef = useRef<RemoteFront | null>(initial ?? null);
  const [attachedName, setAttachedName] = useState<string | undefined>(initial ? initialName : undefined);
  const [candidates, setCandidates] = useState<ServerCandidate[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [sessions, setSessions] = useState<SessionStatus[]>([]);
  const scanningRef = useRef(false);

  const placementCwd = placement?.cwd ?? process.cwd();
  const placementSandbox = placement?.sandboxMode;
  const cwd = useMemo(() => realCwd(placementCwd), [placementCwd]);

  const refreshSessions = useCallback(async () => {
    if (remoteFront) {
      const list = await remoteFront.client.listSessions();
      setSessions(list);
    }
  }, [remoteFront]);

  useEffect(() => {
    if (pickerOpen && remoteFront) void refreshSessions();
  }, [pickerOpen, remoteFront, refreshSessions]);

  const attachOrThrow = useCallback(
    async (url: string): Promise<RemoteFront> => {
      const front = await openRemoteFront(url, { cwd: placementCwd, sandboxMode: placementSandbox });
      setRemoteFront(replaceRemoteFront(remoteFrontRef, front));
      return front;
    },
    [placementCwd, placementSandbox],
  );

  const attach = useCallback(
    async (url: string): Promise<RemoteFront | null> => {
      try {
        const front = await attachOrThrow(url);
        setAttachedName(undefined);
        return front;
      } catch {
        return null;
      }
    },
    [attachOrThrow],
  );

  const connect = useCallback(
    async (server: ServerCandidate): Promise<boolean> => {
      try {
        await attachOrThrow(server.url);
        setAttachedName(server.name);
        rememberKnownServer(server.url, server.name);
        pushToast({ style: "success", title: `Connected to ${serverTitle(server)}` });
        return true;
      } catch (err) {
        pushToast({
          style: "failure",
          title: `Couldn't connect to ${serverTitle(server)}`,
          message: err instanceof Error ? err.message : String(err),
        });
        return false;
      }
    },
    [attachOrThrow, pushToast],
  );

  const openPicker = useCallback(() => {
    if (scanningRef.current) return;
    scanningRef.current = true;
    void discoverServerCandidates()
      .then(async (found) => {
        const choice = choosePickerAction(found, cwd, remoteFrontRef.current?.url ?? null);
        if (choice.kind === "connect") {
          await connect(choice.server);
          return;
        }
        setCandidates(choice.servers);
        setPickerOpen(true);
      })
      .finally(() => {
        scanningRef.current = false;
      });
  }, [connect, cwd]);

  const closePicker = useCallback(() => setPickerOpen(false), []);

  const resume = useCallback(
    async (url: string, sessionId: string): Promise<RemoteFront | null> => {
      const client = new SessionStreamClient(url);
      try {
        await client.connect();
        // subscribe() is fire-and-forget, so a session the node no longer has
        // (restarted, or reaped after idling) used to fail silently. Check first.
        const status = await Promise.race([
          client.status(sessionId),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000)),
        ]);
        if (!status)
          throw new Error(`session ${sessionId} is no longer on this server (it restarted or the session idled out)`);
        client.subscribe(sessionId);
        const front: RemoteFront = { client, sessionId, url };
        setRemoteFront(replaceRemoteFront(remoteFrontRef, front));
        setSessions([]);
        return front;
      } catch (err) {
        client.close();
        setSessions((prev) => prev.filter((s) => s.id !== sessionId));
        pushToast({
          style: "failure",
          title: "Resume failed",
          message: err instanceof Error ? err.message : String(err),
        });
        return null;
      }
    },
    [pushToast],
  );

  const detach = useCallback(() => {
    setRemoteFront(replaceRemoteFront(remoteFrontRef, null));
    setAttachedName(undefined);
  }, []);

  const runtimeMode = useMemo<RuntimeMode>(
    () => (remoteFront ? { kind: "server", url: remoteFront.url, name: attachedName } : { kind: "local" }),
    [remoteFront, attachedName],
  );

  return (
    <Ctx.Provider
      value={{
        remoteFront,
        runtimeMode,
        attach,
        connect,
        detach,
        candidates,
        cwd,
        pickerOpen,
        openPicker,
        closePicker,
        sessions,
        refreshSessions,
        resume,
      }}
    >
      {children}
    </Ctx.Provider>
  );
}

export function useServerMode(): ServerModeValue {
  return useContext(Ctx);
}
