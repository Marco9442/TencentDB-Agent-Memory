import type { Context } from "hono";
import { extractSpaceIdFromPath, tryReportCreditFromPath } from "../credit-reporter.js";
import { verifyUserKey } from "../auth.js";
import { extractBearerToken, apiKeyToKeyId } from "../opik.js";
import { writeLog } from "../logger.js";
import type { ProxyConfig } from "../types.js";
import { adaptResponsesRequest, responsesInputToMessages } from "./request-adapter.js";
import { parseResponsesJsonResponse } from "./json-parser.js";
import { resolveResponsesUpstreamUrl, matchResponsesRoute } from "./route.js";
import { ResponsesSseResponseParser } from "./response-parser.js";
import type { JsonObject, ParsedResponsesJson, ParsedResponsesStream } from "./types.js";
import {
  buildCodexSessionIdentity,
  buildSessionNotInitializedResponse,
  codexSessionKeyId,
  InMemoryCodexResponseSessionMap,
  ProxyStorageCodexResponseSessionMap,
  readCodexIdentityHeaders,
  resolveCodexSessionKey,
  validateCodexBinding,
  type CodexResponseSessionMap,
} from "../session/codex/index.js";
import { getSessionStore, handleSessionInit, parsePresetIdentity } from "../session/index.js";
import { getMetadataClient } from "../meta/client.js";
import { injectCodexInstructions, injectCodexSessionContext } from "../injection/agents/codex/index.js";
import { getInjectionPipeline } from "../injection/index.js";
import { getProxyStorage } from "../storage/factory.js";
import { ProxyStorageResponsesRoundStore, InMemoryResponsesRoundStore, type ResponsesRoundState, type ResponsesRoundStore } from "./round-store.js";
import { enforceRateLimit, isRateLimitExceededError, recordInputTokenUsage } from "../rate-limit/guard.js";
import { TdaiClient } from "../tdai/client.js";
import { deriveTdaiIdentity } from "../tdai/identity.js";
import { extractLatestUserMessage } from "../tdai/recorder.js";
import { trackWrite, withL0Retry } from "../tdai/pending-writes.js";
import { isExtractionAllowed } from "../extraction-gate.js";
import { triggerSkillExtractIfReady } from "../skill/handler-glue.js";
import { log } from "../report/log.js";

const SKIP_REQUEST_HEADERS = new Set([
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
  "authorization",
  "proxy-authorization",
  "x-api-key",
  "sk-mem",
  "x-tdai-user-key",
  "x-tdai-user-token",
  "x-tdai-session-key",
  "x-team-id",
  "x-agent-id",
  "x-task-id",
  "x-user-id",
  "x-cb-user-id",
]);

const SKIP_RESPONSE_HEADERS = new Set([
  "content-length",
  "content-encoding",
  "transfer-encoding",
  "connection",
  "authorization",
  "proxy-authorization",
  "www-authenticate",
  "x-api-key",
  "set-cookie",
]);

function responseHeaders(source: Headers): Headers {
  const headers = new Headers();
  source.forEach((value, key) => {
    if (!SKIP_RESPONSE_HEADERS.has(key.toLowerCase())) headers.set(key, value);
  });
  return headers;
}

function requestHeaders(c: Context, apiKey: string): Headers {
  const headers = new Headers();
  for (const [key, value] of c.req.raw.headers.entries()) {
    if (!SKIP_REQUEST_HEADERS.has(key.toLowerCase())) headers.set(key, value);
  }
  // The client credential is a MemoryProxy user_key, not an upstream
  // provider credential. Never forward it to CLIProxyAPI/Provider. A server
  // configured key is the only credential allowed on the upstream leg.
  headers.delete("authorization");
  headers.delete("x-api-key");
  if (apiKey) {
    headers.set("authorization", `Bearer ${apiKey}`);
  }
  return headers;
}

function extractUsage(parsed: ParsedResponsesStream | ReturnType<typeof parseResponsesJsonResponse>): JsonObject | null {
  return parsed.usage && Object.keys(parsed.usage).length > 0 ? parsed.usage : null;
}

