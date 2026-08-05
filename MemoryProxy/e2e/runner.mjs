import { createHash } from "node:crypto";

const proxyUrl = process.env.PROXY_URL ?? "http://127.0.0.1:8096";
const coreUrl = process.env.CORE_URL ?? "http://127.0.0.1:8420";
const mockUrl = process.env.MOCK_URL ?? "http://127.0.0.1:8080";
const clientKey = "e2e-client-key";
const userId = createHash("sha256").update(clientKey).digest("hex").slice(0, 8);
const sessionId = "e2e-session";
const spaceId = "e2e-space";
const teamId = "e2e-team";
const agentId = "e2e-agent";
const taskId = "e2e-task";
const responsesPath = "/codex/e2e-space/v1/responses";

function responsesPathFor(requestSpaceId) {
  return `/codex/${requestSpaceId}/v1/responses`;
}

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

function proxyHeaders({ withSession = true, session = sessionId } = {}) {
  return {
    "content-type": "application/json",
    authorization: `Bearer ${clientKey}`,
    ...(withSession ? { "x-conversation-id": session } : {}),
  };
}

function coreHeaders({ requestSpaceId = spaceId, session = sessionId } = {}) {
  return {
    "content-type": "application/json",
    authorization: "Bearer local",
    "x-tdai-service-id": requestSpaceId,
    "x-tdai-team-id": teamId,
    "x-tdai-user-id": userId,
    "x-tdai-agent-id": agentId,
    "x-tdai-task-id": taskId,
    "x-tdai-session-id": session,
  };
}

async function postProxy(path, body, options = {}) {
  const { withSession = true, session = sessionId } = options;
  return call(`${proxyUrl}${path}`, {
    method: "POST",
    headers: proxyHeaders({ withSession, session }),
    body: JSON.stringify(body),
  });
}

