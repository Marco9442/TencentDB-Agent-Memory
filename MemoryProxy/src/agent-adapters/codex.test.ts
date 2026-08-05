import { describe, expect, it } from "vitest";
import { codexAdapter } from "./codex.js";

describe("Codex agent adapter", () => {
  it("extracts the latest user text from Responses input items", () => {
    expect(codexAdapter.extractUserText([
      { role: "user", content: [{ type: "input_text", text: "first" }] },
      { type: "function_call_output", output: "tool result" },
      { role: "user", content: [{ type: "input_text", text: "latest" }] },
    ])).toBe("latest");
    expect(codexAdapter.classifyRequest({})).toBe("main");
  });
});
