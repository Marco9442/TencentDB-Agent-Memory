import type {
  JsonObject,
  ParsedResponsesJson,
  ResponsesFunctionCall,
} from "./types.js";

function asObject(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function outputTextFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((part) => {
    const object = asObject(part);
    if (!object) return [];
    if ((object.type === "output_text" || object.type === "text") && typeof object.text === "string") {
      return [object.text];
    }
    return [];
  }).join("");
}

function refusalTextFromContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content.flatMap((part) => {
    const object = asObject(part);
    if (!object || object.type !== "refusal" || typeof object.refusal !== "string") return [];
    return [object.refusal];
  }).join("");
}

export function extractResponsesOutputText(value: unknown): string {
  const object = asObject(value);
  if (!object) return "";
  const output = object.output;
  let text = "";
  if (Array.isArray(output)) {
    text = output.flatMap((item) => {
      const itemObject = asObject(item);
      if (!itemObject) return [];
      if (itemObject.type === "message") return [outputTextFromContent(itemObject.content)];
      if (itemObject.type === "output_text" && typeof itemObject.text === "string") return [itemObject.text];
      return [];
    }).join("");
  }
  if (text) return text;

  const outputText = object.output_text;
  if (typeof outputText === "string") return outputText;
  if (Array.isArray(outputText)) {
    return outputText.flatMap((part) => {
      if (typeof part === "string") return [part];
      const partObject = asObject(part);
      return partObject && typeof partObject.text === "string" ? [partObject.text] : [];
    }).join("");
  }
  return "";
}

export function extractResponsesRefusalText(value: unknown): string {
  const object = asObject(value);
  if (!object) return "";

  if (typeof object.refusal === "string") return object.refusal;
  const output = object.output;
  if (!Array.isArray(output)) return "";
  return output.flatMap((item) => {
    const itemObject = asObject(item);
    if (!itemObject) return [];
    if (itemObject.type === "message") return [refusalTextFromContent(itemObject.content)];
    if (itemObject.type === "refusal" && typeof itemObject.refusal === "string") {
      return [itemObject.refusal];
    }
    return [];
  }).join("");
}

export function extractResponsesFunctionCalls(value: unknown): ResponsesFunctionCall[] {
  const object = asObject(value);
  if (!object || !Array.isArray(object.output)) return [];
  return object.output.flatMap((item) => {
    const call = asObject(item);
    if (!call || call.type !== "function_call") return [];
    return [{
      ...(typeof call.id === "string" ? { id: call.id } : {}),
      ...(typeof call.call_id === "string" ? { call_id: call.call_id } : {}),
      ...(typeof call.name === "string" ? { name: call.name } : {}),
      ...(typeof call.arguments === "string" ? { arguments: call.arguments } : {}),
    }];
  });
}

function responseObject(value: JsonObject): JsonObject {
  return asObject(value.response) ?? value;
}

export function extractResponsesUsage(value: unknown): JsonObject | null {
  const object = asObject(value);
  if (!object) return null;
  const response = responseObject(object);
  return asObject(response.usage) ?? asObject(object.usage);
}

/** Parse a non-stream Responses body without throwing on upstream oddities. */
export function parseResponsesJsonResponse(value: string | unknown): ParsedResponsesJson {
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return {
        ok: false,
        value: null,
        response: null,
        outputText: "",
        refusalText: "",
        usage: null,
        outputItems: [],
        functionCalls: [],
        assistantMessage: null,
      };
    }
  }

  const object = asObject(parsed);
  if (!object) {
    return {
      ok: false,
      value: null,
    response: null,
    outputText: "",
    refusalText: "",
    usage: null,
      outputItems: [],
      functionCalls: [],
      assistantMessage: null,
    };
  }

  const response = responseObject(object);
  const outputItems = Array.isArray(response.output)
    ? response.output.flatMap((item) => {
      const itemObject = asObject(item);
      return itemObject ? [itemObject] : [];
    })
    : [];
  const functionCalls = extractResponsesFunctionCalls(response);
  const outputText = extractResponsesOutputText(response);
  const refusalText = extractResponsesRefusalText(response);
  const assistantMessage = outputText || refusalText || functionCalls.length > 0
    ? {
        role: "assistant",
        content: outputText || refusalText || null,
        ...(functionCalls.length > 0
          ? {
              tool_calls: functionCalls.map((call) => ({
                id: call.call_id ?? call.id,
                type: "function",
                function: { name: call.name, arguments: call.arguments ?? "" },
              })),
            }
          : {}),
      }
    : null;

  const status = typeof response.status === "string"
    ? response.status
    : typeof object.status === "string" ? object.status : undefined;
  return {
    ok: true,
    value: object,
    response,
    ...(status ? { status } : {}),
    outputText,
    refusalText,
    usage: extractResponsesUsage(object),
    outputItems,
    functionCalls,
    assistantMessage,
  };
}

export const parseResponsesResponseJson = parseResponsesJsonResponse;
export const extractOutputText = extractResponsesOutputText;
