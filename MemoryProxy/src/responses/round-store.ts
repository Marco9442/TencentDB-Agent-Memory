import { createHash, randomUUID } from "node:crypto";
import type { ProxyStorage } from "../storage/proxy-storage.js";

/** Durable state for one Responses tool-loop response. */
export interface ResponsesRoundState {
  spaceId: string;
  userId: string;
  agentSource: string;
  sessionKey: string;
  /** The response id whose state is stored under this record. */
  roundId: string;
  originalUserInput: string;
  pendingCallIds: string[];
  seenResponseIds: string[];
  /** Input-side history needed by the Skill round, excluding the final answer. */
  conversationMessages?: Array<Record<string, unknown>>;
  finalResponseId?: string;
  l0Status?: "pending" | "completed";
  updatedAt: string;
}

interface FinalClaim {
  responseId: string;
  status: "pending";
  owner: string;
  claimedAt: string;
}

interface CompletedMarker {
  responseId: string;
  status: "l0_completed";
  completedAt: string;
}

export interface ResponsesRoundStore {
  getState(responseId: string): Promise<ResponsesRoundState | null>;
  putState(responseId: string, state: ResponsesRoundState): Promise<void>;
  /** Atomically claim the final L0 write for this response id. */
  beginFinal(responseId: string): Promise<boolean>;
  /** Publish the durable completed marker after strict L0 success. */
  completeL0(responseId: string): Promise<void>;
  /** Release a failed claim so a retry/replay can claim it again. */
  releaseFinal(responseId: string): Promise<void>;
  /** Compatibility alias for callers that used the old write-only method. */
  recordState?(state: ResponsesRoundState): Promise<void>;
}

const CLAIM_LEASE_MS = 30_000;
const PROCESS_OWNER = randomUUID();

// These maps are deliberately keyed by scope + response id. They are the
// write-through cache for immediate same-process continuation and test fallback.
const localStates = new Map<string, ResponsesRoundState>();
const localClaims = new Set<string>();
const localCompleted = new Set<string>();

function normalizeResponseId(responseId: string): string | null {
  const normalized = responseId.trim();
  return normalized || null;
}

function digestKey(prefix: string, scope: string, responseId: string): string {
  const digest = createHash("sha256")
    .update(`${scope}\0${responseId}`)
    .digest("hex");
  return `nottl/responses-${prefix}/${digest}.json`;
}

function stateKey(scope: string, responseId: string): string {
  return digestKey("round-state", scope, responseId);
}

function claimKey(scope: string, responseId: string): string {
  return digestKey("round-claim", scope, responseId);
}

function completedKey(scope: string, responseId: string): string {
  return digestKey("round-completed", scope, responseId);
}

function localKey(scope: string, responseId: string): string {
  return `${scope}\0${responseId}`;
}

function cloneState(state: ResponsesRoundState): ResponsesRoundState {
  return {
    ...state,
    pendingCallIds: [...state.pendingCallIds],
    seenResponseIds: [...state.seenResponseIds],
    ...(state.conversationMessages
      ? { conversationMessages: state.conversationMessages.map((message) => ({ ...message })) }
      : {}),
  };
}

function isStaleClaim(value: FinalClaim | null): boolean {
  if (!value || value.status !== "pending") return false;
  const claimedAt = Date.parse(value.claimedAt);
  return !Number.isFinite(claimedAt) || Date.now() - claimedAt > CLAIM_LEASE_MS;
}

function setLocalState(key: string, state: ResponsesRoundState): void {
  const existing = localStates.get(key);
  const next = (localCompleted.has(key) || existing?.l0Status === "completed")
    ? { ...state, l0Status: "completed" as const }
    : state;
  localStates.set(key, cloneState(next));
}

function markLocalCompleted(key: string): void {
  localCompleted.add(key);
  localClaims.delete(key);
}

function markLocalPending(key: string): void {
  const state = localStates.get(key);
  if (state) {
    state.l0Status = "pending";
    state.updatedAt = new Date().toISOString();
  }
  localCompleted.delete(key);
}

export class ProxyStorageResponsesRoundStore implements ResponsesRoundStore {
  constructor(
    private readonly storage: ProxyStorage,
    private readonly scope: string,
  ) {}

  async getState(responseId: string): Promise<ResponsesRoundState | null> {
    const normalized = normalizeResponseId(responseId);
    if (!normalized) return null;
    const key = localKey(this.scope, normalized);
    const cached = localStates.get(key);
    if (cached) return cloneState(cached);

    try {
      const state = await this.storage.getJSON<ResponsesRoundState>(stateKey(this.scope, normalized));
      if (!state || typeof state !== "object") return null;
      setLocalState(key, state);
      return cloneState(state);
    } catch {
      return null;
    }
  }

  async putState(responseId: string, state: ResponsesRoundState): Promise<void> {
    const normalized = normalizeResponseId(responseId);
    if (!normalized) return;
    const key = localKey(this.scope, normalized);
    // Write-through publication: continuation can read this before durable
    // storage finishes or even when the optional storage is temporarily slow.
    setLocalState(key, state);
    await this.storage.putJSON(stateKey(this.scope, normalized), cloneState(state));
  }

