import { createHash, randomUUID } from "node:crypto";
import type { ProxyStorage } from "../storage/proxy-storage.js";
import type { TdaiMessage } from "../tdai/types.js";

/** Durable lifecycle state for one Anthropic human turn. */
export interface AnthropicRoundState {
  spaceId: string;
  userId: string;
  agentSource: string;
  sessionKey: string;
  /** Proxy allocated id. It is deliberately not derived from message text. */
  roundId: string;
  /** Structured request event used only to recognise a replay of the same request. */
  sourceEventKey: string;
  /** Native/client request id when supplied; absent clients have an explicit ambiguity boundary. */
  sourceRequestId?: string;
  originalUserInput: string;
  conversationMessages: Array<Record<string, unknown>>;
  pendingToolUseIds: string[];
  finalized?: boolean;
  lastResponseKey?: string;
  lastResponseId?: string;
  l0Status?: "pending" | "completed";
  skillStatus?: "pending" | "completed";
  updatedAt: string;
}

export interface AnthropicUserEvent {
  message: TdaiMessage;
  eventKey: string;
}

export interface AnthropicRoundRequest {
  messages: unknown[];
  /** Adapter supplied text extractor; Claude's structural adapter is preferred. */
  extractUserText: (content: unknown) => string | null;
  requestId?: string;
}

export interface AnthropicRoundResponse {
  inputMessages: unknown[];
  assistantMessage: Record<string, unknown> | null;
  assistantText: string | null;
  toolUseIds: string[];
  toolResultIds: string[];
  final: boolean;
  responseId?: string;
}

interface OnceMarker {
  status: "pending" | "completed";
  owner: string;
  createdAt: string;
}

