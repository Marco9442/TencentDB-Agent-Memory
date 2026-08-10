import { describe, expect, it } from "vitest";
import { parseResponsesSse } from "../responses/response-parser.js";
import {
  buildNativeSelectionResponse,
  mergeNativePromptContinuation,
} from "./native-form.js";
import type { TeamOption } from "./types.js";

const team: TeamOption = {
  team_id: "team-herigo",
  team_name: "HeriGo",
  agents: [
    { agent_id: "agent-admin", agent_name: "personal-admin", description: "个人记忆" },
    { agent_id: "agent-review", agent_name: "herigo-review", description: "代码审查" },
  ],
  tasks: [{ task_id: "task-herigo", task_name: "HeriGo" }],
};

describe("Responses native memory-agent forms", () => {
  it.each([
    ["codex", "request_user_input"],
    ["opencode", "question"],
  ] as const)("builds the %s native tool", async (client, toolName) => {
    const built = buildNativeSelectionResponse({ client, modelId: "grok-4.5", team, stream: false });
    const body = await built.response.json() as Record<string, unknown>;
    const output = (body.output as Array<Record<string, unknown>>)[0];
    expect(output.name).toBe(toolName);
    const args = JSON.parse(String(output.arguments)) as Record<string, any>;
    expect(args.questions).toHaveLength(1);
    expect(args.questions[0].options).toHaveLength(2);
    if (client === "codex") {
      expect(args.isBlocking).toBe(true);
      expect(args.questions[0].id).toBe("agent");
    } else {
      expect(args.questions[0].multiple).toBe(false);
    }
  });

  it("emits a parseable streaming function call", async () => {
    const built = buildNativeSelectionResponse({ client: "codex", modelId: "grok-4.5", team, stream: true });
    const parsed = parseResponsesSse(await built.response.text());
    expect(parsed.status).toBe("completed");
    expect(parsed.functionCalls).toContainEqual(expect.objectContaining({
      call_id: built.prompt.callId,
      name: "request_user_input",
    }));
  });

  it("replays the synthetic call before the native answer", () => {
    const input = [{ type: "function_call_output", call_id: "call-1", output: '{"answers":{}}' }];
    const merged = mergeNativePromptContinuation({
      responseId: "resp-1",
      itemId: "item-1",
      callId: "call-1",
      toolName: "question",
      arguments: "{}",
      initialInput: [{ type: "message", role: "user", content: "你好" }],
    }, input);
    expect(merged.map((item: any) => item.type)).toStrictEqual([
      "message",
      "function_call",
      "function_call_output",
    ]);
  });
});
