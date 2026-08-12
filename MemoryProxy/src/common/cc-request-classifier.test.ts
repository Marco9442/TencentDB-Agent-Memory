import { describe, expect, it } from "vitest";
import { classifyCcRequest } from "./cc-request-classifier.js";

const text = (value: string, cache = false) => ({
  role: "user",
  content: [{ type: "text", text: value, ...(cache ? { cache_control: { type: "ephemeral" } } : {}) }],
});

describe("Claude request classification", () => {
  it("classifies a marker on the last message as main", () => {
    expect(classifyCcRequest({ messages: [text("hello", true)], tools: [{}] })).toBe("main");
  });

  it("classifies a marker on the penultimate message as fork", () => {
    expect(classifyCcRequest({
      messages: [text("cached", true), text("fork")],
      tools: [{}],
    })).toBe("fork");
  });

  it("classifies the no-cache lightweight shape as sidequery", () => {
    expect(classifyCcRequest({
      messages: [text("title")],
      tools: [],
      thinking: { type: "disabled" },
    })).toBe("sidequery");
  });

  it("fails open to main for an unknown no-marker shape", () => {
    expect(classifyCcRequest({ messages: [text("hello")], tools: [{}] })).toBe("main");
  });
});
