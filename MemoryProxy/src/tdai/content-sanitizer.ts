/**
 * Sanitize assistant text before it is copied into TDAI L0.
 *
 * L0 is the short-term conversation archive, not a terminal transcript. Keep
 * ordinary answers intact while removing terminal colour/control sequences and
 * the exact internal block-control responses observed in the Claude path.
 */

// CSI sequences (for example ESC[38;2;255;180;90m) plus OSC sequences used by
// terminals for titles/links. This intentionally does not remove ordinary
// Unicode control characters other than ANSI escapes.
const ANSI_ESCAPE_RE = /(?:\u001B\][^\u0007]*(?:\u0007|\u001B\\)|\u001B\[[0-?]*[ -/]*[@-~]|\u009B[0-?]*[ -/]*[@-~])/g;

const BLOCK_NO_RE = /^<block>\s*no\s*<\/block>$/i;
const BLOCK_YES_RE = /^<block>\s*yes\s*<\/block>\s*<category>[\s\S]*?<\/category>\s*<reason>[\s\S]*?<\/reason>$/i;

export type TdaiAssistantDropReason = "empty" | "control-marker";

export interface TdaiAssistantSanitizeResult {
  content: string | null;
  reason?: TdaiAssistantDropReason;
}

/** Remove ANSI terminal escape sequences without changing normal text. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE_RE, "");
}

/** Return true only for a complete internal block-control response. */
export function isInternalBlockControl(text: string): boolean {
  return BLOCK_NO_RE.test(text) || BLOCK_YES_RE.test(text);
}

/**
 * Prepare assistant text for L0. The returned text is trimmed because leading
 * and trailing terminal whitespace has no memory value; ordinary content is
 * otherwise preserved.
 */
export function sanitizeTdaiAssistantContent(
  value: string | null | undefined,
): TdaiAssistantSanitizeResult {
  if (typeof value !== "string") return { content: null, reason: "empty" };

  const cleaned = stripAnsi(value).trim();
  if (!cleaned) return { content: null, reason: "empty" };
  if (isInternalBlockControl(cleaned)) {
    return { content: null, reason: "control-marker" };
  }
  return { content: cleaned };
}
