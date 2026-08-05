import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../../config.js";
import { createApp } from "../../server.js";
import { normalizeWhitelistRequestPath } from "../../routes/whitelist.js";
import { responsesInputToMessages, adaptResponsesRequest } from "../request-adapter.js";
import {
  extractResponsesOutputText,
  parseResponsesJsonResponse,
} from "../json-parser.js";
import { SseFrameParser } from "../sse-parser.js";
import { parseResponsesSse } from "../response-parser.js";
import { matchResponsesRoute } from "../route.js";
import { findLastFinalAssistant, isFinalAnswer } from "../../skill/normalize-conversation.js";
import { countHumanTurns } from "../../turnSeq.js";
import { __resetInjectionPipelineForTests } from "../../injection/index.js";
import type { ProxyConfig } from "../../types.js";

function testConfig(): ProxyConfig {
  const config = structuredClone(DEFAULT_CONFIG);
  config.upstream = {
    url: "http://responses.test/v1/chat/completions",
    apiKey: "",
    agents: {},
  };
  config.log.backend = "noop";
  config.log.file = "";
  config.creditReport.url = "";
  return config;
}

function stubJsonUpstream(body: Record<string, unknown>) {
  const response = new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => response.clone());
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function forwardedBody(init: RequestInit | undefined): string {
  const body = init?.body;
  if (typeof body === "string") return body;
  if (body instanceof ArrayBuffer) return new TextDecoder().decode(body);
  return "";
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  __resetInjectionPipelineForTests();
});

describe("Responses route contract", () => {
  it.each([
    ["/v1/responses", "root"],
    ["/responses", "root"],
    ["/openai/v1/responses", "agent-space"],
    ["/openai/demo-space/v1/responses", "agent-space"],
    ["/codex/demo-space/responses?stream=false", "agent-space"],
    ["/proxy/demo-space/v1/responses", "proxy-space"],
  ])("matches route alias %s", (path, prefix) => {
    expect(matchResponsesRoute(path as string)).toMatchObject({
      endpoint: "responses",
      prefix,
    });
    expect(normalizeWhitelistRequestPath(path as string)).toBe("/v1/responses");
  });

  it.each([
    "/v1/responses",
    "/openai/demo-space/v1/responses",
    "/proxy/demo-space/responses",
  ])("registers route alias %s without entering Chat", async (path) => {
    const upstream = stubJsonUpstream({ id: "resp_1", status: "completed", output: [] });
    const response = await createApp(testConfig()).request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "model-alias", input: "hello" }),
    });

    expect(response.status).toBe(200);
    expect(upstream).toHaveBeenCalledOnce();
    expect(new URL(String(upstream.mock.calls[0]?.[0])).pathname).toBe("/v1/responses");
  });
});

