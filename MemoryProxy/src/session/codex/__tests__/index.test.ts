import { describe, expect, it, vi } from "vitest";
import {
  InMemoryCodexResponseSessionMap,
  ProxyStorageCodexResponseSessionMap,
  buildSessionNotInitializedPayload,
  buildSessionNotInitializedResponse,
  readCodexIdentityHeaders,
  recoverCodexSession,
  resolveCodexSessionKey,
  validateCodexBinding,
} from "../index.js";
import { MemoryStorage } from "../../../storage/memory-storage.js";
import type { SessionStore } from "../../store.js";

describe("Codex session boundary", () => {
  it("prefers an explicit header and uses previous_response_id only through a map", async () => {
    const map = new InMemoryCodexResponseSessionMap();
    await map.put("resp_1", "session-from-response");

    await expect(resolveCodexSessionKey({
      headers: { "X-Session-ID": " header-session " },
      body: { previous_response_id: "resp_1" },
      fallbackKey: "fallback",
      responseSessionMap: map,
    })).resolves.toMatchObject({ source: "header", sessionKey: "header-session" });

    await expect(resolveCodexSessionKey({
      body: { previous_response_id: "resp_1" },
      fallbackKey: "fallback",
      responseSessionMap: map,
    })).resolves.toMatchObject({
      source: "previous_response_id",
      sessionKey: "session-from-response",
    });

    await expect(resolveCodexSessionKey({
      body: { previous_response_id: "resp_missing" },
      fallbackKey: "fallback",
      responseSessionMap: map,
    })).resolves.toMatchObject({ source: "fallback", sessionKey: "fallback" });
  });

  it("uses the stable Responses body identifiers before previous_response_id", async () => {
    await expect(resolveCodexSessionKey({
      headers: { "x-tdai-session-key": "tdai-session" },
      body: { prompt_cache_key: "cache-key", conversation: { id: "conversation-id" } },
      fallbackKey: "fallback",
    })).resolves.toMatchObject({ source: "header", sessionKey: "tdai-session" });

    await expect(resolveCodexSessionKey({
      body: { prompt_cache_key: "cache-key", previous_response_id: "resp_1" },
      fallbackKey: "fallback",
    })).resolves.toMatchObject({ source: "prompt_cache_key", sessionKey: "cache-key" });

    await expect(resolveCodexSessionKey({
      body: { conversation: { id: "conversation-id" } },
      fallbackKey: "fallback",
    })).resolves.toMatchObject({ source: "conversation", sessionKey: "conversation-id" });
  });

  it("scopes a ProxyStorage response map to the existing session layout", async () => {
    const storage = new MemoryStorage();
    const map = new ProxyStorageCodexResponseSessionMap(storage, {
      spaceId: "space-a",
      userId: "user-a",
    });
    await map.put("resp_2", "session-a");
    await expect(map.get("resp_2")).resolves.toBe("session-a");
    await expect(map.get("resp/invalid")).resolves.toBeNull();
  });

  it("rejects header identity changes against a stored binding", () => {
    expect(readCodexIdentityHeaders(new Headers({
      "X-Team-ID": " team-a ",
      "x-agent-id": "agent-a",
    }))).toMatchObject({ teamId: "team-a", agentId: "agent-a" });

    const binding = {
      outcome: "initialized" as const,
      userId: "user-a",
      teamId: "team-a",
      agentId: "agent-a",
      taskId: "task-a",
    };
    expect(validateCodexBinding(binding, {
      teamId: "team-a",
      agentId: "agent-a",
      taskId: "task-a",
    }, "user-a")).toMatchObject({ valid: true, status: "valid" });
    expect(validateCodexBinding(binding, { agentId: "agent-b" }, "user-a"))
      .toMatchObject({ valid: false, status: "mismatch", field: "agentId" });
  });

  it("does not call SessionStore recovery after binding validation fails", async () => {
    const getOrRecover = vi.fn();
    const bindingRepo = {
      getBinding: vi.fn().mockResolvedValue({
        outcome: "initialized",
        userId: "user-a",
        teamId: "team-a",
        agentId: "agent-a",
      }),
    };
    const result = await recoverCodexSession({
      store: { getOrRecover } as unknown as SessionStore,
      bindingRepo: bindingRepo as never,
      headers: { "x-agent-id": "agent-b" },
      sessionKey: "session-a",
      userId: "user-a",
    });
    expect(result.bindingRejected).toBe(true);
    expect(getOrRecover).not.toHaveBeenCalled();

    const noRepo = await recoverCodexSession({
      store: { getOrRecover } as unknown as SessionStore,
      headers: { "x-agent-id": "agent-a" },
      sessionKey: "session-a",
      userId: "user-a",
    });
    expect(noRepo.bindingValidation).toMatchObject({ valid: false, status: "unavailable" });
    expect(getOrRecover).not.toHaveBeenCalled();
  });

  it("builds the structured 409 error", async () => {
    expect(buildSessionNotInitializedPayload()).toMatchObject({
      error: { type: "invalid_request_error", code: "session_not_initialized" },
    });
    const response = buildSessionNotInitializedResponse();
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "session_not_initialized" },
    });
  });
});
