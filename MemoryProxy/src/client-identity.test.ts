import { describe, expect, it } from "vitest";
import {
  clientFamilyToAgentSource,
  isNonInteractiveClientSource,
  normalizeClientFamily,
  readClientFamily,
  resolveAgentSourceFromClient,
} from "./client-identity.js";

describe("client identity", () => {
  it("accepts only the documented client families", () => {
    expect(normalizeClientFamily("claude")).toBe("claude");
    expect(normalizeClientFamily("Claude Desktop")).toBeUndefined();
    expect(normalizeClientFamily("claude-desktop")).toBeUndefined();
    expect(normalizeClientFamily("codex-cli")).toBeUndefined();
    expect(normalizeClientFamily("OpenCode")).toBe("opencode");
    expect(normalizeClientFamily("openai")).toBeUndefined();
  });

  it("reads x-client case-insensitively and trims values", () => {
    expect(readClientFamily(new Headers({ "X-Client": "  OpenCode " }))).toBe("opencode");
    expect(readClientFamily({ "X-CLIENT": "codex" })).toBe("codex");
    expect(readClientFamily({ "x-client": "unknown" })).toBeUndefined();
  });

  it("uses the family as the storage namespace", () => {
    expect(clientFamilyToAgentSource("claude")).toBe("claude");
    expect(clientFamilyToAgentSource("codex")).toBe("codex");
    expect(clientFamilyToAgentSource("opencode")).toBe("opencode");
    expect(resolveAgentSourceFromClient({ "x-client": "opencode" }, "codex")).toBe("opencode");
    expect(resolveAgentSourceFromClient({}, "codebuddy")).toBe("codebuddy");
    expect(isNonInteractiveClientSource("codex")).toBe(true);
    expect(isNonInteractiveClientSource("opencode")).toBe(true);
    expect(isNonInteractiveClientSource("claude")).toBe(false);
  });
});
