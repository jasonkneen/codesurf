import fs from "fs";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ToolResult } from "../types/index";
import { closeDatabase } from "./db";
import { SessionStore } from "./sessions";
import { extractToolResultFromOutput } from "./tool-results";
import { appendMessages, buildChatEntries, loadTranscriptState } from "./transcript";
import { systemReminderMessage } from "./transcript-view";

describe("transcript media tool results", () => {
  it("preserves media metadata when stored tool output is normalized", () => {
    const mediaResult: ToolResult = {
      success: true,
      output: "Generated 1 image.\n- /tmp/example.png",
      media: [
        {
          kind: "image",
          path: "/tmp/example.png",
          url: "https://example.com/generated.png",
          sourcePath: "/tmp/source.png",
          prompt: "Create a new hero image",
          modelId: "grok-imagine-image",
        },
      ],
    };

    expect(extractToolResultFromOutput(mediaResult)).toEqual(mediaResult);
  });
});

describe("transcript follow-up markers", () => {
  const tempRoot = path.join(process.cwd(), ".tmp-transcript-tests");
  const originalCodesurfHome = process.env.CODESURF_HOME;
  let tempHome = "";
  let tempCwd = "";
  let sessionId = "";

  beforeEach(() => {
    fs.mkdirSync(tempRoot, { recursive: true });
    tempHome = fs.mkdtempSync(path.join(tempRoot, "home-"));
    tempCwd = fs.mkdtempSync(path.join(tempRoot, "cwd-"));
    process.env.CODESURF_HOME = tempHome;
    closeDatabase();
    sessionId = new SessionStore(tempCwd).createSession("test-model", "agent", tempCwd).id;
  });

  afterEach(() => {
    closeDatabase();
    if (originalCodesurfHome === undefined) delete process.env.CODESURF_HOME;
    else process.env.CODESURF_HOME = originalCodesurfHome;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it("strips hidden follow-up markers while preserving extracted suggestions", () => {
    appendMessages(sessionId, [
      {
        role: "assistant",
        content: 'Done.\n\n<!-- codesurf-followups: ["Run focused tests", "Open the Hermes provider"] -->',
      },
    ]);

    expect(buildChatEntries(sessionId)).toMatchObject([
      {
        type: "assistant",
        content: "Done.",
        followupSuggestions: ["Run focused tests", "Open the Hermes provider"],
      },
    ]);
  });
});

describe("transcript structured tool failures", () => {
  const tempRoot = path.join(process.cwd(), ".tmp-transcript-failure-tests");
  const originalCodesurfHome = process.env.CODESURF_HOME;
  let tempHome = "";
  let tempCwd = "";
  let sessionId = "";

  beforeEach(() => {
    fs.mkdirSync(tempRoot, { recursive: true });
    tempHome = fs.mkdtempSync(path.join(tempRoot, "home-"));
    tempCwd = fs.mkdtempSync(path.join(tempRoot, "cwd-"));
    process.env.CODESURF_HOME = tempHome;
    closeDatabase();
    sessionId = new SessionStore(tempCwd).createSession("test-model", "agent", tempCwd).id;
  });

  afterEach(() => {
    closeDatabase();
    if (originalCodesurfHome === undefined) delete process.env.CODESURF_HOME;
    else process.env.CODESURF_HOME = originalCodesurfHome;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it("keeps error-json diagnostics and denied-execution reasons across persistence and rebuild", () => {
    appendMessages(sessionId, [
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "call-denied", toolName: "edit_file", input: { path: "a.ts" } },
          { type: "tool-call", toolCallId: "call-failed", toolName: "bash", input: { command: "rm -rf /" } },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-denied",
            toolName: "edit_file",
            output: { type: "execution-denied", reason: "user refused" },
          },
          {
            type: "tool-result",
            toolCallId: "call-failed",
            toolName: "bash",
            output: { type: "error-json", value: { success: false, error: "permission denied" } },
          },
        ],
      },
    ]);

    const entries = buildChatEntries(sessionId).filter((entry) => entry.type === "tool_result");
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      content: "user refused",
      toolResult: { success: false, error: "user refused" },
    });
    expect(entries[1]).toMatchObject({
      content: "permission denied",
      toolResult: { success: false, error: "permission denied" },
    });
  });
});

describe("background notifications on reload", () => {
  const tempRoot = path.join(process.cwd(), ".tmp-transcript-reminder-tests");
  const originalCodesurfHome = process.env.CODESURF_HOME;
  let tempHome = "";
  let tempCwd = "";
  let sessionId = "";

  beforeEach(() => {
    fs.mkdirSync(tempRoot, { recursive: true });
    tempHome = fs.mkdtempSync(path.join(tempRoot, "home-"));
    tempCwd = fs.mkdtempSync(path.join(tempRoot, "cwd-"));
    process.env.CODESURF_HOME = tempHome;
    closeDatabase();
    sessionId = new SessionStore(tempCwd).createSession("test-model", "agent", tempCwd).id;
  });

  afterEach(() => {
    closeDatabase();
    if (originalCodesurfHome === undefined) delete process.env.CODESURF_HOME;
    else process.env.CODESURF_HOME = originalCodesurfHome;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it("shows a <system-reminder> notification as a system row, not a user bubble", () => {
    appendMessages(sessionId, [
      { role: "user", content: "start d1" },
      { role: "assistant", content: "started" },
      systemReminderMessage("Delegation d1 finished."),
    ]);

    const entries = buildChatEntries(sessionId);

    expect(entries.map((entry) => entry.type)).toEqual(["user", "assistant", "assistant"]);
    expect(entries[2]?.content).toBe("Delegation d1 finished.");
    expect(JSON.stringify(entries)).not.toContain("<system-reminder>");
  });

  it("keeps a typed message that merely starts with a reminder as a user bubble", () => {
    appendMessages(sessionId, [{ role: "user", content: "<system-reminder>\nhook ctx\n</system-reminder>\n\nhi" }]);

    expect(buildChatEntries(sessionId).map((entry) => entry.type)).toEqual(["user"]);
  });

  it("rewrites a legacy mid-conversation system row into a reminder turn on load", () => {
    // What sessions saved before the fix hold: a notification as role "system"
    // between turns, which Anthropic rejects on every later request.
    appendMessages(sessionId, [
      { role: "user", content: "start d1" },
      { role: "assistant", content: "started" },
    ]);
    appendMessages(sessionId, [{ role: "system", content: "Delegation d1 finished." }]);
    appendMessages(sessionId, [{ role: "user", content: "what did it find?" }]);

    const { messages, seqs } = loadTranscriptState(sessionId);

    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "user"]);
    expect(messages[2]).toEqual(systemReminderMessage("Delegation d1 finished."));
    expect(seqs).toHaveLength(messages.length);
    expect(buildChatEntries(sessionId)[2]).toMatchObject({ type: "assistant", content: "Delegation d1 finished." });
  });
});
