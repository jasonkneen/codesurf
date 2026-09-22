#!/usr/bin/env bun
// Compare each scene's two captures cell by cell.
//
// `diff` is the wrong instrument here: it aligns whole LINES, so a bordered
// panel whose every row is prefixed with `│` reads as thirteen deleted lines
// and thirteen inserted ones even when every glyph inside sits in the exact
// same cell. This compares by (row, column) instead, which is the only way the
// answer means anything on a character grid.
//
//   bun scripts/parity/compare.mjs              # summary + differing rows
//   bun scripts/parity/compare.mjs --strict     # exit 1 if any real difference
//   bun scripts/parity/compare.mjs markdown     # one scene
//
// Border glyphs are reported separately rather than counted as failures: the
// phase 5 §10.2 decision is that the web host reserves the border's cell but
// paints a CSS rule through it instead of a box-drawing character, so those
// cells are expected to hold a glyph in the terminal and a space in the
// browser. A border cell where the BROWSER has a glyph is a real difference and
// is reported as one.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SCENES } from "./scenes.mjs";

const ROOT = resolve(import.meta.dir, "../..");
const strict = process.argv.includes("--strict");
const wanted = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const scenes = wanted.length > 0 ? SCENES.filter((s) => wanted.includes(s.id)) : SCENES;

// The Box Drawing block. Deliberately NOT including Block Elements
// (U+2580–U+259F): `█` and `░` are the progress bar's own content, and
// swallowing them here would hide a real difference as an expected border.
const BOX_DRAWING = /[\u2500-\u257F]/;

const say = (line = "") => process.stdout.write(`${line}\n`);

function grid(path) {
  return existsSync(path) ? readFileSync(path, "utf-8").split("\n") : null;
}

let anyDifference = false;
let missing = 0;

for (const scene of scenes) {
  const terminal = grid(resolve(ROOT, `.parity/${scene.id}.terminal.txt`));
  const browser = grid(resolve(ROOT, `.parity/${scene.id}.browser.txt`));

  say(`\n── ${scene.id} — ${scene.label} ${"─".repeat(Math.max(0, 46 - scene.label.length))}`);

  if (!terminal || !browser) {
    say(`  no capture (run \`bun run parity\`) — ${!terminal ? "terminal" : "browser"} missing`);
    missing += 1;
    continue;
  }

  const rows = Math.max(terminal.length, browser.length);
  // One width for the whole comparison, so the cell count is the grid's area
  // rather than a function of how much trailing whitespace each writer trimmed.
  const width = Math.max(...terminal.map((l) => l.length), ...browser.map((l) => l.length));

  const differences = [];
  let borderCells = 0;
  let comparedCells = 0;

  for (let row = 0; row < rows; row += 1) {
    const left = terminal[row] ?? "";
    const right = browser[row] ?? "";
    const rowDiffs = [];

    for (let col = 0; col < width; col += 1) {
      const a = left[col] ?? " ";
      const b = right[col] ?? " ";
      comparedCells += 1;
      if (a === b) continue;
      // Expected by the §10.2 decision: terminal glyph, browser CSS rule.
      if (BOX_DRAWING.test(a) && b === " ") {
        borderCells += 1;
        continue;
      }
      rowDiffs.push({ col, terminal: a, browser: b });
    }

    if (rowDiffs.length > 0) differences.push({ row: row + 1, cells: rowDiffs });
  }

  const differingCells = differences.reduce((n, d) => n + d.cells.length, 0);
  say(`  grid            ${width}x${rows}`);
  say(`  cells compared  ${comparedCells}`);
  say(`  border cells    ${borderCells}  (terminal glyph vs web CSS rule)`);
  say(`  differing       ${differingCells} across ${differences.length} row(s)`);

  for (const { row, cells } of differences) {
    const shown = cells
      .slice(0, 10)
      .map(({ col, terminal: a, browser: b }) => `${col}:${JSON.stringify(a)}→${JSON.stringify(b)}`)
      .join(" ");
    say(`    row ${String(row).padStart(3)}  ${shown}${cells.length > 10 ? ` …(+${cells.length - 10})` : ""}`);
    say(`          terminal │${(terminal[row - 1] ?? "").replace(/ +$/, "")}│`);
    say(`          browser  │${(browser[row - 1] ?? "").replace(/ +$/, "")}│`);
  }

  if (differences.length === 0) say("  ✓ every non-border cell matches");
  else anyDifference = true;
}

say("");
process.exit(strict && (anyDifference || missing > 0) ? 1 : 0);
