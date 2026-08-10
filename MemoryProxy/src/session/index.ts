/**
 * Session Initialization Module — Public API.
 *
 * 拆分后的架构：
 *   - codebuddy/    → CodeBuddy 专属 session-init（ask_followup_question form, XML extractor）
 *   - claude/       → Claude family 专属 session-init（AskUserQuestion form, JSON extractor, 分页）
 *   - 共享模块：store.ts, types.ts, context-injector.ts, registrar.ts
 *
 * 内核 API 调用统一走 src/meta/client.ts (MetadataClient)。
 */

// ── 共享模块 ──────────────────────────────────────────────────────────────────

export { SessionStore, getSessionStore } from "./store.js";
export type {
  SessionInitStatus,
  SessionInitState,
  SessionInitData,
  SessionRegistrationData,
  SessionInfo,
  AgentDetail,
  TaskDetail,
  TeamOption,
  AgentInTeam,
  TaskInTeam,
  TaskOption as TaskOpt,
  AgentOption as AgentOpt,
} from "./types.js";

export { buildSessionInfo } from "./registrar.js";
export { injectSessionContext, SESSION_CONTEXT_OPEN, SESSION_CONTEXT_CLOSE } from "./context-injector.js";
export { parsePresetIdentity, resolvePresetIdentity } from "./preset.js";
export type { PresetIdentity, PresetResolution } from "./preset.js";
export {
  buildNativeSelectionResponse,
  mergeNativePromptContinuation,
} from "./native-form.js";
export type {
  NativeResponsesClient,
  NativePromptState,
  NativeFormResponse,
  NativeSelectionFormOptions,
} from "./native-form.js";

// ── CodeBuddy 专属模块 ─────────────────────────────────────────────────────────

export {
  handleSessionInit as handleCodeBuddySessionInit,
  buildFormResponse as buildCodeBuddyFormResponse,
  containsFormTitle as containsCodeBuddyFormTitle,
  extractFromOptionText as extractCodeBuddyFromOptionText,
  extractStructured as extractCodeBuddyStructured,
  resolveAgent as resolveCodeBuddyAgent,
  resolveTask as resolveCodeBuddyTask,
  BYPASS_MARKER as CB_BYPASS_MARKER,
  getLastUserMessageText as getCodeBuddyLastUserMessage,
} from "./codebuddy/index.js";

// ── Claude family 专属模块 ─────────────────────────────────────────────────────

export {
  handleSessionInit as handleClaudeSessionInit,
  buildFormResponse as buildClaudeFormResponse,
  containsFormTitle as containsClaudeFormTitle,
  extractFromOptionText as extractClaudeFromOptionText,
  extractStructured as extractClaudeStructured,
  resolveAgent as resolveClaudeAgent,
  resolveTask as resolveClaudeTask,
  BYPASS_MARKER as CC_BYPASS_MARKER,
  MORE_MARKER,
  getLastUserMessageText as getClaudeLastUserMessage,
} from "./claude/index.js";

// ── Shared dispatcher ─────────────────────────────────────────────────────────

import type { SessionInitConfig } from "../types.js";
import { SessionStore } from "./store.js";
import {
  handleSessionInit as cbHandle,
  SessionRequestContext as CBSessionRequestContext,
  SessionInitResult as CBSessionInitResult,
} from "./codebuddy/init.js";
import {
  handleSessionInit as ccHandle,
  SessionRequestContext as ClaudeSessionRequestContext,
} from "./claude/init.js";

// Shared dispatcher types.
export type SessionRequestContext = CBSessionRequestContext & Partial<ClaudeSessionRequestContext>;
export type SessionInitResult = CBSessionInitResult;

/**
 * 根据 canonical agentSource 路由到对应的实现。
 */
import type { MetadataClient } from "../meta/client.js";
import type { PresetIdentity } from "./preset.js";

export async function handleSessionInit(
  sessionKey: string,
  userId: string | null,
  messages: Record<string, unknown>[],
  config: SessionInitConfig,
  store: SessionStore,
  reqCtx: SessionRequestContext,
  agentSource: string = "codebuddy",
  metadataClient?: MetadataClient,
  userKey?: string,
  spaceId?: string,
  presetIdentity?: PresetIdentity,
): Promise<SessionInitResult> {
  if (agentSource === "claude") {
    return ccHandle(
      sessionKey, userId, messages, config, store,
      // protocol MUST be forwarded — without it, applyArtifactsAndContext
      // takes the openai path (injects <session_context> into messages as a
      // role=system message) instead of the anthropic path (returns
      // systemAppend that anthropicHandler merges into body.system). The
      // openai path currently only works because AnthropicAdapter.serialize()
      // hoists role=system back onto body.system as a safety net; but forwarding
      // the correct protocol keeps intent and implementation aligned and
      // survives `injection.enabled=false` where no adapter runs.
      { stream: reqCtx.stream, modelId: reqCtx.modelId, protocol: reqCtx.protocol },
      metadataClient,
      userKey,
      spaceId,
      presetIdentity,
    );
  }
  return cbHandle(
    sessionKey, userId, messages, config, store,
    {
      stream: reqCtx.stream,
      modelId: reqCtx.modelId,
      protocol: reqCtx.protocol,
      formResponse: reqCtx.formResponse,
      nativeAgentSelection: reqCtx.nativeAgentSelection,
    },
    metadataClient,
    userKey,
    spaceId,
    presetIdentity,
    agentSource,
  );
}
