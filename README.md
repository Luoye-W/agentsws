# agentsws

[![CI](https://github.com/Luoye-W/agentsws/actions/workflows/ci.yml/badge.svg)](https://github.com/Luoye-W/agentsws/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

> **In English.** agentsws is an open-source, self-hosted agent middle-office for
> cross-border e-commerce and DTC brands. Agents read your mail and store data and
> **propose** work — a reply, a refund, a reship — and a human approves each one from a
> queue. It is a distribution of [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness),
> not a fork: 19 frozen contracts, three interchangeable runtimes, and a simulation loop
> that runs a synthetic three-person company against six invariants on every commit.
> Everything runs on your machine, with your own API keys and your own accounts.
> **Status: `0.1.0-alpha`, not production-ready** — see [SECURITY.md](SECURITY.md) and the
> honest status table below. Architecture in English:
> **[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)**. The design documents are in Chinese
> and indexed in [`docs/README.md`](docs/README.md).

**一句话**：把人、Agent、渠道和公司知识接成一套协同系统——开源免费、跑在公司自己的机器上；
Agent 只**提议**，写操作一律进人审队列。

**给谁用**：做独立站 / 跨境电商 / 品牌出海的小团队（3–50 人）。最典型的一天是：几十封英文
客户来信、时差、退换货规则记不住、现有工具按席位收费还要把客户数据传上去。

**别处收费、这里免费**（`docs/32` §3）：客服 AI（Gorgias / Zendesk / Intercom Fin 按席位）、
连接器平台（Composio / Pipedream 按连接数）、审批工作流、带权限的公司知识库、多店铺 /
多部门——在这里都是开源版的一部分，没有付费墙。模型 key、店铺账号、邮箱都是你自己的。

---

## 与 DeepSeek Harness 的关系

本仓是 dsh 的**发行版**，不 fork 内核：

- `profiles/agentsws/` 把官方 `@deepseek-ai/dsh-*` 锁死在同一个版本（当前 `0.1.3-alpha.2`）。
- 所有对 dsh 的调用收口在 `packages/dsh-adapter`，业务代码只 import 契约。升级 dsh =
  改版本号 → 跑适配层的 seam 契约测试 → 跑模拟回路 → 全绿才合并。
- 内核用的就是 dsh vendored 的那个 Cordis（`@deepseek-ai/cordis`）：我们的每个模块也是
  一个 Cordis 插件。
- dsh 自己 `AGENTS.md` 里的四条纪律原样采用：**Plugins, not loop changes**、
  **Model-visible ⟺ logged**、数据格式并排发新版永不就地改写、每文件 100% 覆盖。
- 另有一个 `direct-llm` 运行时完全不经过 dsh。它存在的唯一理由是证明 dsh 可替换——
  同一批场景在 `stub` / `dsh` / `direct` 三个运行时下都要过同样的不变量。

上游贡献分两条线：对话渠道（WhatsApp、IMAP / SMTP 适配器）回 dsh-channels，系统动作
provider 回 OpenConnector。两者不是一回事，为什么见 `docs/09` §7。

---

## 30 分钟跑通

需要 **Node ≥ 22** 与 **pnpm ≥ 10**（`corepack enable pnpm` 即可）。前三步不需要 Docker、
不需要模型 key、不需要任何账号——全部跑在替身上。

```bash
git clone https://github.com/Luoye-W/agentsws.git
cd agentsws
pnpm install            # 装依赖（含 better-sqlite3、Electron 等原生依赖）
pnpm build              # tsc -b
```

时间大头在这两步，取决于网络与 pnpm store 有没有缓存；后面每一步都是秒级
（本机实测：install 4 秒 / build 7 秒 / simulate 1 秒 / `dev:demo` 起来 10 秒，
store 已预热）。**30 分钟里剩下的都是读架构的时间。**

**① 跑模拟回路，看 8/8**

```bash
pnpm simulate --tier fast --pack packs/dtc-3c-3p --scenario 'scenarios/**/*.yml' --seed 42
```

跑的是一家三人跨境公司的合成数字孪生：八条场景（退货窗口内 / 窗口外、首次遇到业务边界、
提示注入与它的对照组、订单备注里的注入、模型停机、预算耗尽），每条都对六条不变量断言：

```
PASS  aftersales/return-within-window  [fast, seed 42]
  invariants: ✓no_write_without_stage ✓apply_only_after_approved ✓provenance_respected
              ✓fencing_covers_external ✓prompt_replayable ✓freeze_on_model_outage
...
8/8 场景通过（dtc-3c-3p，fast 档）
合并门禁：通过（fast 全过且指标未劣化）
```

这六条就是这个项目的全部主张：**没 stage 就没有写、apply 前必有人批、说过的话必须有出处、
外部文本一律围栏、进模型的每一个字都能从事件日志重建、模型挂了就冻结不发**。
加 `--report out/` 会写一份 JSON 报告。同一条命令就是 CI 的合并门禁。

**② 把工作台跑起来，看真卡片**

```bash
pnpm dev:demo                     # 构建工作台 + 用合成世界当后端；只听 127.0.0.1
pnpm dev:demo --port 4318         # 4317 被占了就换一个
```

打开它打印的地址（默认 <http://127.0.0.1:4317>），**自动登录，不用填任何东西**。看到的是
上面那家合成公司：卡片队列里有 4 张真的待批项（业务边界提问、回复草稿、变更待批），
两个岗位的数据条里是真数字（本月订单、销售额、退款额，来自合成世界的订单与交易日志），
没连上的数据源老老实实显示「去连接」而不是假图。批准一张卡，执行器会真的施行它——
这条链路有端到端测试守着（`apps/cli/test/demo.test.ts`：「点批准走 decide，退款真的被
施行；全程没有任何 `model.*` 事件」）。

顶上会有一条黄条说「还没接模型，Agent 跑不起来」——**这是对的**：demo 世界不叫模型，
卡片是合成的。想让 Agent 真跑起来要去设置页接一个模型 key，那属于第 ③ 步。

界面长什么样：`docs/assets/workstation/`（首页、卡片、事项、日历、连接、模型设置的截图）。

**③（可选）接真账号**——需要 Docker，以及你自己的 Shopify 自建应用与邮箱应用专用密码

```bash
scripts/dev-real.sh     # 起加固的 OpenConnector 容器 + SQLite 落盘的服务进程 + 工作台
```

密钥只生成一次、落在 600 权限的文件里。凭据在工作台「连接」页的原生表单里自己填，**不经过
模型、不进日志**。这一步是「1d 真账号验收」，**还没有在真店铺真邮箱上端到端跑通过**——
见下面的状态表。

**读懂架构**：先看 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)（英文，从 `docs/09`
提炼），再看下面这张图，然后翻 `packages/contracts/src/` —— 每份契约的文件头都写着它实现
的是中文规范的哪一节。

---

## 架构

![分层总图](docs/assets/架构图-01-分层总图.png)

四条硬要求决定了其余一切：① 符合 DeepSeek Harness 的设计规范 ② 一切 API 化 ③ 用虚拟数据集
做全流程自动化模拟，不只是 CI 全绿 ④ 模块之间像插拔一样可替换可升级。展开见
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)。

