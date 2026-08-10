/**
 * Agent Adapter 工厂。
 *
 * 根据 URL 前缀映射来的 `agentSource` 返回对应的适配器；未识别的客户端返回
 * default adapter（等价现状的保守行为）。
 *
 * 各点详见：
 *   - types.ts —— AgentAdapter 接口 + 三个适配点的说明
 *   - claude.ts —— Claude family 特化实现（Claude Code/Desktop）
 *   - codebuddy.ts —— CB stub（沿用 default 行为，等抓包再补 CB 特化）
 *   - default.ts —— unknown 兜底
 */

import type { AgentAdapter } from "./types.js";
import { claudeAdapter } from "./claude.js";
import { codebuddyAdapter } from "./codebuddy.js";
import { codexAdapter } from "./codex.js";
import { defaultAdapter } from "./default.js";

export type { AgentAdapter, AgentKind, RequestKind } from "./types.js";

export function resolveAgentAdapter(agentSource: string): AgentAdapter {
  switch (agentSource) {
    case "claude":
      return claudeAdapter;
    case "codebuddy":
      return codebuddyAdapter;
    case "codex":
      return codexAdapter;
    default:
      return defaultAdapter;
  }
}