function responseId(parsed: ParsedResponsesJson | ParsedResponsesStream): string | undefined {
  const id = parsed.response?.id;
  return typeof id === "string" && id.trim() ? id : undefined;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    if (!part || typeof part !== "object") return "";
    const record = part as Record<string, unknown>;
    if (typeof record.text === "string") return record.text;
    return typeof record.refusal === "string" ? record.refusal : "";
  }).filter(Boolean).join("\n");
}

function responseVisibleText(parsed: ParsedResponsesJson | ParsedResponsesStream): string {
  if (parsed.outputText) return parsed.outputText;
  if ("refusalText" in parsed && parsed.refusalText) return parsed.refusalText;
  const refusal = parsed.response?.refusal;
  if (typeof refusal === "string") return refusal;
  const output = parsed.response?.output;
  if (!Array.isArray(output)) return "";
  return output.map((item) => {
    if (!item || typeof item !== "object") return "";
    const record = item as Record<string, unknown>;
    return contentText(record.content);
  }).filter(Boolean).join("\n");
}

function firstRealUserMessage(messages: JsonObject[]): ReturnType<typeof extractLatestUserMessage> {
  for (const message of messages) {
    const user = extractLatestUserMessage([message]);
    if (user) return user;
  }
  return null;
}

function toolOutputIds(messages: JsonObject[]): Set<string> {
  return new Set(
    messages
      .filter((message) => message.role === "tool")
      .map((message) => message.tool_call_id)
      .filter((id): id is string => typeof id === "string" && id.length > 0),
  );
}

function responseAssistantMessage(
  parsed: ParsedResponsesJson | ParsedResponsesStream,
  assistantText: string,
): JsonObject | null {
  if (parsed.functionCalls.length > 0) {
    return {
      role: "assistant",
      content: null,
      tool_calls: parsed.functionCalls.map((call) => ({
        id: call.call_id ?? call.id,
        type: "function",
        function: { name: call.name, arguments: call.arguments ?? "" },
      })),
    };
  }
  return assistantText ? { role: "assistant", content: assistantText } : null;
}

function sameMessage(left: JsonObject, right: JsonObject): boolean {
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

function mergeRoundMessages(
  predecessor: Array<Record<string, unknown>> | undefined,
  current: JsonObject[],
  assistantMessage: JsonObject | null,
): Array<Record<string, unknown>> {
  const result: Array<Record<string, unknown>> = (predecessor ?? []).map((message) => ({ ...message }));
  for (const message of current) {
    if (!result.some((existing) => sameMessage(existing, message))) result.push({ ...message });
  }
  if (assistantMessage && !result.some((existing) => sameMessage(existing, assistantMessage))) {
    result.push({ ...assistantMessage });
  }
  return result;
}

function textFromChatMessages(messages: JsonObject[], role: "system" | "developer"): string[] {
  return messages
    .filter((message) => message.role === role)
    .map((message) => contentText(message.content))
    .filter(Boolean);
}

function injectionAdditions(original: JsonObject[], injected: JsonObject[]): string[] {
  const remaining = textFromChatMessages(original, "system").concat(textFromChatMessages(original, "developer"));
  const additions: string[] = [];
  for (const text of textFromChatMessages(injected, "system").concat(textFromChatMessages(injected, "developer"))) {
    const index = remaining.indexOf(text);
    if (index >= 0) remaining.splice(index, 1);
    else additions.push(text);
  }
  return additions;
}

function createTdaiClient(config: ProxyConfig, spaceId: string): TdaiClient | null {
  if (!config.tdai.enabled || !config.tdai.memory.enabled || !config.tdai.endpoint) return null;
  return new TdaiClient({
    enabled: true,
    endpoint: config.tdai.endpoint,
    apiKey: config.tdai.apiKey,
    serviceId: spaceId || config.tdai.serviceId,
    writeL0: config.tdai.memory.writeL0,
    recallL1: config.tdai.memory.recallL1,
    injectL2L3: config.tdai.memory.injectL2L3,
    l1Limit: config.tdai.memory.l1Limit,
    l2Limit: config.tdai.memory.l2Limit,
    timeoutMs: config.tdai.memory.timeoutMs,
  });
}

const fallbackResponseMaps = new Map<string, CodexResponseSessionMap>();

function responseSessionMap(
  config: ProxyConfig,
  userId: string,
  spaceId: string,
  agentSource: string,
): CodexResponseSessionMap {
  const scope = `${spaceId || "_default"}:${userId || "anonymous"}:${agentSource}`;
  try {
    return new ProxyStorageCodexResponseSessionMap(getProxyStorage(config.storage), {
      userId: userId || "anonymous",
      spaceId: spaceId || "_default",
      agentSource,
    });
  } catch {
    const existing = fallbackResponseMaps.get(scope);
    if (existing) return existing;
    const created = new InMemoryCodexResponseSessionMap();
    fallbackResponseMaps.set(scope, created);
    return created;
  }
}

async function recordUsage(
  config: ProxyConfig,
  path: string,
  modelId: string,
  keyId: string,
  sessionKey: string | undefined,
  upstreamUrl: string,
  stream: boolean,
  status: number,
  usage: JsonObject | null,
): Promise<void> {
  if (!usage || !statusIsSuccess(status)) return;

  try {
    writeLog(config, {
      timestamp: new Date().toISOString(),
      event: "usage",
      modelId,
      keyId,
      sessionKey: sessionKey ?? keyId,
      upstreamUrl,
      stream,
      usage,
      spaceId: extractSpaceIdFromPath(path) ?? undefined,
    });
  } catch {
    // Observability must not change the upstream response path.
  }

  if (!config.creditReport?.url) return;
  try {
    await tryReportCreditFromPath(
      config.creditReport,
      path,
      usage,
      config.creditPricing,
      modelId,
      upstreamUrl,
      "usage",
    );
  } catch {
    // Credit reporting is best effort for a transparent transport.
  }
}

function statusIsSuccess(status: number): boolean {
  return status >= 200 && status < 400;
}

function requestPath(c: Context): string {
  return c.req.url || c.req.path;
}

interface PreparedResponsesRequest {
  body: Record<string, unknown>;
  messages: JsonObject[];
  sessionKey?: string;
  sessionInfo?: Record<string, unknown> | null;
  responseSessionMap?: CodexResponseSessionMap;
  roundStore?: ResponsesRoundStore;
  predecessorState?: ResponsesRoundState | null;
  agentSource: string;
}

function lowerHeaders(c: Context): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of c.req.raw.headers.entries()) result[key.toLowerCase()] = value;
  return result;
}

