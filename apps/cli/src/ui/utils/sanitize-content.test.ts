import { describe, expect, it } from "vitest";
import {
  ASSISTANT_STREAM_PENDING_TAIL_CHARS,
  createAssistantStreamPreview,
  sanitizeAssistantContent,
} from "./sanitize-content";

describe("streaming assistant preview", () => {
  it("keeps the rendered response cumulative after it exceeds the pending-tail window", () => {
    const preview = createAssistantStreamPreview();
    const chunks = Array.from({ length: 180 }, (_, index) => `[${index}] `);
    let expected = "";
    let rendered = "";

    for (const chunk of chunks) {
      expected += chunk;
      rendered = preview.append(chunk);
      expect(rendered).toBe(expected);
    }

    expect(expected.length).toBeGreaterThan(ASSISTANT_STREAM_PENDING_TAIL_CHARS);
    expect(rendered).toContain("[0]");
    expect(rendered).toContain("[179]");
  });

  it("hides a completed follow-up marker live while finalization still extracts its suggestions", () => {
    const preview = createAssistantStreamPreview();
    const raw = 'assistant: Done.\n<!-- codesurf-followups: ["Run the focused tests"] -->';

    expect(preview.append("assistant: Done.\n<!-- codesurf-followups: [")).toBe("Done.\n<!-- codesurf-followups: [");
    expect(preview.append('"Run the focused tests"] -->')).toBe("Done.\n");
    expect(sanitizeAssistantContent(raw)).toEqual({
      content: "Done.",
      followupSuggestions: ["Run the focused tests"],
    });
  });

  it("drops a legacy tool wrapper even when its header arrives across deltas", () => {
    const preview = createAssistantStreamPreview();

    expect(preview.append('Visible answer.\n{"success": true, "out')).toBe('Visible answer.\n{"success": true, "out');
    expect(preview.append('put": "ignored"}')).toBe("Visible answer.\n");
  });
});
