import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../config.js";
import type { MetadataClient } from "../meta/client.js";
import { handleSessionInit } from "./codebuddy/init.js";
import { resolveNonInteractiveFallback } from "./noninteractive-fallback.js";
import { SessionStore } from "./store.js";
import { buildNativeSelectionResponse } from "./native-form.js";
import type { TeamOption } from "./types.js";

const teams: TeamOption[] = [{
  team_id: "team-herigo",
  team_name: "HeriGo",
  agents: [
    { agent_id: "agt-global", agent_name: "global-agent" },
    { agent_id: "agt-private", agent_name: "personal-admin" },
  ],
  tasks: [
    { task_id: "task-general", task_name: "herigo-general" },
  ],
}];

describe("non-interactive fallback", () => {
  it("selects only the team-wide global Agent and the explicit task", () => {
    expect(resolveNonInteractiveFallback(teams, {
      teamId: "team-herigo",
      taskId: "task-general",
      agentName: "global-agent",
    })).toEqual({ teamId: "team-herigo", agentId: "agt-global", taskId: "task-general" });
  });

  it("uses the sole task when the client omitted x-task-id", () => {
    expect(resolveNonInteractiveFallback(teams, {
      teamId: "team-herigo",
      agentName: "global-agent",
    })?.taskId).toBe("task-general");
  });

  it("does not guess across multiple candidate teams or tasks", () => {
    expect(resolveNonInteractiveFallback([
      ...teams,
      { ...teams[0], team_id: "team-other" },
    ], { agentName: "global-agent" })).toBeUndefined();
    expect(resolveNonInteractiveFallback([
      { ...teams[0], tasks: [
        { task_id: "task-a", task_name: "a" },
        { task_id: "task-b", task_name: "b" },
      ] },
    ], { teamId: "team-herigo", agentName: "global-agent" })).toBeUndefined();
  });

  it("registers the fallback for an OpenCode session with team/task headers", async () => {
    const config = structuredClone(DEFAULT_CONFIG.sessionInit);
    config.enabled = true;
    const metadata = {
      listTeams: async () => [{
        team_id: "team-herigo",
        name: "HeriGo",
        metadata_json: JSON.stringify({ fallback_agent_id: "agt-global" }),
      }],
      listSessionAgents: async () => [{
        agent_id: "agt-global",
        team_id: "team-herigo",
        name: "global-agent",
        description: "fallback",
        status: "active",
        visibility: "team",
      }],
      listTasks: async () => [{
        task_id: "task-general",
        team_id: "team-herigo",
        title: "herigo-general",
        status: "running",
      }],
      getAgent: async () => ({
        agent_id: "agt-global",
        team_id: "team-herigo",
        name: "global-agent",
        description: "fallback",
        status: "active",
        visibility: "team",
      }),
      getTask: async () => ({
        task_id: "task-general",
        team_id: "team-herigo",
        title: "herigo-general",
        status: "running",
      }),
      appendParticipationLog: async () => ({}),
    } as unknown as MetadataClient;

    const result = await handleSessionInit(
      "opencode-session",
      "usr-member",
      [{ role: "user", content: "hello" }],
      config,
      new SessionStore(),
      { stream: false, modelId: "grok-4.5", protocol: "openai" },
      metadata,
      "user-key",
      "default",
      { teamId: "team-herigo", taskId: "task-general" },
      "opencode",
    );

    expect(result.intercepted).toBe(false);
    expect(result.sessionInfo?.agent_id).toBe("agt-global");
    expect(result.sessionInfo?.task_id).toBe("task-general");
  });

  it("runs a native OpenCode agent selection and resumes with its answer", async () => {
    const config = structuredClone(DEFAULT_CONFIG.sessionInit);
    config.enabled = true;
    const metadata = {
      listTeams: async () => [{
        team_id: "team-herigo",
        name: "HeriGo",
        metadata_json: JSON.stringify({ fallback_agent_id: "agt-global" }),
      }],
      listSessionAgents: async () => [
        { agent_id: "agt-global", team_id: "team-herigo", name: "global-agent", status: "active", visibility: "team" },
        { agent_id: "agt-private", team_id: "team-herigo", name: "personal-admin", status: "active", visibility: "private" },
      ],
      listTasks: async () => [{ task_id: "task-general", team_id: "team-herigo", title: "herigo-general", status: "running" }],
      getAgent: async () => ({ agent_id: "agt-private", team_id: "team-herigo", name: "personal-admin", status: "active", visibility: "private" }),
      getTask: async () => ({ task_id: "task-general", team_id: "team-herigo", title: "herigo-general", status: "running" }),
      appendParticipationLog: async () => ({}),
    } as unknown as MetadataClient;
    const store = new SessionStore();
    let nativeCallId = "";
    const formResponse = (data: any) => {
      const built = buildNativeSelectionResponse({ client: "opencode", modelId: "grok-4.5", team: data.teams[0], stream: false });
      nativeCallId = built.prompt.callId;
      return built;
    };
    const preset = { teamId: "team-herigo", taskId: "task-general" };
    const first = await handleSessionInit(
      "native-session", "usr-member", [{ role: "user", content: "你是谁" }], config,
      store,
      { stream: false, modelId: "grok-4.5", protocol: "openai", nativeAgentSelection: true, formResponse },
      metadata, "user-key", "default", preset, "opencode",
    );
    expect(first.intercepted).toBe(true);
    expect(first.nativePrompt?.callId).toBe(nativeCallId);

    // Use the real id suffix emitted by the form, not a hard-coded fixture.
    const agentLabel = "personal-admin (agt-private)";
    const resumed = await handleSessionInit(
      "native-session", "usr-member", [{ role: "tool", tool_call_id: nativeCallId, content: JSON.stringify({ answers: { agent: agentLabel } }) }], config,
      store,
      { stream: false, modelId: "grok-4.5", protocol: "openai", nativeAgentSelection: true, formResponse },
      metadata, "user-key", "default", preset, "opencode",
    );
    expect(resumed.intercepted).toBe(false);
    expect(resumed.sessionInfo?.agent_id).toBe("agt-private");
    expect(resumed.sessionInfo?.task_id).toBe("task-general");
  });
});