const CLAIM_LEASE_MS = 30_000;
const OWNER = randomUUID();
const localStates = new Map<string, AnthropicRoundState>();
const localClaims = new Set<string>();
const localDone = new Set<string>();
const locks = new Map<string, Promise<void>>();

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((key) => `${JSON.stringify(key)}:${stableJson(obj[key])}`).join(",")}}`;
}

function cloneState(state: AnthropicRoundState): AnthropicRoundState {
  return {
    ...state,
    pendingToolUseIds: [...state.pendingToolUseIds],
    conversationMessages: state.conversationMessages.map((message) => ({ ...message })),
  };
}

function keyFor(scope: string): string {
  return `nottl/anthropic-round-current/${digest(scope)}.json`;
}

function markerKey(scope: string, roundId: string, kind: "l0" | "skill", done = false): string {
  return `nottl/anthropic-round-${kind}-${done ? "done" : "claim"}/${digest(`${scope}\0${roundId}`)}.json`;
}

function localOnceKey(scope: string, roundId: string, kind: "l0" | "skill"): string {
  return `${scope}\0${roundId}\0${kind}`;
}

function isPureToolResult(message: unknown): boolean {
  const m = message as Record<string, unknown>;
  if (!m || m.role !== "user") return false;
  if (!Array.isArray(m.content) || m.content.length === 0) return false;
  return (m.content as unknown[]).every((block) => (
    block && typeof block === "object" && (block as Record<string, unknown>).type === "tool_result"
  ));
}

/** Only clean terminal responses may finalize a memory round. */
export function isAnthropicTerminalStopReason(reason: unknown): boolean {
  return reason === "end_turn" || reason === "stop_sequence";
}

/**
 * Return the latest real human event. A user message containing only
 * `tool_result` blocks is a continuation, not a new human turn.
 *
 * The digest is a replay detector, not the round identity: a new random
 * roundId is allocated whenever persistent state says the previous round is
 * complete and the structured request event differs.
 */
export function detectAnthropicUserEvent(request: AnthropicRoundRequest): AnthropicUserEvent | null {
  const messages = request.messages;
  const lastUser = [...messages].reverse().find((message) => (
    (message as Record<string, unknown>)?.role === "user"
  ));
  if (!lastUser || isPureToolResult(lastUser)) return null;
  const m = lastUser as Record<string, unknown>;
  const text = request.extractUserText(m.content);
  if (!text || !text.trim()) return null;
  // Include the structural main request (roles/content/tool ids), not just
  // user text. This distinguishes retries from the same question asked later.
  // Hash the complete structured request (roles/content/tool ids), not only
  // the user text or suffix. A retry has the same payload, while asking the
  // same text again normally carries a different preceding assistant/history
  // prefix and therefore receives a fresh round.
  const eventMessages = messages;
  return {
    message: { role: "user", content: text.trim() },
    eventKey: request.requestId
      ? `request:${request.requestId}`
      : digest(stableJson(eventMessages)),
  };
}

/** Slice only the current human turn, excluding prior compacted/history turns. */
export function sliceAnthropicRoundMessages(messages: unknown[]): Array<Record<string, unknown>> {
  const items = messages as Array<Record<string, unknown>>;
  let lastUser = -1;
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i]?.role === "user") { lastUser = i; break; }
  }
  if (lastUser < 0) return [];
  const last = items[lastUser];
  if (!isPureToolResult(last)) return items.slice(lastUser).map((message) => ({ ...message }));
  // A tool_result continuation needs the preceding assistant tool_use and the
  // original real user input. Find the nearest preceding non-tool user.
  for (let i = lastUser - 1; i >= 0; i--) {
    if (items[i]?.role === "user" && !isPureToolResult(items[i])) {
      return items.slice(i).map((message) => ({ ...message }));
    }
  }
  return items.slice(lastUser).map((message) => ({ ...message }));
}

function mergeMessages(
  existing: Array<Record<string, unknown>>,
  incoming: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  if (existing.length === 0) return incoming.map((message) => ({ ...message }));
  if (incoming.length >= existing.length) {
    const prefix = existing.every((message, index) => stableJson(message) === stableJson(incoming[index]));
    if (prefix) return incoming.map((message) => ({ ...message }));
  }
  let overlap = 0;
  const max = Math.min(existing.length, incoming.length);
  for (let n = max; n > 0; n--) {
    const left = existing.slice(existing.length - n);
    const right = incoming.slice(0, n);
    if (left.every((message, index) => stableJson(message) === stableJson(right[index]))) {
      overlap = n;
      break;
    }
  }
  return [...existing, ...incoming.slice(overlap).map((message) => ({ ...message }))];
}

function responseKey(input: AnthropicRoundResponse): string {
  if (input.responseId) return `response:${input.responseId}`;
  return digest(stableJson({
    inputMessages: input.inputMessages,
    assistantMessage: input.assistantMessage,
    assistantText: input.assistantText,
    toolUseIds: input.toolUseIds,
    toolResultIds: input.toolResultIds,
  }));
}

function hasStaleClaim(value: OnceMarker | null): boolean {
  if (!value || value.status !== "pending") return false;
  const t = Date.parse(value.createdAt);
  return !Number.isFinite(t) || Date.now() - t > CLAIM_LEASE_MS;
}

async function serial<T>(scope: string, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(scope) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const queued = previous.then(() => current);
  locks.set(scope, queued);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(scope) === queued) locks.delete(scope);
  }
}

export class AnthropicRoundStore {
  constructor(
    private readonly storage: ProxyStorage | null,
    readonly scope: string,
  ) {}

  private async readCurrent(): Promise<AnthropicRoundState | null> {
    const cached = localStates.get(this.scope);
    if (cached) return cloneState(cached);
    if (!this.storage) return null;
    try {
      const stored = await this.storage.getJSON<AnthropicRoundState>(keyFor(this.scope));
      if (!stored || typeof stored !== "object" || !stored.roundId) return null;
      localStates.set(this.scope, cloneState(stored));
      return cloneState(stored);
    } catch {
      return null;
    }
  }

  private async publish(state: AnthropicRoundState): Promise<void> {
    localStates.set(this.scope, cloneState(state));
    if (!this.storage) return;
    try {
      await this.storage.putJSON(keyFor(this.scope), cloneState(state));
    } catch {
      // Storage is optional. The local cache still prevents same-process dupes.
    }
  }

  async beginRequest(request: AnthropicRoundRequest, identity: Omit<AnthropicRoundState, "roundId" | "sourceEventKey" | "sourceRequestId" | "originalUserInput" | "conversationMessages" | "pendingToolUseIds" | "updatedAt">): Promise<{ state: AnthropicRoundState | null; isNew: boolean; userEvent: AnthropicUserEvent | null }> {
    return serial(this.scope, async () => {
      const current = await this.readCurrent();
      const userEvent = detectAnthropicUserEvent(request);
      if (!current && !userEvent) return { state: null, isNew: false, userEvent };
      if (current && !userEvent) return { state: current, isNew: false, userEvent };
      if (current && userEvent && (
        (request.requestId && current.sourceRequestId === request.requestId)
        || (!request.requestId && current.sourceEventKey === userEvent.eventKey)
      )) {
        return { state: current, isNew: false, userEvent };
      }
      // A new real user event while an older round still has pending tools is
      // treated as an explicit supersession boundary. We never merge the two
      // rounds (which could write the wrong user/assistant pair); the older
      // round remains unfinalized and is intentionally not emitted to L0.
      const state: AnthropicRoundState = {
        ...identity,
        roundId: `anthropic_${Date.now().toString(36)}_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
        sourceEventKey: userEvent?.eventKey ?? `continuation_${randomUUID()}`,
        ...(request.requestId ? { sourceRequestId: request.requestId } : {}),
        originalUserInput: userEvent?.message.content ?? "",
        conversationMessages: [],
        pendingToolUseIds: [],
        updatedAt: new Date().toISOString(),
      };
      await this.publish(state);
      return { state: cloneState(state), isNew: true, userEvent };
    });
  }

  async recordResponse(roundId: string, response: AnthropicRoundResponse): Promise<AnthropicRoundState | null> {
    return serial(this.scope, async () => {
      const current = await this.readCurrent();
      if (!current || current.roundId !== roundId) return null;
      const key = responseKey(response);
      if (current.lastResponseKey === key) return current;
      const resultIds = new Set(response.toolResultIds);
      const pending = [...new Set([
        ...current.pendingToolUseIds.filter((id) => !resultIds.has(id)),
        ...response.toolUseIds,
      ])];
      const messages = sliceAnthropicRoundMessages(response.inputMessages);
      const next: AnthropicRoundState = {
        ...current,
        conversationMessages: mergeMessages(current.conversationMessages, messages),
        pendingToolUseIds: pending,
        lastResponseKey: key,
        ...(response.responseId ? { lastResponseId: response.responseId } : {}),
        updatedAt: new Date().toISOString(),
      };
      if (response.assistantMessage) next.conversationMessages = mergeMessages(next.conversationMessages, [response.assistantMessage]);
      if (response.final && pending.length === 0) {
        next.finalized = true;
        next.l0Status = next.l0Status ?? "pending";
      }
      await this.publish(next);
      return cloneState(next);
    });
  }

  async getCurrent(): Promise<AnthropicRoundState | null> {
    return this.readCurrent();
  }

  async beginOnce(roundId: string, kind: "l0" | "skill"): Promise<boolean> {
    const localKey = localOnceKey(this.scope, roundId, kind);
    if (localDone.has(localKey) || localClaims.has(localKey)) return false;
    const claim = { status: "pending" as const, owner: OWNER, createdAt: new Date().toISOString() } satisfies OnceMarker;
    if (!this.storage) {
      localClaims.add(localKey);
      return true;
    }
    try {
      if (await this.storage.getJSON<OnceMarker>(markerKey(this.scope, roundId, kind, true))) {
        localDone.add(localKey);
        return false;
      }
      if (await this.storage.putJSONIfAbsent(markerKey(this.scope, roundId, kind), claim)) {
        localClaims.add(localKey);
        return true;
      }
      const existing = await this.storage.getJSON<OnceMarker>(markerKey(this.scope, roundId, kind));
      if (hasStaleClaim(existing)) {
        await this.storage.del(markerKey(this.scope, roundId, kind));
        if (await this.storage.putJSONIfAbsent(markerKey(this.scope, roundId, kind), claim)) {
          localClaims.add(localKey);
          return true;
        }
      }
      return false;
    } catch {
      localClaims.add(localKey);
      return true;
    }
  }

  async completeOnce(roundId: string, kind: "l0" | "skill"): Promise<boolean> {
    const localKey = localOnceKey(this.scope, roundId, kind);
    if (this.storage) {
      try {
        await this.storage.putJSON(markerKey(this.scope, roundId, kind, true), {
          status: "completed",
          completedAt: new Date().toISOString(),
        });
        await this.storage.del(markerKey(this.scope, roundId, kind));
      } catch {
        // Do not mark local completion when the durable marker failed. Caller
        // can release/retry and the same key remains idempotent at Core.
        return false;
      }
    }
    localDone.add(localKey);
    localClaims.delete(localKey);
    const current = await this.readCurrent();
    if (current?.roundId === roundId) {
      if (kind === "l0") current.l0Status = "completed";
      else current.skillStatus = "completed";
      current.updatedAt = new Date().toISOString();
      await this.publish(current);
    }
    return true;
  }

  async releaseOnce(roundId: string, kind: "l0" | "skill"): Promise<void> {
    const localKey = localOnceKey(this.scope, roundId, kind);
    localClaims.delete(localKey);
    if (this.storage) {
      try { await this.storage.del(markerKey(this.scope, roundId, kind)); } catch { /* lease can expire */ }
    }
  }
}

export function __resetAnthropicRoundStoreForTests(): void {
  localStates.clear();
  localClaims.clear();
  localDone.clear();
  locks.clear();
}
