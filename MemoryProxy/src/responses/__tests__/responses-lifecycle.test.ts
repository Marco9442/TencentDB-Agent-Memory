import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../../config.js";
import { createApp } from "../../server.js";
import { __resetProxyStorageForTests, getProxyStorage } from "../../storage/factory.js";
import {
  __resetCodexResponseSessionMapForTests,
  InMemoryCodexResponseSessionMap,
  ProxyStorageCodexResponseSessionMap,
  resolveCodexSessionKey,
} from "../../session/codex/index.js";
import {
  __resetResponsesRoundStoreForTests,
  InMemoryResponsesRoundStore,
  ProxyStorageResponsesRoundStore,
} from "../round-store.js";
import { finalizeResponsesLifecycle } from "../handler.js";
import type { ParsedResponsesJson, ResponsesFunctionCall } from "../types.js";
import { flushPendingWrites, pendingWriteCount } from "../../tdai/pending-writes.js";
import type { ProxyConfig } from "../../types.js";
import type { ProxyStorage } from "../../storage/proxy-storage.js";
import { MemoryStorage } from "../../storage/memory-storage.js";

function testConfig(): ProxyConfig {
  const config = structuredClone(DEFAULT_CONFIG);
  config.upstream = { url: "http://responses.test/v1", apiKey: "server-key", agents: {} };
  config.storage.backend = "memory";
  config.log.backend = "noop";
  config.log.file = "";
  config.creditReport.url = "";
  config.tdai = {
    enabled: true,
    endpoint: "http://tdai.test",
    apiKey: "tdai-key",
    serviceId: "default",
    memory: {
      enabled: true,
      inject: false,
      writeL0: true,
      recallL1: false,
      injectL2L3: false,
      l1Limit: 5,
      l2Limit: 3,
      timeoutMs: 1000,
    },
  };
  return config;
}

const sessionInfo = {
  team_id: "team-a",
  agent_id: "agent-a",
  task_id: "task-a",
  user_id: "user-a",
  session_id: "session-a",
  space_id: "space-a",
};

function parsedResponse(
  id: string,
  status: "completed" | "incomplete" = "completed",
  outputText = "",
  functionCalls: ResponsesFunctionCall[] = [],
): ParsedResponsesJson {
  return {
    ok: true,
    value: { id, status },
    response: { id, status },
    status,
    outputText,
    refusalText: "",
    usage: null,
    outputItems: [],
    functionCalls,
    assistantMessage: null,
  };
}

async function finalize(
  config: ProxyConfig,
  store: InMemoryResponsesRoundStore,
  map: InMemoryCodexResponseSessionMap,
  id: string,
  parsed: ParsedResponsesJson,
  messages: Array<Record<string, unknown>>,
  predecessorState?: Awaited<ReturnType<InMemoryResponsesRoundStore["getState"]>>,
): Promise<void> {
  await finalizeResponsesLifecycle({
    config,
    path: "/v1/responses",
    modelId: "model-a",
    keyId: "user-a",
    sessionKey: "session-a",
    userId: "user-a",
    userKey: "user-key",
    agentSource: "codex",
    spaceId: "space-a",
    upstreamUrl: "http://upstream.test/v1/responses",
    status: 200,
    stream: false,
    parsed,
    messages,
    sessionInfo,
    responseSessionMap: map,
    roundStore: store,
    predecessorState,
  });
}

afterEach(async () => {
  await flushPendingWrites(100);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  __resetResponsesRoundStoreForTests();
  __resetCodexResponseSessionMapForTests();
  __resetProxyStorageForTests();
});

