import { createHash } from "node:crypto";

const proxyUrl = process.env.PROXY_URL ?? "http://127.0.0.1:8096";
const coreUrl = process.env.CORE_URL ?? "http://127.0.0.1:8420";
const mockUrl = process.env.MOCK_URL ?? "http://127.0.0.1:8080";
const clientKey = "e2e-client-key";
const userId = createHash("sha256").update(clientKey).digest("hex").slice(0, 8);
const sessionId = "e2e-session";
const teamId = "e2e-team";
const agentId = "e2e-agent";
const taskId = "e2e-task";
const responsesPath = "/codex/e2e-space/v1/responses";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function call(url, init = {}) {
  const response = await fetch(url, init);
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* text response */ }
  return { response, status: response.status, text, body };
}

async function waitFor(name, fn, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${name} timed out${lastError ? `: ${lastError.message}` : ""}`);
}

function proxyHeaders(withSession = true) {
  return {
    "content-type": "application/json",
    authorization: `Bearer ${clientKey}`,
    ...(withSession ? { "x-conversation-id": sessionId } : {}),
  };
}

function coreHeaders() {
  return {
    "content-type": "application/json",
    authorization: "Bearer local",
    "x-tdai-service-id": "e2e-space",
    "x-tdai-team-id": teamId,
    "x-tdai-user-id": userId,
    "x-tdai-agent-id": agentId,
    "x-tdai-task-id": taskId,
    "x-tdai-session-id": sessionId,
  };
}

async function postProxy(path, body, withSession = true) {
  return call(`${proxyUrl}${path}`, {
    method: "POST",
    headers: proxyHeaders(withSession),
    body: JSON.stringify(body),
  });
}

async function queryCore() {
  const result = await call(`${coreUrl}/v3/conversation/query`, {
    method: "POST",
    headers: coreHeaders(),
    body: JSON.stringify({
      team_id: teamId,
      user_id: userId,
      agent_id: agentId,
      task_id: taskId,
      session_id: sessionId,
      limit: 100,
    }),
  });
  assert(result.status === 200 && result.body?.code === 0, `MemoryCore query failed: ${result.status} ${result.text}`);
  return result.body.data?.messages ?? [];
}

async function mockRequests() {
  const result = await call(`${mockUrl}/__test/requests`);
  assert(result.status === 200, `Mock request query failed: ${result.status}`);
  return result.body;
}

async function main() {
  await waitFor("MemoryProxy health", async () => (await call(`${proxyUrl}/health`)).status === 200);
  await waitFor("MemoryCore health", async () => (await call(`${coreUrl}/health`)).status === 200);
  await waitFor("Mock health", async () => (await call(`${mockUrl}/health`)).status === 200);
  await call(`${mockUrl}/__test/requests`, { method: "DELETE" });

  const models = await call(`${proxyUrl}/v1/models`, { method: "GET", headers: { authorization: `Bearer ${clientKey}` } });
  assert(models.status === 200 && models.body?.data?.[0]?.id === "e2e-model", "models route failed");

  const compact = await postProxy("/v1/responses/compact", { model: "e2e-model", input: "compact" });
  assert(compact.status === 200 && compact.body?.object === "response.compaction", `compact route failed: ${compact.status} ${compact.text}`);
  const search = await postProxy("/v1/alpha/search", { query: "e2e" });
  assert(search.status === 200 && search.body?.object === "search_result", `alpha/search route failed: ${search.status} ${search.text}`);
  const unknown = await postProxy("/v1/responses/unknown", { model: "e2e-model", input: "unknown" });
  assert(unknown.status === 404, `unknown Responses route returned ${unknown.status}`);

  const first = await postProxy(responsesPath, {
    model: "e2e-model-alias",
    input: "question one",
    instructions: [{ type: "input_text", text: "client instruction" }],
    unknown_provider_field: { keep: true },
    e2e_case: "json",
  });
  assert(first.status === 200 && first.body?.status === "completed", "JSON Responses failed");
  const firstId = first.body.id;

  const firstRecords = await mockRequests();
  const providerRecord = firstRecords.find((entry) => entry.path === "/v1/responses" && entry.body?.unknown_provider_field);
  assert(providerRecord, "mock did not receive the JSON Responses request");
  assert(providerRecord.body.input === "question one", "input was not preserved");
  assert(providerRecord.body.instructions?.[0]?.type === "input_text", "instructions shape was not preserved");
  assert(providerRecord.body.unknown_provider_field.keep === true, "unknown field was not preserved");
  assert(providerRecord.headers.authorization === "Bearer mock-upstream-key", "client credential leaked or provider key missing");
  assert(!providerRecord.headers["x-tdai-user-key"], "memory credential leaked to provider");

  await waitFor("first L0 write", async () => (await queryCore()).some((message) => message.content === "question one"));

  const second = await postProxy(responsesPath, {
    model: "e2e-model-alias",
    previous_response_id: firstId,
    input: "question two",
    e2e_case: "json",
  }, false);
  assert(second.status === 200 && second.body?.status === "completed", "previous_response_id continuation failed");
  await waitFor("second L0 write", async () => (await queryCore()).some((message) => message.content === "question two"));

  const streamed = await postProxy(responsesPath, {
    model: "e2e-model",
    input: "stream question",
    stream: true,
    e2e_case: "sse",
  });
  assert(streamed.status === 200 && streamed.text.includes("data: [DONE]"), "SSE Responses failed");
  assert(streamed.text.includes("\r\n"), "SSE CRLF bytes were not preserved");
  await waitFor("stream L0 write", async () => (await queryCore()).some((message) => message.content === "stream question"));

  const functionCall = await postProxy(responsesPath, {
    model: "e2e-model",
    input: "tool question",
    tools: [{ type: "function", name: "lookup" }],
    e2e_case: "function_call",
  });
  assert(functionCall.status === 200 && functionCall.body.output?.[0]?.type === "function_call", "function_call response failed");
  const beforeToolFinal = (await queryCore()).length;

  const functionFinalBody = {
    model: "e2e-model",
    previous_response_id: functionCall.body.id,
    input: [{ type: "function_call_output", call_id: "call_1", output: "42" }],
    e2e_response_id: "resp_function_final_fixed",
    e2e_case: "function_final",
  };
  const functionFinal = await postProxy(responsesPath, functionFinalBody, false);
  assert(functionFinal.status === 200 && functionFinal.body.status === "completed", "function_call final response failed");
  await waitFor("function-call L0 write", async () => (await queryCore()).some((message) => message.content === "tool question"));
  const afterToolFinal = (await queryCore()).length;
  assert(afterToolFinal >= beforeToolFinal + 2, "function-call final did not write one user/assistant pair");

  const replay = await postProxy(responsesPath, functionFinalBody, false);
  assert(replay.status === 200 && replay.body.id === "resp_function_final_fixed", "function-call replay response failed");
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert((await queryCore()).length === afterToolFinal, "replaying a response id duplicated L0");

  const functionStream = await postProxy(responsesPath, {
    model: "e2e-model",
    input: "stream tool question",
    stream: true,
    e2e_case: "function_sse",
  });
  assert(functionStream.status === 200 && functionStream.text.includes("response.function_call_arguments.delta"), "SSE function_call failed");
  const functionStreamFinal = await postProxy(responsesPath, {
    model: "e2e-model",
    previous_response_id: functionStream.text.match(/resp_function_sse_\d+/)?.[0] ?? "missing",
    input: [{ type: "function_call_output", call_id: "call_1", output: "ok" }],
    e2e_case: "function_sse_final",
  }, false);
  assert(functionStreamFinal.status === 409 || functionStreamFinal.status === 200, "SSE function continuation was unstable");

  const incomplete = await postProxy(responsesPath, { model: "e2e-model", input: "partial", e2e_case: "incomplete" });
  assert(incomplete.status === 200 && incomplete.body.status === "incomplete", "incomplete response failed");
  const httpError = await postProxy(responsesPath, { model: "e2e-model", input: "error", e2e_case: "http_error" });
  assert(httpError.status === 500, `upstream HTTP error changed status to ${httpError.status}`);

  const chat = await postProxy("/v1/chat/completions", { model: "e2e-model", messages: [{ role: "user", content: "chat" }] });
  assert(chat.status === 200 && chat.body?.object === "chat.completion", "Chat Completions compatibility failed");
  const messages = await postProxy("/v1/messages", { model: "e2e-model", max_tokens: 8, messages: [{ role: "user", content: "messages" }] });
  assert(messages.status === 200 && messages.body?.type === "message", "Anthropic Messages compatibility failed");

  const controller = new AbortController();
  const cancelRequest = fetch(`${proxyUrl}${responsesPath}`, {
    method: "POST",
    headers: proxyHeaders(),
    body: JSON.stringify({ model: "e2e-model", input: "cancel", stream: false, e2e_case: "cancel" }),
    signal: controller.signal,
  }).then(async (response) => ({ status: response.status, text: await response.text() }))
    .catch((error) => ({ error: error.name }));
  setTimeout(() => controller.abort(), 150);
  await cancelRequest;
  await waitFor("upstream cancellation", async () => {
    const records = await mockRequests();
    return records.some((entry) => entry.body?.e2e_case === "cancel" && entry.clientClosed);
  });

  console.log(JSON.stringify({
    status: "PASS",
    routes: ["responses", "responses/compact", "models", "alpha/search", "unknown"],
    protocols: ["JSON", "SSE", "function_call", "Chat Completions", "Anthropic Messages"],
    memory: "MemoryCore /v3/conversation/query confirmed L0 writes and replay idempotency",
    cancellation: "upstream connection close observed",
  }));
}

main().catch((error) => {
  console.error(JSON.stringify({ status: "FAIL", error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
});
