// Curated live front — P3.
//
// Not the full TUI App: that tree pulls Agent, fs, telegram, and a setImmediate
// paint loop. The P3 exit is a browser tab that drives a turn on a running
// `codesurf node` and streams chunks back. SessionStreamClient +
// createRemoteSessionTurn already speak that protocol (mode-2 headless fronts
// use the same pair); this file is the composer + transcript around them.

import { useEffect, useRef, useState } from "react";
import { createRemoteSessionTurn, SessionStreamClient, withToken } from "../../relay/session-stream.js";
import { getTheme } from "../../ui/themes/catalog.js";
import type { ScrollBoxHandle } from "../opentui-dom/scrollbox.js";
import type { TextareaHandle } from "../opentui-dom/textarea.js";
import { applyChunk, startUserTurn, type TranscriptEntry } from "./transcript.js";
import { tokenFromSearch } from "./url.js";

const t = getTheme("dark");

const BINDINGS = [
  { name: "return", action: "submit" },
  { name: "return", shift: true, action: "newline" },
] as const;

type Phase = "connecting" | "ready" | "streaming" | "error";

function rowColor(entry: TranscriptEntry): string {
  switch (entry.kind) {
    case "user":
      return t.accent;
    case "error":
      return t.diffRemovedFg;
    case "tool":
    case "status":
      return t.textMuted;
    default:
      return t.text;
  }
}

function rowLabel(entry: TranscriptEntry): string {
  switch (entry.kind) {
    case "user":
      return "you";
    case "assistant":
      return "node";
    case "tool":
      return `tool ${entry.name}`;
    case "error":
      return "error";
    case "status":
      return entry.text;
  }
}

function rowBody(entry: TranscriptEntry): string {
  switch (entry.kind) {
    case "user":
    case "error":
      return entry.text;
    case "assistant":
      return entry.text || (entry.reasoning ? `(thinking) ${entry.reasoning}` : "");
    case "tool":
      return entry.name;
    case "status":
      return "";
  }
}

export function LiveApp({ url, sessionId: requestedSession }: { url: string; sessionId?: string | null }) {
  const [phase, setPhase] = useState<Phase>("connecting");
  const [error, setError] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  const clientRef = useRef<SessionStreamClient | null>(null);
  const sessionRef = useRef<string | null>(null);
  const composerRef = useRef<TextareaHandle | null>(null);
  const scrollRef = useRef<ScrollBoxHandle | null>(null);
  const turnRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    // The node requires its token; the browser gets it from ?token= (never
    // from tokenResolver/server-discovery, which read node:fs).
    const client = new SessionStreamClient(withToken(url, tokenFromSearch(window.location.search)));
    clientRef.current = client;
    setPhase("connecting");
    setError(null);
    client.on({
      onError: (message) => {
        if (cancelled) return;
        setPhase("error");
        setError(message);
      },
    });
    void client
      .connect()
      .then(() => {
        if (requestedSession) {
          client.subscribe(requestedSession);
          return requestedSession;
        }
        return client.createSession();
      })
      .then((id) => {
        if (cancelled) {
          client.close();
          return;
        }
        sessionRef.current = id;
        setSessionId(id);
        setPhase("ready");
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        setPhase("error");
        setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      cancelled = true;
      client.close();
      clientRef.current = null;
      sessionRef.current = null;
    };
  }, [url, requestedSession]);

  useEffect(() => {
    // Re-run when the transcript changes so the pin tracks streaming tokens,
    // not just new rows. The handle is the only thing we read; `entries` is
    // the trigger.
    void entries;
    const box = scrollRef.current;
    if (box) box.scrollTo(box.scrollHeight);
  }, [entries]);

  const submit = () => {
    const text = composerRef.current?.plainText.trim() ?? "";
    const client = clientRef.current;
    const session = sessionRef.current;
    if (!text || !client || !session || phase !== "ready") return;
    composerRef.current?.clear();
    turnRef.current += 1;
    const turnId = `t${turnRef.current}`;
    setEntries((current) => startUserTurn(current, text, turnId));
    setPhase("streaming");
    void (async () => {
      try {
        for await (const chunk of createRemoteSessionTurn(client, session, text)) {
          setEntries((current) => applyChunk(current, chunk));
        }
      } catch (reason: unknown) {
        setEntries((current) =>
          applyChunk(current, { type: "error", content: reason instanceof Error ? reason.message : String(reason) }),
        );
      } finally {
        setPhase((current) => (current === "streaming" ? "ready" : current));
      }
    })();
  };

  return (
    <box flexDirection="column" width="100%" height="100%" backgroundColor={t.background}>
      <box paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1} flexDirection="column">
        <text fg={t.accent}>
          <b>{"codesurf — live"}</b>
        </text>
        <text fg={t.textMuted}>
          {phase === "connecting"
            ? `connecting ${url}`
            : phase === "error"
              ? (error ?? "connect failed")
              : `${url}  session ${sessionId ?? "—"}  ${phase}`}
        </text>
      </box>
      <scrollbox ref={scrollRef} flexGrow={1} paddingLeft={2} paddingRight={2}>
        {entries.length === 0 ? (
          <text fg={t.textMuted}>
            {phase === "ready" ? "session ready — type below, enter to send, shift+enter for a newline" : ""}
          </text>
        ) : (
          <box flexDirection="column" gap={1}>
            {entries.map((entry) => {
              const body = rowBody(entry);
              if (!body && entry.kind === "status") {
                return (
                  <text key={entry.id} fg={rowColor(entry)}>
                    {rowLabel(entry)}
                  </text>
                );
              }
              return (
                <box key={entry.id} flexDirection="column">
                  <text fg={rowColor(entry)}>
                    <b>{rowLabel(entry)}</b>
                  </text>
                  {body ? <text fg={t.text}>{body}</text> : null}
                </box>
              );
            })}
          </box>
        )}
      </scrollbox>
      <box paddingLeft={2} paddingRight={2} paddingBottom={1} paddingTop={1}>
        <box borderStyle="single" borderColor={t.border} paddingLeft={1} paddingRight={1}>
          <textarea
            ref={composerRef}
            focused={phase === "ready"}
            placeholder={phase === "ready" ? "Message the node…" : "Waiting for the node…"}
            placeholderColor={t.textMuted}
            textColor={t.text}
            minHeight={3}
            maxHeight={8}
            wrapMode="word"
            keyBindings={BINDINGS}
            onSubmit={submit}
          />
        </box>
      </box>
    </box>
  );
}