另外两张图：[模拟测试回路](docs/assets/架构图-02-模拟测试回路.png)、
[契约矩阵](docs/assets/架构图-03-契约矩阵.png)。可编辑源在 Claude Design 画布
《agentsws 底层框架》。

---

## 目录

```
packages/     契约与它们的实现
apps/         四个客户端进程（服务、工作台、桌面壳、CLI）
role-packs/   官方职责包（package.yml + roles + skills + scenarios）
skills/       共享 skill（Agent Skills 格式）
packs/        合成公司数据集（dtc-3c-3p：3 人、3 个产品线）
presets/      按职责的 dsh preset
profiles/     dsh profile：版本锁定
vendor/       上游子树（dsh-channels 等）
evals/        eval 用例
docs/         38 份中文设计文档 + 英文 ARCHITECTURE
scripts/      review-wp.sh（审核一个任务包分支）· dev-real.sh（真账号环境）· release.sh
```

| 包 | 一句话 |
|---|---|
| `packages/contracts` | 19 份契约：类型、事件、错误码。纯 TS，无实现，接口已冻结 |
| `packages/core` | 框架无关纯规则：fencing、provenance / guardrail 门禁、账本类型、RawStore 端口 |
| `packages/kernel` | Cordis 容器、模块清单与签名、append-only 事件日志、config、急停、trace |
| `packages/data` | 共享数据层：记录信封、乐观锁、Casbin 过滤下推到 SQL、加密分片删除 |
| `packages/txn` | 交易控制：审批总线 + 变更账本 + 执行器，一个事务边界 |
| `packages/roles` | 职责与分配：YAML 职责定义、岗位、分配、策略层、Casbin 策略编译 |
| `packages/knowledge` | 知识与记忆：事实卡、带身份的检索（FTS5）、运行记忆纪律 |
| `packages/skills` | 技能：Agent Skills 解析、段 id、三层叠加、lesson 池与夜间整理 |
| `packages/model-gateway` | 模型网关：路由、按岗位记账、三级预算、数据驻留、急停 |
| `packages/dsh-adapter` | `runtime: dsh`。唯一允许 import dsh 的地方 |
| `packages/runtime-direct` | `runtime: direct`。不经 dsh 的 turn loop，证明 dsh 可替换 |
| `packages/connect-adapter` | 唯一允许 import `@oomol-lab/connector` 的地方，对接本地 OpenConnector |
| `packages/channels` | 邮件渠道：IMAP 收 / SMTP 发、入站管线（去重、围栏、脱敏、路由、死信） |
| `packages/meetings` | 会议内核：六种记录来源、受控原始材料区、转写 → 认领卡 / 知识候选 |
| `packages/work` | 工作模型：事项 · 目标 · 待办 · 每日计划 · 复盘 · 日历 |
| `packages/deck` | 卡片投影与工作台积木：DeckCard、五动作矩阵、命名查询、数字块 |
| `packages/support-core` | 客服共享包：分类、业务边界注册表、起草、知识引导、升级与 SLA。纯函数 |
| `packages/stand-ins` | 全部替身：mock OpenConnector、stub 模型、合成人、合成时钟、收件箱 |
| `packages/simulation` | 场景 DSL、synth 生成器、runner、报告与合并门禁 |
| `packages/api` | API 网关：`/v1` 全部路由、鉴权、幂等、限流、急停；本地身份实现 |
| `packages/packages-local` | **占位**，二阶段实现，契约在 `contracts/src/packages.ts` |
| `apps/server` | 协同服务进程：把上面全部装配成一个进程 |
| `apps/workstation` | Web 工作台（React + Vite） |
| `apps/desktop` | Electron 托盘壳：sidecar 监督、首次运行密钥、原生桥接 |
| `apps/cli` | `agentsws` 命令：`simulate` / `synth` / `replay` / `demo` |

