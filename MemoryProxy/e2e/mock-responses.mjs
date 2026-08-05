import http from "node:http";

const port = Number(process.env.PORT ?? 8080);
const requests = [];
let responseNumber = 0;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function requestPath(req) {
  return new URL(req.url ?? "/", "http://mock.local").pathname;
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return { raw, value: null };
  try {
    return { raw, value: JSON.parse(raw) };
  } catch {
    return { raw, value: raw };
  }
}

function recordRequest(req, body) {
  const record = {
    method: req.method,
    path: requestPath(req),
    headers: Object.fromEntries(Object.entries(req.headers).map(([key, value]) => [key, String(value ?? "")])),
    body,
    clientClosed: false,
    responseClosed: false,
  };
  requests.push(record);
  req.on("aborted", () => { record.aborted = true; });
  return record;
}

function responseId(kind) {
  responseNumber += 1;
  return `resp_${kind}_${responseNumber}`;
}

function messageOutput(text) {
  return [{
    id: `msg_${responseNumber}`,
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", annotations: [], text }],
  }];
}

function responseBody(request, kind, status = "completed", text = "e2e response") {
  const id = request?.e2e_response_id ?? responseId(kind);
  return {
    id,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    model: request?.model ?? "e2e-model",
    status,
    output: status === "failed" ? [] : messageOutput(text),
    output_text: text,
    usage: status === "completed"
      ? { input_tokens: 7, output_tokens: 3, total_tokens: 10 }
      : undefined,
  };
}

function functionBody(request, kind) {
  const id = responseId(kind);
  return {
    id,
    object: "response",
    model: request?.model ?? "e2e-model",
    status: "completed",
    output: [{
      id: "item_call_1",
      type: "function_call",
      status: "completed",
      call_id: "call_1",
      name: "lookup",
      arguments: "{\"q\":\"x\"}",
    }],
    usage: { input_tokens: 8, output_tokens: 2, total_tokens: 10 },
  };
}

function sseFrame(event, value) {
  return `event: ${event}\r\ndata: ${JSON.stringify(value)}\r\n\r\n`;
}

async function sendSse(res, frames) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  for (const frame of frames) {
    if (res.destroyed) return;
    res.write(frame);
    await sleep(8);
  }
  if (!res.destroyed) res.end();
}

async function responseEndpoint(req, res, body, record) {
  const kind = body?.e2e_case ?? body?.metadata?.e2e_case ?? "json";
  if (kind === "cancel") {
    await sleep(10_000);
    if (!res.destroyed) json(res, 200, responseBody(body, kind));
    return;
  }

  if (kind === "http_error") {
    json(res, 500, { id: "resp_http_error", status: "completed", output: messageOutput("must not persist") });
    return;
  }

  if (kind === "function_call") {
    json(res, 200, functionBody(body, kind));
    return;
  }

  if (kind === "function_final" || kind === "function_sse_final") {
    json(res, 200, responseBody(
      body,
      kind,
      "completed",
      kind === "function_sse_final" ? "sse tool result accepted" : "tool result accepted",
    ));
    return;
  }

  if (kind === "function_sse") {
    const id = responseId(kind);
    await sendSse(res, [
      sseFrame("response.output_item.added", {
        type: "response.output_item.added",
        item: { type: "function_call", id: "item_call_1", call_id: "call_1", name: "lookup" },
      }),
      sseFrame("response.function_call_arguments.delta", {
        type: "response.function_call_arguments.delta",
        item_id: "item_call_1",
        delta: "{\"q\":\"x\"}",
      }),
      sseFrame("response.function_call_arguments.done", {
        type: "response.function_call_arguments.done",
        item_id: "item_call_1",
        arguments: "{\"q\":\"x\"}",
      }),
      sseFrame("response.completed", {
        type: "response.completed",
        response: { id, status: "completed", output: [{ type: "function_call", id: "item_call_1", call_id: "call_1", name: "lookup", arguments: "{\"q\":\"x\"}" }] },
      }),
      "data: [DONE]\r\n\r\n",
    ]);
    return;
  }

  if (kind === "sse") {
    const response = responseBody(body, kind, "completed", "streamed answer");
    await sendSse(res, [
      sseFrame("response.created", { type: "response.created", response: { id: response.id, status: "in_progress" } }),
      ": side-channel comment\r\n\r\n",
      sseFrame("response.output_text.delta", { type: "response.output_text.delta", response_id: response.id, delta: "streamed " }),
      sseFrame("response.output_text.delta", { type: "response.output_text.delta", response_id: response.id, delta: "answer" }),
      sseFrame("response.completed", { type: "response.completed", response }),
      "data: [DONE]\r\n\r\n",
    ]);
    return;
  }

  if (kind === "refusal") {
    const response = responseBody(body, kind, "completed", "");
    response.output = [{
      id: "msg_refusal",
      type: "message",
      role: "assistant",
      content: [{ type: "refusal", refusal: "e2e refusal" }],
    }];
    response.output_text = "";
    json(res, 200, response);
    return;
  }

  if (kind === "incomplete") {
    json(res, 200, responseBody(body, kind, "incomplete", "partial answer"));
    return;
  }

  json(res, 200, responseBody(body, kind));
  void record;
}

const server = http.createServer(async (req, res) => {
  const path = requestPath(req);
  if (req.method === "GET" && path === "/health") {
    json(res, 200, { status: "ok" });
    return;
  }
  if (req.method === "GET" && path === "/__test/requests") {
    json(res, 200, requests);
    return;
  }
  if (req.method === "DELETE" && path === "/__test/requests") {
    requests.length = 0;
    json(res, 200, { cleared: true });
    return;
  }

  const { value } = await readBody(req);
  const record = recordRequest(req, value);
  res.on("close", () => {
    record.responseClosed = true;
    if (!res.writableEnded) record.clientClosed = true;
  });

  if (req.method === "GET" && path === "/v1/models") {
    json(res, 200, { object: "list", data: [{ id: "e2e-model", object: "model", owned_by: "e2e" }] });
    return;
  }
  if (req.method === "POST" && path === "/v1/responses") {
    await responseEndpoint(req, res, value, record);
    return;
  }
  if (req.method === "POST" && (path === "/v1/responses/compact" || path === "/v1/alpha/search")) {
    json(res, 200, { object: path.endsWith("search") ? "search_result" : "response.compaction", data: [] });
    return;
  }
  if (req.method === "POST" && path === "/v1/chat/completions") {
    json(res, 200, {
      id: "chat_e2e",
      object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content: "chat compatibility" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    });
    return;
  }
  if (req.method === "POST" && path === "/v1/messages") {
    json(res, 200, {
      id: "msg_e2e",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "messages compatibility" }],
      model: value?.model ?? "e2e-model",
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 2 },
    });
    return;
  }

  json(res, 404, { error: "mock route not found" });
});

server.listen(port, "0.0.0.0", () => {
  console.log(`mock-responses listening on ${port}`);
});
