#!/usr/bin/env bun
// Browser-side capture for the phase 5 parity harness.
//
// Serves the built bundle, drives headless Chrome over the DevTools protocol,
// and asks each scene's page for its cell grid (window.__codesurfParity, wired
// in web/main.tsx). No browser-automation dependency: CDP is a WebSocket and a
// JSON endpoint, and Bun has both.
//
//   bun run web:build && bun scripts/parity/capture-browser.mjs
//   bun scripts/parity/capture-browser.mjs markdown      # one scene
//
// Writes .parity/<scene>.browser.txt beside each terminal reference.

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { SCENES } from "./scenes.mjs";

const ROOT = resolve(import.meta.dir, "../..");
const DIST = join(ROOT, "dist-web");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const DEBUG_PORT = 9333;

const wanted = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const scenes = wanted.length > 0 ? SCENES.filter((s) => wanted.includes(s.id)) : SCENES;

const say = (line) => process.stderr.write(`${line}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── static server ──────────────────────────────────────────────────────────
const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    const file = Bun.file(join(DIST, path === "/" ? "index.html" : path));
    return (await file.exists()) ? new Response(file) : new Response("not found", { status: 404 });
  },
});
const origin = `http://127.0.0.1:${server.port}`;

// ── headless chrome ────────────────────────────────────────────────────────
const profile = mkdtempSync(join(tmpdir(), "codesurf-parity-"));
const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    // A fixed window means a fixed layout; the scenes are sized in cells anyway,
    // but a narrow default viewport would clip one before it could be measured.
    "--window-size=1600,1400",
    "about:blank",
  ],
  { stdio: "ignore" },
);

function cleanup() {
  chrome.kill();
  server.stop(true);
  rmSync(profile, { recursive: true, force: true });
}

/** Chrome needs a moment before /json answers; poll rather than guess. */
async function devtools(pathname, attempts = 50) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${DEBUG_PORT}${pathname}`, { method: "PUT" });
      if (response.ok) return await response.json();
    } catch {
      // not listening yet
    }
    await sleep(100);
  }
  throw new Error(`devtools endpoint ${pathname} never answered`);
}

/**
 * Capture one scene in its own tab.
 *
 * A fresh target per scene rather than navigating one page: each scene sizes
 * #root to its own grid during module evaluation, so reusing a page would
 * measure the second scene inside the first one's box.
 */
async function captureScene(scene) {
  const pageUrl = `${origin}/?scene=${scene.id}`;
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

  // Wait for the grid to hold content AND stop changing.
  //
  // The hook's existence is NOT a ready signal: web/main.tsx installs it at
  // module scope right after `createRoot().render()`, and React renders
  // concurrently, so the hook is reachable a tick before the DOM is populated.
  // Reading then captures a blank grid — which is exactly what happened, and it
  // presented as "the scene renders nothing" rather than as a race.
  //
  // Stability matters as well as non-emptiness: the markdown renderer measures
  // its own width on first layout and re-renders once, so a capture taken
  // between those two paints would record tables laid out at a guessed width.
  let capture = null;
  let previous = null;
  let stable = 0;
  for (let i = 0; i < 200; i += 1) {
    const { result } = await send("Runtime.evaluate", {
      expression: "window.__codesurfParity ? JSON.stringify(window.__codesurfParity()) : null",
      returnByValue: true,
      awaitPromise: true,
    });

    if (typeof result.value === "string") {
      const seen = JSON.parse(result.value);
      if (seen.text.trim() !== "") {
        if (seen.text === previous) {
          stable += 1;
          if (stable >= 2) {
            capture = seen;
            break;
          }
        } else {
          stable = 0;
        }
        previous = seen.text;
      }
    }
    await sleep(50);
  }

  socket.close();
  if (!capture) {
    // A page that threw during module evaluation never installs the hook. Report
    // what it threw rather than a bare timeout — the blank-page hang this
    // harness already caught once presented exactly as a timeout.
    const why = failures.length > 0 ? `\n  page threw: ${failures.join("\n  ")}` : "";
    const what = previous === null ? "never exposed window.__codesurfParity or stayed empty" : "never settled";
    throw new Error(`scene "${scene.id}" ${what}${why}`);
  }

  const out = join(ROOT, `.parity/${scene.id}.browser.txt`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, capture.text, "utf-8");
  say(
    `${scene.id.padEnd(10)} browser  → ${out} (${capture.columns}x${capture.rows}, cell ${capture.cellWidth.toFixed(3)}x${capture.cellHeight}px, clipped ${capture.clipped})`,
  );
}

try {
  for (const scene of scenes) await captureScene(scene);
} finally {
  cleanup();
}

process.exit(0);
