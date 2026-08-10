/**
 * Native Responses selection forms for the two clients that expose their own
 * user-input tool.  The form is deliberately built from the already fetched
 * TeamOption list; no capability probing or client-specific discovery is
 * performed.
 */

import type { TeamOption } from "./types.js";

export type NativeResponsesClient = "codex" | "opencode";

export interface NativePromptState {
  responseId: string;
  itemId: string;
  callId: string;
  toolName: "request_user_input" | "question";
  arguments: string;
  /** The original Responses input, replayed when the synthetic form is answered. */
  initialInput?: unknown;
}

export interface NativeFormResponse {
  response: Response;
  responseId: string;
  prompt: Omit<NativePromptState, "initialInput">;
}

export interface NativeSelectionFormOptions {
  client: NativeResponsesClient;
  modelId: string;
  team: TeamOption;
  stream: boolean;
}

interface NativeOption {
  label: string;
  description: string;
}

function ids(prefix: string): { responseId: string; itemId: string; callId: string } {
  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  return {
    responseId: `resp_memory_init_${suffix}`,
    itemId: `fc_memory_init_${suffix}`,
    callId: `call_memory_init_${suffix}`,
  };
}

function optionsFor(team: TeamOption): NativeOption[] {
  return team.agents.map((agent) => ({
    label: `${agent.agent_name} (${agent.agent_id.slice(-8)})`,
    description: agent.description ?? "",
  }));
}

function buildArguments(client: NativeResponsesClient, team: TeamOption): {
  toolName: "request_user_input" | "question";
  value: Record<string, unknown>;
} {
  const options = optionsFor(team);
  const question = `请选择「${team.team_name}」下要绑定的记忆 Agent：`;
  if (client === "codex") {
    return {
      toolName: "request_user_input",
      value: {
        questions: [{
          id: "agent",
          header: "记忆 Agent",
          question,
          isOther: false,
          isSecret: false,
          options,
        }],
        isBlocking: true,
      },
    };
  }
  return {
    toolName: "question",
    value: {
      questions: [{
        question,
        header: "记忆 Agent",
        options,
        multiple: false,
      }],
    },
  };
}

function responseObject(
  responseId: string,
  itemId: string,
  callId: string,
  modelId: string,
  toolName: string,
  args: string,
  status: "in_progress" | "completed" = "completed",
): Record<string, unknown> {
  return {
    id: responseId,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    model: modelId,
    status,
    output: [{
      id: itemId,
      type: "function_call",
      status: status === "completed" ? "completed" : "in_progress",
      call_id: callId,
      name: toolName,
      arguments: args,
    }],
    output_text: "",
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
  };
}

function sseFrame(type: string, value: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`;
}

function buildStream(
  responseId: string,
  itemId: string,
  callId: string,
  modelId: string,
  toolName: string,
  args: string,
): ReadableStream<Uint8Array> {
  const finalResponse = responseObject(responseId, itemId, callId, modelId, toolName, args);
  const inProgress = responseObject(responseId, itemId, callId, modelId, toolName, args, "in_progress");
  const output = Array.isArray(finalResponse.output) ? finalResponse.output : [];
  const item = (output[0] ?? {}) as Record<string, unknown>;
  const frames = [
    sseFrame("response.created", { response: inProgress }),
    sseFrame("response.output_item.added", {
      output_index: 0,
      item: { ...item, status: "in_progress", arguments: "" },
    }),
    sseFrame("response.function_call_arguments.delta", {
      item_id: itemId,
      output_index: 0,
      call_id: callId,
      name: toolName,
      delta: args,
    }),
    sseFrame("response.function_call_arguments.done", {
      item_id: itemId,
      output_index: 0,
      call_id: callId,
      name: toolName,
      arguments: args,
    }),
    sseFrame("response.output_item.done", { output_index: 0, item }),
    sseFrame("response.completed", { response: finalResponse }),
    "data: [DONE]\n\n",
  ];
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
}

/** Build a synthetic Responses tool call which native clients render as a form. */
export function buildNativeSelectionResponse(options: NativeSelectionFormOptions): NativeFormResponse {
  const { responseId, itemId, callId } = ids("memory_init");
  const built = buildArguments(options.client, options.team);
  const args = JSON.stringify(built.value);
  const prompt = { responseId, itemId, callId, toolName: built.toolName, arguments: args } as const;
  if (options.stream) {
    return {
      response: new Response(
        buildStream(responseId, itemId, callId, options.modelId, built.toolName, args),
        { status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } },
      ),
      responseId,
      prompt,
    };
  }
  return {
    response: new Response(
      JSON.stringify(responseObject(responseId, itemId, callId, options.modelId, built.toolName, args)),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
    responseId,
    prompt,
  };
}

/**
 * Convert a synthetic prompt continuation back into a valid upstream
 * Responses input.  The upstream never saw the synthetic response id, so the
 * original input and the synthetic function call must be replayed explicitly.
 */
export function mergeNativePromptContinuation(
  prompt: NativePromptState,
  currentInput: unknown,
): unknown[] {
  const initial = Array.isArray(prompt.initialInput)
    ? prompt.initialInput
    : prompt.initialInput === undefined || prompt.initialInput === null
      ? []
      : [{ type: "message", role: "user", content: prompt.initialInput }];
  const current = Array.isArray(currentInput)
    ? currentInput
    : currentInput === undefined || currentInput === null
      ? []
      : [{ type: "message", role: "user", content: currentInput }];
  const hasCall = current.some((item) => (
    item && typeof item === "object" &&
    (item as Record<string, unknown>).type === "function_call" &&
    ((item as Record<string, unknown>).call_id === prompt.callId ||
      (item as Record<string, unknown>).id === prompt.itemId)
  ));
  if (hasCall) return [...current];
  return [
    ...initial,
    {
      type: "function_call",
      id: prompt.itemId,
      call_id: prompt.callId,
      name: prompt.toolName,
      arguments: prompt.arguments,
    },
    ...current,
  ];
}