describe("Responses round lifecycle", () => {
  it("merges a real three-request tool loop and writes L0 once", async () => {
    const config = testConfig();
    const store = new InMemoryResponsesRoundStore("loop-scope");
    const map = new InMemoryCodexResponseSessionMap();
    const l0Bodies: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      l0Bodies.push(JSON.parse(String(init?.body ?? "{}")));
      return new Response(JSON.stringify({ code: 0, data: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }));

    await finalize(
      config,
      store,
      map,
      "resp_A",
      parsedResponse("resp_A", "completed", "", [
        { id: "item_A", call_id: "call_A", name: "lookup", arguments: "{}" },
      ]),
      [{ role: "user", content: "question" }],
    );
    const stateA = await store.getState("resp_A");

    await finalize(
      config,
      store,
      map,
      "resp_B",
      parsedResponse("resp_B", "completed", "", [
        { id: "item_B", call_id: "call_B", name: "lookup", arguments: "{}" },
      ]),
      [{ role: "tool", tool_call_id: "call_A", content: "result-A" }],
      stateA,
    );
    const stateB = await store.getState("resp_B");

    await finalize(
      config,
      store,
      map,
      "resp_C",
      parsedResponse("resp_C", "completed", "final answer"),
      [{ role: "tool", tool_call_id: "call_B", content: "result-B" }],
      stateB,
    );
    const stateC = await store.getState("resp_C");

    expect(l0Bodies).toHaveLength(1);
    expect((l0Bodies[0] as { messages: Array<{ role: string; content: string }> }).messages)
      .toStrictEqual([
        { role: "user", content: "question" },
        { role: "assistant", content: "final answer" },
      ]);
    expect(stateA).toMatchObject({ originalUserInput: "question", pendingCallIds: ["call_A"] });
    expect(stateB).toMatchObject({
      originalUserInput: "question",
      pendingCallIds: ["call_B"],
      seenResponseIds: ["resp_A", "resp_B"],
    });
    expect(stateC).toMatchObject({
      originalUserInput: "question",
      pendingCallIds: [],
      seenResponseIds: ["resp_A", "resp_B", "resp_C"],
      finalResponseId: "resp_C",
      l0Status: "completed",
      sessionKey: "session-a",
    });
    expect(stateC?.conversationMessages?.map((message) => message.role)).toStrictEqual([
      "user", "assistant", "tool", "assistant", "tool",
    ]);
    await expect(map.get("resp_C")).resolves.toBe("session-a");
  });

  it("leaves the marker pending on a 503 and completes after retry", async () => {
    const config = testConfig();
    const store = new InMemoryResponsesRoundStore("retry-scope");
    const map = new InMemoryCodexResponseSessionMap();
    let failures = 1;
    const stateDuringFailure: { current: { l0Status?: string } | null } = { current: null };
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (failures > 0) {
        failures--;
        stateDuringFailure.current = await store.getState("resp_retry");
        return new Response("temporarily unavailable", { status: 503 });
      }
      return new Response(JSON.stringify({ code: 0, data: {} }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await finalize(
      config,
      store,
      map,
      "resp_retry",
      parsedResponse("resp_retry", "completed", "recovered"),
      [{ role: "user", content: "retry question" }],
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(stateDuringFailure.current?.l0Status).not.toBe("completed");
    await expect(store.getState("resp_retry")).resolves.toMatchObject({ l0Status: "completed" });
  });

  it("uses the atomic claim for concurrent duplicate finals", async () => {
    const config = testConfig();
    const store = new InMemoryResponsesRoundStore("claim-scope");
    const map = new InMemoryCodexResponseSessionMap();
    const fetchMock = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      return new Response(JSON.stringify({ code: 0, data: {} }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const final = parsedResponse("resp_duplicate", "completed", "one answer");
    await Promise.all([
      finalize(config, store, map, "resp_duplicate", final, [{ role: "user", content: "same" }]),
      finalize(config, store, map, "resp_duplicate", final, [{ role: "user", content: "same" }]),
    ]);

    expect(fetchMock).toHaveBeenCalledOnce();
    await expect(store.getState("resp_duplicate")).resolves.toMatchObject({ l0Status: "completed" });
  });
});

describe("Responses HTTP continuation", () => {
  it("keeps client and internal identity credentials off the provider leg", async () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.upstream = { url: "http://responses.test/v1", apiKey: "server-key", agents: {} };
    config.storage.backend = "memory";
    config.log.backend = "noop";
    config.log.file = "";
    config.creditReport.url = "";
    let forwardedHeaders: Headers | undefined;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      forwardedHeaders = new Headers(init?.headers);
      return new Response(JSON.stringify({ id: "resp_headers", status: "incomplete" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await createApp(config).request("/v1/responses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: "Bearer client-key",
        "x-api-key": "client-api-key",
        "x-tdai-user-key": "memory-user-key",
        "x-tdai-user-token": "memory-user-token",
        "x-team-id": "team-a",
        "x-agent-id": "agent-a",
        "x-task-id": "task-a",
        "x-tdai-session-key": "session-a",
      },
      body: JSON.stringify({ model: "m", input: "headers" }),
    });
    expect(response.status).toBe(200);
    await response.text();
    expect(forwardedHeaders?.get("authorization")).toBe("Bearer server-key");
    for (const name of [
      "x-api-key",
      "x-tdai-user-key",
      "x-tdai-user-token",
      "x-team-id",
      "x-agent-id",
      "x-task-id",
      "x-tdai-session-key",
    ]) {
      expect(forwardedHeaders?.has(name)).toBe(false);
    }
  });

  it("publishes mapping and round state before delayed durable writes", async () => {
    const base = new MemoryStorage();
    const delayed = {
      type: "memory" as const,
      putJSON: async (key: string, value: unknown) => {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        await base.putJSON(key, value);
      },
      putText: base.putText.bind(base),
      putJSONIfAbsent: async (key: string, value: unknown) => {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        return base.putJSONIfAbsent(key, value);
      },
      putTextIfAbsent: base.putTextIfAbsent.bind(base),
      getJSON: base.getJSON.bind(base),
      getText: base.getText.bind(base),
      exists: base.exists.bind(base),
      del: base.del.bind(base),
      delPrefix: base.delPrefix.bind(base),
      listNames: base.listNames.bind(base),
    } satisfies ProxyStorage;
    const store = new ProxyStorageResponsesRoundStore(delayed, "race-scope");
    const map = new ProxyStorageCodexResponseSessionMap(delayed, {
      userId: "user-a",
      spaceId: "space-a",
    });
    const state = {
      spaceId: "space-a",
      userId: "user-a",
      agentSource: "codex",
      sessionKey: "session-a",
      roundId: "resp_race",
      originalUserInput: "question",
      pendingCallIds: ["call-a"],
      seenResponseIds: ["resp_race"],
      updatedAt: new Date().toISOString(),
    };

    const stateWrite = store.putState("resp_race", state);
    const mapWrite = map.put("resp_race", "session-a");
    await expect(store.getState("resp_race")).resolves.toMatchObject({ originalUserInput: "question" });
    await expect(resolveCodexSessionKey({
      body: { previous_response_id: "resp_race" },
      responseSessionMap: map,
    })).resolves.toMatchObject({ sessionKey: "session-a", source: "previous_response_id" });
    await Promise.all([stateWrite, mapWrite]);
  });

  it("keeps three independent HTTP requests in one response chain", async () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.upstream = { url: "http://responses.test/v1", apiKey: "", agents: {} };
    config.storage.backend = "memory";
    config.log.backend = "noop";
    config.log.file = "";
    config.creditReport.url = "";
    const upstreamBodies = [
      {
        id: "resp_http_A",
        status: "completed",
        output: [{ type: "function_call", call_id: "http_call_A", name: "lookup", arguments: "{}" }],
      },
      {
        id: "resp_http_B",
        status: "completed",
        output: [{ type: "function_call", call_id: "http_call_B", name: "lookup", arguments: "{}" }],
      },
      {
        id: "resp_http_C",
        status: "completed",
        output: [{ type: "message", content: [{ type: "output_text", text: "done" }] }],
      },
    ];
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(upstreamBodies.shift()), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const app = createApp(config);

    const first = await app.request("/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "m", input: "question" }),
    });
    expect(first.status).toBe(200);
    await first.text();

    const second = await app.request("/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "m",
        previous_response_id: "resp_http_A",
        input: [{ type: "function_call_output", call_id: "http_call_A", output: "A" }],
      }),
    });
    expect(second.status).toBe(200);
    await second.text();

    const third = await app.request("/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "m",
        previous_response_id: "resp_http_B",
        input: [{ type: "function_call_output", call_id: "http_call_B", output: "B" }],
      }),
    });
    expect(third.status).toBe(200);
    await third.text();

    const scope = "_default:unknown:codex:unknown";
    const store = new ProxyStorageResponsesRoundStore(getProxyStorage(config.storage), scope);
    await expect(store.getState("resp_http_C")).resolves.toMatchObject({
      originalUserInput: "question",
      seenResponseIds: ["resp_http_A", "resp_http_B", "resp_http_C"],
      pendingCallIds: [],
      finalResponseId: "resp_http_C",
      sessionKey: "unknown",
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("closes SSE before a slow tracked side effect and flushes it later", async () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.upstream = { url: "http://responses.test/v1", apiKey: "", agents: {} };
    config.storage.backend = "memory";
    config.log.backend = "noop";
    config.log.file = "";
    config.creditReport.url = "http://credit.test";
    let creditStarted = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("credit.test")) {
        creditStarted = true;
        await new Promise((resolve) => setTimeout(resolve, 1000));
        return new Response(JSON.stringify({ code: 0 }), { status: 200 });
      }
      const sse = "event: response.completed\ndata: {\"response\":{\"id\":\"resp_sse\",\"status\":\"completed\",\"usage\":{\"input_tokens\":1}}}\n\ndata: [DONE]\n\n";
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(sse));
          controller.close();
        },
      }), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const response = await createApp(config).request("/codex/space-a/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "m", input: "sse" , stream: true }),
    });

    const startedAt = Date.now();
    const body = await response.text();
    const elapsed = Date.now() - startedAt;
    expect(body).toContain("data: [DONE]");
    expect(elapsed).toBeLessThan(500);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(creditStarted).toBe(true);
    expect(pendingWriteCount()).toBeGreaterThan(0);
    await expect(flushPendingWrites(2500)).resolves.toMatchObject({ drained: true, remaining: 0 });
    expect(pendingWriteCount()).toBe(0);
  });
});
