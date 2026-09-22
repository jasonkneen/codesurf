import { describe, expect, it } from "vitest";
import { createChipShortener, shortenToolChipName } from "./chip-name";

describe("chip-name shortening", () => {
  it("collapses BUDDY-namespaced tools to BUDDY", () => {
    const short = createChipShortener();
    expect(short("BUDDY.BLOUBTEAMCONTROL")).toBe("BUDDY");
    expect(short("BUDDY.BLOUBTEAM")).toBe("BUDDY");
  });

  it("aliases COMMAND to RUN", () => {
    const short = createChipShortener();
    expect(short("COMMAND")).toBe("RUN");
  });

  it("leaves common tools unchanged", () => {
    const short = createChipShortener();
    expect(short("SEARCH")).toBe("SEARCH");
    expect(short("bash")).toBe("BASH");
  });

  it("truncates absurdly long names to CHIP_MAX", () => {
    const short = createChipShortener();
    expect(short("A_REALLY_VERY_LONG_PROCESSING_TOOL_NAME")).toHaveLength(12);
  });

  it("accepts user overrides for aliases and org heads (editable config)", () => {
    const short = createChipShortener({ aliases: { FILE: "F", CHANGE: "CH" }, orgHeads: ["ACME"] });
    expect(short("FILE")).toBe("F");
    expect(short("CHANGE")).toBe("CH");
    expect(short("ACME.DO_SOMETHING")).toBe("ACME");
    expect(short("COMMAND")).toBe("RUN"); // defaults kept when not overridden
  });

  it("shortenToolChipName loads defaults without throwing", () => {
    expect(shortenToolChipName("COMMAND")).toBeTruthy();
    expect(shortenToolChipName("SEARCH")).toBe("SEARCH");
  });
});
