import { describe, expect, it } from "vitest";
import {
  choosePickerAction,
  chooseStartupServer,
  isEligible,
  isInsideProject,
  rankServers,
  type ServerCandidate,
  scopeLabel,
} from "./scope";

const cwd = "/work/app/src";
const server = (over: Partial<ServerCandidate>): ServerCandidate => ({
  url: "ws://127.0.0.1:3948",
  scope: "user",
  known: true,
  ...over,
});

const defaultUser = server({ name: "default", lastUsedAt: "2026-09-01T00:00:00Z" });
const otherUser = server({ url: "ws://127.0.0.1:3949", name: "second", lastUsedAt: "2026-09-20T00:00:00Z" });
const thisProject = server({ url: "ws://127.0.0.1:3950", name: "app", scope: "project", project: "/work/app" });
const otherProject = server({ url: "ws://127.0.0.1:3951", name: "other", scope: "project", project: "/work/other" });
const fresh = server({ url: "ws://127.0.0.1:3952", known: false });

describe("scope helpers", () => {
  it("project containment", () => {
    expect(isInsideProject("/work/app", "/work/app")).toBe(true);
    expect(isInsideProject("/work/app/src", "/work/app")).toBe(true);
    expect(isInsideProject("/work/application", "/work/app")).toBe(false);
    expect(isInsideProject("/work", "/work/app")).toBe(false);
  });

  it("eligibility and labels", () => {
    expect(isEligible(defaultUser, cwd)).toBe(true);
    expect(isEligible(thisProject, cwd)).toBe(true);
    expect(isEligible(otherProject, cwd)).toBe(false);
    expect(scopeLabel(defaultUser)).toBe("user");
    expect(scopeLabel(thisProject)).toBe("project: /work/app");
  });

  it("ranks this project > default > most recently used > other folders", () => {
    expect(rankServers([otherProject, otherUser, defaultUser, thisProject], cwd).map((s) => s.name)).toEqual([
      "app",
      "default",
      "second",
      "other",
    ]);
  });
});

describe("chooseStartupServer", () => {
  it.each<[string, ServerCandidate[], ReturnType<typeof chooseStartupServer>]>([
    ["nothing running -> none", [], { kind: "none" }],
    ["single known user server -> attach", [defaultUser], { kind: "attach", server: defaultUser }],
    ["single new server -> confirm", [fresh], { kind: "confirm", server: fresh }],
    ["another project's server -> never auto (none)", [otherProject], { kind: "none" }],
    ["this project's server beats default", [defaultUser, thisProject], { kind: "attach", server: thisProject }],
    ["default beats a more recent user server", [otherUser, defaultUser], { kind: "attach", server: defaultUser }],
    ["known beats new", [fresh, otherUser], { kind: "attach", server: otherUser }],
    [
      "other project's server ignored next to default",
      [otherProject, defaultUser],
      { kind: "attach", server: defaultUser },
    ],
    [
      "most recently used wins among equals",
      [
        server({ name: "a", lastUsedAt: "2026-09-01T00:00:00Z" }),
        server({ name: "b", lastUsedAt: "2026-09-02T00:00:00Z" }),
      ],
      { kind: "attach", server: server({ name: "b", lastUsedAt: "2026-09-02T00:00:00Z" }) },
    ],
  ])("%s", (_label, candidates, expected) => {
    expect(chooseStartupServer(candidates, cwd)).toEqual(expected);
  });

  it("ambiguous known servers -> choose", () => {
    const a = server({ name: "a" });
    const b = server({ url: "ws://127.0.0.1:3949", name: "b" });
    expect(chooseStartupServer([a, b], cwd)).toEqual({ kind: "choose", servers: [a, b] });
  });

  it("several new servers -> choose", () => {
    const other = { ...fresh, url: "ws://127.0.0.1:3953" };
    expect(chooseStartupServer([fresh, other], cwd)).toMatchObject({ kind: "choose" });
  });
});

describe("choosePickerAction (/server)", () => {
  it("single known user server -> connect", () => {
    expect(choosePickerAction([defaultUser], cwd)).toEqual({ kind: "connect", server: defaultUser });
  });

  it("single known project server for this folder -> connect", () => {
    expect(choosePickerAction([thisProject], cwd)).toEqual({ kind: "connect", server: thisProject });
  });

  it("single new server -> picker", () => {
    expect(choosePickerAction([fresh], cwd)).toEqual({ kind: "picker", servers: [fresh] });
  });

  it("another folder's project server -> picker, never auto", () => {
    expect(choosePickerAction([otherProject], cwd)).toEqual({ kind: "picker", servers: [otherProject] });
  });

  it("already attached to the only server -> picker (so you can detach)", () => {
    expect(choosePickerAction([defaultUser], cwd, defaultUser.url)).toEqual({ kind: "picker", servers: [defaultUser] });
  });

  it("multiple -> picker, ranked", () => {
    expect(choosePickerAction([otherProject, defaultUser, thisProject], cwd)).toEqual({
      kind: "picker",
      servers: [thisProject, defaultUser, otherProject],
    });
  });

  it("nothing running -> empty picker", () => {
    expect(choosePickerAction([], cwd)).toEqual({ kind: "picker", servers: [] });
  });
});
