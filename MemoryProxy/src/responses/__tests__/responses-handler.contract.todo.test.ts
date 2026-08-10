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

  it("traces an OpenCode native selection and replays it to the upstream", async () => {
    const config = testConfig();
    config.upstream = { url: "http://upstream.test/v1", apiKey: "", agents: {} };
    config.storage.backend = "memory";
    config.storage.enabled = true;
    config.sessionInit.enabled = true;
    config.coreSkill.endpoint = "http://metadata.test";
    config.coreSkill.timeoutMs = 1000;
    config.injection.enabled = false;
    config.tdai.enabled = true;
    config.tdai.endpoint = "http://tdai.test";
    config.tdai.apiKey = "tdai-key";
    config.tdai.memory.enabled = true;
    config.tdai.memory.writeL0 = true;
    config.tdai.memory.recallL1 = false;

    const forwardedBodies: Record<string, unknown>[] = [];
    const l0Bodies: Record<string, unknown>[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("http://upstream.test")) {
        forwardedBodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
        return new Response(JSON.stringify({
          id: "upstream-final",
          object: "response",
          status: "completed",
          output: [{ type: "message", content: [{ type: "output_text", text: "你好，我是 global-agent。" }] }],
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.startsWith("http://tdai.test") && new URL(url).pathname.endsWith("/v3/conversation/add")) {
        l0Bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
        return new Response(JSON.stringify({ code: 0, data: {} }));
      }
      const path = new URL(url).pathname;
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      const team = {
        team_id: "team-herigo",
        name: "HeriGo",
        metadata_json: JSON.stringify({ fallback_agent_id: "agent-global" }),
      };
      const globalAgent = {
        agent_id: "agent-global", team_id: "team-herigo", name: "global-agent",
        description: "fallback", status: "active", visibility: "team",
      };
      const privateAgent = {
        agent_id: "agent-private", team_id: "team-herigo", name: "personal-admin",
        description: "private", status: "active", visibility: "private",
      };
      const task = { task_id: "task-herigo", team_id: "team-herigo", title: "HeriGo", status: "running" };
      if (path.endsWith("/team/list")) return new Response(JSON.stringify({ code: 0, data: { items: [team], total: 1 } }));
      if (path.endsWith("/agent/list")) return new Response(JSON.stringify({ code: 0, data: { items: [privateAgent], total: 1 } }));
      if (path.endsWith("/agent/get")) return new Response(JSON.stringify({ code: 0, data: body.agent_id === "agent-global" ? globalAgent : privateAgent }));
      if (path.endsWith("/task/list")) return new Response(JSON.stringify({ code: 0, data: { items: [task], total: 1 } }));
      if (path.endsWith("/task/get")) return new Response(JSON.stringify({ code: 0, data: task }));
      return new Response(JSON.stringify({ code: 0, data: {} }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const headers = {
      "content-type": "application/json",
      Authorization: "Bearer user-key",
      "x-client": "opencode",
      "x-team-id": "team-herigo",
      "x-task-id": "task-herigo",
      "x-tdai-session-key": "native-http-session",
    };
    const first = await createApp(config).request("/proxy/space-a/v1/responses", {
      method: "POST",
      headers,
      body: JSON.stringify({ model: "grok-4.5", input: "你是谁" }),
    });
    expect(first.status).toBe(200);
    const firstBody = await first.json() as Record<string, any>;
    const firstCall = firstBody.output[0];
    expect(firstCall.name).toBe("question");
    const firstArgs = JSON.parse(firstCall.arguments);
    expect(firstArgs.questions[0].multiple).toBe(false);

    const second = await createApp(config).request("/proxy/space-a/v1/responses", {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "grok-4.5",
        previous_response_id: firstBody.id,
        input: [{
          type: "function_call_output",
          call_id: firstCall.call_id,
          output: JSON.stringify({ answers: { agent: "personal-admin (agent-private)" } }),
        }],
      }),
    });
    expect(second.status).toBe(200);
    await second.text();
    expect(forwardedBodies).toHaveLength(1);
    expect(forwardedBodies[0].previous_response_id).toBeUndefined();
    expect((forwardedBodies[0].input as any[]).map((item) => item.type)).toStrictEqual([
      "message", "function_call", "function_call_output",
    ]);
    expect(l0Bodies).toHaveLength(1);
    expect(l0Bodies[0].agent_id).toBe("agent-private");
    expect(l0Bodies[0].task_id).toBe("task-herigo");
    expect(l0Bodies[0].messages).toStrictEqual([
      { role: "user", content: "你是谁" },
      { role: "assistant", content: "你好，我是 global-agent。" },
    ]);
  });
});
