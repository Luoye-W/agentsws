# Shopify 接入 v1

| | |
|---|---|
| 日期 | 2026-09-10 |
| 起因 | 老的接法只能"读一读、提个建议"。要让 Agent 真的**操作、编辑、优化店铺**，得先把 Shopify 官方到底给了什么、没给什么查清楚——不是凭记忆，是逐条实查 |
| 范围 | 连一家店、读店铺、写店铺、改主题、查文档与校验 GraphQL；出站防护在代理环境下的表现 |
| 关系 | 08 §2.3（读走原生 Action、写走 Backend）、12 §2（建站岗位）、15 §2（变更种类与 hard_ceiling）、18 §1（连接器契约）、27（职责模板）、35 §4（派工） |
| 实查 | 2026-09-10，对着 `@shopify/dev-mcp@1.15.0` 带的 Admin schema（2026-10 版）与官方 CLI 4.8 的 flag 表 |

## 0. 一句话

**Shopify 后台没有官方 MCP。** 想让 Agent 动店铺，只有 Admin GraphQL API 一条路；
主题是例外，它走官方 CLI。官方的三个 MCP 里只有 Dev MCP 与我们这一版有关，
而它**碰不到任何一家店**——它只会查文档和验语法。

把这句话拆开，就是下面三张表。

---

## 1. 官方给了什么（2026-09-10 实查）

### 1.1 三种官方 MCP，逐个说清

| | 它是什么 | 能碰店铺数据吗 | 我们怎么用 |
|---|---|---|---|
| **Dev MCP**（`@shopify/dev-mcp`） | 本机起的 stdio 进程，查开发者文档、取 Admin GraphQL schema、验一段 GraphQL 成不成立 | **不能**。它连店铺域名都不需要，没有任何鉴权 | ✅ 接进运行时，三个只读工具（§2.5） |
| **Storefront MCP** | 面向**顾客**那一侧：搜商品、看购物车、下单流程 | 能，但走的是店面（Storefront）身份，看到的是顾客能看到的那些 | ⬜ 二阶段（§3.3） |
| **Customer Accounts MCP** | 面向**已登录顾客**：查自己的订单、地址、订阅 | 能，需要顾客本人授权 | ⬜ 二阶段（§3.3） |

**没有 Admin MCP。** 这一条是这份文档最重要的事实：想让 Agent 改价、上下架、发折扣码、
改订单地址，官方**没有**给一个"MCP 工具"让你调，只有 Admin GraphQL API。
所以我们的写口全部落在 08 §2.3 那条既有的路上——经连接器的原生 Action，由执行器发起。

### 1.2 Admin GraphQL API

- 后台能做的事基本都在这儿（五百多个 mutation），版本按季度走，当前 `2026-10`。
- 主题相关的 `themePublish` / `themeFilesUpsert` **2024-10 起确实有**，
  但要 `write_themes` **加上向 Shopify 单独申请的豁免**——所以主题我们仍然走 CLI（§2.4）。
- 有几类东西 Admin API 给得出、但 15 §2 的变更目录里**没有对应的 kind**，于是我们不给入口（§3.2）。

### 1.3 Shopify CLI

主题开发的官方路径。它用的是 CLI 自己那套登录（或 Theme Access 密码），
**不经我们的连接器**——这一点在模拟层和真身里都要保持一致，否则出站观察表里
会凭空多出一条根本不存在的记录。

实查订正两处（都写进了代码注释，免得下次又按记忆写）：

- `theme pull` **没有** `--force`（那是 `publish` 的 flag）；非交互模式下
  `--live` / `--development` / `--theme <id>` 必须三选一。
- `theme push --unpublished` 造出来的永远是副本，线上一个字节不动。

---

## 2. 我们怎么接

### 2.1 连一家店：只有一条路

`apps/server/src/catalog.ts` 的 Shopify 条目 `flow: 'shopify_client_credentials'`。
表单三个字段：店铺域名、Client ID、Client secret。