function stateBinding(state: {
  bypassed?: boolean;
  userId?: string;
  sessionInfo?: unknown;
}) {
  const info = state.sessionInfo as {
    user_id?: unknown;
    team_id?: unknown;
    agent_id?: unknown;
    task_id?: unknown;
  } | null | undefined;
  return {
    outcome: state.bypassed ? "bypassed" as const : "initialized" as const,
    userId: typeof info?.user_id === "string" ? info.user_id : state.userId,
    teamId: typeof info?.team_id === "string" ? info.team_id : undefined,
    agentId: typeof info?.agent_id === "string" ? info.agent_id : undefined,
    taskId: typeof info?.task_id === "string" ? info.task_id : undefined,
  };
}

async function prepareResponsesRequest(
  c: Context,
  config: ProxyConfig,
  path: string,
  route: NonNullable<ReturnType<typeof matchResponsesRoute>>,
  request: ReturnType<typeof adaptResponsesRequest>,
  clientKey: string,
  keyId: string,
  spaceId: string,
): Promise<PreparedResponsesRequest | Response> {
  const body = request.request ? { ...request.request } as Record<string, unknown> : null;
  const agentSource = route.agentName === "openai" ? "openai" : "codex";
  if (route.endpoint !== "responses" || !body) {
    return { body: body ?? {}, messages: [], agentSource };
  }

  const messages = responsesInputToMessages(body.input, body.instructions);
  const userId = keyId || "anonymous";
  const responseMap = responseSessionMap(config, userId, spaceId, agentSource);
  const resolved = await resolveCodexSessionKey({
    headers: c.req.raw.headers,
    body,
    previousResponseId: request.previousResponseId,
    fallbackKey: config.sessionInit.enabled ? undefined : keyId,
    responseSessionMap: responseMap,
  });
  if (!resolved.sessionKey) return buildSessionNotInitializedResponse();

  const sessionKey = resolved.sessionKey;
  const roundScope = `${spaceId || "_default"}:${userId}:${agentSource}:${sessionKey}`;
  let roundStore: ResponsesRoundStore;
  try {
    roundStore = new ProxyStorageResponsesRoundStore(getProxyStorage(config.storage), roundScope);
  } catch {
    roundStore = new InMemoryResponsesRoundStore(roundScope);
  }

  const predecessorState = request.previousResponseId
    ? await roundStore.getState(request.previousResponseId)
    : null;

  let sessionInfo: Record<string, unknown> | null | undefined;
  if (config.sessionInit.enabled) {
    const store = getSessionStore();
    const identity = buildCodexSessionIdentity(sessionKey, userId, spaceId, agentSource);
    const compositeKey = `${agentSource}:${sessionKey}`;
    const identityHeaders = readCodexIdentityHeaders(c.req.raw.headers);
    const bindingRepo = store.getBindingRepo();
    if (bindingRepo) {
      try {
        const binding = await bindingRepo.getBinding(
          spaceId,
          userId,
          agentSource,
          sessionKey,
        );
        if (binding && !validateCodexBinding(binding, identityHeaders, userId).valid) {
          return c.json({
            error: {
              type: "forbidden",
              code: "session_binding_mismatch",
              message: "Codex Team, Agent or Task binding does not match this session",
            },
          }, 403);
        }
      } catch {
        return c.json({ error: { type: "service_unavailable", code: "session_store_unavailable" } }, 503);
      }
    }

    const metadataClient = config.coreSkill.endpoint
      ? getMetadataClient(config.coreSkill, spaceId, clientKey)
      : undefined;
    const recovered = await store.getOrRecover(compositeKey, identity, {
      metadataClient,
      messages,
    });
    if (recovered) {
      if (recovered.bypassed) return buildSessionNotInitializedResponse();
      const validation = validateCodexBinding(
        stateBinding(recovered),
        identityHeaders,
        userId,
      );
      if (!validation.valid) {
        return c.json({
          error: {
            type: "forbidden",
            code: "session_binding_mismatch",
            message: "Codex Team, Agent or Task binding does not match this session",
          },
        }, 403);
      }
      sessionInfo = recovered.sessionInfo as unknown as Record<string, unknown> | null | undefined;
      const sessionInjection = injectCodexSessionContext(
        body,
        recovered.agentDetail,
        recovered.taskDetail,
        config.sessionInit,
        sessionKey,
      );
      Object.assign(body, sessionInjection.body);
    } else {
      const preset = parsePresetIdentity(config.sessionInit, lowerHeaders(c));
      if (!preset) return buildSessionNotInitializedResponse();
      if (!metadataClient) {
        return c.json({ error: { type: "service_unavailable", code: "session_backend_unavailable" } }, 503);
      }
      const initResult = await handleSessionInit(
        sessionKey,
        userId || null,
        messages,
        {
          ...config.sessionInit,
          // Codex cannot answer an interactive form and must fail closed on
          // a mismatched header rather than silently bypassing memory.
          headerAutoSelect: config.sessionInit.headerAutoSelect
            ? { ...config.sessionInit.headerAutoSelect, onMismatch: "form" }
            : undefined,
        },
        store,
        { stream: body.stream === true, modelId: request.model, protocol: "openai" },
        agentSource,
        metadataClient,
        clientKey,
        spaceId,
        preset,
      );
      if (initResult.intercepted || initResult.bypassed || !initResult.sessionInfo) {
        return buildSessionNotInitializedResponse();
      }
      sessionInfo = initResult.sessionInfo as unknown as Record<string, unknown>;
      const sessionInjection = injectCodexSessionContext(
        body,
        initResult.agentDetail,
        initResult.taskDetail,
        config.sessionInit,
        sessionKey,
      );
      Object.assign(body, sessionInjection.body);
    }
  }

  if (config.injection.enabled && config.injection.injectors.length > 0 && sessionKey) {
    try {
      const traceId = crypto.randomUUID();
      const pipelineBody = await getInjectionPipeline(config).process({ messages }, {
        protocol: "openai",
        traceId,
        keyId,
        modelId: request.model,
        stream: body.stream === true,
        agentSource,
        userId,
        spaceId,
        sessionKey,
        turnSeq: messages.filter((message) => message.role === "user").length,
        requestPath: c.req.path,
        custom: sessionInfo ? { session: sessionInfo, userKey: clientKey || undefined } : undefined,
      });
      const injectedMessages = Array.isArray(pipelineBody.messages)
        ? pipelineBody.messages as JsonObject[]
        : messages;
      const additions = injectionAdditions(messages, injectedMessages);
      if (additions.length > 0) {
        Object.assign(body, injectCodexInstructions(body, additions.join("\n\n")).body);
      }
    } catch {
      // Existing proxy semantics treat injection as non-fatal; the original
      // Responses request remains valid and is still forwarded.
    }
  }

  return {
    body,
    messages,
    sessionKey,
    sessionInfo,
    responseSessionMap: responseMap,
    roundStore,
    predecessorState,
    agentSource,
  };
}

