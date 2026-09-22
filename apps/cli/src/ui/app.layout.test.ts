import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("App overlay layout", () => {
  it("keeps inline approval panels out of the full-screen modal scrim", () => {
    const source = readFileSync(fileURLToPath(new URL("./hooks/use-modal-guard-state.ts", import.meta.url)), "utf8");

    expect(source).toContain("const inlinePromptCaptureOpen =");
    expect(source).toContain(
      "!!pendingPaymentApproval || !!pendingToolApproval || !!pendingEditApproval || !!pendingQuestionnaire",
    );
    // captureOpen = modals + inline prompts; modalOpen (modals only) is what
    // the inline cards consult so they ignore keys under a modal.
    expect(source).toContain("const modalOpen =\n    blockPrompt ||");
    expect(source).toContain("const captureOpen = modalOpen || inlinePromptCaptureOpen || showPlanPanel;");
    expect(source).toContain("!inlinePromptCaptureOpen &&");
  });

  it("suppresses terminal-native inline images behind full-screen overlays", () => {
    const source = readFileSync(fileURLToPath(new URL("./hooks/use-modal-guard-state.ts", import.meta.url)), "utf8");

    expect(source).toContain('import { setInlineImageSuppressed } from "../ai-output/inline-image"');
    expect(source).toContain("setInlineImageSuppressed(modalScrimOpen || modal.dynamicScreens.size > 0)");
    expect(source).toContain("return () => setInlineImageSuppressed(false)");
  });

  it("keeps footer chrome in bounded left and right lanes", () => {
    const source = readFileSync(fileURLToPath(new URL("./app.tsx", import.meta.url)), "utf8");
    const ccLayout = readFileSync(fileURLToPath(new URL("./layouts/claude-code.tsx", import.meta.url)), "utf8");
    const ocLayout = readFileSync(fileURLToPath(new URL("./layouts/opencode.tsx", import.meta.url)), "utf8");

    // Footer widths are still computed in App and forwarded via ctx.
    expect(source).toContain("const footerRightMaxWidth =");
    expect(source).toContain("const compactFooterHints =");
    // The footer JSX now lives in the layout modules.
    const footerSource = `${ccLayout}\n${ocLayout}`;
    expect(footerSource).toContain('flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden"');
    expect(footerSource).toContain("maxWidth={footerRightMaxWidth}");
    expect(footerSource).toContain(
      "<ComposerShortcutHints t={t} hints={composerShortcutHints} compact={compactFooterHints} />",
    );
  });

  it("keeps session status and approval chrome when routed through layouts", () => {
    const _source = readFileSync(fileURLToPath(new URL("./app.tsx", import.meta.url)), "utf8");
    const ccLayout = readFileSync(fileURLToPath(new URL("./layouts/claude-code.tsx", import.meta.url)), "utf8");
    const ocLayout = readFileSync(fileURLToPath(new URL("./layouts/opencode.tsx", import.meta.url)), "utf8");
    const layoutSource = `${ccLayout}\n${ocLayout}`;
    const sessionRoute = readFileSync(fileURLToPath(new URL("./routes/session-route.tsx", import.meta.url)), "utf8");

    expect(sessionRoute).toContain("<SubagentActivity t={t} status={activeSubagent} />");
    expect(sessionRoute).toContain("<ClaudeCodeStatusLine");
    expect(sessionRoute).toContain("<PlanQuestionsPanel t={t} questions={planQuestions} state={pqs} />");
    expect(sessionRoute).toContain("<EditApprovalPanel");
    expect(sessionRoute).toContain("statusSlot,");
    expect(layoutSource).toContain("{statusSlot}");
  });

  it("lets fast provider tool lifecycle events paint before result cleanup", () => {
    const source = readFileSync(fileURLToPath(new URL("./hooks/use-turn-engine.ts", import.meta.url)), "utf8");

    expect(source).toContain("Hermes can emit running/completed lifecycle events");
    expect(source).toContain("await new Promise<void>((r) => setImmediate(r));\n                break;");
  });

  it("commits a submitted message before waiting for prompt preparation or the shared turn coordinator", () => {
    const source = readFileSync(fileURLToPath(new URL("./hooks/use-turn-engine.ts", import.meta.url)), "utf8");

    expect(source).toContain("flushSync(() => {");
    expect(source).toContain("buildUserEntry((displayText ?? text).trim()");
    expect(source.indexOf("flushSync(() => {")).toBeLessThan(source.indexOf("coordinatorRef.current.run"));
    expect(source.indexOf("coordinatorRef.current.run")).toBeLessThan(source.indexOf("await resolveTurnInput({"));
  });

  // The flushSync above latches isProcessing=true BEFORE the turn joins the
  // coordinator, so the release must not hang off the happy path alone. If a
  // turn throws, is abandoned by an abort, or simply never settles, the latch
  // has to come off anyway — otherwise processMessage's
  // `if (isProcessingRef.current) return` guard locks the user out of every
  // future turn ("Waiting... Ns" with nothing running).
  it("releases the processing latch on every turn exit, not just the happy path", () => {
    const source = readFileSync(fileURLToPath(new URL("./hooks/use-turn-engine.ts", import.meta.url)), "utf8");

    expect(source).toContain(".finally(() => {");
    expect(source.indexOf("coordinatorRef.current.run")).toBeLessThan(source.indexOf(".finally(() => {"));
    // Released only if this run still owns the latch — finishTurnProcessing also
    // dispatches the next queued message, so an unguarded second call would shift
    // the queue twice and silently drop a message.
    expect(source).toContain("if (!isStale() && isProcessingRef.current) {");
    expect(source).toContain("finishTurnProcessing();");
  });

  it("forces the transcript to an inline approval or questionnaire when it appears", () => {
    const engine = readFileSync(fileURLToPath(new URL("./hooks/use-turn-engine.ts", import.meta.url)), "utf8");
    const stream = readFileSync(fileURLToPath(new URL("./hooks/use-turn-stream.ts", import.meta.url)), "utf8");

    expect(engine).toContain("const revealInlinePrompt");
    expect(engine).toContain("revealInlinePrompt();");
    expect(stream).toContain("const scrollToBottom = useCallback(");
    expect(stream).toContain("(force = false) => {");
    expect(stream).toContain("if (!force && !transcriptAutoFollowRef.current) return;");
  });
});