describe("Responses request forwarding", () => {
  it("uses GET for the models helper endpoint", async () => {
    const upstream = stubJsonUpstream({ data: [{ id: "model-a" }] });
    const response = await createApp(testConfig()).request("/openai/demo-space/v1/models", {
      method: "GET",
    });

    expect(response.status).toBe(200);
    expect(upstream.mock.calls[0]?.[1]).toMatchObject({ method: "GET" });
  });

  it("preserves input/instructions shapes and the model alias in the raw upstream body", async () => {
    const requestBody = {
      model: "provider-model-alias",
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: "keep this input shape" }],
        },
        {
          type: "function_call_output",
          call_id: "call_1",
          output: "{\"ok\":true}",
        },
      ],
      instructions: [{ type: "input_text", text: "keep these instructions" }],
      stream: false,
    };
    const upstream = stubJsonUpstream({
      id: "resp_1",
      status: "completed",
      output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }],
    });

    const response = await createApp(testConfig()).request("/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(requestBody),
    });
    const init = upstream.mock.calls[0]?.[1] as RequestInit | undefined;

    expect(response.status).toBe(200);
    expect(JSON.parse(forwardedBody(init))).toStrictEqual(requestBody);
  });

  it.each([
    {
      name: "without instructions",
      body: {
        model: "model-alias",
        input: "real user input",
        tools: [{ type: "function", function: { name: "lookup" } }],
        previous_response_id: "resp_prev",
        unknown_provider_field: { nested: true },
      },
      assertInstructions: (instructions: unknown) => {
        expect(typeof instructions).toBe("string");
        expect(instructions).toEqual(expect.stringContaining("<skill_tools>"));
      },
    },
    {
      name: "with string instructions",
      body: {
        model: "model-alias",
        input: "real user input",
        instructions: "client instructions",
        unknown_provider_field: { nested: true },
      },
      assertInstructions: (instructions: unknown) => {
        expect(instructions).toEqual(expect.stringContaining("client instructions"));
        expect(String(instructions).match(/client instructions/g)).toHaveLength(1);
        expect(String(instructions).match(/<skill_tools>/g)).toHaveLength(1);
      },
    },
    {
      name: "with array instructions",
      body: {
        model: "model-alias",
        input: "real user input",
        instructions: [
          { type: "input_text", text: "client instructions" },
          { type: "future_item", payload: { keep: true } },
        ],
        unknown_provider_field: { nested: true },
      },
      assertInstructions: (instructions: unknown) => {
        expect(instructions).toBeInstanceOf(Array);
        const items = instructions as Array<Record<string, unknown>>;
        expect(items[0]?.type).toBe("input_text");
        expect(items[0]?.text).toEqual(expect.stringContaining("client instructions"));
        expect(String(items[0]?.text).match(/<skill_tools>/g)).toHaveLength(1);
        expect(items[1]).toStrictEqual({ type: "future_item", payload: { keep: true } });
      },
    },
  ])("overlays enabled injection into $name without changing the Responses shape", async ({ body, assertInstructions }) => {
    const config = testConfig();
    config.injection.enabled = true;
    config.injection.injectors = ["skill"];
    config.injection.externalGatewayUrl = "http://proxy.test";
    const upstream = stubJsonUpstream({ id: "resp_injection", status: "incomplete", output: [] });

    const response = await createApp(config).request("/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(200);

    const forwarded = JSON.parse(forwardedBody(upstream.mock.calls[0]?.[1] as RequestInit)) as Record<string, unknown>;
    expect(forwarded.input).toStrictEqual(body.input);
    expect(forwarded.model).toBe(body.model);
    expect(forwarded.tools).toStrictEqual(body.tools);
    expect(forwarded.previous_response_id).toBe(body.previous_response_id);
    expect(forwarded.unknown_provider_field).toStrictEqual(body.unknown_provider_field);
    assertInstructions(forwarded.instructions);
  });

  it("propagates a cancelled Responses request to the upstream stream without finalizing", async () => {
    const config = testConfig();
    config.server.forwardTimeoutMs = 10_000;
    let upstreamSignal: AbortSignal | undefined;
    const upstream = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      upstreamSignal = init?.signal ?? undefined;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(
            'event: response.output_text.delta\ndata: {"delta":"partial"}\n\n',
          ));
          upstreamSignal?.addEventListener("abort", () => {
            controller.error(upstreamSignal?.reason ?? new DOMException("aborted", "AbortError"));
          }, { once: true });
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    });
    vi.stubGlobal("fetch", upstream);

    const controller = new AbortController();
    const response = await createApp(config).fetch(new Request("http://proxy/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "model-alias", input: "cancel me", stream: true }),
      signal: controller.signal,
    }));
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    await reader!.read();

    controller.abort();

    await expect(reader!.read()).rejects.toThrow();
    expect(upstreamSignal?.aborted).toBe(true);
    expect(upstream).toHaveBeenCalledOnce();
  });
});

describe("Responses JSON protocol", () => {
  it("extracts output_text from non-stream JSON and ignores function_call output items", () => {
    const parsed = parseResponsesJsonResponse(JSON.stringify({
      status: "completed",
      output: [
        { type: "function_call", call_id: "call_1", name: "lookup", arguments: "{}" },
        {
          type: "message",
          content: [
            { type: "output_text", text: "Hello" },
            { type: "output_text", text: " world" },
          ],
        },
      ],
    }));

    expect(parsed.ok).toBe(true);
    expect(parsed.outputText).toBe("Hello world");
    expect(parsed.functionCalls).toStrictEqual([
      { call_id: "call_1", name: "lookup", arguments: "{}" },
    ]);
    expect(extractResponsesOutputText(parsed.response)).toBe("Hello world");
  });

  it.each([
    {
      status: "completed",
      body: {
        status: "completed",
        output: [{ type: "message", content: [{ type: "output_text", text: "done" }] }],
        usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
      },
      usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
      outputText: "done",
    },
    {
      status: "incomplete",
      body: {
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        output: [{ type: "message", content: [{ type: "output_text", text: "partial" }] }],
      },
      usage: null,
      outputText: "partial",
    },
    {
      status: "failed",
      body: { status: "failed", error: { code: "upstream_error" } },
      usage: null,
      outputText: "",
    },
  ])("preserves $status and tolerates missing usage", ({ status, body, usage, outputText }) => {
    const parsed = parseResponsesJsonResponse(JSON.stringify(body));
    expect(parsed.status).toBe(status);
    expect(parsed.outputText).toBe(outputText);
    expect(parsed.usage).toStrictEqual(usage);
  });

  it("extracts refusal content from a message output item", () => {
    const parsed = parseResponsesJsonResponse(JSON.stringify({
      status: "completed",
      output: [{
        type: "message",
        content: [{ type: "refusal", refusal: "I cannot help with that." }],
      }],
    }));

    expect(parsed.refusalText).toBe("I cannot help with that.");
    expect(parsed.assistantMessage?.content).toBe("I cannot help with that.");
  });
});

