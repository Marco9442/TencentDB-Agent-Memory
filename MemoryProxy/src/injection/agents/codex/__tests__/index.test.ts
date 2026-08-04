import { describe, expect, it } from "vitest";
import {
  injectCodexDeveloperInstructions,
  injectCodexInstructions,
  injectCodexSessionContext,
  injectCodexSystemInstructions,
} from "../index.js";

describe("Codex Responses instruction injection", () => {
  it("appends to string and input_text instructions without mutating the body", () => {
    const body = {
      instructions: [{ type: "input_text", text: "base" }],
      input: "question",
    };
    const result = injectCodexInstructions(body, "memory");
    expect(result.applied).toBe(true);
    expect(result.body.instructions).toStrictEqual([
      { type: "input_text", text: "base\n\nmemory" },
    ]);
    expect(body.instructions).toStrictEqual([{ type: "input_text", text: "base" }]);
  });

  it("targets developer/system input roles explicitly", () => {
    const body = {
      input: [
        { role: "developer", content: "developer rules" },
        { role: "system", content: "system rules" },
      ],
    };
    expect(injectCodexDeveloperInstructions(body, "dev").body.input).toStrictEqual([
      { role: "developer", content: "developer rules\n\ndev" },
      { role: "system", content: "system rules" },
    ]);
    expect(injectCodexSystemInstructions(body, "sys").body.input).toStrictEqual([
      { role: "developer", content: "developer rules" },
      { role: "system", content: "system rules\n\nsys" },
    ]);
  });

  it("reuses the existing Agent/Task session context block", () => {
    const result = injectCodexSessionContext(
      {},
      { id: "agent-a", name: "Agent A", prompt: "be precise" },
      { id: "task-a", name: "Task A", description: "ship it" },
      null,
      "session-a",
    );
    expect(result.applied).toBe(true);
    expect(result.body.instructions).toEqual(expect.stringContaining("<session_context>"));
    expect(result.body.instructions).toEqual(expect.stringContaining("agent-a"));
    expect(result.body.instructions).toEqual(expect.stringContaining("task-a"));
  });
});