换令牌走 OAuth 2.0 **client credentials grant**
（`POST https://{shop}.myshopify.com/admin/oauth/access_token`），
拿到的访问令牌 24 小时过期、**没有 refresh token**——同样的请求再发一次就是刷新，
`apps/server/src/shopify-broker.ts` 提前一小时自动续，用户不用管。

四条纪律写死在那个模块里：

1. 密钥与访问令牌**永远不进日志、事件与响应体**；事件里只有店铺域名、连接 id、过期时间、授到的权限串。
2. 密钥只落在本机的加密库（AES-256-GCM），每次换令牌读一次。
3. **访问令牌我们这边一个字节都不存**——直接 PUT 进 OpenConnector 的凭据库，本地只留过期时间。
4. 换令牌成功之后才存密钥。换不到就别把密钥留在本机。

界面：`docs/assets/workstation/shopify-connect-card.png`（卡上只有一种接法，没有"选哪条"这一步）。

### 2.2 读：原生 Action

照 08 §2.3 不变。Agent 拿 `role-read` 令牌调 `get_order` / `list_orders` / `get_product` 这些，
读到什么进 provenance，`before` 只能来自读回来的记录。

岗位页的店铺后台面板就是这些读口的产物：`docs/assets/workstation/shopify-position-panel.png`。

### 2.3 写：Admin 写动作 → ChangeKind → 账本

`packages/connect-adapter/src/shopify-actions.ts` 是这一版的核心表：
**33 条 Admin 写动作**，每条要么给出 15 §2 目录里的一条 kind，要么写清为什么给不出。

- **25 条有 kind**，用到 10 种：`listing_edit`（13 条）、`discount_code`、`promotion`、
  `publish_theme`、`price_change`、`publish_product`、`unpublish_product`、
  `refund`、`reship`、`address_change`。
- **8 条明说不给**（§3.2）。`canStageAction()` 把那句理由**直接说给模型听**——
  比回一句 `forbidden` 有用得多，模型看得懂"这条要先定一个新 kind"就不会反复试。

`execute_graphql` / `submit_bulk_query` **不在这张表里**，而且永远判成写外部：
它们的副作用取决于运行时传进来的那段文档，谁也事先说不准（§3.4）。

### 2.4 主题：走 CLI，发布才进账本

`apps/server/src/shopify-theme.ts` 以子进程跑官方 CLI：

| 这一步 | 命令 | 它是什么 |
|---|---|---|
| 看现在线上是哪一份 | `theme list --json` | 读 |
| 拉下来改 | `theme pull --live` / `--theme <id>` | 读 |
| 推一份副本 + 拿预览链接 | `theme push --unpublished --theme <name> --json` | **stage**——线上不动 |
| 本地热重载预览 | `theme dev` | 读 |
| 换线上那一份 | `theme publish --theme <id> --force` | **apply**——只有批准过的变更才该调它 |

12 §2 那句话就落在这张表上：**未发布的主题副本就是 stage，预览链接就是审批材料，
发布就是 apply。** `proposePublish()` 组的那条提案 `risk_class` 恒为 `high`，
`before` 取自 `theme list` 真读到的线上主题——不是模型说的那一份。

子进程的环境变量是**白名单**（`PASSTHROUGH_ENV`：`PATH` / `HOME` / `TMPDIR` / … 12 个），
秘密库密钥、连接器管理令牌、模型 key 一个都不往下传。
CLI 用的 Theme Access 令牌**作为函数参数传进来**，不从 `process.env` 读。
那张白名单上有一句注释，抄在这里：**"别往这张表里加东西——每加一个都是一条
'我们的秘密可能被第三方 CLI 读到'的路。"**

CLI 没装不是错误：`status()` 回 `installed: false` 加一条能直接复制的 `npm i -g @shopify/cli`。

配套新职责 `site.builder`（12 §2 的建站岗位）：预览可以到 L3，
发布 `hard_ceiling` 永远 L1 且立刻通知所有者；商品只读——改价是 `dtc.ops` 的事。