describe("Responses SSE protocol", () => {
  it("handles split JSON, CRLF, multiple data events, and terminal status/usage", () => {
    const parsed = parseResponsesSse([
      "event: response.output_text.delta\r\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"Hel",
      "lo\"}\r\n\r\nevent: response.output_text.delta\r\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\" world\"}\r\n\r\n",
      "event: response.completed\r\ndata: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\",\"usage\":{\"input_tokens\":2}}}\r\n\r\n",
      "data: [DONE]\r\n\r\n",
    ]);

    expect(parsed.outputText).toBe("Hello world");
    expect(parsed.status).toBe("completed");
    expect(parsed.usage).toStrictEqual({ input_tokens: 2 });
    expect(parsed.done).toBe(true);
    expect(parsed.malformedEvents).toBe(0);
    expect(parsed.events).toHaveLength(4);
  });

  it("joins multiple data fields in one SSE frame", () => {
    const parser = new SseFrameParser();
    expect(parser.push("event: message\ndata: first\ndata: second\n\n")).toStrictEqual([
      {
        event: "message",
        data: "first\nsecond",
        raw: "event: message\ndata: first\ndata: second",
      },
    ]);
  });

  it("aggregates function_call_arguments deltas without persisting reasoning", () => {
    const parsed = parseResponsesSse([
      "event: response.function_call_arguments.delta\ndata: {\"type\":\"response.function_call_arguments.delta\",\"item_id\":\"fc_1\",\"delta\":\"{\\\"q\\\":\"x\"\"}\n\n",
      "event: response.function_call_arguments.done\ndata: {\"type\":\"response.function_call_arguments.done\",\"item_id\":\"fc_1\",\"arguments\":\"{\\\"q\\\":\\\"x\\\"}\"}\n\n",
      "event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_fc\",\"status\":\"completed\"}}\n\n",
    ]);

    expect(parsed.functionCalls).toMatchObject([{ id: "fc_1", arguments: "{\"q\":\"x\"}" }]);
    expect(parsed.refusalText).toBe("");
  });

  it("does not turn failed or error events into a completed round", () => {
    const failed = parseResponsesSse([
      "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"partial\"}\n\n",
      "event: response.failed\ndata: {\"type\":\"response.failed\"}\n\n",
      "data: [DONE]\n\n",
    ]);
    const errored = parseResponsesSse([
      "event: error\ndata: {\"type\":\"error\",\"message\":\"upstream failed\"}\n\n",
      "data: [DONE]\n\n",
    ]);

    expect(failed.status).toBe("failed");
    expect(failed.done).toBe(true);
    expect(errored.status).toBe("failed");
  });
});

describe("Responses function_call loop round contract", () => {
  it("keeps one human round across repeated function_call/tool-result continuation", () => {
    const messages = responsesInputToMessages(
      [
        { role: "user", content: [{ type: "input_text", text: "question" }] },
        { type: "function_call", call_id: "call_1", name: "lookup", arguments: "{\"q\":\"x\"}" },
        { type: "function_call_output", call_id: "call_1", output: "result-1" },
        { type: "function_call", call_id: "call_2", name: "lookup", arguments: "{\"q\":\"y\"}" },
        { type: "function_call_output", call_id: "call_2", output: "result-2" },
        { role: "assistant", content: [{ type: "output_text", text: "done" }] },
      ],
      [{ type: "input_text", text: "system instruction" }],
    );

    const functionCall = messages[2];
    const finalAnswer = messages.at(-1);
    expect(functionCall?.role).toBe("assistant");
    expect(isFinalAnswer(functionCall)).toBe(false);
    expect(isFinalAnswer(finalAnswer)).toBe(true);
    expect(countHumanTurns(messages, "openai")).toBe(1);
    expect(findLastFinalAssistant(messages, "openai")).toBe(messages.length - 1);
    expect(countHumanTurns([...messages, { role: "user", content: "next question" }], "openai")).toBe(2);
  });

  it("adapts a function_call loop without changing the raw request model/input", () => {
    const body = {
      model: "model-alias",
      input: [
        { role: "user", content: "question" },
        { type: "function_call", call_id: "call_1", name: "lookup", arguments: "{}" },
        { type: "function_call_output", call_id: "call_1", output: "result" },
      ],
      instructions: "system instruction",
    };
    const adapted = adaptResponsesRequest(body);

    expect(adapted.model).toBe("model-alias");
    expect(adapted.input).toBe(body.input);
    expect(adapted.instructions).toBe(body.instructions);
    expect(adapted.messages.filter((message) => message.role === "user")).toHaveLength(1);
  });
});
