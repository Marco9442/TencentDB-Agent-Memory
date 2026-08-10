# MemoryProxy

MemoryProxy 是一个**透明的 LLM 请求代理**：把编码 Agent（Claude Code / CodeBuddy 等）原本直连大模型的请求，改为先经过它中转。Chat/Messages 请求可执行会话初始化、记忆注入和对话回流；原生 Responses 路由则保持上游协议并旁路观测用量，让 Agent **无需改动一行代码**就能用上 [MemoryCore](../MemoryCore/README_CN.md) 提供的团队记忆、Skill 和 Knowledge。

对客户端和上游模型来说，它是“透明”的——保持 OpenAI Chat Completions 与 Anthropic Messages 的协议格式，并提供原生 OpenAI Responses `/v1/responses` 的独立转发通道。Chat/Messages 与 Responses 都可复用**会话初始化、上下文注入、限流、用量和最终 L0/Skill 回流**；详见[协议与路径兼容性](#协议与路径兼容性)。

> 一句话分工：MemoryProxy 管“接入与转发”，MemoryCore 管“记忆的存储与处理”。Proxy 自身不落记忆数据，所有 Memory / Skill / Knowledge 读写都经 MemoryCore Gateway（默认 `:8420`）完成。整体产品定位见仓库根 [README_CN.md](../README_CN.md)。

## 它在整个体系里的位置

```text
编码 Agent (Claude Code / CodeBuddy / ...)
        │  OpenAI / Anthropic 协议（不改动）
        ▼
   MemoryProxy :8096        ← 本项目（LLM 请求代理）
        │  Chat/Messages：会话初始化 / 注入 / 回流
        │  Responses：鉴权 / session / 注入 / 转发 / 上报
        ├─────────────► 上游 LLM（TokenHub / OpenAI-compatible）
        │
        └─ HTTP API ─► MemoryCore Gateway :8420
                        ├─ Memory  L0 / L1 / L2 / L3
                        ├─ Skill   检索 / 归档 / 抽取
                        └─ Meta    Team / Agent / Task / Knowledge
```

## 核心能力

- **会话初始化**：在 Chat/Messages pipeline 中，首次对话时拦截请求，通过交互式表单引导用户选择 team → agent → task，完成后把 agent/task 上下文注入 system prompt。支持从请求头（`x-team-id` / `x-agent-id` / `x-task-id`）自动预选。
- **上下文注入**：在 Chat/Messages pipeline 中，把 Skill、Knowledge、Memory L2/L3 等按需注入 system prompt；L0/L1 通过只读工具接口暴露给模型主动查询，避免破坏上游 KV cache。
- **对话回流（提取）**：在 Chat/Messages pipeline 中，每轮真人对话结束时，把对话切片同步发到 MemoryCore `/v3/skill/conversation/add`（Skill 归档）并写入 L0 短期记忆，供 core 侧后台抽取。
- **鉴权与身份**：调用 MemoryCore `POST /v3/meta/auth/verify` 校验 `x-tdai-user-key`，解析出 `user_id` 作为全链路用户标识；`spaceId`（memory 实例 id）从 `/proxy/<spaceId>/...` 路径自动提取。
- **原生 Responses 转发**：支持 `/v1/responses` 以及 agent/space、legacy `/proxy/<spaceId>` 变体，保留原始 JSON 请求（包括 `input`、`instructions` 和未知字段），透明转发 JSON/SSE 响应并旁路观测用量。
- **系统用户短路透传**：内部服务账号（如 memory / wiki 内部调用）命中后跳过 session init 和注入，只做透明转发 + 计费。
- **Skill Bridge / Memory Bridge**：反向代理 MemoryCore 的 skill / memory HTTP 工具，转发时注入 `serviceToken`，避免凭据出现在 LLM 可见的 prompt 中。
- **统一存储抽象（ProxyStorage）**：会话初始化状态、注入缓存与 Skill 状态（`inj:*` / `sk:*` / `vpin:*`）支持 Redis、COS（kernel-sts）、SQLite、FS、Memory 五种后端，多节点部署首选 COS。
- **Input TPM / QPM 限流**：按 `spaceId × 最终模型` 在 Redis 上做 60 秒滑动窗口限流，可通过 `/v3/admin/rate-limits` 动态调整。
- **可观测与用量上报**：Opik trace、Langfuse（一个 trace = 一个 turn）、ClickHouse（按 turn 记录 token 明细）三路互相独立，任一失败不影响业务。
- **Credit 计费上报**：每次上游响应完成后按定价表计算 CreditDelta 上报到计费服务；仅识别带 spaceId 的已知路径。
- **多节点部署**：结合外部 gateway 与 COS 后端支持多实例水平扩展；`/skill-bridge` 与 `/memory-bridge` 前缀由 gateway 原样透传到 proxy 实例。

## 请求处理流程

一次带 `spaceId` 的主模型调用大致经过以下阶段：

```text
POST /proxy/<spaceId>/v1/chat/completions | /v1/messages
   │
   ├─ 1. auth ─────── 校验 x-tdai-user-key，解析出 user_id
   ├─ 2. systemUser ─ 命中内部账号则短路透传
   ├─ 3. sessionInit ─ 首次对话弹表单：team → agent → task
   ├─ 4. injection ── system prompt 注入 skill / knowledge / memory
   ├─ 5. rateLimit ── spaceId × 最终模型 TPM/QPM 限流
   ├─ 6. forward ──── 转发到上游 LLM
   ├─ 7. extract ──── 一轮结束后异步回流 conversation + L0
   └─ 8. report ───── ClickHouse / Langfuse / Opik / Credit 上报
```

## 记忆层与注入策略

MemoryProxy 对齐 MemoryCore 的四层记忆结构，按“注入 + 工具化”两种方式接入 prompt：

| 层级 | 作用 | 接入方式 |
| --- | --- | --- |
| L0 | 短期对话记忆 | 每轮对话由 proxy 主动写回 MemoryCore |
| L1 | 会话级关键记忆 | 通过 `<tdai_memory_tools>` 工具让模型按需召回 |
| L2 | Agent Profile | 直接注入 system prompt |
| L3 | Team / Global 记忆 | 直接注入 system prompt |

Skill 与 Knowledge 沿用同样的思路：

- `<cloud_skills>` —— 从 MemoryCore RAG 检索到的相关 Skill 摘要
- `<skill_tools>` —— 告诉模型如何通过 curl 调用 Skill 的说明块（读写权限由 `skillRuntime.allowLlmWrite` 控制）
- `<knowledge_tools>` —— 团队知识资源（Wiki / CodeGraph）两步自发现工具
- `<session_context>` —— session init 完成后每轮追加的 agent/task 信息

## 环境要求

- Node.js `v22.x`（启动时强校验；推荐 `>= 22.16.0`）
- npm 或 pnpm
- 一个已运行的 **MemoryCore Gateway**（默认 `:8420`），提供 Auth / Skill / Meta / Memory API
- Redis（默认承载会话/注入/Skill 状态；启用 `storage.enabled=true` 后可切换到其他后端）
- 一个 OpenAI-compatible 上游 LLM API（TokenHub 或其他）

## 快速开始

### 1. 安装依赖

```bash
cd MemoryProxy
npm install
```

### 2. 创建配置

基于示例配置创建自己的 `config.yaml`：

```bash
cp config.example.yaml config.yaml
# 按需修改 upstream / auth / tdai / skill / storage 等段
```

至少需要确认这几项：

- `upstream.url` / `upstream.apiKey` —— 上游 LLM 地址与凭据
- `auth.url` / `tdai.endpoint` / `skill.endpoint` —— 指向你的 MemoryCore Gateway（默认 `http://127.0.0.1:8420`）

> **本地无 Redis 快速跑通**：示例配置默认 `redis.enabled: true`，本机没起 Redis 时会持续刷 `ECONNREFUSED 127.0.0.1:6379`。纯本地开发建议改为 `redis.enabled: false` + `storage.enabled: true`（`storage.backend: sqlite`），会话/注入/Skill 状态改走本地 SQLite，启动即干净。

### 3. 启动服务

```bash
npm run start:config
# 等价于：
node --import tsx/esm src/index.ts --config config.yaml
```

### 4. 健康检查

```bash
curl http://127.0.0.1:8096/health
```

返回示例（`storage.effective` 是存储后端的观测锚点）：

```json
{
  "status": "ok",
  "version": "0.2.0",
  "upstream": "https://tokenhub.example.com/v1",
  "storage": { "enabled": false, "requested": "sqlite", "effective": "sqlite", "degraded": false }
}
```

## 启动方式

```bash
# 直接启动（使用内置默认值，不推荐生产）
npm start

# 指定配置文件
npm run start:config

# CLI 参数覆盖（优先级最高）
node --import tsx/esm src/index.ts --port 9000 --upstream https://other.api/v1

# 开发模式（文件变更自动重启）
npm run dev:config
```

### 后台管理脚本 `proxy.sh`

固定使用 `./config.yaml`，自动查找 `node` 路径（兼容 nvm / fnm），日志按日期写入 `logs/YYYY-MM-DD.log`。

```bash
./proxy.sh start          # 后台启动
./proxy.sh stop           # 停止
./proxy.sh restart        # 重启
./proxy.sh status         # 查看运行状态（含 /health 输出）
./proxy.sh log            # tail 今日日志

./proxy.sh daemon         # 守护进程模式（崩溃自动拉起）
./proxy.sh daemon-stop
./proxy.sh daemon-status
```

## 客户端配置

把编码 Agent 的上游地址指向本代理，其余字段（`apiKey`、`model` 等）保持不变。请求路径推荐带上 `spaceId`（memory 实例 id），proxy 会提取它用于鉴权和上报；现有 Chat/Messages pipeline 还会用它隔离 session 与注入状态。

OpenAI 兼容客户端：

```json
{
  "apiKey": "sk-mem-xxx",
  "url": "http://localhost:8096/proxy/<spaceId>/v1/chat/completions"
}
```

Anthropic Messages 客户端：

```json
{
  "apiKey": "sk-mem-xxx",
  "url": "http://localhost:8096/proxy/<spaceId>/v1/messages"
}
```

### 协议与路径兼容性

MemoryProxy 有独立的原生 Responses 转发通道，主要路径包括：

- OpenAI Chat Completions：`POST /<agentSource>/<spaceId>/v1/chat/completions`
- Anthropic Messages：`POST /<agentSource>/<spaceId>/v1/messages`
- OpenAI Responses：`POST /v1/responses`
- Agent/space Responses：`POST /<agentSource>/<spaceId>/v1/responses`（例如 `/codebuddy/<spaceId>/v1/responses` 或 `/codex/<spaceId>/v1/responses`）
- Legacy Responses：`POST /proxy/<spaceId>/v1/responses`

同一组显式 Responses 路由还包括 `/v1/responses/compact`、`/v1/models`、
`/v1/alpha/search` 及相应的 agent/space、legacy 前缀；`models` 使用 `GET`，
其余列出的 helper 路径使用 `POST`。

当启用 auth 和 credit reporting 时，直接 Responses 客户端可以使用
`codebuddy`、`codex` 或其它已配置的 `agentSource`；路径提取器会识别这些
agent 对应的 spaceId。Claude family 的 Anthropic 客户端使用 `claude`。旧的
`/proxy/<spaceId>/...` 前缀仍保留。

对于 `POST /.../responses`，handler 保持 Responses JSON 形状，透传
`input`、顶层 `instructions`、`previous_response_id`、未知字段和模型别名，
不转换为 Chat。启用 session 或 memory injection 时，只会追加服务端拥有的
`instructions` overlay，原始 input/tool-call 序列保持不变。非流式响应保留
上游 status/body 和相关 header；SSE 按原始字节透明转发，解析器旁路观测
usage、状态、拒答和 function-call 参数，不改变流内容。凭据和内部身份 header
不会转发给 provider。

原生 Responses handler 与 Chat/Messages 使用不同 wire adapter，但复用共享的
session 和 memory 服务。启用 `sessionInit.enabled=true` 后，会校验当前鉴权
用户可见的 Team/Agent/Task，注册或恢复 Codex session，通过
`previous_response_id` 映射恢复真实 session；缺少无交互绑定时返回结构化 409。
配置的注入块会合并到 `instructions`，完成响应可去重写入一次 L0 并触发 Skill
提取。客户端凭据和内部身份 header 只用于 MemoryProxy，不会发送给 provider。

### 无交互客户端：Header 与 session 绑定

对于现有 Chat/Messages session pipeline，无交互客户端应在首个请求及每次
tool-loop 后续请求中都携带以下 header：

```http
Authorization: Bearer <业务用户 user_key>
x-team-id: <team_id>
x-agent-id: <agent_id>
x-task-id: <task_id>
x-conversation-id: <稳定的会话标识>
```

`team_id`、`agent_id`、`task_id` 会按当前鉴权用户可见的元数据列表校验，不能
盲信 header。启用 `sessionInit.headerAutoSelect.enabled=true` 后，三个身份
header 都有效且带有有效 session header，即可让 Chat/Messages 或 Responses
handler 跳过交互式表单直接注册 session。Responses 缺少或不匹配绑定时返回
结构化 409，不会把这些 header 转发给 provider。

Session 绑定键实际等价于：

```text
(spaceId, authenticated user_id, agentSource, sessionId)
```

`sessionId` 按以下顺序取值：`x-tdai-session-key`、Codex/session headers、
`prompt_cache_key`、`conversation.id`，最后才使用有 scope 的
`previous_response_id` 映射。同一段对话复用同一个值，新对话生成新值。启用
Responses session-init 时，缺少 Team/Agent/Task/session 绑定会被拒绝，不会静默
bypass。

### Codex

Codex 可以直接使用原生 Responses 路径，provider 可以这样配置：

```toml
# ~/.codex/config.toml — Codex → MemoryProxy → 支持 Responses 的上游
model = "<memoryproxy-model>"
model_provider = "memory-proxy"

[model_providers.memory-proxy]
name = "MemoryProxy"
base_url = "http://127.0.0.1:8096/codebuddy/<spaceId>/v1"
env_key = "MEMORY_PROXY_API_KEY"
wire_api = "responses"
requires_openai_auth = true
http_headers = {
  "x-team-id" = "<team_id>",
  "x-agent-id" = "<agent_id>",
  "x-task-id" = "<task_id>",
  "x-conversation-id" = "<stable-conversation-id>"
}
```

`MEMORY_PROXY_API_KEY` 是 MemoryProxy 接受的业务用户 key。上游 provider key
要在 MemoryProxy 的 `upstream.agents.codebuddy.apiKey`（或全局
`upstream.apiKey`）中单独配置；客户端 key 用于 MemoryProxy 鉴权，不会被
Responses handler 转发到上游。四个自定义 header 要在 tool call 间保持稳定。
`/codex/<spaceId>/v1` 也是已注册路由，auth/credit 的 space 提取器会识别
`codex`；实际使用哪个 agent 名称应与上游 profile 配置保持一致。

### CC Switch

如果 CC Switch 作为 MemoryProxy 前面的客户端/provider switch，选择其原生
**OpenAI Responses** 模式，并将 provider base URL 设为：

```text
http://127.0.0.1:8096/codebuddy/<spaceId>/v1
```

填写业务用户 API Key，并保留 `x-team-id`、`x-agent-id`、`x-task-id`、
`x-conversation-id`。这一段不需要启用 Responses → Chat 转换：MemoryProxy
已经接受原生 Responses，并将其转发给支持 Responses 的上游。如果 CC Switch
反过来作为 MemoryProxy 的上游，则把 `upstream.agents.codebuddy.url` 指向
它的 OpenAI-compatible `/v1` endpoint，并确认该 endpoint 提供 `/v1/responses`
以及 JSON/SSE。

### CLIProxyAPI

CLIProxyAPI 可以作为 MemoryProxy 的上游，通过它标准的 OpenAI-compatible
`/v1` endpoint 转发。原生 Responses 场景下，选中的 CLIProxyAPI provider
必须支持 `/v1/responses` 以及 JSON/SSE：

```yaml
# MemoryProxy/config.yaml
upstream:
  agents:
    codebuddy:
      url: "http://127.0.0.1:8317/v1"
      apiKey: "<CLIProxyAPI-api-key>"
```

如果 CLIProxyAPI 作为面向 Codex 的前置 sidecar，则把它的 custom provider
base URL 设为 `http://127.0.0.1:8096/codebuddy/<spaceId>/v1`，选择 OpenAI
Responses wire format，并保留四个 Team/Agent/Task/session header。原生
Responses 路径不需要 Responses → Chat 转换层。

## 已知限制

- 原生 Responses 复用 session、injection、限流、用量和最终 L0/Skill hook；但 cost-guard 路由扩展以及 Opik/Langfuse generation span 还没有 Responses 专用适配，上游选择使用 agent/global 配置。
- Responses 上游必须实现对应的 Responses endpoint；MemoryProxy 不会把 Responses 转换为 Chat Completions 或 Anthropic Messages。
- 启用 auth 时，根路径 `/v1/responses` 没有 `spaceId` 可供 `auth/verify` 使用；请使用 `/codebuddy/<spaceId>/v1/responses`、`/codex/<spaceId>/v1/responses` 或 `/proxy/<spaceId>/v1/responses`。
- `input`、`instructions`、`previous_response_id`、未知 JSON 字段和模型别名会保持语义。启用 session/memory injection 时，服务端会有意追加 `instructions` 并重新序列化请求。
- Responses 请求中的 Team/Agent/Task 与 session header 会按当前用户可见资源校验和绑定；缺少或不匹配时返回结构化 409。直接 header 注册要求有效 task id，交互式表单仍可按既有 Chat/Messages 流程使用。
- 用量日志与 Credit 上报都是 best effort。未知模型别名可能正常转发，但没有对应定价记录；Credit 提取同样依赖可识别的带 spaceId 路径。

## 主要 HTTP 端点

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/proxy/<spaceId>/v1/chat/completions` | OpenAI 兼容主模型调用（带 memory 实例 id） |
| `POST` | `/proxy/<spaceId>/v1/messages` | Anthropic Messages 主模型调用 |
| `POST` | `/proxy/<spaceId>/v1/responses` | 原生 OpenAI Responses 透明转发（JSON/SSE） |
| `POST` | `/<agent>/<spaceId>/v1/responses` | 原生 Responses 透明转发；启用 auth 时推荐 `codebuddy` |
| `POST` | `/v1/messages` | Anthropic Messages API（无 spaceId 兜底） |
| `POST` | `/*` | OpenAI 兼容聊天接口（catch-all） |
| `ALL`  | `/skill-bridge/**` | 反向代理 MemoryCore skill HTTP 工具 |
| `ALL`  | `/memory-bridge/**` | 反向代理 MemoryCore memory HTTP 工具 |
| `POST` | `/v3/instance/proxy-destroy` | 运维口：实例销毁时清 COS 缓存 |
| `GET/PUT/DELETE` | `/v3/admin/rate-limits` | 查询 / 修改实例 × 模型 TPM/QPM |
| `GET`  | `/health` | 运行时健康检查（含 `storage.effective`） |
| `GET`  | `/whoami` | API Key → keyId（纯文本，便于 curl） |

## 配置说明

完整带注释的示例见 [`config.example.yaml`](./config.example.yaml)。配置优先级：**CLI 参数 > YAML 配置文件 > 内置默认值**。

各配置段速览：

| 段 | 作用 |
| --- | --- |
| `server` | 监听 host / port、上游转发超时 |
| `upstream` | 默认上游 URL 与全局 `apiKey`（非空则替换转发请求鉴权） |
| `log` | 日志目录、级别、后端与轮转策略 |
| `redis` | 会话 / 注入 / Skill 状态默认后端；不启用 `storage.enabled` 时使用 |
| `storage` | 统一存储抽象（`cos` / `sqlite` / `fs` / `memory`），多节点部署首选 `cos` |
| `auth` | `x-tdai-user-key` → `user_id` 校验（调用 MemoryCore `/v3/meta/auth/verify`） |
| `admin` | 运维端点（如 `/v3/instance/proxy-destroy`）的 shared secret |
| `systemUsers` | 内部服务账号，命中后短路透传 |
| `injection` | 上下文注入总开关与 injector 列表（`skill` / `knowledge` / `tdai-memory`） |
| `extraction` | 对话回流总开关（skill 归档 + L0 写入） |
| `sessionInit` | 会话初始化表单流程、header 自动预选策略 |
| `tdai` | MemoryCore 连接与 L0/L1/L2/L3 开关 |
| `skill` | MemoryCore 数据面配置（Skill RAG、Skill 归档、Meta） |
| `knowledge` | 独立的 knowledge gateway（可与 skill 不同） |
| `skillRuntime` | 是否允许主模型写 Skill（默认只读） |
| `rateLimit` | Memory 实例 × 实际模型的 Input TPM / QPM 限流 |
| `clickhouse` | 按 turn 的用量上报（计费数据源） |
| `creditReport` / `creditPricing` | Credit 计费上报与定价表 |
| `upstream.agents` | 按 agent name 覆盖上游 URL + apiKey（如 `claude` 单独走 CCR） |

> `injection`、`extraction`、`sessionInit`、`tdai`、`skill`、`knowledge`、`skillRuntime` 是与“记忆”直接相关的配置段，接入时优先关注它们。

### 常用环境变量

```bash
TDAI_MEMORY_SYSTEM_USER_ID   # memory 内部服务账号 user_id
TDAI_MEMORY_SYSTEM_USER_KEY  # memory 内部服务账号 apiKey（仅供运维查看）
TDAI_PROXY_ADMIN_API_KEY     # 运维端点鉴权 shared secret
PROXY_DB_PATH                # sqlite 后端 db 路径（storage.sqlite.dbPath 未配时使用）
```

## 存储后端选型

`storage.enabled=true` 后所有会话/注入/Skill 状态（`inj:*` / `sk:*` / `vpin:*`）走 ProxyStorage：

| 后端 | 适用场景 | 说明 |
| --- | --- | --- |
| `cos` | 生产多实例部署 | 跨节点共享；仅支持 kernel-sts（每 spaceId 一份临时凭证） |
| `sqlite` | 单实例本地开发 / CI | 内置 sweeper 定时清 `ttl/` 桶；`nottl/` 桶永久保留 |
| `fs` | 离线 / docker 兜底 | 无 sweeper，交给外部 tmpwatch |
| `memory` | 兜底 / 测试 | 进程重启即清 |

Key 布局统一为 `proxy_cache/{ttl|nottl}/{spaceId}/{userId}/{agentSource}/{sessionId}/...`；`ttl/` 只放热缓存（可重建），`nottl/` 放 binding 等必须持久化的业务态。

降级链：`cos → sqlite → fs → memory`。任一后端 init 失败自动降级，`/health` 端点会暴露 `storage.effective` 作为观测锚点。

## Docker

镜像用 tsx 直接运行 TypeScript，以 `tini` 作 PID 1、非 root 用户运行，内置 `/health` 的 `HEALTHCHECK`。多阶段构建需启用 BuildKit。

在 `MemoryProxy/` 目录构建：

```bash
DOCKER_BUILDKIT=1 docker build -t memory-proxy:local .
```

启动容器（配置文件通过挂载 `/data/config.yaml` 提供；sqlite 存储持久化到 `/data/tdai-memory-proxy`）：

```bash
docker run --rm \
  -p 8096:8096 \
  -v "$PWD/config.yaml:/data/config.yaml:ro" \
  -v tdai-proxy-data:/data/tdai-memory-proxy \
  -e TDAI_PROXY_ADMIN_API_KEY="replace-with-a-strong-random-token" \
  memory-proxy:local
```

- 配置文件默认路径 `/data/config.yaml`，可在 `docker run` 末尾追加 `--config /other/path.yaml` 覆盖。
- 通过环境变量或 Secret Manager 注入凭证，不要把 API Key / STS 凭证写入镜像和配置仓库。
- 健康检查：`docker inspect --format '{{.State.Health.Status}}' <container>`。

## 目录结构

```text
MemoryProxy/
  src/
    index.ts / server.ts              入口与 HTTP 路由
    handler.ts / anthropicHandler.ts  OpenAI / Anthropic 请求处理器
    auth.ts / identity.ts             用户身份与鉴权
    systemUser.ts / systemUserPassthrough.ts  内部账号短路透传
    session/                          会话初始化：表单流程、状态存储、Claude Code / CodeBuddy 适配
    injection/                        注入 pipeline：skill / knowledge / tdai-memory 等 injector
    skill/                            Skill Bridge、conversation/add 归档触发、版本 pin
    memory/                           Memory Bridge 反向代理
    knowledge/ / meta/                MemoryCore knowledge / metadata 客户端
    tdai/                             Memory L0/L1/L2/L3 客户端、pending write 队列
    storage/                          ProxyStorage 抽象（cos / sqlite / fs / memory）
    db/                               会话 / 注入 / Skill 状态持久化 Repo
    rate-limit/                       Input TPM / QPM 限流
    routes/                           管理端点（admin-auth / instance-destroy / rate-limits）
    clickhouse.ts / langfuse.ts / opik.ts  三路可观测上报
    credit-reporter.ts / pricing.ts   Credit 计费上报与定价
    report/ / logger.ts               结构化日志系统与 JSONL 用量日志
  gateway/                            可选负载均衡网关（keyId 一致性 hash）
  docs/                               架构、设计文档与 e2e runbook
  scripts/                            冒烟、迁移、维护脚本
  config.example.yaml                 带注释的完整配置示例
  Dockerfile                          MemoryProxy 镜像
  proxy.sh                            后台启动 / 守护脚本
  package.json
```

## 运行测试

```bash
npm test              # vitest run（默认单元 + 集成）
npm run test:watch
```

`__tests__/` 分布在各子模块下：`session/__tests__`（会话流程）、`skill/__tests__`（归档触发、版本 pin）、`storage/__tests__`（各后端契约）、`db/__tests__`（Repo 一致性）等。`docs/` 还提供多份端到端 runbook（`e2e-runbook.md` / `e2e-full-coverage-runbook.md` 等），用于在真实 MemoryCore + Redis + Storage 后端上验证记忆链路。

## 安全与发布注意事项

- 非回环地址监听或多节点部署时，必须启用 `auth.enabled=true`，并通过 env 注入 `TDAI_PROXY_ADMIN_API_KEY` 保护运维口。
- 所有 Secret 通过环境变量或 Secret Manager 注入；不要把真实 `apiKey` / `serviceToken` / STS 凭证 / 计费 URL 提交进配置仓库。
- 部署到多节点时必须使用 `storage.backend=cos` 并显式配置 `injection.externalGatewayUrl`，否则每个实例各自缓存会导致上游 KV cache miss。
- 不要提交生成数据、本地数据库、日志或环境变量文件（`logs/`、`*.db`、`.env`、`dump.rdb`、`session*.json`、`*.pid` 等）。

## License

MIT
