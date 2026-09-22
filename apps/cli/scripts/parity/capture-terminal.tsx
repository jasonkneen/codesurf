#!/usr/bin/env bun
// Terminal-side reference capture for the phase 5 parity harness.
//
// Renders each scene through the REAL OpenTUI host (Zig core, yoga layout) into
// a headless test renderer and dumps the resulting cell grid as text. That text
// — not a screenshot — is the reference the browser is compared against,
// because a TUI's truth is which glyph landed in which cell, and a character
// grid diffs while a pixel image does not.
//
//   bun scripts/parity/capture-terminal.tsx             # every scene
//   bun scripts/parity/capture-terminal.tsx markdown    # one scene
//   bun scripts/parity/capture-terminal.tsx --print     # also echo to stderr

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { testRender } from "@opentui/react/test-utils";
import { SCENES } from "./scenes.mjs";

const args = process.argv.slice(2);
const print = args.includes("--print");
const wanted = args.filter((a) => !a.startsWith("--"));
const scenes = wanted.length > 0 ? SCENES.filter((s) => wanted.includes(s.id)) : SCENES;

// The renderer captures console, so status goes to stderr.
const say = (line: string) => process.stderr.write(`${line}\n`);

for (const scene of scenes) {
  const out = resolve(import.meta.dir, `../../.parity/${scene.id}.terminal.txt`);
  const mod = await import(resolve(import.meta.dir, "../..", scene.module));
  const Scene = mod[scene.export];

  const { renderer, renderOnce, captureCharFrame } = await testRender(<Scene />, {
    width: scene.columns,
    height: scene.rows,
    exitOnCtrlC: false,
    useMouse: false,
    // In-process: a worker thread would put the frame on the far side of a
    // channel, and this needs the frame synchronously.
    useThread: false,
  });

  // The markdown renderable parses on a worker and paints on a later frame, so
  // a render-settle is not enough — the first frame would capture an empty box
  // and the comparison would be against nothing. Poll for the scene's sentinel
  // instead of sleeping a fixed interval: how long the worker takes varies
  // with machine load and Bun version, and a fixed sleep once captured an
  // all-blank grid without a word of complaint.
  const deadline = Date.now() + 15_000;
  let frame = "";
  for (;;) {
    await renderOnce();
    frame = captureCharFrame();
    if (scene.settleWhen.test(frame)) break;
    if (Date.now() > deadline) {
      renderer.destroy();
      throw new Error(`scene "${scene.id}" never settled: ${scene.settleWhen} not found in the frame within 15s`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  // Exactly `rows` lines, trailing blanks kept, trailing whitespace dropped.
  // The browser capture is normalised the same way, so a difference between the
  // two files is always a difference in what was drawn — never in how the file
  // was written. (captureCharFrame ends with a newline; the DOM grid does not.)
  frame = frame
    .split("\n")
    .slice(0, scene.rows)
    .map((line) => line.replace(/ +$/, ""))
    .join("\n");

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, frame, "utf-8");
  say(`${scene.id.padEnd(10)} terminal → ${out} (${scene.columns}x${scene.rows})`);
  if (print) say(`${frame}\n`);

  renderer.destroy();
}

process.exit(0);