async function queryCore(options = {}) {
  const { requestSpaceId = spaceId, session = sessionId } = options;
  const result = await call(`${coreUrl}/v3/conversation/query`, {
    method: "POST",
    headers: coreHeaders({ requestSpaceId, session }),
    body: JSON.stringify({
      team_id: teamId,
      user_id: userId,
      agent_id: agentId,
      task_id: taskId,
      session_id: session,
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

function countOccurrences(value, marker) {
  return (value.match(new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) ?? []).length;
}

function instructionText(instructions) {
  if (typeof instructions === "string") return instructions;
  if (!Array.isArray(instructions)) return "";
  return instructions.map((item) => {
    if (!item || typeof item !== "object") return "";
    const record = item;
    if (typeof record.text === "string") return record.text;
    if (Array.isArray(record.content)) {
      return record.content.map((part) => typeof part?.text === "string" ? part.text : "").join("\n");
    }
    return "";
  }).join("\n");
}

function assertMemoryForwarding(record, original, expectedSession, shape, label) {
  assert(record, `mock did not receive ${label} memory request`);
  const forwarded = record.body;
  const expectedKeys = [...new Set([...Object.keys(original), "instructions"])].sort();
  assert(JSON.stringify(Object.keys(forwarded).sort()) === JSON.stringify(expectedKeys), `${label} changed unrelated provider fields`);
  assert(forwarded.model === original.model, `${label} model changed`);
  assert(JSON.stringify(forwarded.input) === JSON.stringify(original.input), `${label} input changed`);
  assert(JSON.stringify(forwarded.tools) === JSON.stringify(original.tools), `${label} tools changed`);
  assert(forwarded.previous_response_id === original.previous_response_id, `${label} previous_response_id changed`);
  assert(JSON.stringify(forwarded.unknown_provider_field) === JSON.stringify(original.unknown_provider_field), `${label} unknown field changed`);
  assert(record.headers.authorization === "Bearer mock-upstream-key", `${label} provider credential missing or client credential leaked`);
  assert(!record.headers["x-tdai-user-key"], `${label} memory credential leaked to provider`);

  if (shape === "no-instructions") {
    assert(typeof forwarded.instructions === "string", `${label} instructions did not become a string`);
  } else if (shape === "string") {
    assert(typeof forwarded.instructions === "string", `${label} instructions changed type`);
    assert(countOccurrences(forwarded.instructions, original.instructions) === 1, `${label} client instruction duplicated`);
  } else {
    assert(Array.isArray(forwarded.instructions), `${label} instructions changed type`);
    assert(forwarded.instructions.length === original.instructions.length, `${label} instructions array length changed`);
    assert(forwarded.instructions[0]?.type === original.instructions[0]?.type, `${label} first item type changed`);
    assert(forwarded.instructions[1]?.type === original.instructions[1]?.type, `${label} opaque item type changed`);
    assert(JSON.stringify(forwarded.instructions[1]) === JSON.stringify(original.instructions[1]), `${label} opaque item changed`);
  }

  const text = instructionText(forwarded.instructions);
  if (shape === "array") {
    assert(countOccurrences(text, original.instructions[0].text) === 1, `${label} original text was not preserved once`);
  }
  assert(countOccurrences(text, "<tdai_memory_tools>") === 1, `${label} memory block count was not one`);
  assert(countOccurrences(text, "</tdai_memory_tools>") === 1, `${label} memory block was incomplete`);
  assert(text.includes(`x-conversation-id: ${expectedSession}`), `${label} session marker missing`);
  return text;
}

function parseSseEvents(text) {
  return text.split(/\r?\n\r?\n/).flatMap((frame) => {
    const data = frame.split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
      .trim();
    if (!data || data === "[DONE]") return [];
    try {
      return [JSON.parse(data)];
    } catch (error) {
      throw new Error(`invalid E2E SSE data frame: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}

async function assertNoMatchingL0(name, query, predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const messages = await query();
    assert(!messages.some(predicate), `${name} wrote an intermediate L0 message`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function assertStableMatchingL0(name, query, predicate, expected, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const count = (await query()).filter(predicate).length;
    assert(count === expected, `${name} changed L0 count from ${expected} to ${count}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
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

  const memoryNoInstructionsBody = {
    model: "e2e-model-alias",
    input: "memory injection no instructions",
    tools: [{ type: "function", name: "client_tool" }],
    previous_response_id: "client-previous-no-instructions",
    unknown_provider_field: {
      case: "no-instructions",
      nested: { keep: true },
    },
    e2e_case: "memory-no-instructions",
    e2e_response_id: "resp_memory_no_instructions",
  };
  const memoryNoInstructions = await postProxy(
    responsesPathFor("e2e-space-a"),
    memoryNoInstructionsBody,
    { session: "e2e-session-a" },
  );
  assert(memoryNoInstructions.status === 200 && memoryNoInstructions.body?.status === "completed", "no-instructions memory Responses failed");

  const memoryStringBody = {
    model: "e2e-model-alias",
    input: "memory injection string instructions",
    instructions: "client string instruction",
    tools: [{ type: "function", name: "client_tool" }],
    previous_response_id: "client-previous-string",
    unknown_provider_field: { case: "string", nested: { keep: true } },
    e2e_case: "memory-string-instructions",
    e2e_response_id: "resp_memory_string_instructions",
  };
  const memoryString = await postProxy(
    responsesPathFor("e2e-space-a"),
    memoryStringBody,
    { session: "e2e-session-a" },
  );
  assert(memoryString.status === 200 && memoryString.body?.status === "completed", "string-instructions memory Responses failed");

  const memoryArrayBody = {
    model: "e2e-model-alias",
    input: "memory injection array instructions",
    instructions: [
      { type: "input_text", text: "client array instruction" },
      { type: "future_item", payload: { keep: true } },
    ],
    tools: [{ type: "function", name: "client_tool" }],
    previous_response_id: "client-previous-array",
    unknown_provider_field: { case: "array", nested: { keep: true } },
    e2e_case: "memory-array-instructions",
    e2e_response_id: "resp_memory_array_instructions",
  };
  const memoryArray = await postProxy(
    responsesPathFor("e2e-space-b"),
    memoryArrayBody,
    { session: "e2e-session-b" },
  );
  assert(memoryArray.status === 200 && memoryArray.body?.status === "completed", "array-instructions memory Responses failed");

  const memoryRecords = await mockRequests();
  const noInstructionsRecord = memoryRecords.find((entry) => entry.body?.e2e_case === memoryNoInstructionsBody.e2e_case);
  const stringInstructionsRecord = memoryRecords.find((entry) => entry.body?.e2e_case === memoryStringBody.e2e_case);
  const arrayInstructionsRecord = memoryRecords.find((entry) => entry.body?.e2e_case === memoryArrayBody.e2e_case);
  const noInstructionsText = assertMemoryForwarding(
    noInstructionsRecord,
    memoryNoInstructionsBody,
    "e2e-session-a",
    "no-instructions",
    "no-instructions",
  );
  const stringInstructionsText = assertMemoryForwarding(
    stringInstructionsRecord,
    memoryStringBody,
    "e2e-session-a",
    "string",
    "string-instructions",
  );
  const arrayInstructionsText = assertMemoryForwarding(
    arrayInstructionsRecord,
    memoryArrayBody,
    "e2e-session-b",
    "array",
    "array-instructions",
  );
  assert(noInstructionsText.includes("e2e-session-a") && !noInstructionsText.includes("e2e-session-b"), "memory injection session A leaked session B state");
  assert(stringInstructionsText.includes("e2e-session-a") && !stringInstructionsText.includes("e2e-session-b"), "string memory injection session A leaked session B state");
  assert(arrayInstructionsText.includes("e2e-session-b") && !arrayInstructionsText.includes("e2e-session-a"), "array memory injection session B leaked session A state");

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
  const providerRecord = firstRecords.find((entry) => entry.path === "/v1/responses" && entry.body?.e2e_case === "json");
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
  }, { withSession: false });
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
  const functionFinal = await postProxy(responsesPath, functionFinalBody, { withSession: false });
  assert(functionFinal.status === 200 && functionFinal.body.status === "completed", "function_call final response failed");
  await waitFor("function-call L0 write", async () => (await queryCore()).some((message) => message.content === "tool question"));
  const afterToolFinal = (await queryCore()).length;
  assert(afterToolFinal >= beforeToolFinal + 2, "function-call final did not write one user/assistant pair");

  const replay = await postProxy(responsesPath, functionFinalBody, { withSession: false });
  assert(replay.status === 200 && replay.body.id === "resp_function_final_fixed", "function-call replay response failed");
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert((await queryCore()).length === afterToolFinal, "replaying a response id duplicated L0");

  const functionStream = await postProxy(responsesPath, {
    model: "e2e-model",
    input: "stream tool question",
    stream: true,
    e2e_case: "function_sse",
  });
  assert(functionStream.status === 200, `SSE function_call returned ${functionStream.status}`);
  assert(functionStream.response.headers.get("content-type")?.toLowerCase().includes("text/event-stream"), "SSE function_call content-type was not event-stream");
  assert(functionStream.text.includes("data: [DONE]"), "SSE function_call did not close with [DONE]");
  const functionEvents = parseSseEvents(functionStream.text);
  const requiredFunctionEvents = [
    "response.output_item.added",
    "response.function_call_arguments.delta",
    "response.function_call_arguments.done",
    "response.completed",
  ];
  for (const type of requiredFunctionEvents) {
    assert(functionEvents.some((event) => event.type === type), `SSE function_call missing ${type}`);
  }
  const completedEvent = functionEvents.find((event) => event.type === "response.completed");
  const functionSseResponseId = completedEvent?.response?.id;
  assert(typeof functionSseResponseId === "string" && functionSseResponseId.length > 0, "SSE function_call did not expose a response id");
  assert(completedEvent.response.status === "completed", "SSE function_call response was not completed");
  const addedCall = functionEvents.find((event) => event.type === "response.output_item.added")?.item;
  const functionCallId = addedCall?.call_id ?? completedEvent.response.output?.find((item) => item?.type === "function_call")?.call_id;
  assert(functionCallId === "call_1", `SSE function_call returned unexpected call_id ${functionCallId ?? "missing"}`);
  const argumentsEvent = functionEvents.find((event) => event.type === "response.function_call_arguments.done");
  const functionArguments = argumentsEvent?.arguments
    ?? functionEvents.filter((event) => event.type === "response.function_call_arguments.delta").map((event) => event.delta ?? "").join("");
  assert(typeof functionArguments === "string" && functionArguments.length > 0, "SSE function_call arguments were empty");
  try {
    JSON.parse(functionArguments);
  } catch {
    throw new Error("SSE function_call arguments were not valid JSON");
  }
  await assertNoMatchingL0(
    "SSE function-call intermediate round",
    queryCore,
    (message) => message.content === "stream tool question" || message.content === "sse tool result accepted",
  );

  const functionStreamFinalBody = {
    model: "e2e-model",
    previous_response_id: functionSseResponseId,
    input: [{ type: "function_call_output", call_id: functionCallId, output: "ok" }],
    e2e_response_id: "resp_function_sse_final_fixed",
    e2e_case: "function_sse_final",
  };
  const functionStreamFinal = await postProxy(responsesPath, functionStreamFinalBody, { withSession: false });
  assert(functionStreamFinal.status === 200, `SSE function continuation returned ${functionStreamFinal.status}`);
  assert(functionStreamFinal.body?.status === "completed", "SSE function continuation was not completed");
  assert(functionStreamFinal.body?.id === "resp_function_sse_final_fixed", "SSE function continuation response id changed");
  assert(functionStreamFinal.body?.output?.some((item) => item?.type === "message"), "SSE function continuation omitted assistant output");
  assert(functionStreamFinal.body?.output_text === "sse tool result accepted", "SSE function continuation assistant output changed");
  await waitFor("SSE function-call final L0 write", async () => {
    const messages = await queryCore();
    const matched = messages.filter((message) => message.content === "stream tool question" || message.content === "sse tool result accepted" || message.content === "ok");
    return matched.length === 2 ? messages : false;
  });
  const afterFunctionStreamMessages = await queryCore();
  const functionStreamL0 = afterFunctionStreamMessages.filter((message) => message.content === "stream tool question" || message.content === "sse tool result accepted" || message.content === "ok");
  assert(functionStreamL0.filter((message) => message.content === "stream tool question").length === 1, "SSE function continuation wrote duplicate user L0");
  assert(functionStreamL0.filter((message) => message.content === "sse tool result accepted").length === 1, "SSE function continuation wrote duplicate assistant L0");
  assert(!functionStreamL0.some((message) => message.content === "ok"), "SSE function_call_output was written as an L0 user message");

  const functionStreamReplay = await postProxy(responsesPath, functionStreamFinalBody, { withSession: false });
  assert(functionStreamReplay.status === 200, `SSE function replay returned ${functionStreamReplay.status}`);
  assert(functionStreamReplay.body?.id === "resp_function_sse_final_fixed", "SSE function replay response id changed");
  await assertStableMatchingL0(
    "SSE function replay",
    queryCore,
    (message) => message.content === "stream tool question" || message.content === "sse tool result accepted" || message.content === "ok",
    2,
  );

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