### 2.5 查文档与校验：Dev MCP

`apps/server/src/shopify-devmcp.ts` 起 `npx -y @shopify/dev-mcp@1.15.0`（stdio JSON-RPC），
对模型只暴露**三个我们自己命名的只读工具**：

| 我们的名字 | 干什么 |
|---|---|
| `shopify.docs.search` | 搜官方开发者文档 |
| `shopify.schema.introspect` | 取 Admin GraphQL schema 的某一片 |
| `shopify.graphql.validate` | 拿真 schema 验一段 GraphQL——**只验不跑** |

上游工具名一直在变（09-10 实查 1.15.0：`search_dev_docs` / `introspect_admin_schema`
**已经没有了**，换成 `search_docs_chunks` / `learn_shopify_api`），所以按候选表挑，新旧两代都认。
我们暴露给模型的三个名字**不跟着上游变**——上游改名不该让模型重新学一遍工具。

**写类变更 stage 之前必须过一次 `guardGraphqlStage()`**，两种放行、一种拦截：

| 校验结果 | 怎么办 | 为什么 |
|---|---|---|
| 不成立 | **拦住**，把官方那句 "Did you mean …" 原样交回给模型，记 `shopify.graphql_rejected` | Admin GraphQL 五百多个 mutation，模型编一个不存在的字段名太容易了。在提案进人的队列**之前**挡住，比让人在审批卡上发现"这条根本跑不通"便宜 |
| 成立 | 放行 | |
| Dev MCP 起不来 / 结果读不懂 | **放行但记 `shopify.graphql_unvalidated`**，审批卡上标明"没经过官方校验" | 校验是加固，不是门禁；真门禁在 15 的账本那一侧。但读不懂**绝不判成"通过"**——那等于把幻觉洗成官方背书 |

默认**不起**（要联网 `npx` 拉包），`AGENTSWS_SHOPIFY_DEVMCP=1` 打开。
起不来时 `toolDefs()` 回空数组——模型不该看见一个它调不了的工具。

---

## 3. 什么不做，以及为什么

### 3.1 `shpat_` 直填令牌：删了

Shopify 2025 之后新建的自定义应用只在 Dev Dashboard 里给客户端 ID + 密钥。
保留两条接法只会让非技术用户在两张表单之间猜；而且 `shpat` 那串**不会过期**、
撤销全靠人记得去后台删——权限与轮换都不如客户端凭据。

已经用老办法接上的连接不会当场坏：启动时认出来（OpenConnector 里有、我们这边没有客户端凭据）
标成 `legacy`，界面上给一条黄色提示说清为什么要换、怎么换。

### 3.2 八条给得出 API、给不出 kind 的写动作

15 §2 的规矩是：**新增一种变更 kind，要先定风险级、默认额度、硬约束，
还要有一个合成执行器能验它。** 在那之前不给入口——不是"暂时没做"，是"故意不给"。

| 动作 | 为什么不给 |
|---|---|
| `delete_product` / `delete_theme` / `delete_discount_code` | 删除不可逆，目录里没有对应 kind。删掉一个正在被人用的折扣码，已经拿到码的客户会当场结算失败 |
| `set_inventory_quantities` / `adjust_inventory_quantities` | 库存既不是 `listing_edit`（不改商品信息）也不是 `price_change`，改错直接超卖——需要一条自己的 `inventory_change`，带"单次调整上限"这类额度 |
| `update_order` | 订单写口目录里只有 `address_change`（带 `unfulfilled_only` 与受保护字段）。通用的"改订单任意字段"没有额度可套，等于给 Agent 一个绕过 protected 的口子 |
| `cancel_order` | 取消订单连带退款与库存回补，影响面比 `refund` 大 |
| `create_theme` | 未发布副本对线上没有任何影响，它是主题工作的"草稿纸"而不是变更——走 CLI，真正要 stage 的是发布那一下 |

