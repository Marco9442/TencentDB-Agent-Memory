/** Loose wire types used by the OpenAI Responses transport. */

export type JsonObject = Record<string, unknown>;

/** The request is intentionally open-ended: Responses adds fields often. */
export interface ResponsesRequest extends JsonObject {
  model?: string;
  input?: unknown;
  instructions?: unknown;
  stream?: boolean;
  previous_response_id?: string;
  tools?: unknown[];
}

/** Metadata extracted without changing the request bytes sent upstream. */
export interface ResponsesRequestAdapter {
  request: ResponsesRequest | null;
  model: string;
  input: unknown;
  instructions: unknown;
  stream: boolean;
  previousResponseId?: string;
  hasTools: boolean;
  /** Best-effort Chat-shaped history for turn/observability consumers. */
  messages: JsonObject[];
}

export type ResponsesEndpoint =
  | "responses"
  | "responses/compact"
  | "models"
  | "alpha/search";

export interface ResponsesRoute {
  endpoint: ResponsesEndpoint;
  /** Canonical upstream suffix without the optional `/v1` prefix. */
  endpointPath: `/${ResponsesEndpoint}`;
  agentName?: string;
  prefix: "root" | "agent-space" | "proxy-space";
}

export interface ResponsesFunctionCall {
  id?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
}

export interface ParsedResponsesJson {
  ok: boolean;
  value: JsonObject | null;
  response: JsonObject | null;
  status?: string;
  outputText: string;
  refusalText: string;
  usage: JsonObject | null;
  outputItems: JsonObject[];
  functionCalls: ResponsesFunctionCall[];
  assistantMessage: JsonObject | null;
}

export interface SseFrame {
  event: string;
  data: string;
  id?: string;
  retry?: number;
  /** Frame text reconstructed from parsed SSE lines for diagnostics. */
  raw: string;
}

export interface ParsedResponsesEvent {
  event: string;
  type: string;
  data: string;
  json: JsonObject | null;
  done: boolean;
  frame: SseFrame;
}

export interface ParsedResponsesStream {
  events: ParsedResponsesEvent[];
  response: JsonObject | null;
  status?: string;
  outputText: string;
  refusalText: string;
  usage: JsonObject | null;
  functionCalls: ResponsesFunctionCall[];
  done: boolean;
  malformedEvents: number;
}
