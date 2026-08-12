import { afterEach, describe, expect, it, vi } from "vitest";
import { TdaiClient } from "./client.js";
import type { TdaiIdentity, TdaiMemoryConfig, TdaiMessage } from "./types.js";

const config: TdaiMemoryConfig = {
  enabled: true,
  endpoint: "http://tdai.test",
  apiKey: "key",
  serviceId: "space",
  writeL0: true,
  recallL1: false,
  injectL2L3: false,
  l1Limit: 5,
  l2Limit: 5,
  timeoutMs: 1000,
};

const identity: TdaiIdentity = {
  teamId: "team",
  userId: "user",
  agentId: "agent",
  sessionId: "session",
};

afterEach(() => vi.unstubAllGlobals());

describe("TdaiClient conversation idempotency", () => {
  it("sends the replay key in both header and body", async () => {
    const requests: RequestInit[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(init ?? {});
      return new Response(JSON.stringify({ code: 0, data: {} }), { status: 200 });
    }));

    await new TdaiClient(config).addConversationStrict(identity, [
      { role: "user", content: "hello" },
      { role: "assistant", content: "world" },
    ], { idempotencyKey: "round-1" });

    expect(requests).toHaveLength(1);
    expect(new Headers(requests[0].headers).get("idempotency-key")).toBe("round-1");
    expect(JSON.parse(String(requests[0].body))).toMatchObject({ idempotency_key: "round-1" });
  });

  it("derives a distinct stable key for each message batch", async () => {
    const keys: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      keys.push(new Headers(init?.headers).get("idempotency-key") ?? "");
      return new Response(JSON.stringify({ code: 0, data: {} }), { status: 200 });
    }));
    const messages: TdaiMessage[] = Array.from({ length: 101 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `message-${index}`,
    }));

    await new TdaiClient(config).addConversationStrict(identity, messages, { idempotencyKey: "round-2" });
    expect(keys).toEqual(["round-2:chunk:0", "round-2:chunk:1"]);
  });
});
