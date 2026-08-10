# MemoryProxy

MemoryProxy is a **transparent LLM request proxy**: instead of having a coding agent (Claude Code / CodeBuddy / ...) talk to the LLM directly, requests are routed through the proxy first. Chat/Messages requests can run session initialization, memory injection and conversation write-back, while the native Responses route preserves the upstream protocol and observes usage. This lets an agent tap into the team memory, Skills and Knowledge provided by [MemoryCore](../MemoryCore/README.md) **without changing a single line of code**.

It is "transparent" to both the client and the upstream model — it keeps the OpenAI Chat Completions and Anthropic Messages wire formats intact, and has a dedicated native OpenAI Responses transport at `/v1/responses`. The existing Chat/Messages and Responses pipelines reuse **authentication, session initialization, context injection, rate limiting, usage observation and final conversation write-back**; only the wire adapters and protocol-specific forwarding differ. See [Protocol and path compatibility](#protocol-and-path-compatibility).

> In one line: MemoryProxy handles "access & forwarding"; MemoryCore handles "storage & processing" of memory. The proxy itself persists no memory data — all Memory / Skill / Knowledge reads and writes go through the MemoryCore Gateway (default `:8420`). For the overall product positioning, see the repo root [README.md](../README.md).

## Where it fits

```text
Coding agent (Claude Code / CodeBuddy / ...)
        │  OpenAI / Anthropic protocol (unchanged)
        ▼
   MemoryProxy :8096        ← this project (LLM request proxy)
        │  Chat/Messages: session init / injection / write-back
        │  Responses: auth / session / injection / forwarding / reporting
        ├─────────────► Upstream LLM (TokenHub / OpenAI-compatible)
        │
        └─ HTTP API ─► MemoryCore Gateway :8420
                        ├─ Memory  L0 / L1 / L2 / L3
                        ├─ Skill   search / archive / extract
                        └─ Meta    Team / Agent / Task / Knowledge
```

## Core capabilities

- **Session initialization**: on the Chat/Messages pipeline, intercepts the first request and guides the user through an interactive form to pick team → agent → task, then injects the agent/task context into the system prompt. Supports auto pre-selection from request headers (`x-team-id` / `x-agent-id` / `x-task-id`).
- **Context injection**: on the Chat/Messages pipeline, injects Skills, Knowledge and Memory L2/L3 into the system prompt on demand; L0/L1 are exposed as read-only tools for the model to query proactively, avoiding upstream KV-cache invalidation.
- **Conversation write-back (extraction)**: on the Chat/Messages pipeline, at the end of each human turn, sends the conversation slice to MemoryCore `/v3/skill/conversation/add` (Skill archival) and writes L0 short-term memory for background extraction on the core side.
- **Auth & identity**: calls MemoryCore `POST /v3/meta/auth/verify` to validate `x-tdai-user-key` and resolve `user_id` as the end-to-end user identity; `spaceId` (memory instance id) is auto-extracted from the `/proxy/<spaceId>/...` path.
- **Native Responses transport**: supports `/v1/responses` and agent/space or legacy `/proxy/<spaceId>` variants, preserves the original JSON request (`input`, `instructions` and unknown fields included), and transparently passes through JSON or SSE responses while observing usage as a side channel.
- **System-user passthrough**: internal service accounts (e.g. memory / wiki internal calls) short-circuit session init and injection on match, doing pure passthrough + billing only.
- **Skill Bridge / Memory Bridge**: reverse-proxies MemoryCore's skill / memory HTTP tools, injecting `serviceToken` on forward so credentials never appear in an LLM-visible prompt.
- **Unified storage abstraction (ProxyStorage)**: session init state, injection cache and Skill state (`inj:*` / `sk:*` / `vpin:*`) support five backends — Redis, COS (kernel-sts), SQLite, FS, Memory. COS is preferred for multi-node deployments.
- **Input TPM / QPM rate limiting**: 60-second sliding-window limiting on Redis, keyed by `spaceId × final model`, adjustable at runtime via `/v3/admin/rate-limits`.
- **Observability & usage reporting**: three independent channels — Opik trace, Langfuse (one trace = one turn), ClickHouse (per-turn token detail). Any one failing does not affect the business path.
- **Credit billing report**: after each upstream response completes, computes CreditDelta from the pricing table and reports it to the billing service; only recognized space-bearing paths are counted.
- **Multi-node deployment**: scales horizontally with an external gateway plus the COS backend; the `/skill-bridge` and `/memory-bridge` prefixes are passed through verbatim from the gateway to proxy instances.

## Request pipeline

A main-model call carrying `spaceId` roughly goes through these stages:

```text
POST /proxy/<spaceId>/v1/chat/completions | /v1/messages
   │
   ├─ 1. auth ─────── validate x-tdai-user-key, resolve user_id
   ├─ 2. systemUser ─ short-circuit passthrough on internal-account match
   ├─ 3. sessionInit ─ first turn shows a form: team → agent → task
   ├─ 4. injection ── inject skill / knowledge / memory into system prompt
   ├─ 5. rateLimit ── spaceId × final-model TPM/QPM limiting
   ├─ 6. forward ──── forward to the upstream LLM
   ├─ 7. extract ──── async write-back of conversation + L0 after the turn
   └─ 8. report ───── ClickHouse / Langfuse / Opik / Credit reporting
```

## Memory layers & injection strategy

MemoryProxy mirrors MemoryCore's four-layer memory structure, plugging into the prompt via two modes — "inject" and "toolize":

| Layer | Role | How it plugs in |
| --- | --- | --- |
| L0 | Short-term conversation memory | proxy writes it back to MemoryCore each turn |
| L1 | Session-level key memory | recalled on demand by the model via the `<tdai_memory_tools>` tools |
| L2 | Agent Profile | injected directly into the system prompt |
| L3 | Team / Global memory | injected directly into the system prompt |

Skills and Knowledge follow the same idea:

- `<cloud_skills>` — summaries of relevant Skills retrieved from MemoryCore RAG
- `<skill_tools>` — a block telling the model how to call Skills via curl (read/write permission controlled by `skillRuntime.allowLlmWrite`)
- `<knowledge_tools>` — two-step self-discovery tools for team knowledge resources (Wiki / CodeGraph)
- `<session_context>` — agent/task info appended every turn after session init completes

## Requirements

- Node.js `v22.x` (checked strictly at startup; `>= 22.16.0` recommended)
- npm or pnpm
- A running **MemoryCore Gateway** (default `:8420`) providing Auth / Skill / Meta / Memory APIs
- Redis (default backing store for session/injection/Skill state; switchable once `storage.enabled=true`)
- An OpenAI-compatible upstream LLM API (TokenHub or others)

## Quick start

### 1. Install dependencies

```bash
cd MemoryProxy
npm install
```

### 2. Create the config

Create your own `config.yaml` from the example:

```bash
cp config.example.yaml config.yaml
# adjust upstream / auth / tdai / skill / storage as needed
```

At minimum confirm:

- `upstream.url` / `upstream.apiKey` — upstream LLM address and credentials
- `auth.url` / `tdai.endpoint` / `skill.endpoint` — point to your MemoryCore Gateway (default `http://127.0.0.1:8420`)

> **Run locally without Redis**: the example config defaults to `redis.enabled: true`, which spams `ECONNREFUSED 127.0.0.1:6379` when no Redis is running locally. For pure local development, set `redis.enabled: false` + `storage.enabled: true` (`storage.backend: sqlite`); session/injection/Skill state then goes to local SQLite and the process starts up cleanly.

### 3. Start the service

```bash
npm run start:config
# equivalent to:
node --import tsx/esm src/index.ts --config config.yaml
```

### 4. Health check

```bash
curl http://127.0.0.1:8096/health
```

Sample response (`storage.effective` is the observability anchor for the storage backend):

```json
{
  "status": "ok",
  "version": "0.2.0",
  "upstream": "https://tokenhub.example.com/v1",
  "storage": { "enabled": false, "requested": "sqlite", "effective": "sqlite", "degraded": false }
}
```

## Ways to start

```bash
# Direct start (built-in defaults, not for production)
npm start

# With a config file
npm run start:config

# CLI overrides (highest priority)
node --import tsx/esm src/index.ts --port 9000 --upstream https://other.api/v1

# Dev mode (auto-restart on file change)
npm run dev:config
```

### Background script `proxy.sh`

Always uses `./config.yaml`, auto-detects the `node` path (nvm / fnm compatible), and writes logs by date to `logs/YYYY-MM-DD.log`.

```bash
./proxy.sh start          # start in background
./proxy.sh stop           # stop
./proxy.sh restart        # restart
./proxy.sh status         # status (includes /health output)
./proxy.sh log            # tail today's log

./proxy.sh daemon         # daemon mode (auto-restart on crash)
./proxy.sh daemon-stop
./proxy.sh daemon-status
```

## Client configuration

Point the coding agent's upstream address at this proxy and keep the rest (`apiKey`, `model`, ...) unchanged. Include `spaceId` (memory instance id) in the path — the proxy extracts it for auth and reporting; the existing Chat/Messages pipeline also uses it for session and injection state.

OpenAI-compatible client:

```json
{
  "apiKey": "sk-mem-xxx",
  "url": "http://localhost:8096/proxy/<spaceId>/v1/chat/completions"
}
```

Anthropic Messages client:

```json
{
  "apiKey": "sk-mem-xxx",
  "url": "http://localhost:8096/proxy/<spaceId>/v1/messages"
}
```

### Protocol and path compatibility

MemoryProxy has a dedicated native Responses transport. The main paths are:

- OpenAI Chat Completions: `POST /<agentSource>/<spaceId>/v1/chat/completions`
- Anthropic Messages: `POST /<agentSource>/<spaceId>/v1/messages`
- OpenAI Responses: `POST /v1/responses`
- Agent/space Responses: `POST /<agentSource>/<spaceId>/v1/responses` (for example `/codebuddy/<spaceId>/v1/responses` or `/codex/<spaceId>/v1/responses`)
- Legacy Responses: `POST /proxy/<spaceId>/v1/responses`

The same explicit Responses route family also includes `/v1/responses/compact`,
`/v1/models` and `/v1/alpha/search` (with the corresponding agent/space and
legacy prefixes). The `models` helper is `GET`; the other listed helper paths
are `POST`.

Use `codebuddy` as the `agentSource` for a direct Responses client when auth and
credit reporting are enabled; the current path extractor recognizes it as a
space-bearing agent. Use `claude` for the Claude family's Anthropic client. The
legacy `/proxy/<spaceId>/...` prefix remains available.

For `POST /.../responses`, the handler preserves the Responses JSON shape and
forwards `input`, top-level `instructions`, `previous_response_id`, unknown
fields and model aliases without converting to Chat. If session or memory
injection is enabled, only the server-owned `instructions` overlay is added;
the original input/tool-call sequence remains intact. A non-stream response
keeps the upstream status/body and relevant headers. An SSE response is byte
transparent; the parser observes usage, status, refusal and function-call
arguments without changing the stream. Transport-only and credential headers
are removed at the proxy boundary.

The native Responses handler is separate from the Chat/Messages wire adapter
but reuses the shared session and memory services. With
`sessionInit.enabled=true`, it validates the authenticated user's visible
Team/Agent/Task headers, registers or recovers a session in the client-specific
namespace, and maps `previous_response_id` back to that session. The protocol
does not identify the caller by itself: send `x-client: claude`, `codex`, or
`opencode`. Codex/OpenCode can omit `x-agent-id` when the configured team-wide
`global-agent` fallback is unambiguous; otherwise a structured `409` is
returned. Configured injection blocks are merged into `instructions`; completed
final responses can write one deduplicated L0 turn and trigger Skill extraction.
Client credentials and internal identity headers are used by MemoryProxy only
and are not forwarded to the provider.

### Headless clients: headers and session binding

For the existing Chat/Messages session pipeline, a non-interactive client should
send these headers on the first request and every tool-loop follow-up:

```http
Authorization: Bearer <business-user-key>
x-team-id: <team_id>
x-agent-id: <agent_id>
x-task-id: <task_id>
x-conversation-id: <stable-conversation-id>
```

The `team_id`, `agent_id` and `task_id` values are checked against the metadata
visible to the authenticated user; headers are not trusted blindly. With
`sessionInit.headerAutoSelect.enabled=true`, valid identity headers and a valid
session header let the Chat/Messages or native Responses handler register the
session without the interactive form. Claude clients can still use their native
selection form. For Codex/OpenCode, `x-client` plus a valid team/task invokes
the client's native single-choice form when `x-agent-id` is absent. If the
invocation cannot display a form, the configured team-wide fallback is used; a
missing or ambiguous binding returns structured `409` and is not forwarded to
the provider.

The session binding is effectively:

```text
(spaceId, authenticated user_id, agentSource, sessionId)
```

`sessionId` is taken, in order, from `x-tdai-session-key`, the Codex/session
headers, `prompt_cache_key`, `conversation.id`, and only then a scoped
`previous_response_id` mapping. Reuse one value for one conversation and
generate a new value for a new conversation. With Responses session-init
enabled, missing Team/Agent/Task/session binding is rejected instead of being
silently bypassed, except for the explicitly configured Codex/OpenCode
`global-agent` fallback.

### Codex

Codex can use the native Responses route directly. A provider configuration can
look like this:

```toml
# ~/.codex/config.toml — Codex → MemoryProxy → Responses-capable upstream
model = "<memoryproxy-model>"
model_provider = "memory-proxy"

[model_providers.memory-proxy]
name = "MemoryProxy"
base_url = "http://127.0.0.1:8096/codebuddy/<spaceId>/v1"
env_key = "MEMORY_PROXY_API_KEY"
wire_api = "responses"
requires_openai_auth = true
http_headers = {
  "x-client" = "codex",
  "x-team-id" = "<team_id>",
  "x-task-id" = "<task_id>",
  "x-conversation-id" = "<stable-conversation-id>"
}
```

`MEMORY_PROXY_API_KEY` is the business user key accepted by MemoryProxy. Configure
the upstream provider key separately in `upstream.agents.codebuddy.apiKey` (or
the global `upstream.apiKey`); the client key is used for MemoryProxy auth and
is not forwarded on the Responses upstream leg. Keep the four custom headers
stable across tool calls. `/codex/<spaceId>/v1` is also a registered route and is
recognized by the auth/credit space extractor; use whichever agent name matches
the configured upstream profile.

### CC Switch

When CC Switch is the client/provider switch in front of MemoryProxy, select its
native **OpenAI Responses** mode and set the provider base URL to:

```text
http://127.0.0.1:8096/codebuddy/<spaceId>/v1
```

Set the business-user API key and preserve `x-team-id`, `x-agent-id`,
`x-task-id` and `x-conversation-id`. Do not enable a Responses-to-Chat
conversion for this leg: MemoryProxy accepts native Responses and forwards it
to a Responses-capable upstream. If a CC Switch deployment is used as
MemoryProxy's upstream instead, set `upstream.agents.codebuddy.url` to its
OpenAI-compatible `/v1` endpoint and ensure that endpoint exposes
`/v1/responses` plus JSON/SSE.

### CLIProxyAPI

CLIProxyAPI can be used as the upstream of MemoryProxy through its normal
OpenAI-compatible `/v1` endpoint. For a native Responses route, the selected
CLIProxyAPI provider must support `/v1/responses` and JSON/SSE:

```yaml
# MemoryProxy/config.yaml
upstream:
  agents:
    codebuddy:
      url: "http://127.0.0.1:8317/v1"
      apiKey: "<CLIProxyAPI-api-key>"
```

If CLIProxyAPI is instead the client-facing sidecar, configure its custom
provider base URL as
`http://127.0.0.1:8096/codebuddy/<spaceId>/v1`, select its OpenAI Responses
wire format, and preserve the four Team/Agent/Task/session headers. No
Responses-to-Chat converter is required for this native route.

## Known limitations

- Native Responses reuses session, injection, rate-limit, usage and final L0/Skill hooks, but the cost-guard routing extension and Opik/Langfuse generation spans are not yet protocol-specific; upstream selection is based on the configured agent/global URL.
- The Responses upstream must implement the requested Responses endpoint. MemoryProxy does not convert Responses to Chat Completions or Anthropic Messages.
- With auth enabled, root `/v1/responses` has no `spaceId` for `auth/verify`; use `/codebuddy/<spaceId>/v1/responses`, `/codex/<spaceId>/v1/responses` or `/proxy/<spaceId>/v1/responses`.
- `input`, `instructions`, `previous_response_id`, unknown JSON fields and model aliases are preserved semantically. When server-side session/memory injection is enabled, `instructions` is intentionally overlaid and the request is reserialized.
- Team/Agent/Task and session headers are consumed by MemoryProxy for Responses session validation and are not forwarded as provider credentials. For Chat/Messages, missing or unstable session headers can skip session initialization and injection; direct header registration also requires a valid task id even though the interactive form can make task optional.
- Usage logging and credit reporting are best effort. An unknown model alias may be forwarded successfully but still produce no priced credit record; credit extraction also depends on a recognized space-bearing path.

## Main HTTP endpoints

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/proxy/<spaceId>/v1/chat/completions` | OpenAI-compatible main-model call (with memory instance id) |
| `POST` | `/proxy/<spaceId>/v1/messages` | Anthropic Messages main-model call |
| `POST` | `/proxy/<spaceId>/v1/responses` | Native OpenAI Responses passthrough (JSON/SSE) |
| `POST` | `/<agent>/<spaceId>/v1/responses` | Native Responses passthrough; `codebuddy` is recommended with auth enabled |
| `POST` | `/v1/messages` | Anthropic Messages API (fallback without spaceId) |
| `POST` | `/*` | OpenAI-compatible chat endpoint (catch-all) |
| `ALL`  | `/skill-bridge/**` | reverse-proxy for MemoryCore skill HTTP tools |
| `ALL`  | `/memory-bridge/**` | reverse-proxy for MemoryCore memory HTTP tools |
| `POST` | `/v3/instance/proxy-destroy` | ops endpoint: clear COS cache on instance destroy |
| `GET/PUT/DELETE` | `/v3/admin/rate-limits` | query / modify per-instance × model TPM/QPM |
| `GET`  | `/health` | runtime health check (includes `storage.effective`) |
| `GET`  | `/whoami` | API Key → keyId (plain text, handy with curl) |

## Configuration

See the fully-commented [`config.example.yaml`](./config.example.yaml). Precedence: **CLI args > YAML config file > built-in defaults**.

Config sections at a glance:

| Section | Purpose |
| --- | --- |
| `server` | listen host / port, upstream forward timeout |
| `upstream` | default upstream URL and global `apiKey` (replaces forward auth when non-empty) |
| `log` | log directory, level, backend and rotation policy |
| `redis` | default backend for session / injection / Skill state (used when `storage.enabled` is off) |
| `storage` | unified storage abstraction (`cos` / `sqlite` / `fs` / `memory`); `cos` preferred for multi-node |
| `auth` | `x-tdai-user-key` → `user_id` validation (calls MemoryCore `/v3/meta/auth/verify`) |
| `admin` | shared secret for ops endpoints (e.g. `/v3/instance/proxy-destroy`) |
| `systemUsers` | internal service accounts; short-circuit passthrough on match |
| `injection` | master switch and injector list (`skill` / `knowledge` / `tdai-memory`) |
| `extraction` | conversation write-back master switch (skill archival + L0 write) |
| `sessionInit` | session init form flow and header auto pre-select policy |
| `tdai` | MemoryCore connection and L0/L1/L2/L3 switches |
| `skill` | MemoryCore data-plane config (Skill RAG, Skill archival, Meta) |
| `knowledge` | standalone knowledge gateway (may differ from skill) |
| `skillRuntime` | whether the main model may write Skills (read-only by default) |
| `rateLimit` | Input TPM / QPM limiting per memory instance × actual model |
| `clickhouse` | per-turn usage reporting (billing data source) |
| `creditReport` / `creditPricing` | Credit billing report and pricing table |
| `upstream.agents` | override upstream URL + apiKey per agent name (e.g. route `claude` through CCR) |

> `injection`, `extraction`, `sessionInit`, `tdai`, `skill`, `knowledge`, `skillRuntime` are the memory-related sections — focus on them first when integrating.

### Common environment variables

```bash
TDAI_MEMORY_SYSTEM_USER_ID   # user_id of the memory internal service account
TDAI_MEMORY_SYSTEM_USER_KEY  # apiKey of the memory internal service account (ops reference only)
TDAI_PROXY_ADMIN_API_KEY     # shared secret for ops endpoint auth
PROXY_DB_PATH                # sqlite backend db path (used when storage.sqlite.dbPath is empty)
```

## Choosing a storage backend

With `storage.enabled=true`, all session/injection/Skill state (`inj:*` / `sk:*` / `vpin:*`) goes through ProxyStorage:

| Backend | Use case | Notes |
| --- | --- | --- |
| `cos` | Production multi-node | cross-node sharing; kernel-sts only (one temp credential per spaceId) |
| `sqlite` | Single-instance local dev / CI | built-in sweeper periodically clears the `ttl/` bucket; `nottl/` is kept forever |
| `fs` | Offline / docker fallback | no sweeper; delegate to external tmpwatch |
| `memory` | Fallback / testing | cleared on process restart |

The key layout is uniformly `proxy_cache/{ttl|nottl}/{spaceId}/{userId}/{agentSource}/{sessionId}/...`; `ttl/` holds hot cache (rebuildable), `nottl/` holds business state such as bindings that must persist.

Degradation chain: `cos → sqlite → fs → memory`. If any backend fails to init, it degrades automatically, and the `/health` endpoint exposes `storage.effective` as the observability anchor.

## Docker

The image runs TypeScript directly via tsx, uses `tini` as PID 1, runs as a non-root user, and ships a `/health` `HEALTHCHECK`. The multi-stage build requires BuildKit.

Build in the `MemoryProxy/` directory:

```bash
DOCKER_BUILDKIT=1 docker build -t memory-proxy:local .
```

Run the container (config provided by mounting `/data/config.yaml`; sqlite storage persisted to `/data/tdai-memory-proxy`):

```bash
docker run --rm \
  -p 8096:8096 \
  -v "$PWD/config.yaml:/data/config.yaml:ro" \
  -v tdai-proxy-data:/data/tdai-memory-proxy \
  -e TDAI_PROXY_ADMIN_API_KEY="replace-with-a-strong-random-token" \
  memory-proxy:local
```

- The default config path is `/data/config.yaml`; override it by appending `--config /other/path.yaml` to `docker run`.
- Inject credentials via environment variables or a Secret Manager; never bake API keys / STS credentials into the image or config repo.
- Health status: `docker inspect --format '{{.State.Health.Status}}' <container>`.

## Directory structure

```text
MemoryProxy/
  src/
    index.ts / server.ts              entry point and HTTP routing
    handler.ts / anthropicHandler.ts  OpenAI / Anthropic request handlers
    auth.ts / identity.ts             user identity and authentication
    systemUser.ts / systemUserPassthrough.ts  internal-account short-circuit passthrough
    session/                          session init: form flow, state store, Claude Code / CodeBuddy adapters
    injection/                        injection pipeline: skill / knowledge / tdai-memory injectors
    skill/                            Skill Bridge, conversation/add archival trigger, version pin
    memory/                           Memory Bridge reverse proxy
    knowledge/ / meta/                MemoryCore knowledge / metadata clients
    tdai/                             Memory L0/L1/L2/L3 client, pending-write queue
    storage/                          ProxyStorage abstraction (cos / sqlite / fs / memory)
    db/                               session / injection / Skill state persistence repos
    rate-limit/                       Input TPM / QPM limiting
    routes/                           admin endpoints (admin-auth / instance-destroy / rate-limits)
    clickhouse.ts / langfuse.ts / opik.ts  three observability channels
    credit-reporter.ts / pricing.ts   Credit billing report and pricing
    report/ / logger.ts               structured logging system and JSONL usage log
  gateway/                            optional load-balancing gateway (keyId consistent hashing)
  docs/                               architecture, design docs and e2e runbooks
  scripts/                            smoke, migration, maintenance scripts
  config.example.yaml                 fully-commented complete config example
  Dockerfile                          MemoryProxy image
  proxy.sh                            background start / daemon script
  package.json
```

## Running tests

```bash
npm test              # vitest run (unit + integration by default)
npm run test:watch
```

`__tests__/` live under each submodule: `session/__tests__` (session flow), `skill/__tests__` (archival trigger, version pin), `storage/__tests__` (backend contracts), `db/__tests__` (repo consistency), etc. `docs/` also provides several end-to-end runbooks (`e2e-runbook.md` / `e2e-full-coverage-runbook.md`, ...) for verifying the memory pipeline against a real MemoryCore + Redis + storage backend.

## Security & release notes

- When listening on a non-loopback address or deploying multi-node, enable `auth.enabled=true` and inject `TDAI_PROXY_ADMIN_API_KEY` via env to protect ops endpoints.
- Inject all secrets via environment variables or a Secret Manager; never commit real `apiKey` / `serviceToken` / STS credentials / billing URLs into the config repo.
- For multi-node deployments you must use `storage.backend=cos` and explicitly set `injection.externalGatewayUrl`, otherwise each instance caches independently and causes upstream KV-cache misses.
- Do not commit generated data, local databases, logs or env files (`logs/`, `*.db`, `.env`, `dump.rdb`, `session*.json`, `*.pid`, ...).

## License

MIT
