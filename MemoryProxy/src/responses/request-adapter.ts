import type { JsonObject, ResponsesRequest, ResponsesRequestAdapter } from "./types.js";

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function decodeBody(value: string | ArrayBuffer | Uint8Array): string {
  if (typeof value === "string") return value;
  return new TextDecoder().decode(value);
}

/** Parse JSON only for metadata; callers can still forward the original bytes. */
export function parseResponsesRequest(
  value: unknown,
): ResponsesRequest | null {
  let parsed = value;
  if (typeof value === "string" || value instanceof ArrayBuffer || value instanceof Uint8Array) {
    try {
      parsed = JSON.parse(decodeBody(value as string | ArrayBuffer | Uint8Array));
    } catch {
      return null;
    }
  }
  return isObject(parsed) ? parsed as ResponsesRequest : null;
}

function contentToChatShape(content: unknown): unknown {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content;
  return content.map((part) => {
    if (!isObject(part)) return part;
    if (part.type === "input_text" && typeof part.text === "string") {
      return { ...part, type: "text" };
    }
    return part;
  });
}

/**
 * Convert Responses input to a small Chat-shaped view for existing turn logic.
 * This view is never serialized back to the upstream request.
 */
export function responsesInputToMessages(
  input: unknown,
  instructions?: unknown,
): JsonObject[] {
  const messages: JsonObject[] = [];
  if (typeof instructions === "string") {
    messages.push({ role: "system", content: instructions });
  } else if (Array.isArray(instructions)) {
    messages.push({ role: "system", content: contentToChatShape(instructions) });
  }

  if (typeof input === "string") {
    messages.push({ role: "user", content: input });
    return messages;
  }
  if (!Array.isArray(input)) return messages;

  for (const item of input) {
    if (!isObject(item)) continue;
    if (item.type === "function_call_output") {
      messages.push({
        role: "tool",
        tool_call_id: item.call_id,
        content: typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? null),
      });
      continue;
    }
    if (item.type === "function_call") {
      messages.push({
        role: "assistant",
        content: null,
        tool_calls: [{
          id: item.call_id ?? item.id,
          type: "function",
          function: { name: item.name, arguments: item.arguments ?? "" },
        }],
      });
      continue;
    }

    const role = typeof item.role === "string" ? item.role : "user";
    const content = item.content ?? item.text ?? item.input;
    messages.push({ role, content: contentToChatShape(content) });
  }
  return messages;
}

export function adaptResponsesRequest(value: unknown): ResponsesRequestAdapter {
  const request = parseResponsesRequest(value);
  const model = typeof request?.model === "string" && request.model
    ? request.model
    : "unknown";
  return {
    request,
    model,
    input: request?.input,
    instructions: request?.instructions,
    stream: request?.stream === true,
    ...(typeof request?.previous_response_id === "string"
      ? { previousResponseId: request.previous_response_id }
      : {}),
    hasTools: Array.isArray(request?.tools) && request.tools.length > 0,
    messages: responsesInputToMessages(request?.input, request?.instructions),
  };
}

/** Compatibility alias for callers that use an explicit "request" verb. */
export const adaptResponsesRequestBody = adaptResponsesRequest;
