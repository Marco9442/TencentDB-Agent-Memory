import type { TdaiClient } from "./client.js";
import type { TdaiIdentity, TdaiMessage } from "./types.js";
import { extractUserQueryText } from "../common/user-query-extractor.js";
import { sanitizeTdaiAssistantContent } from "./content-sanitizer.js";

/**
 * 从最后一条 user 消息中抽取「真正的用户提问」，写入 L0。
 *
 * 背景：CodeBuddy / Claude Code 等编码 agent 的 user 消息里除了真实问题，
 * 还塞了大量 harness 上下文（<additional_data> 打开的文件、current_time、
 * <system_reminder> 等）。如果把整条消息原样写进 L0，记忆会被这些噪声污染，
 * 而且每轮都不一样、检索价值极低。因此这里只保留 <user_query> 正文。
 *
 * 抽取算法在 `common/user-query-extractor.ts` 内实现（tdai / mem-command /
 * codebuddy adapter 共用同一份，避免语义漂移）；本模块只负责"取最后一条
 * user message → 抽 query 文本 → 组装 TdaiMessage"这几步。
 */

// 保留 re-export，避免下游（含单测）import 路径变化引发一次性大改。
export { extractUserQueryText };

/** Extract the user-authored portion of one protocol-specific content value. */
export type TdaiUserTextExtractor = (content: unknown) => string | null;

/** Metadata used to keep one real user message per agentic turn in L0. */
export interface TdaiRecordOptions {
  /** Monotonic turn number shared by the request/tool-loop calls. */
  turnSeq?: number;
}

// A single Claude/Codex turn can produce several upstream requests while the
// model calls tools. Keep the user message only on the first write, while
// retaining each assistant/tool-loop result. This is process-local by design:
// a restarted proxy starts a fresh cache and never loses the conversation data
// that was already written.
const recordedUserTurns = new Set<string>();
const MAX_RECORDED_USER_TURNS = 10_000;

export function extractLatestUserMessage(
  messages: unknown[],
  userTextExtractor?: TdaiUserTextExtractor,
): TdaiMessage | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as Record<string, unknown>;
    if (msg?.role !== "user") continue;
    // Protocol-aware adapters must inspect block `type` before flattening. In
    // particular Anthropic puts tool_result blocks inside a top-level role=user
    // message; those blocks are not user-authored text.
    const content = userTextExtractor
      ? userTextExtractor(msg.content)
      : extractUserQueryText(extractContentText(msg.content));
    if (typeof content === "string" && content.trim()) {
      return { role: "user", content: content.trim() };
    }
  }
  return null;
}

export function __resetTdaiRecorderStateForTests(): void {
  recordedUserTurns.clear();
}

function makeTurnKey(identity: TdaiIdentity, turnSeq: number | undefined): string | null {
  if (!turnSeq || turnSeq <= 0) return null;
  return JSON.stringify([
    identity.teamId,
    identity.userId,
    identity.agentId,
    identity.sessionId,
    identity.taskId ?? "",
    turnSeq,
  ]);
}

function rememberUserTurn(key: string): void {
  if (recordedUserTurns.size >= MAX_RECORDED_USER_TURNS) {
    const oldest = recordedUserTurns.values().next().value as string | undefined;
    if (oldest) recordedUserTurns.delete(oldest);
  }
  recordedUserTurns.add(key);
}

export async function recordTdaiTurn(
  client: TdaiClient,
  identity: TdaiIdentity | null,
  userMessage: TdaiMessage | null,
  assistantContent: string | null | undefined,
  options: TdaiRecordOptions = {},
): Promise<void> {
  if (!identity) return;

  const turnKey = makeTurnKey(identity, options.turnSeq);
  const hasRecordedUser = Boolean(turnKey && recordedUserTurns.has(turnKey));
  const includeUser = Boolean(userMessage) && !hasRecordedUser;
  // An internal Claude prompt can arrive before the real user message while
  // sharing the same turn sequence. Do not retain its assistant-only result
  // or claim the deduplication key; the real user request must be first.
  // Keep the legacy no-turnSeq behavior unchanged for callers that do not
  // participate in agentic-turn deduplication.
  if (turnKey && !includeUser && !hasRecordedUser) return;
  const messages: TdaiMessage[] = [];
  if (includeUser && userMessage) messages.push(userMessage);
  const assistant = sanitizeTdaiAssistantContent(assistantContent);
  if (assistant.content) {
    messages.push({ role: "assistant", content: assistant.content });
  }
  if (messages.length === 0) return;

  // Mark before the request so two synchronous tool-loop completions cannot
  // both append the same user message. Remove the mark when the write fails so
  // the normal retry path can resend the complete turn.
  if (turnKey && includeUser) rememberUserTurn(turnKey);
  try {
    await client.addConversation(identity, messages);
  } catch (error) {
    if (turnKey && includeUser) recordedUserTurns.delete(turnKey);
    throw error;
  }
}

function extractContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      const p = part as Record<string, unknown>;
      if (typeof p.text === "string") return p.text;
      if (typeof p.content === "string") return p.content;
      return "";
    }).filter(Boolean).join("\n");
  }
  return "";
}
