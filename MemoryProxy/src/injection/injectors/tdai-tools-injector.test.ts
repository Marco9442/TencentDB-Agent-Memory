import { describe, expect, it } from "vitest";
import { renderTdaiMemoryToolsBlock } from "./tdai-tools-injector.js";

describe("TDAI memory tools integration boundary", () => {
  it("directs Claude Code to the proxy curl tools instead of unavailable tools", () => {
    const block = renderTdaiMemoryToolsBlock(
      "http://memory-proxy:8096",
      "session-1",
      "team-herigo",
    );

    expect(block).toContain("MemoryProxy 外部记忆 Agent");
    expect(block).toContain("不要调用 Claude Code 的 `Skill` 工具");
    expect(block).toContain("`memory-guidance`");
    expect(block).toContain("`subagent_type=memory`");
    expect(block).toContain("Bash + curl");
    expect(block).toContain("/memory-bridge/v3/atomic/search");
  });
});
