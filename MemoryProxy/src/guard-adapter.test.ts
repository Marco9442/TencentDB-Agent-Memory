import { describe, expect, it, vi } from "vitest";
import { joinUrl } from "./guard-adapter.js";
import { log } from "./report/log.js";

describe("joinUrl canonical endpoint handling", () => {
  it("does not warn when handlers pass the normalized Anthropic endpoint", () => {
    const warn = vi.spyOn(log, "warn");

    expect(joinUrl("https://upstream.example/v1", "/messages")).toBe(
      "https://upstream.example/v1/messages",
    );
    expect(warn).not.toHaveBeenCalledWith("joinUrl.fallback", expect.anything());

    warn.mockRestore();
  });

  it("does not warn when handlers pass the normalized OpenAI endpoint with a query", () => {
    const warn = vi.spyOn(log, "warn");

    expect(joinUrl("https://upstream.example/v1", "/chat/completions?stream=true")).toBe(
      "https://upstream.example/v1/chat/completions",
    );
    expect(warn).not.toHaveBeenCalledWith("joinUrl.fallback", expect.anything());

    warn.mockRestore();
  });
});
