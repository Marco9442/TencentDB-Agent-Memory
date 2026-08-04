/**
 * Small, framework-free helpers for an OpenAI Responses session.
 *
 * The existing SessionStore owns session state and recovery. This module only
 * supplies the Codex-specific boundary decisions that cannot be added there
 * without changing the shared Claude/CodeBuddy flow.
 */

import type { BindingRepo, SessionBinding } from "../../db/binding-repo.js";
import type { ProxyStorage } from "../../storage/proxy-storage.js";
import { sessionDirOf } from "../../storage/key-utils.js";
import type { MetadataClient } from "../../meta/client.js";
import type {
  SessionIdentity,
  SessionStore,
  RecoveryContext,
} from "../store.js";
import type { PresetIdentity } from "../preset.js";
import type { SessionInitState } from "../types.js";

export const CODEX_AGENT_SOURCE = "codex";

/** Most-specific client session headers first. */
export const CODEX_SESSION_HEADER_PRIORITY = [
  "x-tdai-session-key",
  "x-codex-session-id",
  "x-codex-conversation-id",
  "x-conversation-id",
  "x-session-id",
  "x-thread-id",
  "x-chat-id",
] as const;

export const CODEX_IDENTITY_HEADERS = {
  teamHeader: "x-team-id",
  agentHeader: "x-agent-id",
  taskHeader: "x-task-id",
} as const;

export type CodexHeaders =
  | Headers
  | Readonly<Record<string, string | readonly string[] | null | undefined>>;

export interface CodexHeaderNames {
  teamHeader?: string;
  agentHeader?: string;
  taskHeader?: string;
}

/** Same identity shape used by the existing header auto-select flow. */
export type CodexIdentityHeaders = PresetIdentity;

function clean(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function getHeader(headers: CodexHeaders | undefined, name: string): string | undefined {
  if (!headers) return undefined;

  const getter = (headers as { get?: unknown }).get;
  if (typeof getter === "function") {
    return clean((getter as (headerName: string) => unknown).call(headers, name));
  }

  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== wanted) continue;
    if (Array.isArray(value)) return clean(value[0]);
    return clean(value);
  }
  return undefined;
}

/** Read only the three configured identity headers; values are trimmed. */
export function readCodexIdentityHeaders(
  headers: CodexHeaders | undefined,
  names: CodexHeaderNames = {},
): CodexIdentityHeaders {
  return {
    teamId: getHeader(headers, names.teamHeader ?? CODEX_IDENTITY_HEADERS.teamHeader),
    agentId: getHeader(headers, names.agentHeader ?? CODEX_IDENTITY_HEADERS.agentHeader),
    taskId: getHeader(headers, names.taskHeader ?? CODEX_IDENTITY_HEADERS.taskHeader),
  };
}

/** Compatibility name matching the Team/Agent/Task terminology. */
export const readTeamAgentTaskHeaders = readCodexIdentityHeaders;

function hasIdentityHeader(headers: CodexIdentityHeaders): boolean {
  return !!(headers.teamId || headers.agentId || headers.taskId);
}

export interface CodexSessionHeaderMatch {
  sessionKey: string;
  headerName: string;
}

/** Return the first non-empty session header, without looking at the body. */
export function readCodexSessionHeader(
  headers: CodexHeaders | undefined,
): CodexSessionHeaderMatch | undefined {
  for (const headerName of CODEX_SESSION_HEADER_PRIORITY) {
    const sessionKey = getHeader(headers, headerName);
    if (sessionKey) return { sessionKey, headerName };
  }
  return undefined;
}

/** Extract the only Responses field used for recovery lookup. */
export function readCodexPreviousResponseId(
  body: unknown,
): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  return clean((body as Record<string, unknown>).previous_response_id);
}

export interface CodexResponseSessionMap {
  /** Look up a real session key by a prior Responses response id. */
  get(responseId: string): Promise<string | null>;
  /** Record an upstream response id against the already-resolved session key. */
  put(responseId: string, sessionKey: string): Promise<void>;
}