### 3.3 Storefront MCP / Customer Accounts MCP：二阶段

这两个是**给顾客用的**，不是给店主的员工用的。它们真正的位置是"店面上那个会说话的助手"：
顾客问"这条裤子有没有我的码"、"我那单到哪了"。

放到二阶段的理由不是工作量，是**责任边界还没定**：顾客端的对话要不要进我们的事件日志？
顾客的身份怎么与工作区的人区分开？出了错谁负责？这些没答案之前接进来，等于把一个
面向陌生人的入口挂在公司的账本上。

### 3.4 `execute_graphql`：永远判成写外部

它的副作用取决于运行时传进来的那段文档。给它一个固定的 `side_effect` 分类是自欺欺人，
所以它永远是 `write`，永远不在写动作对照表里。要用它，路径是：
先过 `shopify.graphql.validate`，再 stage 一条**具体的 kind**。

---

## 4. 出站防护撞上代理 fake-IP

不是 Shopify 的事，但它是这一版真实踩到的坑，记在这里省得下次再查一遍。

Clash / Surge 这类代理开着 fake-IP 时，把外网域名解析成 `198.18.x.x` 这种**保留网段**地址
（真正的连接由代理接管）。连接器的 SSRF 防护把它当成"有人要打内网"直接拒掉，
回一句 `must not resolve to private or reserved IP`。用户看到只会以为我们的软件坏了。

做法：

- `egressAdvice()` 认出这一类错误，翻成两条修法的中文（改用公共 DNS / 把域名加进信任名单），
  已经有名单就把名单念出来。
- `GET /v1/connections/runtime` 加 `egress: { fake_ip_detected, trusted_hosts, detail }`——
  主动探一次公网域名的解析结果（落在保留段 = 是），加上"真被拦过"这一笔。
  主动探测只在真配了连接器时做，替身档不查真 DNS。
- 信任名单走环境变量 `AGENTSWS_CONNECT_TRUSTED_HOSTS`（逗号分隔，前导点 = 整个子域）。
- 排障步骤与判定命令：`deploy/nas/README.md` §9.1。

---

## 5. 模拟层怎么验（26）

15 人 pack 加两条回归题，四个运行时（stub / direct / dsh / dsh-subprocess）都要过：

| 场景 | 钉住什么 |
|---|---|
| `ops/edit-product-price` | 改价之前**真读**一次商品；**真查**官方文档、**真过**官方校验器；模型按记忆写的 `productVariantUpdate` 被当场拦下，提案连人的队列都没进；改对之后降 23% 超了 `max_price_delta_pct: 20`，从自动掉到 L1 进主管队列；批准后执行器拿 `role-apply` 令牌施行，幂等键 = 变更 id |
| `ops/theme-publish-needs-approval` | 推两份未发布副本，线上一份没换；提发布时**故意把等级报成 L3**（等于有人在设置里开了全自动），hard_ceiling 当场拉回 L1；整条题里一次连接器写调用都没有——主题走 CLI |

两个替身：

- `MockDevMcp`（`packages/stand-ins/src/connect/dev-mcp.ts`）——确定性、不联网。
  它认得出几个模型真爱编的名字（`priceV2` / `productVariantUpdate` / `fulfillmentCreateV2` /
  `productPublish`），所以"幻觉进不了人的队列"这条题验的不是空气。
- `MockShopifyCli`（`packages/stand-ins/src/connect/theme-cli.ts`）——方法名与真身
  `ShopifyTheme` 一一对得上，状态落在同一份店铺状态上。**它不是一条 Action**：
  真身不经连接器，替身也不该假装经过。

---

## 5b. 沙箱里跑 CLI（WP89，2026-09-17）

§2 的主题那一段（"主题走官方 CLI"）落地时是**服务端写死的几条调用**——
`apps/server/src/shopify-theme.ts` 里的 `list` / `pull` / `pushUnpublished` / `publish`。
55 §8 Q7 定案之后，**"跑 `shopify theme` 命令"这一步搬到了 Agent 手里**：
它在一个只能写主题工作副本目录的沙箱里按需跑，而不是我们替它排好四条。

