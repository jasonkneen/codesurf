import { createContext, type ReactNode, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { SessionStatus } from "../../relay/host";
import { discoverLocalServers, discoverTargetsFromSettings, type ServerInfo } from "../../relay/server-discovery";
import { type RemoteFront, SessionStreamClient } from "../../relay/session-stream";

export interface ServerModeValue {
  remoteFront: RemoteFront | null;
  /** Attach to a node URL (connect + create a session); null on failure. */
  attach: (url: string) => Promise<RemoteFront | null>;
  /** Detach and close the client; turns fall back to the local agent. */
  detach: () => void;
  /** Detected reachable node servers (refreshed when the picker opens). */
  detected: ServerInfo[];
  /** Whether the server picker is showing. */
  pickerOpen: boolean;
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
  attach: async () => null,
  detach: () => {},
  detected: [],
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

export function ServerModeProvider({ children, initial }: { children: ReactNode; initial?: RemoteFront | null }) {
  const [remoteFront, setRemoteFront] = useState<RemoteFront | null>(initial ?? null);
  const remoteFrontRef = useRef<RemoteFront | null>(initial ?? null);
  const [detected, setDetected] = useState<ServerInfo[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [_scanNonce, setScanNonce] = useState(0);
  const [sessions, setSessions] = useState<SessionStatus[]>([]);

  const openPicker = useCallback(() => {
    setPickerOpen(true);
    setScanNonce((n) => n + 1);
  }, []);

  const closePicker = useCallback(() => setPickerOpen(false), []);

  const refreshSessions = useCallback(async () => {
    if (remoteFront) {
      const list = await remoteFront.client.listSessions();
      setSessions(list);
    }
  }, [remoteFront]);

  useEffect(() => {
    if (pickerOpen && remoteFront) void refreshSessions();
  }, [pickerOpen, remoteFront, refreshSessions]);

  useEffect(() => {
    if (!pickerOpen) return;
    void discoverLocalServers(discoverTargetsFromSettings()).then((servers) => setDetected(servers));
  }, [pickerOpen]);

  const attach = useCallback(async (url: string): Promise<RemoteFront | null> => {
    const client = new SessionStreamClient(url);
    try {
      await client.connect();
      const sessionId = await client.createSession();
      const front: RemoteFront = { client, sessionId, url };
      setRemoteFront(replaceRemoteFront(remoteFrontRef, front));
      return front;
    } catch {
      client.close();
      return null;
    }
  }, []);

  const resume = useCallback(async (url: string, sessionId: string): Promise<RemoteFront | null> => {
    const client = new SessionStreamClient(url);
    try {
      await client.connect();
      await client.subscribe(sessionId);
      const front: RemoteFront = { client, sessionId, url };
      setRemoteFront(replaceRemoteFront(remoteFrontRef, front));
      setSessions([]);
      return front;
    } catch {
      client.close();
      return null;
    }
  }, []);

  const detach = useCallback(() => {
    setRemoteFront(replaceRemoteFront(remoteFrontRef, null));
  }, []);

  return (
    <Ctx.Provider
      value={{
        remoteFront,
        attach,
        detach,
        detected,
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