---

## 状态：什么是真的

`0.1.0-alpha`。**这不是生产就绪的软件**（见 [SECURITY.md](SECURITY.md)）。截至
2026-09-10，main 上 172 个测试文件、2251 个用例，`tsc -b --force` 与 `biome check .` 全绿，
fast 档 8/8。

下面是逐层的诚实盘点，来自 [`docs/38-底层收口清单.md`](docs/38-底层收口清单.md) §1：

| 层 | 状态 | 缺什么 |
|---|---|---|
| 内核（Cordis、事件日志、急停、模块清单） | **通** | 模块热替换 / 动态 entry；Postgres 档 |
| 数据层（授权下推、敏感度、擦除） | **通** | Postgres 方言；原始材料区加密还没跨包接线 |
| 制度（职责 / 岗位 / 分配 / 授权） | **通** | **没有管理界面**：真实模式只有「工作区所有者」，建不了岗位、分配不了人 |
| 审核机制（审批项、账本、Guardrail、执行器） | **通** | 跨进程施行锁；合并卡整组决定；知识 / 技能类专属预检 |
| 知识与记忆 | **通** | 缺口队列、verified 晋升、sqlite-vec |
| 技能与学习回路 | **半通** | **lesson → 次日提案 → 审批 → 技能新版本这条回路没端到端接上**；周合并未接调度 |
| 模型网关 | **通** | rerank、流式；用量告警、密钥轮换 |
| 运行协议（dsh / direct / stub） | **半通** | **dsh 是进程内装配不是真 headless 子进程**（要 IPC 桥）；dsh / direct 没有边界提问的口子 |
| 连接器（OpenConnector） | **通** | **真 provider 实机零次**；OAuth 真回调没验过 |
| 渠道（邮件） | **通** | IMAP IDLE / Gmail push；附件；**轮询与发信还没在服务进程里装配** |
| **定时与流程** | **没做** | 契约 98 行，一行实现都没有：计划 / 复盘没有定时触发，令牌刷新靠各自 setTimeout |
| 通知路由与投递 | **半通** | 规则引擎只在 txn 里有雏形；IM 投递没有 |
| 身份与 Join | **半通** | 本地 magic-link 单人；**邀请同事、多人登录没有** |
| API 网关 | **通** | WebSocket / MCP 面；若干路由；logout |
| 工作台积木 | **通** | 两套 BattleReport 字段名要合一；自适应重排；bundle 未拆 |
| 应用包与市场 | **没做**（二阶段） | 扩展点只有会议两个；安装 / 卸载没有执行器 |
| 桌面壳 | **通** | 装机需机器上有 Node 22；签名公证；更新源；几个新接口还没接 |
| 模拟回路 | **通** | 只有 fast 档；realistic / soak / judge / 15 人 pack 都没做 |
| 开源基建（CI、README、ARCHITECTURE、SECURITY、release） | **通** | 见 [`CHANGELOG.md`](CHANGELOG.md) |

