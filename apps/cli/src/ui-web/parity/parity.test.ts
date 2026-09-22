// Guards the two invariants the parity harness rests on.
//
// The harness itself (`bun run parity`) needs a real terminal and a real
// browser, so it is a command rather than a test. What CAN be asserted cheaply
// is that its constants still describe the scene they are measuring — because
// if they drift, the comparison keeps passing while comparing the wrong thing.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PARITY_COLUMNS, PARITY_ROWS } from "./fixture.js";

const ROOT = resolve(import.meta.dirname, "../../..");
const TERMINAL = resolve(ROOT, ".parity/widgets.terminal.txt");

describe("parity grid", () => {
  it("is tall enough that the terminal does not compress rows", () => {
    // Below the scene's own height the terminal host does not clip or scroll —
    // it SHRINKS rows to fit, collapsing some to zero height while still
    // drawing them, so two text rows composite into one cell row. (At 60 rows,
    // ApprovalCard's title and summary land on the same row, the title legible
    // only through the summary's spaces.) CSS flexbox overflows instead, so a
    // comparison at a compressed height would report the terminal's overflow
    // behaviour as a fidelity failure in the DOM host.
    //
    // The scene occupies 61 rows. The margin is small on purpose: a much taller
    // viewport would also hide a genuine regression that made the scene grow.
    expect(PARITY_ROWS).toBeGreaterThan(61);
    expect(PARITY_ROWS).toBeLessThan(80);
    expect(PARITY_COLUMNS).toBe(100);
  });

  it("the checked-in terminal capture matches those constants", () => {
    // Skipped rather than failed when absent: a fresh checkout has no capture
    // until `bun run parity` has been run once, and that is not a defect.
    if (!existsSync(TERMINAL)) return;
    const lines = readFileSync(TERMINAL, "utf-8").split("\n");
    expect(lines.length).toBe(PARITY_ROWS);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(PARITY_COLUMNS);

    // The scene must not have silently shrunk to fit — that is the compression
    // symptom, and it would make a passing comparison meaningless.
    const lastContentRow = lines.findLastIndex((line) => line.trim() !== "") + 1;
    expect(lastContentRow).toBeGreaterThan(55);
  });
});
