import { beforeEach, describe, expect, it } from "vitest";
import { MemoryStorage } from "../storage/memory-storage.js";
import {
  AnthropicRoundStore,
  __resetAnthropicRoundStoreForTests,
  detectAnthropicUserEvent,
  isAnthropicTerminalStopReason,
} from "./round-store.js";

const identity = {
  spaceId: "space-1",
  userId: "user-1",
  agentSource: "claude",
  sessionKey: "session-1",
};
const text = (value: string) => ({ role: "user", content: [{ type: "text", text: value }] });
const extract = (content: unknown) => Array.isArray(content)
  ? ((content[content.length - 1] as Record<string, unknown>)?.text as string | undefined) ?? null
  : null;

describe("Anthropic round lifecycle", () => {
  beforeEach(() => __resetAnthropicRoundStoreForTests());

  it("keeps tool_result continuation in one round and emits a final claim once", async () => {
    const store = new AnthropicRoundStore(new MemoryStorage(), "scope-1");
    const first = await store.beginRequest({ messages: [text("find it")], extractUserText: extract }, identity);
    expect(first.state?.roundId).toBeTruthy();
    const roundId = first.state!.roundId;

    await store.recordResponse(roundId, {
      inputMessages: [text("find it")],
      assistantMessage: { role: "assistant", content: [{ type: "tool_use", id: "tool-1", name: "find", input: {} }] },
      assistantText: "",
      toolUseIds: ["tool-1"],
      toolResultIds: [],
      final: false,
    });
    const continued = await store.beginRequest({
      messages: [
        text("find it"),
        { role: "assistant", content: [{ type: "tool_use", id: "tool-1", name: "find", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-1", content: "ok" }] },
      ],
      extractUserText: extract,
    }, identity);
    expect(continued.state?.roundId).toBe(roundId);

    const finalState = await store.recordResponse(roundId, {
      inputMessages: continued.state!.conversationMessages.concat([
        { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-1", content: "ok" }] },
      ]),
      assistantMessage: { role: "assistant", content: [{ type: "text", text: "done" }] },
      assistantText: "done",
      toolUseIds: [],
      toolResultIds: ["tool-1"],
      final: true,
    });
    expect(finalState?.pendingToolUseIds).toEqual([]);
    expect(await store.beginOnce(roundId, "l0")).toBe(true);
    expect(await store.beginOnce(roundId, "l0")).toBe(false);
    expect(await store.completeOnce(roundId, "l0")).toBe(true);
    expect(await store.beginOnce(roundId, "l0")).toBe(false);
  });

  it("allocates a new id for identical text after a completed round", async () => {
    const store = new AnthropicRoundStore(new MemoryStorage(), "scope-2");
    const first = await store.beginRequest({ messages: [text("same")], extractUserText: extract }, identity);
    await store.recordResponse(first.state!.roundId, {
      inputMessages: [text("same")],
      assistantMessage: { role: "assistant", content: [{ type: "text", text: "one" }] },
      assistantText: "one",
      toolUseIds: [],
      toolResultIds: [],
      final: true,
    });
    const replay = await store.beginRequest({ messages: [text("same")], extractUserText: extract }, identity);
    expect(replay.isNew).toBe(false);
    const second = await store.beginRequest({
      messages: [{ role: "assistant", content: [{ type: "text", text: "one" }] }, text("same")],
      extractUserText: extract,
    }, identity);
    expect(second.isNew).toBe(true);
    expect(second.state?.roundId).not.toBe(first.state?.roundId);
  });

  it("ignores pure tool_result as a new human event", () => {
    expect(detectAnthropicUserEvent({
      messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: "ok" }] }],
      extractUserText: extract,
    })).toBeNull();
  });

  it("finalizes only clean Anthropic terminal stop reasons", () => {
    expect(isAnthropicTerminalStopReason("end_turn")).toBe(true);
    expect(isAnthropicTerminalStopReason("stop_sequence")).toBe(true);
    expect(isAnthropicTerminalStopReason("tool_use")).toBe(false);
    expect(isAnthropicTerminalStopReason("pause_turn")).toBe(false);
    expect(isAnthropicTerminalStopReason("max_tokens")).toBe(false);
    expect(isAnthropicTerminalStopReason(undefined)).toBe(false);
  });

  it("does not attach a late old response to a newer round", async () => {
    const store = new AnthropicRoundStore(new MemoryStorage(), "scope-late");
    const first = await store.beginRequest({ messages: [text("old")], extractUserText: extract }, identity);
    const second = await store.beginRequest({
      messages: [{ role: "assistant", content: [{ type: "text", text: "old answer" }] }, text("new")],
      extractUserText: extract,
    }, identity);
    expect(second.state?.roundId).not.toBe(first.state?.roundId);
    await expect(store.recordResponse(first.state!.roundId, {
      inputMessages: [text("old")],
      assistantMessage: { role: "assistant", content: [{ type: "text", text: "late" }] },
      assistantText: "late",
      toolUseIds: [],
      toolResultIds: [],
      final: true,
    })).resolves.toBeNull();
    await expect(store.getCurrent()).resolves.toMatchObject({ roundId: second.state?.roundId, originalUserInput: "new" });
  });
});