/** In-memory implementation for tests and single-process callers. */
export class InMemoryCodexResponseSessionMap implements CodexResponseSessionMap {
  private readonly values = new Map<string, string>();

  async get(responseId: string): Promise<string | null> {
    return this.values.get(clean(responseId) ?? "") ?? null;
  }

  async put(responseId: string, sessionKey: string): Promise<void> {
    const id = clean(responseId);
    const key = clean(sessionKey);
    if (!id || !key) return;
    this.values.set(id, key);
  }
}

interface StoredCodexResponseSession {
  sessionKey: string;
}

export interface CodexResponseSessionMapScope {
  userId: string;
  spaceId?: string;
  agentSource?: string;
}

/**
 * ProxyStorage-backed response-id map.
 *
 * It deliberately uses the ttl bucket: the map is only a recovery hint, while
 * the durable session binding remains the source of truth for old sessions.
 */
export class ProxyStorageCodexResponseSessionMap implements CodexResponseSessionMap {
  private readonly agentSource: string;
  private readonly userId: string;
  private readonly spaceId: string;

  constructor(
    private readonly storage: ProxyStorage,
    scope: CodexResponseSessionMapScope,
  ) {
    this.agentSource = scope.agentSource ?? CODEX_AGENT_SOURCE;
    this.userId = clean(scope.userId) ?? "anonymous";
    this.spaceId = clean(scope.spaceId) ?? "_default";
  }

  async get(responseId: string): Promise<string | null> {
    const key = this.key(responseId);
    if (!key) return null;
    try {
      const row = await this.storage.getJSON<StoredCodexResponseSession>(key);
      return clean(row?.sessionKey) ?? null;
    } catch {
      return null;
    }
  }

  async put(responseId: string, sessionKey: string): Promise<void> {
    const key = this.key(responseId);
    const resolvedSessionKey = clean(sessionKey);
    if (!key || !resolvedSessionKey) return;
    try {
      await this.storage.putJSON(key, { sessionKey: resolvedSessionKey });
    } catch {
      // Mapping is an optimization; SessionStore/BindingRepo remain authoritative.
    }
  }

  private key(responseId: string): string | null {
    const id = clean(responseId);
    if (!id) return null;
    try {
      return `${sessionDirOf(
        "ttl",
        this.spaceId,
        this.userId,
        this.agentSource,
        id,
      )}response-session.json`;
    } catch {
      // Reject path-like ids rather than weakening ProxyStorage key validation.
      return null;
    }
  }
}

export type CodexResponseSessionMapping = CodexResponseSessionMap;

export interface CodexSessionKeyInput {
  headers?: CodexHeaders;
  body?: Record<string, unknown>;
  /** Explicit value wins over body.previous_response_id when supplied. */
  previousResponseId?: string | null;
  /** Last-resort caller-owned key; never derived from previous_response_id. */
  fallbackKey?: string | null;
  responseSessionMap?: CodexResponseSessionMap;
}

export type CodexSessionKeySource =
  | "header"
  | "prompt_cache_key"
  | "conversation"
  | "previous_response_id"
  | "fallback"
  | "none";

export interface CodexSessionKeyResolution {
  sessionKey?: string;
  source: CodexSessionKeySource;
  headerName?: string;
  previousResponseId?: string;
}

function readCodexBodySessionKey(body: Record<string, unknown> | undefined): {
  sessionKey?: string;
  source?: "prompt_cache_key" | "conversation";
} {
  const promptCacheKey = clean(body?.prompt_cache_key);
  if (promptCacheKey) return { sessionKey: promptCacheKey, source: "prompt_cache_key" };

  const conversation = body?.conversation;
  if (conversation && typeof conversation === "object" && !Array.isArray(conversation)) {
    const conversationId = clean((conversation as Record<string, unknown>).id);
    if (conversationId) return { sessionKey: conversationId, source: "conversation" };
  }
  return {};
}

/**
 * Resolve a Responses session key without ever treating previous_response_id
 * itself as the session key.
 */
