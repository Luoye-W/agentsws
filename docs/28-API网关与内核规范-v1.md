# API 网关与内核规范 v1

| | |
|---|---|
| 日期 | 2026-09-08 |
| 对应 | 09 §0 API 化、§2 内核服务；16 §1 profile；13 §5 Electron 壳 |
| 原则 | ① 唯一入口，所有客户端平等 ② 内核 = Cordis 容器，模块 = 插件 ③ 拉取不执行代码 ④ 急停一个变量 |

## 1. 内核（Cordis）

- 每个契约模块是一个 Cordis 插件：`inject` 依赖的服务、`provide` 自己的服务、`Config` Schemastery 校验、`ctx.effect()` 注册回收；热替换靠 fiber 状态机
- 模块清单 `modules.yml`：`{ id, provides: {contract: version}, requires: {contract: range}, entry, signature }`；装载器校验签名与允许源（官方 / 公司私有）；不满足 requires 则挂起等待（Cordis 语义）并在 doctor 里报
- 内核服务：event-log（21）、config、typed events、lifecycle、health、trace（OpenTelemetry；trace_id 贯穿 run→tool→action→apply→delivery）、budget（22 §3 三级 + 工具调用 / 时长）、halt（`AGENTSWS_HALT=all|model|outbound|learning`）
- 进程：协同服务一进程（含内核与全部模块）+ dsh sidecar（每运行一进程，headless）+ OpenConnector sidecar；托管档一工作区一组

## 2. API 网关

- 协议：HTTP JSON（REST 风格路径见各规范）+ JSON-RPC（内部批量）+ WebSocket 事件流（`/events?since=<ulid>&types=`，断线按 ulid 续）
- OpenAPI 由契约类型自动生成；每个模块的 API 只是其服务方法的投影，不许网关里写业务
- 鉴权：Bearer（浏览器 cookie / API key / 运行时短期 token / 内部服务凭据）；每请求解析 `{ person, workspace, assignment?, kind }`；跨工作区显式头
- 幂等：所有 POST 接受 `Idempotency-Key`，24h 重放
- 限流与预算：按 workspace × kind；超限 429 带 retry-after
- 版本：路径 `/v1`；破坏性变更并排 `/v2`，旧版保留一个大版本
- 错误：统一 `{ code, message, details, trace_id }`；code 表跨模块复用（`not_found / forbidden / sod_violation / not_approved / stale_record / budget_exhausted / connection_not_allowed / …`）
- MCP 面：`/mcp`（知识检索、队列、只读数据）供 Claude Code / dsh 接；工具即 API 方法的白名单子集

## 3. 客户端

| 客户端 | 用什么 |
|---|---|
| 工作台 Web（Electron 内 / 浏览器） | REST + WS；桥接层特性检测 |
| CLI | 同一 OpenAPI 生成的客户端 |
| dsh-adapter / 执行器 | 内部凭据；RunRequest / RunResult 经 API，不走进程内捷径（可替换性） |
| 浏览器插件 | API key（配对） |
| IM 卡片回调 | 投递 provider 的 webhook → `/approvals/{id}/decide` |
| 付费应用远程 Backend | 我们调它（OpenAPI 契约）；它回调我们用 entitlement token |

## 4. 一致性用例

1. 工作台任何功能仅经 `/v1`（网络层断言：无其他端口 / 通道）
2. 未签名模块装载被拒；requires 不满足的模块处于挂起并在 `/health` 可见
3. `AGENTSWS_HALT=outbound` 后所有 send / apply 返回 `halted`，读照常
4. WS 断线以 ulid 续传无丢无重
5. 同 Idempotency-Key 的 POST 重放返回原响应
6. trace_id 从入站事件到投递回调可在 Langfuse / 日志中连成一条