**流程一个字没变**（12 §2 那句话仍然成立：未发布副本就是 stage，预览链接就是审批材料，
发布就是 apply）。变的只有"谁跑命令"：

| 这一跳 | 谁做 | 用什么 |
|---|---|---|
| `theme_edit`：改副本 | **Agent** | 在沙箱里改 `AGENTSWS_DATA_DIR/themes/<workspace>/<store>/` 下的文件（**"改文件"这一手还差一个后置件**，见本节末尾） |
| 推一份未发布主题 | **Agent** | `shopify theme push --unpublished`（线上一个字节不动） |
| 提议发布 | **Agent 只能提议** | 它跑 `shopify theme publish` 会被门禁接住，物化成一条 `publish_theme` 的 staged change |
| 真发布 | **服务端** | 审批过了，执行器调 `shopify-theme.ts` 的 `publish()`——**整条路上唯一**换线上主题的地方 |

### 挂了哪些官方包

一个字都不是我们写的（`@agentsws/dsh-adapter` 的 `harness.ts`，只在这条职责 +
`RunRequest.shell` 都在场时才挂——**不是写进职责 preset**：实测上游拒绝在 preset 的
子树里发布 `shell` / `sandbox` 这类进程级服务，见 55 §8 落点的"偏离一件"）：

| 包 | 干什么 |
|---|---|
| `@deepseek-ai/dsh-tool-bash` | 模型面的 `bash` 工具（`enableRunInBackground: false`：不挂 jobs，也不要长驻进程） |
| `@deepseek-ai/dsh-bash-sandbox` | 一条命令 = 一个经沙箱包起来的 `bash -c` 子进程（我们挂的是它的子类，见"凭据"一段） |
| `@deepseek-ai/dsh-sandbox-local` | 按平台选笼子：macOS Seatbelt / Linux bwrap→Landlock / Windows 受限令牌。选不出来 `SANDBOX_UNAVAILABLE` **fail-closed** |
| `@deepseek-ai/dsh-sandbox-policy` | 档位与可写根。**`workspace-write`，不给 `danger-full-access`** |
| `@deepseek-ai/dsh-shell-env` / `-subprocess-local` | 管理的 `DSH_*` 环境与真正 fork 进程的那一层 |

**实测（macOS 26，arm64，0.1.6-alpha.1）**：`workspace-write` 起得来，上游把"管住了多少"
当事实报出来，Seatbelt 这一档是 `enforcement: 'full'`；副本目录外的写回
`Operation not permitted`。Linux / Windows 按上游文档（未在本机实测）。
`pnpm install --frozen-lockfile` 不开任何构建——沙箱那条线拖进来的
`@deepseek-ai/node-addon-system` 是**预编译平台包**（`optionalDependencies`），本来就不构建，
`pnpm-workspace.yaml` 的 `allowBuilds` 里也早写死了 `false`。

### 命令白名单（表外拒）

只放行五个前缀，各带子命令表。判定在 `dsh-adapter` 的 `src/shell.ts`
（`checkShellCommand`），排在读写分类**之前**——一个 `bash` 名字底下几十条命令，
按工具名是判不出读写的。

