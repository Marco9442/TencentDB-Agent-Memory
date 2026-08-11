import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TdaiClient } from "./client.js";
import {
  __resetTdaiRecorderStateForTests,
  extractLatestUserMessage,
  recordTdaiTurn,
} from "./recorder.js";
import { extractLastUserText } from "../common/user-text-extractor.js";
import { claudeAdapter } from "../agent-adapters/claude.js";
import type { TdaiIdentity, TdaiMessage } from "./types.js";

const identity: TdaiIdentity = {
  teamId: "team-herigo",
  userId: "user-admin",
  agentId: "agent-global",
  sessionId: "session-1",
  taskId: "task-1",
};

const userMessage: TdaiMessage = { role: "user", content: "你好" };

describe("TDAI L0 recorder", () => {
  beforeEach(() => {
    __resetTdaiRecorderStateForTests();
  });

  it("writes the user message once across an agentic tool loop", async () => {
    const addConversation = vi.fn(
      async (_identity: TdaiIdentity, _messages: TdaiMessage[]) => undefined,
    );
    const client = { addConversation } as unknown as TdaiClient;

    await recordTdaiTurn(client, identity, userMessage, "正在检索记忆…", { turnSeq: 1 });
    await recordTdaiTurn(client, identity, userMessage, "检索完成", { turnSeq: 1 });
    await recordTdaiTurn(client, identity, userMessage, "下一步", { turnSeq: 1 });

    expect(addConversation).toHaveBeenCalledTimes(3);
    expect(addConversation.mock.calls[0]?.[1]).toEqual([
      userMessage,
      { role: "assistant", content: "正在检索记忆…" },
    ]);
    expect(addConversation.mock.calls[1]?.[1]).toEqual([
      { role: "assistant", content: "检索完成" },
    ]);
    expect(addConversation.mock.calls[2]?.[1]).toEqual([
      { role: "assistant", content: "下一步" },
    ]);
  });

  it("does not let a Claude internal prompt claim the turn before the real user message", async () => {
    const internalPrompt = "[SUGGESTION MODE: suggest what the user might type next]";
    expect(claudeAdapter.extractUserText(internalPrompt)).toBeNull();
    expect(claudeAdapter.extractUserText("做一次只读校验")).toBe("做一次只读校验");

    const addConversation = vi.fn(
      async (_identity: TdaiIdentity, _messages: TdaiMessage[]) => undefined,
    );
    const client = { addConversation } as unknown as TdaiClient;

    const internalUser = extractLatestUserMessage(
      [{ role: "user", content: internalPrompt }],
      (content) => claudeAdapter.extractUserText(content),
    );
    await recordTdaiTurn(client, identity, internalUser, "synthetic reply", { turnSeq: 13 });

    const realUser = extractLatestUserMessage(
      [{ role: "user", content: "做一次只读校验" }],
      (content) => claudeAdapter.extractUserText(content),
    );
    await recordTdaiTurn(client, identity, realUser, "真实回复", { turnSeq: 13 });

    expect(addConversation).toHaveBeenCalledTimes(1);
    expect(addConversation.mock.calls[0]?.[1]).toEqual([
      { role: "user", content: "做一次只读校验" },
      { role: "assistant", content: "真实回复" },
    ]);
  });

  it("starts a new user message for a new turn and keeps legacy calls unchanged", async () => {
    const addConversation = vi.fn(
      async (_identity: TdaiIdentity, _messages: TdaiMessage[]) => undefined,
    );
    const client = { addConversation } as unknown as TdaiClient;

    await recordTdaiTurn(client, identity, userMessage, "first", { turnSeq: 1 });
    await recordTdaiTurn(client, identity, userMessage, "second", { turnSeq: 2 });
    await recordTdaiTurn(client, identity, userMessage, "legacy");

    expect(addConversation.mock.calls.map((call) => call[1])).toEqual([
      [userMessage, { role: "assistant", content: "first" }],
      [userMessage, { role: "assistant", content: "second" }],
      [userMessage, { role: "assistant", content: "legacy" }],
    ]);
  });

  it("allows a failed first write to retry the complete turn", async () => {
    const addConversation = vi
      .fn(async (_identity: TdaiIdentity, _messages: TdaiMessage[]) => undefined)
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockResolvedValueOnce(undefined);
    const client = { addConversation } as unknown as TdaiClient;

    await expect(
      recordTdaiTurn(client, identity, userMessage, "first", { turnSeq: 1 }),
    ).rejects.toThrow("temporary failure");
    await recordTdaiTurn(client, identity, userMessage, "retry", { turnSeq: 1 });

    expect(addConversation.mock.calls[1]?.[1]).toEqual([
      userMessage,
      { role: "assistant", content: "retry" },
    ]);
  });

  it("does not flatten Anthropic tool_result blocks into user text", () => {
    const toolResultOnly = extractLatestUserMessage([
      {
        role: "user",
        content: [{ type: "tool_result", content: "app.asar\nStatsig" }],
      },
    ], extractLastUserText);
    expect(toolResultOnly).toBeNull();

    const mixed = extractLatestUserMessage([
      {
        role: "user",
        content: [
          { type: "text", text: "真实问题" },
          { type: "tool_result", content: "app.asar\nStatsig" },
        ],
      },
    ], extractLastUserText);
    expect(mixed).toEqual({ role: "user", content: "真实问题" });
  });

  it("drops internal assistant block markers and strips ANSI sequences", async () => {
    const addConversation = vi.fn(
      async (_identity: TdaiIdentity, _messages: TdaiMessage[]) => undefined,
    );
    const client = { addConversation } as unknown as TdaiClient;

    await recordTdaiTurn(client, identity, userMessage, "<block>no</block>", { turnSeq: 1 });
    expect(addConversation.mock.calls[0]?.[1]).toEqual([userMessage]);

    await recordTdaiTurn(
      client,
      identity,
      userMessage,
      "<block>yes</block>\n<category>Credential Materialization</category>\n<reason>internal check</reason>",
      { turnSeq: 2 },
    );
    expect(addConversation.mock.calls[1]?.[1]).toEqual([userMessage]);

    await recordTdaiTurn(
      client,
      identity,
      userMessage,
      "\u001b[38;2;255;180;90m可见文本\u001b[0m",
      { turnSeq: 3 },
    );
    expect(addConversation.mock.calls[2]?.[1]).toEqual([
      userMessage,
      { role: "assistant", content: "可见文本" },
    ]);
  });
});
