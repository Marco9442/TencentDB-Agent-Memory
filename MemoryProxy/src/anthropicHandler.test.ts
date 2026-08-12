import { describe, expect, it } from "vitest";
import { shouldRecordAnthropicMemory } from "./anthropicHandler.js";

describe("Anthropic memory eligibility", () => {
  it("rejects an internal text-only request when no human text was extracted", () => {
    expect(shouldRecordAnthropicMemory(null, [
      { role: "user", content: "Err on the side of blocking..." },
    ])).toBe(false);
  });

  it("keeps pure tool_result continuations eligible for assistant/tool-loop records", () => {
    expect(shouldRecordAnthropicMemory(null, [
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-1", content: "ok" }] },
    ])).toBe(true);
  });

  it("does not let an old tool_result make a later internal request eligible", () => {
    expect(shouldRecordAnthropicMemory(null, [
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-1", content: "ok" }] },
      { role: "assistant", content: [{ type: "text", text: "continued" }] },
      { role: "user", content: "Err on the side of blocking..." },
    ])).toBe(false);
  });
});
