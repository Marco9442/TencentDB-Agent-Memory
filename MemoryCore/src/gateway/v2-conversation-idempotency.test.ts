import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IMemoryStore, L0QueryRow, L0Record } from "../core/store/types.js";
import type { StorageAdapter } from "../core/storage/adapter.js";
import type { Logger } from "../core/types.js";
import type { V2AuthContext } from "./v2-schemas.js";
import {
  __resetConversationIdempotencyForTests,
  handleConversationAdd,
  type V2RouterDeps,
} from "./v2-router.js";

const auth: V2AuthContext = { apiKey: "test", serviceId: "space-1" };
const isolation = {
  teamId: "team-1",
  userId: "user-1",
  agentId: "agent-1",
  sessionId: "session-1",
  taskId: "task-1",
};

function toRow(record: L0Record): L0QueryRow {
  return {
    record_id: record.id,
    session_key: record.sessionKey,
    session_id: record.sessionId,
    team_id: record.teamId ?? "",
    task_id: record.taskId ?? "",
    user_id: record.userId ?? "",
    agent_id: record.agentId ?? "",
    role: record.role,
    message_text: record.messageText,
    recorded_at: record.recordedAt,
    timestamp: record.timestamp,
  };
}

function harness() {
  const rows = new Map<string, L0QueryRow>();
  const upsertL0 = vi.fn((record: L0Record) => {
    rows.set(record.id, toRow(record));
    return true;
  });
  const getL0RecordsByIds = vi.fn((ids: string[]) => ids.flatMap((id) => {
    const row = rows.get(id);
    return row ? [row] : [];
  }));
  const appendFile = vi.fn(async () => undefined);
  const notifyPipeline = vi.fn(async () => undefined);
  const store = { upsertL0, getL0RecordsByIds } as unknown as IMemoryStore;
  const storage = { appendFile } as unknown as StorageAdapter;
  const deps: V2RouterDeps = {
    getStore: () => store,
    getEmbedding: () => undefined,
    getStorage: () => storage,
    logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } as unknown as Logger,
    deployMode: "standalone",
    requestIsolation: isolation,
    notifyPipeline,
  };
  return { rows, upsertL0, getL0RecordsByIds, appendFile, notifyPipeline, deps };
}

const body = {
  session_id: isolation.sessionId,
  idempotency_key: "round-1",
  messages: [
    { role: "user", content: "hello" },
    { role: "assistant", content: "world" },
  ],
};

describe("conversation/add idempotency", () => {
  beforeEach(() => __resetConversationIdempotencyForTests());

  it("replays from durable L0 rows after process-local state is cleared", async () => {
    const h = harness();
    const first = await handleConversationAdd(body, auth, "req-1", h.deps);
    expect(first.code).toBe(0);
    expect(h.upsertL0).toHaveBeenCalledTimes(2);
    expect(h.notifyPipeline).toHaveBeenCalledTimes(1);
    expect(h.appendFile).toHaveBeenCalledTimes(1);

    __resetConversationIdempotencyForTests();
    const replay = await handleConversationAdd(body, auth, "req-2", h.deps);
    expect(replay.code).toBe(0);
    expect(replay.data).toEqual(first.data);
    expect(h.upsertL0).toHaveBeenCalledTimes(2);
    expect(h.notifyPipeline).toHaveBeenCalledTimes(1);
    expect(h.appendFile).toHaveBeenCalledTimes(1);
  });

  it("rejects the same key with different content after local state is cleared", async () => {
    const h = harness();
    expect((await handleConversationAdd(body, auth, "req-1", h.deps)).code).toBe(0);
    __resetConversationIdempotencyForTests();
    const conflict = await handleConversationAdd({
      ...body,
      messages: [body.messages[0], { role: "assistant", content: "changed" }],
    }, auth, "req-2", h.deps);
    expect(conflict.code).toBe(409);
    expect(h.upsertL0).toHaveBeenCalledTimes(2);
  });

  it("keeps legacy no-key writes independent", async () => {
    const h = harness();
    const legacy = { session_id: isolation.sessionId, messages: body.messages };
    const first = await handleConversationAdd(legacy, auth, "req-1", h.deps);
    const second = await handleConversationAdd(legacy, auth, "req-2", h.deps);
    expect(first.code).toBe(0);
    expect(second.code).toBe(0);
    expect((first.data as { accepted_ids: string[] }).accepted_ids)
      .not.toEqual((second.data as { accepted_ids: string[] }).accepted_ids);
    expect(h.upsertL0).toHaveBeenCalledTimes(4);
  });
});
