import { createHash } from "node:crypto";
import type { ProxyStorage } from "../storage/proxy-storage.js";

/** Durable state for one Responses tool-loop round. */
export interface ResponsesRoundState {
  spaceId: string;
  userId: string;
  agentSource: string;
  sessionKey: string;
  roundId: string;
  originalUserInput: string;
  pendingCallIds: string[];
  seenResponseIds: string[];
  finalResponseId?: string;
  updatedAt: string;
}

export interface ResponsesRoundStore {
  markFinal(responseId: string): Promise<boolean>;
  recordState?(state: ResponsesRoundState): Promise<void>;
}

const processSeen = new Set<string>();
const inMemoryStates = new Map<string, ResponsesRoundState>();

function safeKey(scope: string, responseId: string): string {
  const digest = createHash("sha256")
    .update(`${scope}\0${responseId}`)
    .digest("hex");
  return `nottl/responses-round/${digest}.json`;
}

export class ProxyStorageResponsesRoundStore implements ResponsesRoundStore {
  constructor(
    private readonly storage: ProxyStorage,
    private readonly scope: string,
  ) {}

  async markFinal(responseId: string): Promise<boolean> {
    const normalized = responseId.trim();
    if (!normalized) return false;
    const key = safeKey(this.scope, normalized);
    try {
      return await this.storage.putJSONIfAbsent(key, {
        responseId: normalized,
        recordedAt: new Date().toISOString(),
      });
    } catch {
      // The in-process guard still prevents same-process duplicates; a
      // storage outage must not turn a successful provider response into 5xx.
      return markProcessFinal(`${this.scope}\0${normalized}`);
    }
  }

  async recordState(state: ResponsesRoundState): Promise<void> {
    try {
      const key = `nottl/responses-round-state/${createHash("sha256")
        .update(this.scope)
        .digest("hex")}.json`;
      await this.storage.putJSON(key, state);
    } catch {
      // State is recovery metadata; never turn a successful provider response
      // into a transport error when the optional store is unavailable.
    }
  }
}

export class InMemoryResponsesRoundStore implements ResponsesRoundStore {
  constructor(private readonly scope: string) {}

  async markFinal(responseId: string): Promise<boolean> {
    const normalized = responseId.trim();
    return normalized ? markProcessFinal(`${this.scope}\0${normalized}`) : false;
  }

  async recordState(state: ResponsesRoundState): Promise<void> {
    inMemoryStates.set(this.scope, state);
  }
}

function markProcessFinal(key: string): boolean {
  if (processSeen.has(key)) return false;
  processSeen.add(key);
  return true;
}

export function __resetResponsesRoundStoreForTests(): void {
  processSeen.clear();
  inMemoryStates.clear();
}