export async function resolveCodexSessionKey(
  input: CodexSessionKeyInput,
): Promise<CodexSessionKeyResolution> {
  const header = readCodexSessionHeader(input.headers);
  if (header) {
    return {
      sessionKey: header.sessionKey,
      source: "header",
      headerName: header.headerName,
    };
  }

  const bodySession = readCodexBodySessionKey(input.body);
  if (bodySession.sessionKey && bodySession.source) {
    return { sessionKey: bodySession.sessionKey, source: bodySession.source };
  }

  const previousResponseId = clean(
    input.previousResponseId ?? readCodexPreviousResponseId(input.body),
  );
  if (previousResponseId && input.responseSessionMap) {
    try {
      const sessionKey = clean(await input.responseSessionMap.get(previousResponseId));
      if (sessionKey) {
        return { sessionKey, source: "previous_response_id", previousResponseId };
      }
    } catch {
      // Fall through to the explicit caller fallback.
    }
  }

  const fallbackKey = clean(input.fallbackKey);
  if (fallbackKey) {
    return {
      sessionKey: fallbackKey,
      source: "fallback",
      ...(previousResponseId ? { previousResponseId } : {}),
    };
  }

  return {
    source: "none",
    ...(previousResponseId ? { previousResponseId } : {}),
  };
}

/** Convenience wrapper for callers that only need the resolved string. */
export async function getCodexSessionKey(
  input: CodexSessionKeyInput,
): Promise<string | undefined> {
  return (await resolveCodexSessionKey(input)).sessionKey;
}

export type CodexBindingField = "userId" | "teamId" | "agentId" | "taskId";

export type CodexBindingValidationStatus =
  | "unbound"
  | "valid"
  | "bypassed"
  | "mismatch"
  | "unavailable";

export interface CodexBindingValidation {
  valid: boolean;
  status: CodexBindingValidationStatus;
  field?: CodexBindingField;
  binding?: SessionBinding | null;
}

/**
 * Validate only caller-provided identity values against a stored binding.
 * Missing headers do not change an existing binding; extra values cannot
 * create or replace one.
 */
export function validateCodexBinding(
  binding: SessionBinding | null | undefined,
  identity: CodexIdentityHeaders,
  userId?: string | null,
): CodexBindingValidation {
  if (!binding) return { valid: true, status: "unbound", binding: null };

  const currentUserId = clean(userId);
  if (currentUserId && binding.userId && currentUserId !== clean(binding.userId)) {
    return { valid: false, status: "mismatch", field: "userId", binding };
  }

  if (binding.outcome === "bypassed") {
    return hasIdentityHeader(identity)
      ? { valid: false, status: "bypassed", binding }
      : { valid: true, status: "bypassed", binding };
  }

  const fields: Array<{
    field: Exclude<CodexBindingField, "userId">;
    header: keyof CodexIdentityHeaders;
    bound: keyof SessionBinding;
  }> = [
    { field: "teamId", header: "teamId", bound: "teamId" },
    { field: "agentId", header: "agentId", bound: "agentId" },
    { field: "taskId", header: "taskId", bound: "taskId" },
  ];

  for (const field of fields) {
    const provided = clean(identity[field.header]);
    if (!provided) continue;
    const expected = clean(binding[field.bound]);
    if (!expected || expected !== provided) {
      return { valid: false, status: "mismatch", field: field.field, binding };
    }
  }

  return { valid: true, status: "valid", binding };
}

export const isCodexBindingValid = (
  binding: SessionBinding | null | undefined,
  identity: CodexIdentityHeaders,
  userId?: string | null,
): boolean => validateCodexBinding(binding, identity, userId).valid;

export function codexSessionKeyId(sessionKey: string, agentSource = CODEX_AGENT_SOURCE): string {
  return `${agentSource}:${sessionKey}`;
}

export function buildCodexSessionIdentity(
  sessionKey: string,
  userId?: string | null,
  spaceId?: string,
  agentSource = CODEX_AGENT_SOURCE,
): SessionIdentity {
  return {
    userId: clean(userId) ?? "anonymous",
    agentSource,
    sessionId: sessionKey,
    spaceId,
  };
}