  async beginFinal(responseId: string): Promise<boolean> {
    const normalized = normalizeResponseId(responseId);
    if (!normalized) return false;
    const key = localKey(this.scope, normalized);
    if (localCompleted.has(key) || localClaims.has(key)) return false;

    const current = localStates.get(key);
    if (current?.l0Status === "completed") {
      markLocalCompleted(key);
      return false;
    }

    const claim = {
      responseId: normalized,
      status: "pending" as const,
      owner: PROCESS_OWNER,
      claimedAt: new Date().toISOString(),
    } satisfies FinalClaim;
    const durableClaimKey = claimKey(this.scope, normalized);

    try {
      const completed = await this.storage.getJSON<CompletedMarker>(completedKey(this.scope, normalized));
      if (completed?.status === "l0_completed") {
        markLocalCompleted(key);
        return false;
      }

      if (await this.storage.putJSONIfAbsent(durableClaimKey, claim)) {
        localClaims.add(key);
        markLocalPending(key);
        return true;
      }

      const existing = await this.storage.getJSON<FinalClaim>(durableClaimKey);
      if (isStaleClaim(existing)) {
        // ProxyStorage exposes only put-if-absent; reclaiming an expired lease
        // is therefore delete + CAS. Same-process claims remain guarded above.
        await this.storage.del(durableClaimKey);
        if (await this.storage.putJSONIfAbsent(durableClaimKey, claim)) {
          localClaims.add(key);
          markLocalPending(key);
          return true;
        }
      }
      return false;
    } catch {
      // Storage outages must not turn a successful upstream response into 5xx.
      // Keep the single-process claim so a local replay cannot duplicate L0.
      if (localClaims.has(key) || localCompleted.has(key)) return false;
      localClaims.add(key);
      markLocalPending(key);
      return true;
    }
  }

  async completeL0(responseId: string): Promise<void> {
    const normalized = normalizeResponseId(responseId);
    if (!normalized) return;
    const key = localKey(this.scope, normalized);
    const current = localStates.get(key);
    if (current) {
      current.l0Status = "completed";
      current.updatedAt = new Date().toISOString();
      setLocalState(key, current);
    }

    const nextState = current ? cloneState(current) : null;
    if (nextState) {
      await this.storage.putJSON(stateKey(this.scope, normalized), nextState);
    }
    await this.storage.putJSON(completedKey(this.scope, normalized), {
      responseId: normalized,
      status: "l0_completed",
      completedAt: new Date().toISOString(),
    } satisfies CompletedMarker);
    await this.storage.del(claimKey(this.scope, normalized));
    markLocalCompleted(key);
  }

  async releaseFinal(responseId: string): Promise<void> {
    const normalized = normalizeResponseId(responseId);
    if (!normalized) return;
    const key = localKey(this.scope, normalized);
    if (!localClaims.has(key)) return;
    localClaims.delete(key);
    markLocalPending(key);
    try {
      await this.storage.del(claimKey(this.scope, normalized));
    } catch {
      // The lease remains available for a later expiry-based retry.
    }
  }

  async recordState(state: ResponsesRoundState): Promise<void> {
    await this.putState(state.roundId, state);
  }
}

export class InMemoryResponsesRoundStore implements ResponsesRoundStore {
  constructor(private readonly scope: string) {}

  async getState(responseId: string): Promise<ResponsesRoundState | null> {
    const normalized = normalizeResponseId(responseId);
    if (!normalized) return null;
    const state = localStates.get(localKey(this.scope, normalized));
    return state ? cloneState(state) : null;
  }

  async putState(responseId: string, state: ResponsesRoundState): Promise<void> {
    const normalized = normalizeResponseId(responseId);
    if (!normalized) return;
    setLocalState(localKey(this.scope, normalized), state);
  }

  async beginFinal(responseId: string): Promise<boolean> {
    const normalized = normalizeResponseId(responseId);
    if (!normalized) return false;
    const key = localKey(this.scope, normalized);
    if (localCompleted.has(key) || localClaims.has(key)) return false;
    localClaims.add(key);
    markLocalPending(key);
    return true;
  }

  async completeL0(responseId: string): Promise<void> {
    const normalized = normalizeResponseId(responseId);
    if (!normalized) return;
    const key = localKey(this.scope, normalized);
    const state = localStates.get(key);
    if (state) {
      state.l0Status = "completed";
      state.updatedAt = new Date().toISOString();
      setLocalState(key, state);
    }
    markLocalCompleted(key);
  }

  async releaseFinal(responseId: string): Promise<void> {
    const normalized = normalizeResponseId(responseId);
    if (!normalized) return;
    const key = localKey(this.scope, normalized);
    if (localClaims.delete(key)) markLocalPending(key);
  }

  async recordState(state: ResponsesRoundState): Promise<void> {
    await this.putState(state.roundId, state);
  }
}

export function __resetResponsesRoundStoreForTests(): void {
  localStates.clear();
  localClaims.clear();
  localCompleted.clear();
}
