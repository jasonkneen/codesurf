// Attach a front to a server: connect and create a session that runs in the
// front's folder with its sandbox mode (the server itself runs from the config
// dir). The single place fronts create remote sessions.

import { type RemoteFront, runRemoteTurn, SessionStreamClient } from "../relay/session-stream";
import type { SandboxMode } from "../utils/settings";

export interface SessionPlacement {
  cwd: string;
  sandboxMode?: SandboxMode;
}

export async function openRemoteFront(url: string, placement: SessionPlacement): Promise<RemoteFront> {
  const client = new SessionStreamClient(url);
  try {
    await client.connect();
    const sessionId = await client.createSession({ cwd: placement.cwd, sandboxMode: placement.sandboxMode });
    return { client, sessionId, url };
  } catch (err) {
    client.close();
    throw err;
  }
}

/**
 * Whether a front can send turns without a local API key: attached to a
 * server, the server owns the Agent and its credentials; serverless (including
 * after a failed attach) needs a model that can run here.
 */
export function canRunTurns(runtime: { kind: "local" | "server" }, localModelCanRun: boolean): boolean {
  return runtime.kind === "server" || localModelCanRun;
}

/**
 * One headless turn over the wire, writing the reply text as it streams.
 * A failed turn arrives as an in-stream error chunk followed by done (so
 * runRemoteTurn resolves); this rejects with that error instead.
 */
export async function runWireTurn(
  client: SessionStreamClient,
  sessionId: string,
  prompt: string,
  write: (text: string) => void,
): Promise<void> {
  let turnError: string | undefined;
  await runRemoteTurn(client, sessionId, prompt, {
    onChunk: (chunk) => {
      if (chunk?.type === "error") {
        turnError ??= typeof chunk.content === "string" && chunk.content ? chunk.content : "turn failed";
        return;
      }
      if (chunk?.type === "content" && typeof chunk.content === "string" && chunk.content) write(chunk.content);
    },
  });
  if (turnError !== undefined) throw new Error(turnError);
}
