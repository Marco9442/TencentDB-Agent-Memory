import { describe, expect, it } from "vitest";
import { buildFormResponse } from "./form.js";

describe("Claude memory Agent selection form", () => {
  it("uses the MemoryProxy binding wording", async () => {
    const response = buildFormResponse({
      teams: [
        {
          team_id: "team-herigo",
          team_name: "HeriGo",
          agents: [
            { agent_id: "agent-personal-admin", agent_name: "personal-admin" },
            { agent_id: "agent-herigo-admin", agent_name: "herigo-admin" },
          ],
          tasks: [],
        },
      ],
      stage: "agent_select",
      selectedTeamId: "team-herigo",
    });

    const body = await response.text();
    expect(body).toContain("请选择「HeriGo」下要绑定的记忆 Agent：");
    expect(body).toContain('\\"header\\":\\"记忆 Agent\\"');
  });
});
