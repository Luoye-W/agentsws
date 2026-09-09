# @agentsws/connect-adapter

见 docs/34 §2、docs/08、docs/18 §1。**唯一允许 import `@oomol-lab/connector` 的包**——`OOMOL_CONNECT_*`
变量、`x-oo-*` 头、`oct_` token 全部收在这里，业务代码只看 `Connect` 契约。

对接**自托管的 OpenConnector 本地 runtime**（`ghcr.io/oomol-lab/open-connector`）：

| 契约方法 | 上游 |
|---|---|
| `providers()` / `actions(service)` | `GET /v1/providers`、`GET /api/providers/:service`；`side_effect` 由 `action-side-effects.yml` 决定（未标按 `write`） |
| `connections()` | `GET /api/connections` + 本地 workspace / ownership 元数据 |
| `beginConnect()` | oauth2 → `POST /api/oauth/authorizations`；api_key / custom_credential → 由 provider 的 `auth` 元数据生成 secure form 描述（**凭据不经本包**，由不经模型的原生表单直接 `PUT /api/connections/:service`） |
| `pollConnect()` | 轮询 `GET /api/connections` 看目标 alias 是否出现（上游没有 connection-request 读接口） |
| `submitForm()` | `PUT /api/connections/:service`（body `{ authType, connectionName, values }`）——WP20 原生表单直填的落点。**`values` 只在这一次转发里存在**：不进本包状态、不进事件（事件里只有字段名）、不进返回值 |
| `removeConnection()` | 先试 `DELETE /api/connections/:service/:connectionName`，再试 `DELETE /api/connections/:id`；两条都不通抛 `not_implemented`（09-09 那次录制没打到管理面的删除端点，形状待实机确认，**绝不静默当成删掉了**） |
| `transferConnection()` | v1：同一 runtime 内改本地 ownership / workspace 元数据；跨 runtime 未实现 |
| `issueToken()` / `revokeTokens()` | `POST /api/runtime-tokens`、`GET`/`DELETE /api/runtime-tokens/:id` |
| `execute()` | `POST /v1/actions/:id`（经 SDK `OpenConnector.executeRaw`）+ `Idempotency-Key` + `x-oo-connector-alias` |
| `proxy()` | 一律本地拒绝（role-read 的 `allowedProxies` 恒空；role-apply v1 也不开） |

安装器策略见 `assertRuntimeHardened()`：鉴权未开或加密无法确认时返回 `{ ok: false, reasons }`，
server 装配不通过则拒绝启动。

测试两档：

- **录制**（本机有 docker）：`RECORD_FIXTURES=1 vitest run packages/connect-adapter/test/record-fixtures.test.ts`
  起一个真的 `ghcr.io/oomol-lab/open-connector` 容器（随机端口 / 随机 admin token 与加密密钥 /
  `OOMOL_CONNECT_BLOCKED_PROXIES=*`）+ 一个本地 stub provider，用适配器自己把全部场景跑一遍，
  把**脱敏后**的 HTTP 交互写进 `test/fixtures/`（磁带里没有任何凭据原文）。
- **回放**（CI / 无 docker）：把同一份磁带注入 `fetch`，默认档就是这个。

契约一致性套件 `test/connect-conformance.ts` 接受任意 `Connect` 实例，对 stand-ins 的 mock
与本适配器（回放档）各跑一遍——两边行为不一致就会在这里露出来。

冒烟：`node packages/connect-adapter/scripts/smoke-connect.ts`（需要真凭据，缺就跳过并打印原因）。