| 命令 | 判成 | 说明 |
|---|---|---|
| `shopify theme list / pull / check / info` | `read_external` | 读店里的主题 |
| `shopify theme push --unpublished` | `read_external` | 推一份副本，线上不动。**这是 `theme_edit` 落地的唯一方式** |
| `shopify --version` / `shopify theme --help` | `local` | — |
| `git status / diff / log / show / add / commit / init / branch / checkout / switch / restore / stash / rev-parse / ls-files` | `local` | 只有本地的。没有 `push` / `pull` / `fetch` / `clone` / `remote` / `config`（前五个通网络，`config` 能设 `core.sshCommand` 那种"下次顺手跑一条命令"的字段） |
| `node --version` / `node <副本里的脚本>` | `local` | `-e` / `-p` / `-r` / `--import` 一律拒（那是"把一段没检查过的代码交给 node 跑"） |
| `npx shopify …` / `npx @shopify/cli …` | `read_external` | 后面的参数按 `shopify` 那张表**重判一次** |
| `pnpm install / i / list / ls / --version` | `read_external` | 没有 `run` / `exec` / `dlx` / `add`——那四个等于跑任意东西 |
| `shopify theme publish / delete / rename` | **`publish_theme` 卡** | 见下 |
| `shopify theme push`（不带 `--unpublished`）、任何带 `--live` / `--allow-live` 的 | **`publish_theme` 卡** | 见下 |
| `shopify theme dev / console / language-server / open / share` | 拒 | 长驻进程（一次运行一棵树，跑完即销毁，长驻的东西没有主人）或把预览抛到外面 |
| 别的一切（`rm`、`curl`、`cat`、`echo`…） | 拒 | 表外 |
| 管道 `\|`、命令替换 `` ` `` / `$(…)`、进程替换、后台 `&` | 拒 | 整类写法不放行：它们能把一条没过白名单的命令接进来 |
| 重定向 / 路径 / `workdir` 落到副本目录之外 | 拒 | 人话理由："这个岗位只能动那一份副本里的文件" |
| `sandbox_permissions`（升档）、`run_in_background` | 拒 | 档位没有第三档；后台进程没有主人 |

`;` / `&&` / `||` 是放行的，但**每一段各自再过一遍这张表**；只要有一段是发布，
整条命令就是发布——不允许把 `publish` 藏在一串正经命令后面。

**拒绝怎么出现**：与浏览器策略同一套——物化成 `tool.result{blocked}` 进事件日志（17 §2），
`reason` 就是给人看的那一句。

### 发布物化成卡，而不是简单拒掉

公司端遇到发布类命令**不直接拒**：门禁调 `stage()` 造一条 `publish_theme` 的变更
（15 §2：high 风险、hard_ceiling、**永远 L1**），发 `change.staged`，再把这次工具调用拒掉
（卡已经出去了，命令不该再跑一遍）。同一条命令重试不会变成第二张卡。

卡上的 `before`（"从哪一份换过来"）**这里填不出来**——Agent 没读过线上那一份，
15 §1 不许我们替它编一个。它由服务端 `proposePublish()` 在渲染卡之前跑一次真的
`theme list` 补上；那一跳本来就在。

### 凭据（13 §4）

`SHOPIFY_CLI_THEME_TOKEN` 的来源是 OpenConnector 里这家店的 Shopify 连接
（`credentials-openconnector` 的 record），`SHOPIFY_FLAG_STORE` 是店铺域名。
契约（`RunRequest.shell`）里**只有名字与记录地址**，没有值。

**实测到的一件与预判不同的事**：官方 `dsh-subprocess` 对**继承来的**环境有一道自己的
清洗——`/KEY|PASSWORD|SECRET|TOKEN/i` 的名字一律不往子进程传（上游原话：the harness's own
`DEEPSEEK_API_KEY`/secrets must not leak into a spawned process implicitly）。
`SHOPIFY_CLI_THEME_TOKEN` 正好撞这条，所以 WP86 那条"放进 `process.env` 再还原"的路
**在这里走不通**。上游给的路是"显式 env 在清洗之后合进去"，而显式 env 来自
`ShellExecSpec.env`——官方 `tool-bash` 有意不把 `env` 开给模型。于是我们继承执行器
（`AgentswsBashExecutor`），在 `resolve()` 里把这一跳要用的几个名字合进去。

结果比 preset 那条路更紧：**令牌一次都不进这个进程的环境**，它只在"这一条命令"里活着，
`tools/post-execute` 一到就清空。事件日志、模型面两处都只看得见名字。

### 不做，与一件后置

**不做**：用户面的终端窗口；给非建站职责开 shell；`danger-full-access`（契约里拼不出来）。

**后置一件（诚实记一笔）**：白名单只有那五个前缀，所以 `cat` / `echo` / `sed` 这些
"直接写文件"的命令一条都不在里面——**Agent 现在还没有"在副本目录里改文件"的手**。
`theme_edit` 这一步真正落地，要的是官方的文件工具：`@deepseek-ai/dsh-tool-fs` +
`@deepseek-ai/dsh-fs-sandbox`（它读的是**同一个** `ctx.sandboxPolicy`，所以可写边界
与这里逐字一致，不会多开一个口子）。那两个包没在这一轮里挂，因为 Q7 的交付单只说
shell 与沙箱。挂它们要做的事：mount 两个包、给三个 `read` / `write` / `edit` 工具
各写一行读写分类、把路径越界那一道接到同一个 `insideRoot()`。

为什么不用"放行 `cat > file`"顶一下：那等于把重定向变成通用写口，而重定向的目标
是一个字符串——判得出 `../`，判不出 symlink。留给文件工具做是对的，它走的是
`ctx.fs`，路径由沙箱的 provider 在它自己的文件系统上 canonicalize。

---

## 6. 落地清单

| | 状态 |
|---|---|
| Dev Dashboard 应用 + client credentials，老的 `shpat_` 那条删掉 | ✅ |
| 出站防护人话 + `runtime` 状态里的 `egress` + NAS 排障 §9.1 | ✅ |
| 33 条 Admin 写动作 → ChangeKind 对照表（8 条明说不给） | ✅ |
| 主题走官方 CLI + `site.builder` 职责 | ✅ |
| 主题 CLI 改由 Agent 在官方 shell + 沙箱里跑（§5b，WP89） | ✅ |
| Agent 在副本目录里**改文件**的工具（`dsh-tool-fs` + `dsh-fs-sandbox`） | ⬜ 后置，见 §5b 末尾 |
| Dev MCP 三个只读工具 + 写类 stage 前先校验 | ✅ |
| 15 人 pack 两条回归题 × 四个运行时 | ✅ |
| 真店实机（真 Dev Dashboard 应用 / 真 CLI / 真 `npx @shopify/dev-mcp`） | ⬜ 未跑 |
| Storefront MCP（店面顾客对话） | ⬜ 二阶段 |
| Customer Accounts MCP（顾客查自己的单） | ⬜ 二阶段 |
| `inventory_change` / `cancel_order` / `delete_*` 这几种新 kind | ⬜ 要先过 15 §2 那道手续 |

## 附：真店实测记录（2026-09-11，glass-bowl 开发店）

- client credentials 换令牌 ✓；`get_shop` ✓（回 `{ shop: { id, name, myshopifyDomain, primaryDomainUrl } }`，**没有币种与时区**，币种只能从订单行的 `currencyCode` 取）；`list_products` ✓（3 个样品商品）。
- `list_customers` ✗：`This app is not approved to access the Customer object`——Shopify 的 **Protected customer data** 审批（Dev Dashboard → 应用 → API access → Protected customer data access）。开发店也要点一次。
- `list_orders` 回 **0 条且不报错**（`first: 5` 不带 query 也是 0）。两种可能：开发店确实没订单，或同样被受保护客户数据规则挡住（Shopify 对未审批的应用把订单过滤成空而不是报错）。连接卡的准备步骤已补这一条；1d 复验要先在店里下一笔测试订单。
- 真实入参：`list_orders` 只认 GraphQL connection 三件套 `first` / `after` / `query`（多一个键被 schema 校验顶回）；返回 `{ orders: [{ id(gid), name, email, displayFinancialStatus, displayFulfillmentStatus, currencyCode, totalAmount, totalCurrencyCode, createdAt, cursor, raw }], pageInfo: { hasNextPage, endCursor } }`。