interface PublishedResponsesLifecycle {
  id?: string;
  state?: ResponsesRoundState;
  assistantText: string;
  finalCandidate: boolean;
  publicationTasks: Promise<unknown>[];
}

function publishResponsesCompletion(args: {
  config: ProxyConfig;
  path: string;
  modelId: string;
  keyId: string;
  sessionKey?: string;
  userId: string;
  userKey: string;
  agentSource: string;
  spaceId: string;
  upstreamUrl: string;
  status: number;
  stream: boolean;
  parsed: ParsedResponsesJson | ParsedResponsesStream;
  messages: JsonObject[];
  sessionInfo?: Record<string, unknown> | null;
  responseSessionMap?: CodexResponseSessionMap;
  roundStore?: ResponsesRoundStore;
  predecessorState?: ResponsesRoundState | null;
}): PublishedResponsesLifecycle {
  const publicationTasks: Promise<unknown>[] = [];
  const id = responseId(args.parsed);
  const status = args.parsed.status;
  const streamDone = "done" in args.parsed ? args.parsed.done : true;
  const final = status === "completed" || (!status && streamDone);
  const functionCallIds = args.parsed.functionCalls
    .map((call) => call.call_id ?? call.id)
    .filter((callId): callId is string => !!callId);
  const finalCandidate = final && functionCallIds.length === 0;

  if (id && args.responseSessionMap && args.sessionKey) {
    // The map implementation is write-through: the local publication happens
    // before this promise reaches its first await.
    publicationTasks.push(args.responseSessionMap.put(id, args.sessionKey));
  }

  let state: ResponsesRoundState | undefined;
  if (id && args.sessionKey && args.roundStore) {
    const predecessor = args.predecessorState;
    const currentUser = firstRealUserMessage(args.messages);
    const outputIds = toolOutputIds(args.messages);
    const pendingCallIds = [...new Set([
      ...(predecessor?.pendingCallIds ?? []).filter((callId) => !outputIds.has(callId)),
      ...functionCallIds,
    ])];
    const roundComplete = finalCandidate && pendingCallIds.length === 0;
    const l0Expected = Boolean(
      args.sessionInfo
      && args.sessionKey
      && args.config.tdai.enabled
      && args.config.tdai.endpoint
      && args.config.tdai.memory.enabled
      && args.config.tdai.memory.writeL0
      && isExtractionAllowed(args.config, "tdai-memory"),
    );
    const originalUserInput = predecessor?.originalUserInput?.trim()
      || currentUser?.content.trim()
      || "";
    const assistantText = responseVisibleText(args.parsed);
    state = {
      spaceId: args.spaceId,
      userId: args.userId,
      agentSource: args.agentSource,
      sessionKey: args.sessionKey,
      roundId: id,
      originalUserInput,
      pendingCallIds,
      seenResponseIds: [...new Set([...(predecessor?.seenResponseIds ?? []), id])],
      conversationMessages: mergeRoundMessages(
        predecessor?.conversationMessages,
        args.messages,
        roundComplete ? null : responseAssistantMessage(args.parsed, assistantText),
      ),
      ...(roundComplete
        ? {
            finalResponseId: id,
            ...(l0Expected ? { l0Status: "pending" as const } : {}),
          }
        : {}),
      updatedAt: new Date().toISOString(),
    };
    publicationTasks.push(args.roundStore.putState(id, state));
  }

  return {
    id,
    state,
    assistantText: responseVisibleText(args.parsed),
    finalCandidate: !!state && finalCandidate && state.pendingCallIds.length === 0,
    publicationTasks,
  };
}

