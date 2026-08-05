/**
 * Codex Responses instruction injection.
 *
 * Responses has a top-level `instructions` string instead of Chat
 * Completions' `messages[role=system]`. The helpers below operate on opaque
 * records, preserve unrelated fields, and only touch text-shaped values.
 */

import type { AgentDetail, TaskDetail } from "../../../session/types.js";
import {
  buildSessionContextBlockWithToggles,
} from "../../../session/context-injector.js";
import type { SessionInitConfig } from "../../../types.js";

export type CodexInstructionRole = "developer" | "system";

export interface CodexInstructionInjectionOptions {
  /** Default is the Responses top-level instructions field. */
  target?: "instructions" | CodexInstructionRole;
  /** When targeting a role, append to input items with that role. */
  input?: unknown;
}

export interface CodexInstructionInjectionResult {
  body: Record<string, unknown>;
  applied: boolean;
  target: "instructions" | CodexInstructionRole | "none";
}

function appendText(existing: string, addition: string): string {
  if (!existing) return addition;
  return `${existing}\n\n${addition}`;
}

function appendToContent(content: unknown, addition: string): unknown {
  if (typeof content === "string") return appendText(content, addition);
  if (!Array.isArray(content)) return undefined;

  return appendToTextPartArray(content, addition);
}

function appendToTextPartArray(content: unknown[], addition: string): unknown[] | undefined {
  const parts = [...content];
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i];
    if (!part || typeof part !== "object" || Array.isArray(part)) continue;
    const record = part as Record<string, unknown>;
    if (
      (record.type === "input_text" || record.type === "text")
      && typeof record.text === "string"
    ) {
      parts[i] = { ...record, text: appendText(record.text, addition) };
      return parts;
    }
  }
  return undefined;
}

function appendToInstructionsArray(instructions: unknown[], addition: string): unknown[] {
  const next = [...instructions];

  // Prefer the last system/developer message's text, then a top-level text
  // part. Every untouched item remains the original opaque value.
  for (let i = instructions.length - 1; i >= 0; i--) {
    const rawItem = instructions[i];
    if (!rawItem || typeof rawItem !== "object" || Array.isArray(rawItem)) continue;
    const item = rawItem as Record<string, unknown>;
    if (item.role === "system" || item.role === "developer") {
      const content = appendToContent(item.content, addition);
      if (content !== undefined) {
        next[i] = { ...item, content };
        return next;
      }
    }
  }

  for (let i = instructions.length - 1; i >= 0; i--) {
    const rawItem = instructions[i];
    if (!rawItem || typeof rawItem !== "object" || Array.isArray(rawItem)) continue;
    const item = rawItem as Record<string, unknown>;
    if (
      (item.type === "input_text" || item.type === "text")
      && typeof item.text === "string"
    ) {
      next[i] = { ...item, text: appendText(item.text, addition) };
      return next;
    }
  }

  // The array may contain only opaque/unknown items. Preserve them and add
  // the smallest Responses-compatible developer message.
  next.push({
    type: "message",
    role: "developer",
    content: [{ type: "input_text", text: addition }],
  });
  return next;
}

function injectIntoInputRole(
  body: Record<string, unknown>,
  input: unknown,
  role: CodexInstructionRole,
  addition: string,
): CodexInstructionInjectionResult {
  if (!Array.isArray(input)) {
    return { body, applied: false, target: "none" };
  }

  let changed = false;
  const nextInput = input.map((rawItem) => {
    if (changed || !rawItem || typeof rawItem !== "object") return rawItem;
    const item = rawItem as Record<string, unknown>;
    if (item.role !== role) return rawItem;
    const nextContent = appendToContent(item.content, addition);
    if (nextContent === undefined) return rawItem;
    changed = true;
    return { ...item, content: nextContent };
  });

  return changed
    ? { body: { ...body, input: nextInput }, applied: true, target: role }
    : { body, applied: false, target: "none" };
}

/**
 * Inject a text block into a Responses request without importing an SDK.
 * Top-level `instructions` is the default and remains the preferred target.
 */
export function injectCodexInstructions(
  body: Record<string, unknown>,
  addition: string,
  options: CodexInstructionInjectionOptions = {},
): CodexInstructionInjectionResult {
  if (!addition) return { body, applied: false, target: "none" };

  const target = options.target ?? "instructions";
  if (target === "instructions") {
    const current = body.instructions;
    if (current === undefined || current === null) {
      return { body: { ...body, instructions: addition }, applied: true, target };
    }
    if (typeof current === "string") {
      return {
        body: { ...body, instructions: appendText(current, addition) },
        applied: true,
        target,
      };
    }
    const nextInstructions = Array.isArray(current)
      ? appendToInstructionsArray(current, addition)
      : appendToContent(current, addition);
    if (nextInstructions === undefined) return { body, applied: false, target: "none" };
    return {
      body: { ...body, instructions: nextInstructions },
      applied: true,
      target,
    };
  }

  return injectIntoInputRole(body, options.input ?? body.input, target, addition);
}

export const injectResponsesInstructions = injectCodexInstructions;

export function injectCodexDeveloperInstructions(
  body: Record<string, unknown>,
  addition: string,
  input?: unknown,
): CodexInstructionInjectionResult {
  return injectCodexInstructions(body, addition, { target: "developer", input });
}

export function injectCodexSystemInstructions(
  body: Record<string, unknown>,
  addition: string,
  input?: unknown,
): CodexInstructionInjectionResult {
  return injectCodexInstructions(body, addition, { target: "system", input });
}

/** Inject the existing Agent/Task session block into Responses instructions. */
export function injectCodexSessionContext(
  body: Record<string, unknown>,
  agent: AgentDetail | null | undefined,
  task: TaskDetail | null | undefined,
  config: Pick<SessionInitConfig, "injectAgentContext" | "injectTaskContext"> | null | undefined,
  sessionKey: string,
  options?: CodexInstructionInjectionOptions,
): CodexInstructionInjectionResult {
  const block = buildSessionContextBlockWithToggles(agent, task, config, sessionKey);
  return block
    ? injectCodexInstructions(body, block, options)
    : { body, applied: false, target: "none" };
}

/** Compatibility spelling for callers that use "Responses" in the name. */
export const injectResponsesSessionContext = injectCodexSessionContext;
