import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../../config.js";
import { createApp } from "../../server.js";
import type { ProxyConfig } from "../../types.js";

function testConfig(): ProxyConfig {
  const config = structuredClone(DEFAULT_CONFIG);
  config.upstream = { url: "http://responses.test/v1", apiKey: "", agents: {} };
  config.log.backend = "noop";
  config.log.file = "";
  config.creditReport.url = "";
  return config;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Responses handler black-box wiring", () => {
  it("rejects an unknown POST without invoking the Chat Completions handler", async () => {
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);
    const response = await createApp(testConfig()).request("/v1/responses/unknown", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "m", input: "x" }),
    });

    expect(response.status).toBe(404);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("fails closed when Responses session-init has no non-interactive binding", async () => {
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);
    const config = testConfig();
    config.sessionInit.enabled = true;
    const response = await createApp(config).request("/codex/space-a/v1/responses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-tdai-session-key": "session-without-identity",
      },
      body: JSON.stringify({ model: "m", input: "x" }),
    });

    expect(response.status).toBe(409);
    expect(upstream).not.toHaveBeenCalled();
  });
});
