import {
  extractResponsesFunctionCalls,
  extractResponsesOutputText,
  extractResponsesRefusalText,
  extractResponsesUsage,
} from "./json-parser.js";
import { SseFrameParser } from "./sse-parser.js";
import type {
  JsonObject,
  ParsedResponsesEvent,
  ParsedResponsesStream,
  ResponsesFunctionCall,
  SseFrame,
} from "./types.js";

function asObject(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function eventType(frame: SseFrame, json: JsonObject | null): string {
  return typeof json?.type === "string" ? json.type : frame.event;
}

function responseFromEvent(json: JsonObject | null): JsonObject | null {
  return asObject(json?.response);
}

function mergeCalls(existing: ResponsesFunctionCall[], next: ResponsesFunctionCall[]): ResponsesFunctionCall[] {
  const result = [...existing];
  for (const call of next) {
    const keys = [call.call_id, call.id].filter((value): value is string => !!value);
    const index = keys.length > 0
      ? result.findIndex((item) => keys.some((key) => item.call_id === key || item.id === key))
      : -1;
    if (index < 0) result.push(call);
    else result[index] = { ...result[index], ...call };
  }
  return result;
}

/** Incrementally parses Responses SSE while passing the original bytes elsewhere. */
export class ResponsesSseResponseParser {
  private readonly frames = new SseFrameParser();
  private readonly events: ParsedResponsesEvent[] = [];
  private response: JsonObject | null = null;
  private status: string | undefined;
  private outputText = "";
  private refusalText = "";
  private usage: JsonObject | null = null;
  private functionCalls: ResponsesFunctionCall[] = [];
  private malformedEvents = 0;
  private done = false;
  private finished = false;

  push(input: string | Uint8Array): ParsedResponsesEvent[] {
    if (this.finished) return [];
    const parsed = this.frames.push(input);
    return this.consume(parsed);
  }

  finish(): ParsedResponsesStream {
    if (!this.finished) {
      this.consume(this.frames.finish());
      this.finished = true;
    }
    if (!this.outputText && this.response) {
      this.outputText = extractResponsesOutputText(this.response);
    }
    if (this.response) {
      this.functionCalls = mergeCalls(this.functionCalls, extractResponsesFunctionCalls(this.response));
      if (!this.refusalText) this.refusalText = extractResponsesRefusalText(this.response);
    }
    return this.result();
  }

  result(): ParsedResponsesStream {
    return {
      events: [...this.events],
      response: this.response,
      ...(this.status ? { status: this.status } : {}),
      outputText: this.outputText,
      refusalText: this.refusalText,
      usage: this.usage,
      functionCalls: [...this.functionCalls],
      done: this.done,
      malformedEvents: this.malformedEvents,
    };
  }

  private consume(frames: SseFrame[]): ParsedResponsesEvent[] {
    const emitted: ParsedResponsesEvent[] = [];
    for (const frame of frames) {
      const done = frame.data.trim() === "[DONE]";
      let json: JsonObject | null = null;
      if (!done) {
        try {
          json = asObject(JSON.parse(frame.data));
        } catch {
          this.malformedEvents++;
        }
      }

      const type = done ? "done" : eventType(frame, json);
      const parsedEvent: ParsedResponsesEvent = {
        event: frame.event,
        type,
        data: frame.data,
        json,
        done,
        frame,
      };
      emitted.push(parsedEvent);
      this.events.push(parsedEvent);
      if (done) {
        this.done = true;
        continue;
      }
      this.consumeJson(type, json);
    }
    return emitted;
  }

  private consumeJson(type: string, json: JsonObject | null): void {
    if (!json) return;
    if (type === "response.completed") this.status = "completed";
    if (type === "response.incomplete") this.status = "incomplete";
    if (type === "response.failed" || type === "error") {
      this.status = "failed";
      this.done = true;
    }
    const response = responseFromEvent(json);
    if (response) {
      this.response = response;
      if (typeof response.status === "string") this.status = response.status;
    }
    if (typeof json.status === "string") this.status = json.status;

    const usage = extractResponsesUsage(json);
    if (usage) this.usage = usage;

    if (type === "response.output_text.delta" && typeof json.delta === "string") {
      this.outputText += json.delta;
    } else if (type === "response.output_text.done" && !this.outputText && typeof json.text === "string") {
      this.outputText = json.text;
    }

    if (type === "response.refusal.delta" && typeof json.delta === "string") {
      this.refusalText += json.delta;
    } else if (type === "response.refusal.done" && !this.refusalText && typeof json.refusal === "string") {
      this.refusalText = json.refusal;
    }

    if (type === "response.function_call_arguments.delta" || type === "response.function_call_arguments.done") {
      const itemId = typeof json.item_id === "string" ? json.item_id : undefined;
      const callId = typeof json.call_id === "string" ? json.call_id : undefined;
      const keys = [callId, itemId].filter((value): value is string => !!value);
      const currentIndex = keys.length > 0
        ? this.functionCalls.findIndex((call) => keys.some((key) => call.call_id === key || call.id === key))
        : -1;
      const current = currentIndex >= 0 ? this.functionCalls[currentIndex] : undefined;
      const delta = typeof json.delta === "string" ? json.delta : undefined;
      const completedArguments = typeof json.arguments === "string" ? json.arguments : undefined;
      const nextArguments = type.endsWith(".delta")
        ? `${current?.arguments ?? ""}${delta ?? ""}`
        : completedArguments ?? current?.arguments;
      const nextCall: ResponsesFunctionCall = {
        ...(itemId ? { id: itemId } : {}),
        ...(callId ? { call_id: callId } : {}),
        ...(typeof json.name === "string" ? { name: json.name } : {}),
        ...(nextArguments !== undefined ? { arguments: nextArguments } : {}),
      };
      this.functionCalls = mergeCalls(this.functionCalls, [nextCall]);
    }

    const item = asObject(json.item) ?? asObject(json.output_item);
    if (item?.type === "function_call") {
      this.functionCalls = mergeCalls(this.functionCalls, extractResponsesFunctionCalls({ output: [item] }));
    }

    if (type === "response.completed" || type === "response.incomplete" || type === "response.failed") {
      this.done = true;
    }
  }
}

export function parseResponsesSse(
  input: string | Uint8Array | readonly (string | Uint8Array)[],
): ParsedResponsesStream {
  const parser = new ResponsesSseResponseParser();
  if (Array.isArray(input)) {
    for (const chunk of input) parser.push(chunk);
  } else {
    parser.push(input as string | Uint8Array);
  }
  return parser.finish();
}

export const parseResponsesStream = parseResponsesSse;
export const ResponsesResponseParser = ResponsesSseResponseParser;
