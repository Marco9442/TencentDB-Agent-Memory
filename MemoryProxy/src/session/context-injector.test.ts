import { describe, expect, it } from "vitest";
import {
  injectSessionContext,
  injectSessionContextIntoAnthropicSystem,
} from "./context-injector.js";

const agent = {
  id: "agent-personal-admin",
  name: "personal-admin",
};

const task = {
  id: "task-review",
  name: "review",
};

function expectBindingNotice(value: unknown): void {
  const text = String(value);
  expect(text).toContain("[MemoryProxy Agent]");
  expect(text).toContain("[MemoryProxy Task]");
  expect(text).toContain("当前用户选择的是 MemoryProxy 的外部记忆角色，非 Claude Code 子 Agent、后台 Agent 或消息接收者。");
  expect(text).toContain("本会话已完成绑定。在当前对话中直接回答用户，无需转发或委派当前消息。");
  expect(text).not.toContain("remote-control:set_agent");
}

describe("session context Agent binding notice", () => {
  it("is included in the message-based injection path", () => {
    const messages = injectSessionContext(
      [{ role: "system", content: "original system prompt" }],
      agent,
      task,
    );

    expectBindingNotice(messages[0]?.content);
  });

  it("is included in the Anthropic system-field injection path", () => {
    const system = injectSessionContextIntoAnthropicSystem(
      "original system prompt",
      agent,
      task,
      null,
      "test-session",
    );

    expectBindingNotice(system);
  });
});