export interface RecoverCodexSessionInput {
  store: SessionStore;
  sessionKey: string;
  userId?: string | null;
  spaceId?: string;
  headers?: CodexHeaders;
  bindingRepo?: BindingRepo;
  metadataClient?: MetadataClient;
  messages?: Record<string, unknown>[];
}

export interface RecoverCodexSessionResult {
  keyId: string;
  identity: SessionIdentity;
  state?: SessionInitState;
  binding?: SessionBinding | null;
  bindingValidation?: CodexBindingValidation;
  bindingRejected?: boolean;
}

/**
 * Adapter around the shared SessionStore. A BindingRepo is optional so this
 * helper can be used before the host exposes the repo selected by injection
 * startup; when supplied, header validation happens before any recovery read.
 */
export async function recoverCodexSession(
  input: RecoverCodexSessionInput,
): Promise<RecoverCodexSessionResult> {
  const identity = buildCodexSessionIdentity(input.sessionKey, input.userId, input.spaceId);
  const keyId = codexSessionKeyId(input.sessionKey);
  const headerIdentity = readCodexIdentityHeaders(input.headers);

  let binding: SessionBinding | null | undefined;
  let bindingValidation: CodexBindingValidation | undefined;
  if (input.bindingRepo) {
    try {
      binding = await input.bindingRepo.getBinding(
        input.spaceId ?? "",
        identity.userId,
        identity.agentSource,
        identity.sessionId,
      );
    } catch {
      bindingValidation = { valid: false, status: "unavailable" };
      return { keyId, identity, bindingValidation, bindingRejected: true };
    }

    bindingValidation = validateCodexBinding(
      binding,
      headerIdentity,
      identity.userId,
    );
    if (!bindingValidation.valid) {
      return {
        keyId,
        identity,
        binding,
        bindingValidation,
        bindingRejected: true,
      };
    }
  } else if (hasIdentityHeader(headerIdentity)) {
    // Do not recover a session while caller-supplied identity is unchecked.
    bindingValidation = { valid: false, status: "unavailable" };
    return { keyId, identity, bindingValidation, bindingRejected: true };
  }

  const recoveryContext: RecoveryContext = {
    metadataClient: input.metadataClient,
    messages: input.messages ?? [],
  };
  const state = await input.store.getOrRecover(keyId, identity, recoveryContext);
  return { keyId, identity, state, binding, bindingValidation };
}

export const SESSION_NOT_INITIALIZED_CODE = "session_not_initialized" as const;
const DEFAULT_SESSION_NOT_INITIALIZED_MESSAGE =
  "The Codex Responses session has not been initialized.";

export interface CodexSessionErrorPayload {
  error: {
    type: "invalid_request_error";
    code: typeof SESSION_NOT_INITIALIZED_CODE;
    message: string;
  };
}

export function buildSessionNotInitializedPayload(
  message = DEFAULT_SESSION_NOT_INITIALIZED_MESSAGE,
): CodexSessionErrorPayload {
  return {
    error: {
      type: "invalid_request_error",
      code: SESSION_NOT_INITIALIZED_CODE,
      message,
    },
  };
}

export function buildSessionNotInitializedResponse(
  message = DEFAULT_SESSION_NOT_INITIALIZED_MESSAGE,
): Response {
  return new Response(JSON.stringify(buildSessionNotInitializedPayload(message)), {
    status: 409,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
}

export const createSessionNotInitializedResponse = buildSessionNotInitializedResponse;

export class CodexSessionNotInitializedError extends Error {
  readonly status = 409;
  readonly code = SESSION_NOT_INITIALIZED_CODE;

  constructor(message = DEFAULT_SESSION_NOT_INITIALIZED_MESSAGE) {
    super(message);
    this.name = "CodexSessionNotInitializedError";
  }

  toJSON(): CodexSessionErrorPayload {
    return buildSessionNotInitializedPayload(this.message);
  }
}