**明确不承诺的事**（写在这里，免得你猜）：

- 没有在真店铺、真邮箱上端到端跑通过一封信。凭据能填、链路能起，但真账号验收还没做。
- 没有多人。今天只有工作区所有者一个人；邀请同事、按岗位分配、换岗位都还没有界面。
- 没有定时。「每天早上出计划、晚上出复盘」写在契约里，实现是空的。
- 没有应用市场与 registry、没有 IM 投递、没有 MCP 面、没有 Postgres、没有 WebSocket 实时
  刷新、没有 Windows / Linux 安装包验证、没有代码签名与公证。
- 没有第三方安全审计，没有 bug bounty，没有维护分支与 backport。
- 学习回路只走通了一半：能记下 lesson，还不能自动变成第二天的技能提案。
- 「采纳率高了就自动执行」——**这个我们不做**。退款、补发、发布、配置、资金这些
  `risk_class: medium|high` 的动作，v1 永远人审（`docs/31` §3.4）。

---

## 路线

收口顺序见 [`docs/38-底层收口清单.md`](docs/38-底层收口清单.md) §2。不做新功能，只补底座：

| 波次 | 内容 |
|---|---|
| 七 | **WP26 开源基建**（本次）· **WP27 定时与流程**（Scheduler + WorkflowEngine，接七个消费者）· **WP28 制度管理界面 + 多人身份**（岗位 / 分配 CRUD、邀请同事） |
| 八 | WP29 学习回路闭环 · WP30 运行时对齐（dsh 真 headless 子进程）· WP31 安全底座补完（原始材料区加密、跨进程施行锁、密钥轮换） |
| 九 | WP32 模拟回路加强（realistic / soak / judge，每夜跑）· WP33 API 面补齐（WebSocket、OpenAPI 完整、SDK 生成） |
| 之后 | 应用包执行器、IM 投递、MCP 面、Postgres —— 开源后按社群需求排 |

方向与采用指标见 [`docs/32-开源优先路线修正.md`](docs/32-开源优先路线修正.md)：开源优先、
build in public、接口冻结 / 实现按切片。

---

## 贡献

看 [`CONTRIBUTING.md`](CONTRIBUTING.md)。最欢迎的三类：职责包 / 技能 / 模板（声明类）、
模拟场景与合成数据、连接器（优先贡献到上游）。行为准则见
[`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md)。安全问题**不要开公开 issue**，走
[`SECURITY.md`](SECURITY.md) 的私密渠道。

## 许可证

- 代码、契约、职责包、技能、模拟回路、DevKit 规范：**Apache-2.0**（[`LICENSE`](LICENSE)、
  [`NOTICE`](NOTICE)）。选它的理由见 `docs/33` §2：自带专利授权、与全部上游兼容。
- 名称与标志：[`TRADEMARK.md`](TRADEMARK.md)——**可以 fork，不能叫 agentsws**。
- 贡献：DCO（`git commit -s`），不要 CLA。
