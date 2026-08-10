/**
 * Client identity carried by the provider's `x-client` header.
 *
 * The API protocol alone cannot identify the application: Claude clients may
 * use Anthropic Messages, while Codex, OpenCode and other SDKs may all use
 * OpenAI Responses.  Keep this header deliberately small and allowlisted so
 * it can select proxy behaviour without becoming an arbitrary storage key.
 */

export const CLIENT_HEADER = "x-client" as const;

/** Canonical client families used by MemoryProxy. */
export type MemoryClientFamily = "claude" | "codex" | "opencode";

/**
 * Read a header from either Fetch Headers or a plain lower/upper-case record.
 * The helper is intentionally local so request handlers do not each implement
 * subtly different case/whitespace handling.
 */
function readHeader(
  headers: Headers | Readonly<Record<string, string | undefined>> | undefined,
): string | undefined {
  if (!headers) return undefined;
  const getter = (headers as { get?: unknown }).get;
  if (typeof getter === "function") {
    const value = (getter as (name: string) => unknown).call(headers, CLIENT_HEADER);
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  }
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== CLIENT_HEADER) continue;
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  }
  return undefined;
}

/**
 * Normalize the values documented for CC Switch.
 *
 * Canonical values:
 *   - `claude`   — Claude Code CLI and Claude Desktop
 *   - `codex`    — Codex Desktop and Codex CLI
 *   - `opencode` — OpenCode
 *
 * Only these three values are accepted.  Product-specific spellings are not
 * aliases: the provider configuration is the contract and must be explicit.
 */
export function normalizeClientFamily(value: unknown): MemoryClientFamily | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return undefined;

  if (normalized === "claude") return "claude";
  if (normalized === "codex") return "codex";
  if (normalized === "opencode") return "opencode";
  return undefined;
}

/** Return the normalized family from a request's `x-client` header. */
export function readClientFamily(
  headers: Headers | Readonly<Record<string, string | undefined>> | undefined,
): MemoryClientFamily | undefined {
  return normalizeClientFamily(readHeader(headers));
}

/**
 * Map a client family to the stable session/adapter namespace.
 * The family name is also the persistence namespace; do not add aliases.
 */
export function clientFamilyToAgentSource(family: MemoryClientFamily): string {
  switch (family) {
    case "claude":
      return "claude";
    case "codex":
      return "codex";
    case "opencode":
      return "opencode";
  }
}

/**
 * Prefer the explicit canonical client header.  A long-form route may still
 * provide one of the canonical agent names; every other path is anonymous
 * and must not be guessed as a Claude/Codex/OpenCode client.
 */
export function resolveAgentSourceFromClient(
  headers: Headers | Readonly<Record<string, string | undefined>> | undefined,
  pathSource: string,
): string {
  const family = readClientFamily(headers);
  if (family) return clientFamilyToAgentSource(family);
  return ["claude", "codex", "opencode", "codebuddy"].includes(pathSource)
    ? pathSource
    : "unknown";
}

/** Clients that need a team-wide fallback when no native form can be shown. */
export function isNonInteractiveClientSource(agentSource: string): boolean {
  return agentSource === "codex" || agentSource === "opencode";
}
