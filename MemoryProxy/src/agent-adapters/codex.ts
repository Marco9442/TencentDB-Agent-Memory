/**
 * Codex / OpenAI Responses adapter.
 *
 * This file intentionally does not import an OpenAI SDK. Responses input is
 * handled structurally so the helper remains usable with the proxy's opaque
 * request body and with future SDK versions.
 */

import type { AgentAdapter } from "./types.js";
import {
  getCodexSessionKey,
  readCodexPreviousResponseId,
  readCodexSessionHeader,
  resolveCodexSessionKey,
  type CodexSessionKeyInput,
  type CodexSessionKeyResolution,
} from "../session/codex/index.js";

export type CodexAgentKind = "codex";

export interface CodexAgentAdapter extends Pick<AgentAdapter, "classifyRequest" | "extractUserText"> {
  readonly agentKind: CodexAgentKind;
}

interface InputItem {
  role?: unknown;
  type?: unknown;
  content?: unknown;
  text?: unknown;
}

function textFromContent(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;

  const parts: string[] = [];
  for (const rawPart of content) {
    if (!rawPart || typeof rawPart !== "object") continue;
    const part = rawPart as Record<string, unknown>;
    if (typeof part.text === "string") parts.push(part.text);
  }
  return parts.length > 0 ? parts.join("\n") : null;
}

/** Extract the latest user message from Responses `input` items. */
function extractResponsesUserText(input: unknown): string | null {
  if (typeof input === "string") return input;
  if (!Array.isArray(input)) return null;

  for (let i = input.length - 1; i >= 0; i--) {
    const item = input[i] as InputItem;
    if (!item || typeof item !== "object") continue;
    if (item.role !== "user") continue;
    const text = textFromContent(item.content ?? item.text);
    if (text !== null) return text;
  }
  return null;
}

export const codexAdapter: CodexAgentAdapter = {
  agentKind: "codex",

  classifyRequest() {
    return "main";
  },

  extractUserText(content) {
    return extractResponsesUserText(content);
  },
};

export { extractResponsesUserText };

/** Explicit exports keep the adapter independently callable by a Responses host. */
export {
  getCodexSessionKey,
  readCodexPreviousResponseId,
  readCodexSessionHeader,
  resolveCodexSessionKey,
};
export type { CodexSessionKeyInput, CodexSessionKeyResolution };
