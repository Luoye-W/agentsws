# 应用包与市场 API 规范 v1（契约 #11 包与分发 · #18 市场与授权）

| | |
|---|---|
| 日期 | 2026-09-08 |
| 对应 | 11（市场与包）、12（DevKit、命名「应用」）、16 §4（dsh 插件三档）、07 P6、teamai 分发协议 |
| 原则 | ① 安装单元 = 包（对外「应用」）；内容为声明 ② 拉取永不自动执行代码 ③ 签名 + 允许源 ④ 本地 `agentsws test` 跑与市场相同的自动管线，**但不等于审核通过**（发布者身份、隔离、隐藏场景、远程服务行为由市场侧独立验证；09-08 改） |

## 1. package.yml（定稿，11 §2 的基础上补齐）

```yaml
id: <publisher>/<name>; version: semver; kind: role-pack|position|starter|skill|block|connector|backend|dsh-plugin-wrapper
name: {zh, en}; description: {zh, en}; category: [客服, 独立站, …]; tags: []
publisher: { id, tier: official|verified|community }; license; homepage; changelog_url
pricing: { model: free|credits|subscription|one-time; plan_ref? }
provides: { roles[], positions[], starters[], skills[], blocks[], scenarios[], backends[], connectors[], tools[]: {plugin, tool, side_effect} }
requires: { contracts: {name: range}, agentsws: range, connectors[], permissions[], model_budget, packages[]: {id, range} }
compat: { tested_with: { agentsws: [], dsh: [], open_connector: [] } }      # 沙盒加载结果，registry 写入
upgrade: { breaking_permissions: bool, migrations[] }
telemetry: { opt_in_health: bool }
signature: { sigstore_bundle }
files: [ roles/*.yml, skills/*/SKILL.md, blocks/*.json, scenarios/*.yml, backend.yml, connector/… ]
```

约束：`provides.tools[].side_effect` 必填（16 §3）；`kind: connector | dsh-plugin-wrapper` 才允许含代码引用；`files` 里不得有可执行入口除上述两类。

## 2. 本地包管理（#11）

```ts
interface Packages {
  resolve(spec): Manifest                                  // 从允许的源解析、校验签名与兼容
  install(manifest, { workspace, consent_event_id }): InstallResult   // 声明类：写内容仓 + 注册；connector：装进 OpenConnector runtime；wrapper：按 profile 装 dsh 插件（仅个人端或 verified）
  uninstall(id, { keep_data: true })
  upgrade(id, to)                                          // 公司端生成 app_upgrade 审批项；个人端直接（可回滚）
  list(); status(id)                                       // 就绪检查：连接器、权限、依赖
  trial(id): SandboxWorkspace                              // "先试试"：复用模拟回路
  sync(): ReportSyncAck                                    // §4 分发协议
}
```

叠加解析（技能）：个人 > 部门 > 公司 > 包基础版；同名 premium 覆盖 open（06 §3）。

## 3. Registry API（#18）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/registry/search?q=&category=&kind=&tier=` | |
| GET | `/registry/packages/{id}`、`/{id}/versions`、`/{id}/health` | health = 匿名计数 |
| GET | `/registry/packages/{id}/{version}/download` | 签名 URL |
| POST | `/registry/publish` | 上传 → 审核管线（§5） |
| GET | `/registry/publish/{id}/status` | |
| POST | `/registry/entitlements` / GET `/entitlements?workspace=` | 免费 = 自动发放；付费 = 钱包 / 订阅（12 §4） |
| POST | `/registry/reviews`、`/reports` | |
| POST | `/registry/telemetry` | 只收计数：安装、留存、采纳率、干预率、卸载原因 |

私有 registry 同一 API；客户端 `registries[]` 允许多源，签名密钥按源信任。

## 4. 分发协议（teamai HTTP 模式的形状）

- `POST /dist/report`：客户端上报已装清单与版本（会话启动）
- `POST /dist/sync`：返回命令 `[{ id, type: install|update|uninstall|tombstone, package, version, download_url, signature }]`
- `POST /dist/commands/ack`：`{ id, status, error }`
- 客户端规则：命令只安装声明类内容；含代码的（connector / wrapper）只提示，需人确认；download host 白名单；`AGENTSWS_DISABLE_REMOTE_CMD=1` 拒绝一切远程命令

## 5. 审核管线

自动：schema 校验 → 签名 → 契约版本兼容 → 一致性套件（含替身）→ 沙盒加载（dsh profile 内，撞名、出网观察）→ 权限声明 vs 实际调用比对 → 场景跑通（fast 档）→ 策略 lint（community 不得含代码）。人工：connector / backend / wrapper。结果写 `compat.tested_with`。本地 `agentsws test` 跑完全相同的管线。

## 6. 一致性用例

1. 未签名包安装被拒；签名有效但源不在允许列表被拒
2. community 包含 `files` 可执行入口 → 审核 lint 失败
3. `sync` 下发 connector 安装 → 客户端只提示不执行
4. 升级带 `breaking_permissions` → 公司端生成审批项且要求重签权限
5. 卸载后该包产生的客户记录仍在（keep_data）
6. tombstone 命令删除已下架包的本地副本，用户自建内容不动
7. trial 在沙盒工作区跑包内场景并出报告，不触碰真实连接