export async function finalizeResponsesLifecycle(args: {
  config: ProxyConfig;
  path: string;
  modelId: string;
  keyId: string;
  sessionKey?: string;
  userId: string;
  userKey: string;
  agentSource: string;
  spaceId: string;
  upstreamUrl: string;
  status: number;
  stream: boolean;
  parsed: ParsedResponsesJson | ParsedResponsesStream;
  messages: JsonObject[];
  sessionInfo?: Record<string, unknown> | null;
  responseSessionMap?: CodexResponseSessionMap;
  roundStore?: ResponsesRoundStore;
  predecessorState?: ResponsesRoundState | null;
}): Promise<void> {
  const publication = publishResponsesCompletion(args);

  // Keep every publication write in the tracked lifecycle, but do not make
  // publication itself wait for durable storage before the SSE closes.
  await Promise.allSettled(publication.publicationTasks);

  const usage = extractUsage(args.parsed);
  await recordUsage(
    args.config,
    args.path,
    args.modelId,
    args.keyId,
    args.sessionKey,
    args.upstreamUrl,
    args.stream,
    args.status,
    usage,
  );
  await recordInputTokenUsage({
    config: args.config,
    instanceId: args.spaceId || undefined,
    modelId: args.modelId,
    usage,
    protocol: "openai",
  }).catch(() => undefined);

  const id = publication.id;
  if (!publication.finalCandidate || !id || !args.roundStore) return;

  const assistantText = publication.assistantText;
  const roundState = publication.state;
  const userContent = roundState?.originalUserInput?.trim()
    || firstRealUserMessage(args.messages)?.content
    || "";

  const tdaiClient = createTdaiClient(args.config, args.spaceId);
  const identity = tdaiClient
    ? deriveTdaiIdentity({
        sessionInfo: args.sessionInfo,
        userId: args.userId || null,
        sessionKey: args.sessionKey ?? "",
        userKey: args.userKey || null,
      })
    : null;
  if (tdaiClient && identity && userContent && assistantText && isExtractionAllowed(args.config, "tdai-memory")) {
    let claimed = false;
    try {
      claimed = await args.roundStore.beginFinal(id);
      if (claimed) {
        let l0Succeeded = false;
        try {
          await withL0Retry(() => tdaiClient.addConversationStrict(identity, [
            { role: "user", content: userContent },
            { role: "assistant", content: assistantText },
          ]));
          l0Succeeded = true;
          await args.roundStore.completeL0(id);
        } catch (error) {
          if (!l0Succeeded) {
            await args.roundStore.releaseFinal(id).catch(() => undefined);
          }
          log.warn("responses.l0_write_failed", {
            responseId: id,
            error: error instanceof Error ? error.message : String(error),
            markerPublished: l0Succeeded,
          });
        }
      }
    } catch (error) {
      if (claimed) await args.roundStore.releaseFinal(id).catch(() => undefined);
      log.warn("responses.l0_claim_failed", {
        responseId: id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (isExtractionAllowed(args.config, "skill")) {
    await triggerSkillExtractIfReady({
      config: args.config,
      sessionKey: args.sessionKey ?? "",
      agentSource: args.agentSource,
      sessionInfo: args.sessionInfo,
      inputMessages: roundState?.conversationMessages ?? args.messages,
      assistantMessage: { role: "assistant", content: assistantText },
      protocol: "openai",
    }).catch(() => undefined);
  }
}

/** Independent raw transport for OpenAI Responses and its small helper paths. */
export async function handleResponses(
  c: Context,
  config: ProxyConfig,
): Promise<Response> {
  const path = requestPath(c);
  const route = matchResponsesRoute(path);
  if (!route) return c.json({ error: "Unregistered Responses endpoint" }, 404);

  const authHeader = c.req.header("authorization") ?? c.req.header("Authorization") ?? "";
  const clientKey =
    c.req.header("x-tdai-user-key") ??
    c.req.header("sk-mem") ??
    c.req.header("x-api-key") ??
    extractBearerToken(authHeader);
  const spaceId = extractSpaceIdFromPath(c.req.path) ?? "";
  const verified = await verifyUserKey(clientKey, spaceId);
  if (verified.rejected) {
    return c.json({ error: `Authentication failed: ${verified.rejectReason ?? "unknown"}` }, 401);
  }

  const method = c.req.method.toUpperCase();
  const rawBody = method === "GET" ? new ArrayBuffer(0) : await c.req.arrayBuffer();
  const request = adaptResponsesRequest(rawBody);
  const keyId = verified.userId || (clientKey ? apiKeyToKeyId(clientKey) : "unknown");
  if (route.endpoint === "responses" && method === "POST" && !request.request) {
    return c.json({
      error: {
        type: "invalid_request_error",
        code: "invalid_json",
        message: "Responses request body must be a JSON object",
      },
    }, 400);
  }
  const lifecycle = await prepareResponsesRequest(
    c,
    config,
    path,
    route,
    request,
    clientKey,
    keyId,
    spaceId,
  );
  if (lifecycle instanceof Response) return lifecycle;
  const target = resolveResponsesUpstreamUrl(config, path);

  if (route.endpoint === "responses" && spaceId) {
    try {
      await enforceRateLimit({
        config,
        instanceId: spaceId,
        modelId: request.model,
        protocol: "openai",
      });
    } catch (error) {
      if (isRateLimitExceededError(error)) return error.response;
      throw error;
    }
  }

  const outgoingBody = route.endpoint === "responses" && method === "POST" && request.request
    ? JSON.stringify(lifecycle.body)
    : rawBody;

  let upstream: Response;
  try {
    const init: RequestInit = {
      method,
      headers: requestHeaders(c, target.apiKey),
      ...(method !== "GET" && (typeof outgoingBody === "string" || outgoingBody.byteLength > 0)
        ? { body: outgoingBody }
        : {}),
    };
    const timeoutMs = config.server.forwardTimeoutMs ?? 600_000;
    if (timeoutMs > 0) init.signal = AbortSignal.timeout(timeoutMs);
    upstream = await fetch(target.url, init);
  } catch {
    return c.json({ error: "Upstream request failed" }, 502);
  }

  const headers = responseHeaders(upstream.headers);
  const contentType = upstream.headers.get("content-type") ?? "";
  const isStream = contentType.toLowerCase().includes("event-stream");

  if (!isStream || !upstream.body) {
    const body = await upstream.arrayBuffer();
    const parsed = parseResponsesJsonResponse(new TextDecoder().decode(body));
    await finalizeResponsesLifecycle({
      config,
      path: c.req.path,
      modelId: request.model,
      keyId,
      sessionKey: lifecycle.sessionKey,
      userId: keyId,
      userKey: clientKey,
      agentSource: lifecycle.agentSource,
      spaceId,
      upstreamUrl: target.url,
      status: upstream.status,
      stream: false,
      parsed,
      messages: lifecycle.messages,
      sessionInfo: lifecycle.sessionInfo,
      responseSessionMap: lifecycle.responseSessionMap,
      roundStore: lifecycle.roundStore,
      predecessorState: lifecycle.predecessorState,
    });
    return new Response(body, { status: upstream.status, headers });
  }

  const parser = new ResponsesSseResponseParser();
  const passthrough = upstream.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      try {
        parser.push(chunk);
      } catch {
        // Parsing is a side channel; never break the byte-identical stream.
      }
      controller.enqueue(chunk);
    },
    flush() {
      let parsed: ParsedResponsesStream;
      try {
        parsed = parser.finish();
      } catch {
        return;
      }
      const task = finalizeResponsesLifecycle({
        config,
        path: c.req.path,
        modelId: request.model,
        keyId,
        sessionKey: lifecycle.sessionKey,
        userId: keyId,
        userKey: clientKey,
        agentSource: lifecycle.agentSource,
        spaceId,
        upstreamUrl: target.url,
        status: upstream.status,
        stream: true,
        parsed,
        messages: lifecycle.messages,
        sessionInfo: lifecycle.sessionInfo,
        responseSessionMap: lifecycle.responseSessionMap,
        roundStore: lifecycle.roundStore,
        predecessorState: lifecycle.predecessorState,
      });
      trackWrite(task).catch((error: unknown) => {
        log.warn("responses.lifecycle_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    },
  }));

  return new Response(passthrough, { status: upstream.status, headers });
}

export const handleOpenAIResponses = handleResponses;
export const handleResponsesEndpoint = handleResponses;
