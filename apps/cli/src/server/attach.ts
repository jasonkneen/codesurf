// Attach a front to a server: connect and create a session that runs in the
// front's folder with its sandbox mode (the server itself runs from the config
// dir). The single place fronts create remote sessions.

import { type RemoteFront, SessionStreamClient } from "../relay/session-stream";
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
