import { describe, expect, it, vi } from "vitest";
import {
  GLOBAL_AGENT_NAME,
  getTeamFallbackAgentId,
  MetadataClient,
} from "./client.js";

function envelope(data: unknown): Response {
  return new Response(JSON.stringify({ code: 0, data }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const ownAgent = {
  agent_id: "agt-own",
  team_id: "team-herigo",
  owner_user_id: "usr-member",
  name: "personal-member",
  status: "active",
  visibility: "private",
};

const globalAgent = {
  agent_id: "agt-global",
  team_id: "team-herigo",
  owner_user_id: "usr-admin",
  name: GLOBAL_AGENT_NAME,
  status: "active",
  visibility: "team",
};

function makeClient(
  global = globalAgent,
  fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const requestUrl = String(url);
    if (requestUrl.endsWith("/v3/meta/agent/list")) {
      return envelope({ items: [ownAgent], total: 1, limit: 100, offset: 0 });
    }
    if (requestUrl.endsWith("/v3/meta/agent/get")) return envelope(global);
    throw new Error(`unexpected URL: ${requestUrl}`);
  }),
) {
  return {
    client: new MetadataClient(
      { endpoint: "http://memory-core:8420", serviceToken: "test", timeoutMs: 1000 },
      "default",
      "user-key",
      fetcher as typeof fetch,
    ),
    fetcher,
  };
}

describe("session Agent candidate policy", () => {
  it("reads the team fallback Agent pointer from metadata_json", () => {
    expect(getTeamFallbackAgentId({
      metadata_json: JSON.stringify({ fallback_agent_id: "agt-global" }),
    })).toBe("agt-global");
    expect(getTeamFallbackAgentId({ metadata_json: "{}" })).toBeUndefined();
    expect(getTeamFallbackAgentId({ metadata_json: "not-json" })).toBeUndefined();
  });

  it("adds only the exact eligible global Agent to the owner-scoped list", async () => {
    const { client, fetcher } = makeClient();
    const agents = await client.listSessionAgents("team-herigo", "usr-member", "agt-global");

    expect(agents.map((agent) => agent.agent_id)).toEqual(["agt-own", "agt-global"]);
    const listCall = fetcher.mock.calls.find(([url]) => String(url).endsWith("/v3/meta/agent/list"));
    expect(JSON.parse(String(listCall?.[1] && (listCall[1] as RequestInit).body))).toMatchObject({
      team_id: "team-herigo",
      owner_user_id: "usr-member",
    });
  });

  it("does not expose a stale or invalid global Agent pointer", async () => {
    const { client } = makeClient({ ...globalAgent, team_id: "other-team" });
    const agents = await client.listSessionAgents("team-herigo", "usr-member", "agt-global");
    expect(agents.map((agent) => agent.agent_id)).toEqual(["agt-own"]);
  });
});
