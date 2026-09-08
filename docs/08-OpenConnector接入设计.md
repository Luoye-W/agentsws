# OpenConnector 接入设计

| | |
|---|---|
| 日期 | 2026-09-08 |
| 对象 | [oomol-lab/open-connector](https://github.com/oomol-lab/open-connector)（Apache-2.0）+ connector-sdk（MIT）；读了 README、runtime-api、credentials、catalog-format、programmatic-connections、instagram-oauth、verification 及仓库 provider 目录 |
| 结论 | **接入，而且它替我们干掉了自建清单里的两大项：公司级凭据加密存储、连接器的原始 API 层。** 它管"出站调用与凭据边界"，我们管"入站事件、职责语义、审批与执行器"。P1 Connect 付费线的技术形态也由它定了 |
| 状态 | 讨论稿 |

---

## 0. 它是什么

一个开源的**连接器网关**（Pipedream / Composio 的替代品）：用户把各服务的账号连一次，网关持有凭据并暴露一个统一目录（仓库里 1063 个 provider，托管版 1474 个 provider、16049 个 Action），Agent 和应用通过 MCP / HTTP / SDK 调用 Action，凭据永不出网关。

对我们最重要的几个事实：

| 事实 | 含义 |
|---|---|
| 凭据存 SQLite / PostgreSQL / D1，AES-256-GCM 加密，支持密钥轮换 | 我们不用再写"公司级凭据加密存储" |
| 每个 provider 可有多个**命名连接**（`default` / `work` / …），运行时 token 可限定 `allowedActions` / `blockedActions` / `allowedProxies` / `allowedConnections` | 一个 token 就是一份"这个职责能对哪个店铺账号做哪些动作"的策略——和我们 05 schema 的权限作用域一一对应 |
| OAuth 可指定 `requestedScopes` 子集，未知 scope 直接拒绝 | 按职责最小授权可以落到 provider 原生 scope |
| `Idempotency-Key`：24 小时内同键重放原响应，进行中返回 409 | 我们 apply 时用变更 id 做键，天然防重复施行 |
| 每次执行有 `executionId` 与脱敏的 run log | 与我们事件日志互链，满足 Model-visible ⟺ logged |
| MCP 端点只有 5 个发现式工具：`list_apps` / `list_connections` / `search_actions` / `get_action_guide` / `execute_action` | 16k 个 Action 不会塞爆 dsh 的工具列表 |
| 有 `/v1/proxy/:service` 直通 provider 原生 API | 目录没覆盖的端点也能走，且受独立策略约束 |
| 可跑 Node 22 / Docker / **单二进制** / Cloudflare Workers | 桌面 App 里可作 sidecar；托管档可放 Cloudflare |
| 自托管**必须自带各 provider 的 OAuth 应用**（Instagram 文档原话：不提供共享 Meta 应用）；OOMOL 托管版提供 OAuth 应用 + 月度 credits | 这正是 07 文档 P1 Connect 的形态，他们已经用同一套契约做了开源 / 托管两档 |
| `ProjectConnector`：让"你的用户"连"他们的账号"，你代为执行（Composio 模式） | 我们 Connect 的 SDK 形态 |
| provider 分 `locallyExecutable` / `catalogOnly` / `needsCredential`；verification 文档明说目录里的不等于验证过的 | 我们关键 provider 要自己跑冒烟 |

---

## 1. 它在我们架构里的位置

```
职责 Backend（读免费 / 写只 stage / apply 重跑 guardrail / provenance）   ← 我们：packages/core + services/executor
        │
连接器适配层（把 provider 原生 Action 映射成职责语义：线程、订单、客户；脱敏字段分级） ← 我们：packages/connectors（变薄）
        │                                                    ▲
OpenConnector runtime（凭据边界 · OAuth · 命名连接 · 策略 token · 幂等 · run log）   │ 入站：webhook / IMAP 轮询 /
        │                                                    │ 去重 / 队列 / 重试 ← 我们：packages/inbound
Provider API（Shopify / Gmail / Meta / WhatsApp / Klaviyo / …）──────────────┘
```

一句话分工：**OpenConnector 管出站调用和凭据，我们管入站事件、职责语义、审批与执行。** 它没有 webhook 接收、轮询、事件流（读到的文档里没有），所以"渠道连接器"的入站一半仍是我们的，dsh 的 webhook 包做最后一跳。

---

## 2. 六个结合点

### 2.1 凭据边界 = OpenConnector 的数据库

- 03 文档 §1.4 的"key 只存在公司实例（加密）"和 02 文档的 `secrets/` 区，物理上就是 OpenConnector 的数据库 + `OOMOL_CONNECT_ENCRYPTION_KEY`。导出 = 它的数据 + 密钥；密钥轮换用它的 `rotate-key`
- dsh 明文 YAML 里不再放任何 provider 凭据，只放 OpenConnector 的运行时 token（短期、按职责签发）
- 模型 key 不走它（它有 deepseek / openai provider，但模型调用要经我们的网关记账）

### 2.2 职责权限 → 运行时 token（这是最漂亮的对应）

05 schema 的 `connectors[].grants` 与 `scopes` 编译成 OpenConnector 的 token 策略：

| 05 schema | OpenConnector |
|---|---|
| `connectors[].kind` | provider `service`（`shopify_admin`、`gmail`、`meta`…） |
| `connectors[].grants` | OAuth `requestedScopes` 子集 |
| `scopes[].ops` 含 `read` | token `allowedActions` 里的读类 Action |
| `scopes[].range: assigned` 的店铺 / 账号 | token `allowedConnections`（命名连接的稳定 id） |
| 写操作 | **不进 Agent 的 token**，见 2.3 |

每个 Assignment 编译出**两个 token**：

| token | 持有者 | 能做什么 |
|---|---|---|
| `role-read` | 给 dsh 运行时（随 RunRequest 下发） | 该职责允许的读 Action + 允许的连接；写 Action 在网关层被拒 |
| `role-apply` | 只有执行器持有 | 该职责的写 Action；只在审批通过后的 apply 里使用，`Idempotency-Key = change_id` |

这样"Agent 不能直接写"不只是我们执行器的约定，网关层也挡一道——纵深防御。撤销职责 = 删 token，立即生效。

### 2.3 读走原生 Action，写走 Backend；长尾写用"通用 staged action"

| 类型 | 路径 | 理由 |
|---|---|---|
| 读 | **有字段分级的数据域（订单、客户、商品成本等）不允许 MCP 直读**，只经我们的语义适配层（09-08 改，31 §3.1）；无敏感字段的只读 Action 可经 MCP 直调，受 `role-read` 限制 | 直读会绕过字段级过滤（评审 F2） |
| 核心写（退款、改价、发信、发帖） | 只经我们的 Backend `stage_*` → 审批 → 执行器 apply（用 `role-apply` 调 Action） | 需要 guardrail、provenance、额度 |
| 长尾写 | `staged_action` **v1 关闭**（31 §3.2）：所有写只经已建模的 ChangeKind；重开前提是能把通用 Action 映射到真实业务效果并套用同一额度 | 评审 F3：通用写接口会绕过业务额度 |

`staged_action` 的存在让"新接一个服务"从"写连接器"变成"在职责里加一行 allowedActions"。这是接入 OpenConnector 最大的产品收益。

### 2.4 入站仍是我们的

Shopify / Meta / WhatsApp 的 webhook 接收、IMAP 轮询、飞书事件订阅、去重键、幂等、重试、排队，都在 `packages/inbound`；入站产生的事件进事件流，触发 RunRequest。OpenConnector 只在 Agent 需要"再读一遍"或"回写"时被调用。

### 2.5 个人 → 部门 → 公司的生长（对齐 03 §7.4）

| 阶段 | OpenConnector 的形态 |
|---|---|
| 个人 | 桌面 App 内置一个本地 runtime（单二进制 sidecar），连接是本人的 |
| 部门 / 公司 | 共享工作区跑一个 runtime；公司资产类连接（公司邮箱、店铺）在这里，命名连接按店铺 / 账号 |
| Join | 公司资产类连接从个人 runtime 迁到共享 runtime（`/v1/connections/by-id/:appId` + 重新授权或凭据搬迁）；个人身份类连接留在本地 runtime |
| 个人客户端（Join 后） | 本地 runtime 只剩个人渠道；**不持有共享工作区的 token**（09-08 删，31 §3.5）；对共享数据的访问经共享 runtime 的 API 以本人身份进行 |

### 2.6 Connect（P1）= 我们托管的 OpenConnector + 我们的 OAuth 应用

用户有两条路，界面上就是"连接"按钮后的一个选择：

| 路 | 谁的 OAuth 应用 | 适合谁 | 免费 / 付费 |
|---|---|---|---|
| 自带应用 | 用户自己在 Meta / Google / TikTok 后台建的 | 有开发者、或只用 API key 类服务（Shopify 自建 app、Klaviyo、AfterShip） | 免费 |
| agentsws Connect | 我们持有的应用（已过审、配额高） | 绝大多数非 IT 用户 | 免费限额 + 席位 / 按量 |

技术上 Connect 就是一套我们托管的 OpenConnector runtime（Cloudflare Workers + D1 + R2 部署方式现成），以 `ProjectConnector` 模式让用户的本地 / 共享 runtime 代表用户发起授权。是否直接用 OOMOL 托管版转售，见 §5 待拍板。

---

## 3. provider 覆盖对照（仓库 `src/providers` 目录，2026-09-08）

| 我们的连接器需求 | 状态 | 备注 |
|---|---|---|
| Shopify | ✅ `shopify` `shopify_admin` `shopify_partner` `shopify_storefront` | 01 开工顺序里"Shopify 只读 MCP"不用自己写了 |
| 邮箱 | ✅ `gmail` `outlook` `qq_mail`；发信 `resend` `sendgrid` `mailgun` `postmark` `brevo` | 通用 IMAP / SMTP **没有**（阿里企业邮、Zoho 要补）；收信轮询本来就是我们入站层的事 |
| Meta（Facebook / Instagram） | ✅ `meta`；Instagram 有专门文档（Business Login，五个权限） | 需要 Meta 应用；Connect 的第一个用例 |
| WhatsApp | ✅ `whatsapp`；另有 `waboxapp` `twochat` `unipile` | Cloud API 仍要 BSP / 企业验证；`unipile` 是 LinkedIn + WhatsApp 统一消息，值得看 |
| TikTok | ⚠️ 只有 `tiktok_business`（广告） | TikTok Shop、TikTok 内容 API **缺** |
| Amazon | ❌ SP-API、Amazon Ads 都缺（只有 `asin_data_api` 第三方数据） | 必须我们贡献；这是 Amazon 运营岗位的前提 |
| Google | ✅ `googleads` `google_analytics` `google_search_console` `googlesheets` `googledrive` `googlecalendar` | Merchant Center **缺** |
| Klaviyo / 邮件营销 | ✅ `klaviyo` `omnisend` `mailchimp` | |
| 物流追踪 | ✅ `aftership` `ship_station` `shippo` `easypost` `ship_bob` | 17track 缺（AfterShip 够用） |
| 评价 | ❌ Judge.me、Loox 缺 | `gorgias` `zendesk` `loop_returns` 有 |
| 社媒 | ✅ `youtube` `linkedin` `twitter` `bluesky` `telegram` `discord`；`ayrshare`（多平台发帖聚合） | Pinterest 缺；小红书缺（`xiaohongshu` 无） |
| 会议 | ✅ `zoom` `recallai` `fireflies` `tldv` `otter_ai` | 会议 bot 走 `recallai` 一个 Action 接四家 |
| 飞书 / 企微 / 钉钉 | ⚠️ `feishu_app_bot` `feishu_custom_bot` `wecom_bot` `dingtalk_bot`——**只有机器人消息** | 通讯录、文档、审批卡片回调都缺；身份 provider 仍我们自己做（03 §1.5 的结论不变）；`tencent_docs` 有 |
| 数据供给 | ✅ `apify` `phantombuster` `bright_data` `firecrawl` `similarweb` `semrush` `dataforseo` `ahrefs` `tikhub` `crunchbase` | 海关数据（ImportGenius / Volza）缺 |
| 归因 / 分析 | ✅ `triple_whale` `northbeam` `mixpanel` `posthog` | |
| 存储 / BYOC | ✅ `supabase` `neon` `turso` `cloudflare_r2` `aliyun_oss` `aws_s3` | |
| 模型 | ✅ `deepseek` `openai` `anthropic` `gemini` `qianfan` `minimax` `openrouter` | 不经它调模型（走我们网关） |
| 收款 | ✅ `stripe` `paddle` `lemon_squeezy` | Waffo / Creem 缺，但那是我们收款不是客户的 |

**要贡献上游的清单（按优先级）**：Amazon SP-API → Amazon Ads → TikTok Shop → 通用 IMAP / SMTP → 飞书通讯录与文档 → Merchant Center → Pinterest → Judge.me / Loox → 海关数据。与 dsh-channels 的策略一样：fork + vendored + 契约测试，合并后转为依赖。贡献本身把我们放到跨境电商 provider 的上游位置。

---

## 4. 对既有文档的改动

| 文档 | 改什么 |
|---|---|
| README / 03 §1.3 | `packages/connectors` 拆为 `connect-adapter`（对 OpenConnector 的薄封装 + token 签发，与 dsh-adapter 同一纪律：唯一允许 import 它 SDK 的地方）、`inbound`（webhook / 轮询 / 去重 / 队列）、`providers-contrib`（我们贡献上游的 provider，vendored 至合并） |
| 01 开工顺序 | 第 4 步"外部 MCP server 三个"改为两个：知识库检索（我们）+ OpenConnector 的 MCP（配 `role-read` token）；Shopify 只读不再自写。第一阶段加"OpenConnector 冒烟：Shopify admin / Gmail / Meta / WhatsApp / Klaviyo 的关键 Action 逐个验证" |
| 02 换机迁移 | `secrets/` 区 = OpenConnector 数据库 + 加密密钥；导入后用它的 `/v1/connections` 列出需重新授权项 |
| 03 §1.4 | 模型网关不变；"凭据分发与撤销"改由 OpenConnector token 承担 |
| 05 schema | `ConnectorDependency.kind` 改为 OpenConnector `service` id；新增 `WriteAction.kind = 'staged_action'` |
| 07 P1 | Connect 的技术形态 = 托管 OpenConnector + 我们的 OAuth 应用 |
| 自建清单 | 划掉"公司级凭据加密"；"渠道连接器"缩为"入站层 + 语义适配 + 上游贡献" |

---

## 5. 风险与待拍板

**核实（09-08，`SECURITY.md`）**：admin 与 runtime 鉴权**默认关闭**；无 `OOMOL_CONNECT_ENCRYPTION_KEY` 时凭据与 idempotent 响应**明文**；每个 provider proxy **默认允许**直到用变量限制，Action 策略不约束 proxy；持久 token 的 `allowedProxies` 空 = 拒绝 proxy，但 `allowedConnections` 空 = **不限制连接**；安全修复只发在最新版。→ 安装器强制：`ENCRYPTION_KEY` + `ADMIN_TOKEN` 未设不启动；`OOMOL_CONNECT_BLOCKED_PROXIES="*"` 默认；role-read token 的 allowedConnections 必须非空；升级策略不能永久锁旧版（上游哨兵盯安全公告）。

**风险**

1. **成熟度**：目录大不等于能跑。verification 文档自己承认 `catalogOnly` 的存在。要在开工第一阶段对我们的 10 个关键 provider 做冒烟，统计 `locallyExecutable` 比例，不合格的自己补 executor
2. **命名与契约耦合**：`OOMOL_CONNECT_*`、`x-oo-*` 头、`oct_` token——全部收在 `connect-adapter` 里，与 dsh-adapter 同一纪律，不让业务代码碰
3. **单管理员模型**：自托管 runtime 只有一个管理员身份，多用户靠 token 策略区分。这与"每工作区一个 runtime + 协同服务签发 token"的用法吻合，但**不能**让用户直接碰它的 Web Console（那是管理员面）
4. **中国跨境缺口**：Amazon、TikTok Shop、飞书 / 企微全功能都要我们补，工程量不小；但这正是我们该占的上游位置
5. **依赖一家公司**：OOMOL 也在做 Agent 桌面产品（Wanta）；我们只依赖 Apache-2.0 的 runtime，不依赖其托管服务，Connect 自己托管

**待拍板**（09-08 Luoye：第 1 项定案——自己托管 + 自己的 OAuth 应用，短期可借 OOMOL 托管跑通 Meta / Google）

1. ~~Connect 用自己托管的 OpenConnector runtime + 自己的 OAuth 应用，还是转售 OOMOL 托管版？~~ 已定：前者。我倾向前者：OAuth 应用是 Connect 的核心资产，且 OOMOL 没有 Amazon / TikTok Shop；可以短期用 OOMOL 托管跑通 Meta / Google，同时申请自己的应用
2. 长尾写的 `staged_action` 是否 v1 就开（我倾向开，但默认 allowedActions 为空，由 owner 按职责逐个放行）
3. 上游贡献的第一个 provider 选 Amazon SP-API 还是通用 IMAP / SMTP（前者是 Amazon 岗位的前提，后者是客服岗位的前提；我倾向 IMAP / SMTP 先，因为 v1 楔子是客服）
