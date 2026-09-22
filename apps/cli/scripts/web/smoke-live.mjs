#!/usr/bin/env bun
// P3 exit: a browser tab drives a turn on a node and streams chunks back.
//
// Boots an EngineNode with an echo runner (no API key), serves dist-web, opens
// the live front (`?node=ws://...`) in headless Chrome, types a prompt, and
// asserts the echo arrives in the transcript. The node is local and the page
// is http, so this is not mixed-content. Like `codesurf node`, the node requires
// a token and refuses browser origins it was not told about: the page origin is
// allowed explicitly and the token rides in the node URL (and as `&token=`).

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { EngineNode } from "../../src/relay/engine-node.ts";

const ROOT = resolve(import.meta.dir, "../..");
const DIST = join(ROOT, "dist-web");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const DEBUG_PORT = 9334;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (line) => process.stderr.write(`${line}\n`);

async function* echoRunner(_session, message) {
  yield { type: "content", content: `echo:${message}` };
}

const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    const file = Bun.file(join(DIST, path === "/" ? "index.html" : path));
    return (await file.exists()) ? new Response(file) : new Response("not found", { status: 404 });
  },
});
const origin = `http://127.0.0.1:${server.port}`;

const token = randomBytes(32).toString("hex");
const node = new EngineNode({
  nodeId: "p3-smoke",
  turnRunner: echoRunner,
  port: 0,
  authToken: token,
  allowedOrigins: [origin],
});
await node.start();
const nodePort = node.port();
const nodeUrl = `ws://127.0.0.1:${nodePort}/?token=${token}`;
say(`node ws://127.0.0.1:${nodePort} (token-protected, origin ${origin} allowed)`);

const pageUrl = `${origin}/?node=${encodeURIComponent(nodeUrl)}&token=${token}`;
say(`page ${pageUrl}`);

const profile = mkdtempSync(join(tmpdir(), "codesurf-live-"));
const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "--window-size=1200,800",
    "about:blank",
  ],
  { stdio: "ignore" },
);

function cleanup() {
  chrome.kill();
  server.stop(true);
  rmSync(profile, { recursive: true, force: true });
  return node.close();
}

async function devtools(pathname, attempts = 50) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${DEBUG_PORT}${pathname}`, { method: "PUT" });
      if (response.ok) return await response.json();
    } catch {
      // chrome not listening yet
    }
    await sleep(100);
  }
  throw new Error(`devtools endpoint ${pathname} never answered`);
}

try {
  const target = await devtools(`/json/new?${encodeURIComponent(pageUrl)}`);
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((ok, fail) => {
    socket.onopen = ok;
    socket.onerror = () => fail(new Error("CDP socket failed"));
  });

  let nextId = 0;
  const pending = new Map();
  const failures = [];
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.method === "Runtime.exceptionThrown") {
      const detail = message.params.exceptionDetails;
      failures.push(detail.exception?.description ?? detail.text ?? "unknown page exception");
    }
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    message.error ? waiter.fail(new Error(message.error.message)) : waiter.ok(message.result);
  };
  const send = (method, params = {}) =>
    new Promise((ok, fail) => {
      nextId += 1;
      const id = nextId;
      pending.set(id, { ok, fail });
      socket.send(JSON.stringify({ id, method, params }));
    });

  await send("Runtime.enable");
  await send("Page.enable");
  await send("Page.navigate", { url: pageUrl });

  const bodyText = async () => {
    const { result } = await send("Runtime.evaluate", {
      expression: "document.body ? document.body.innerText : ''",
      returnByValue: true,
    });
    return String(result.value ?? "");
  };

  let ready = false;
  for (let i = 0; i < 80; i += 1) {
    const text = await bodyText();
    if (/session ready|session /.test(text) && !/connecting /.test(text)) {
      ready = true;
      break;
    }
    if (/connect failed|session stream connect failed/.test(text)) {
      throw new Error(`live front failed to attach:\n${text}${failures.length ? `\n${failures.join("\n")}` : ""}`);
    }
    await sleep(50);
  }
  if (!ready) {
    throw new Error(
      `live front never reached ready\n${await bodyText()}${failures.length ? `\n${failures.join("\n")}` : ""}`,
    );
  }

  await send("Runtime.evaluate", {
    expression: `(() => {
      const ta = document.querySelector("textarea");
      if (!ta) throw new Error("no textarea");
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
      setter.call(ta, "hello");
      ta.dispatchEvent(new Event("input", { bubbles: true }));
      ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      return ta.value;
    })()`,
    returnByValue: true,
  });

  let last = "";
  let echoed = false;
  for (let i = 0; i < 80; i += 1) {
    last = await bodyText();
    if (last.includes("echo:hello")) {
      echoed = true;
      break;
    }
    await sleep(50);
  }
  socket.close();
  if (!echoed) {
    throw new Error(`turn did not stream echo:hello\n${last}`);
  }
  say("ok: browser tab drove a turn and the echo streamed back");
} finally {
  await cleanup();
}
