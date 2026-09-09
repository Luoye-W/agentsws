# 更新日志 / Changelog

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循
[语义化版本](https://semver.org/lang/zh-CN/)。发版用 `scripts/release.sh <version>`。

按任务包（WP）归纳，逐条的合并记录、采纳的契约建议与遗留项在
[`docs/35-开发任务拆分与派工.md`](docs/35-开发任务拆分与派工.md) §4。

---

## 0.1.0-alpha — 2026-09-10（首个公开版本，尚未打 tag）

第一阶段：框架骨架（1a）→ 替身换真实现（1b）→ 客服共享包（1c）→ 开源基建。
到此为止 main 上 **172 个测试文件、2251 个用例**，`tsc -b --force` 与 `biome check .` 全绿，
模拟回路 fast 档 **8/8**。

**这不是生产就绪的软件**，逐层的诚实盘点见 README 的状态表与
[`docs/38-底层收口清单.md`](docs/38-底层收口清单.md) §1。

### 新增 — 框架骨架（WP1–WP10，1a）

- **契约**（`packages/contracts`）：18 份契约的类型、事件与错误码落成纯 TS，接口冻结
  （`docs/32` §2）。后续实现中又加了 #19 工作模型与会议内核两份
- **内核**（WP1，`packages/kernel`）：Cordis 容器与模块装载、模块清单与签名校验、
  append-only 事件日志（触发器拒 UPDATE / DELETE + 链式哈希 + `verifyChain`）、
  schema 版本并排与 upcaster、config、急停、trace。装载器不执行未验证的 entry
- **数据层**（WP2，`packages/data`）：记录信封、乐观锁 409、**授权按整条元组过滤并下推到
  SQL**（越权字段不返回而不是返回后脱敏）、敏感度分级、erase = 销毁主体密钥 + 墓碑事件
- **制度**（WP3，`packages/roles`）：YAML 职责定义、岗位、分配、策略层、Casbin 策略编译；
  **不做跨 Assignment 并集**，空范围标「未分配」
- **审核机制**（WP4，`packages/txn`）：审批总线 + 变更账本 + 执行器一个事务边界；
  批准绑定执行快照、revision 变化即旧 token 失效、额度预占、apply 三态含 `unknown`、
  关系授权门禁、SoD
- **知识与记忆**（WP5，`packages/knowledge`）：事实卡、带身份的检索（过滤下推，无权域零命中）、
  双值并存与冲突、记忆写过滤（长数字 / 邮箱 / IBAN 拒写）
- **技能**（WP6，`packages/skills`）：Agent Skills 解析、段 id 稳定、三层叠加按段、
  lesson 池与夜间整理；同段冲突不自动合
- **模型网关**（WP7，`packages/model-gateway`）：业务代码无 key、静态前缀哈希稳定、
  数据驻留拦截、三级预算与耗尽冻结、用量汇总与事件求和一致、急停
- **替身**（WP8，`packages/stand-ins`）：mock OpenConnector（写操作真改内存状态、可注入
  限流 / 超时）、stub / replay 模型、合成人、合成时钟、收件箱、假 registry
- **模拟回路**（WP9，`packages/simulation`）：场景 DSL、synth 生成器、runner、报告与
  合并门禁；六条不变量且每条 `checked > 0`；`prompt_replayable` 用同一装配函数从事件日志
  重组 prompt 逐字节比对
- **API 网关与服务进程**（WP10，`packages/api` + `apps/server`）：30 条路由全在 `/v1`；
  中间件链 trace → 急停 → 鉴权限流 → 出站急停 → 绑定 Assignment 授权 → 幂等；只绑 `127.0.0.1`

### 新增 — 替身换真实现（WP11–WP18、WP20、WP24，1b）

- **dsh 运行时**（WP11，`packages/dsh-adapter`）：gate 插件占满 dsh 的五个 seam
  （pre / post-execute、approval answerer、systemPrompt section + context、`tools.restrict`）；
  `profiles/agentsws` 把 `@deepseek-ai/dsh-*` 锁在 `0.1.3-alpha.2`
- **direct-llm 运行时**（WP14，`packages/runtime-direct`）：不经 dsh 的 turn loop，
  证明 dsh 可替换；三个运行时跑同一批场景过同样的不变量
- **连接器**（WP12，`packages/connect-adapter`）：对接自托管 OpenConnector 本地 runtime；
  token 编译 allowed actions / connections、空范围拒签、role-read 禁 proxy、幂等键；
  一致性套件对 mock 与真适配器各跑一遍
- **邮件渠道**（WP13，`packages/channels`）：IMAP 收 / SMTP 发、入站管线（去重、围栏、
  秘密脱敏、解析、路由、死信、重试）；**收件人只从线程台账取**，秘密在落 raw 前抹掉
- **工作台最小版**（WP15、WP21，`packages/deck` + `apps/workstation`）：卡片投影与五动作
  矩阵、按岗位筛选、数字块与命名查询、战报四格
- **Electron 托盘壳**（WP16，`apps/desktop`）：托盘、sidecar 监督、`safeStorage` 密钥、
  CSP 只允许 self、桥接层特性检测
- **客服共享包**（WP17，`packages/support-core`）：入站分类、15 条业务边界注册表、起草、
  知识引导、升级与 SLA。纯函数，无 IO，无模型调用
- **持久化**（WP18）：txn / 幂等 / 身份 / 队列的 SQLite 实现；内存与 SQLite 跑同一份
  一致性套件
- **工作模型与会议**（WP22 `packages/work`、WP23 `packages/meetings`）：事项 · 目标 ·
  待办 · 每日计划 · 复盘 · 日历；会议六种记录来源、受控原始材料区、转写 → 认领卡 /
  知识候选。处理器拿不到音频字节，只拿围栏后的文本
- **连接向导**（WP20）：`/v1/connections/*`、原生表单直填、本机 AES-256-GCM 秘密库、
  OpenConnector 加固状态条；18 条「凭据零泄漏」断言（响应 / 事件日志 / 数据目录每个文件
  字节 / DOM / `localStorage` / stdout）
- **接线与加固**（WP24）：委托与事项发言接真运行时、`POST /v1/ask`、`GET/PUT /v1/halt`
  运行期急停、`/v1/health` 带 pid / port、会话换 HttpOnly cookie
- **三件接入**（WP25）：Shopify Dev Dashboard 应用的 client credentials 换令牌 + 24h
  刷新器、10 条邮箱预设 + MX 自动识别 + 中文错误映射、模型连接设置页（网关热更新、
  按 purpose 默认模型、三级预算、驻留、用量）

### 新增 — 开源基建（WP26，本次）

- **CI**（`.github/workflows/ci.yml`）：ubuntu + macOS 两个矩阵、Node 22 / pnpm 11，
  `pnpm install --frozen-lockfile` → `tsc -b --force` → `biome check .` →
  `vitest run --coverage` → **`simulate --tier fast` 作为合并门禁**；覆盖率与模拟报告
  上传为 artifact。桌面壳只做 tsc 与单元测试，不打包
- **DCO 检查**（`.github/workflows/dco.yml`）：PR 里每个非合并提交都要有 `Signed-off-by`
- **README 重写**：一句话 / 给谁用、与 DeepSeek Harness 的关系、30 分钟跑通、架构图、
  每个包一行、**逐层诚实状态表**、路线、以及一份「明确不承诺的事」
- **`docs/ARCHITECTURE.md`**（英文）：四条硬要求、分层、19 份契约一览、运行协议与三个
  运行时、审批与账本、模拟回路与六条不变量、安全模型、与 dsh / OpenConnector 的边界
- **`SECURITY.md`**：私密报告渠道、支持范围、以及「不是生产就绪」的逐条诚实声明
- **`CODE_OF_CONDUCT.md`**（Contributor Covenant 2.1）、issue 模板（bug / feature /
  question）、PR 模板（含 DCO 与 `docs/35` §3 审核清单）
- **`CONTRIBUTING.md` 重写**：worktree + `wp/<n>` 分支的开发方式、`scripts/review-wp.sh`、
  契约冻结规则、提交规范、合并前必须全绿的五条命令
- **`docs/README.md`**：38 份中文文档的索引，一句话一份，标出真源在哪
- **`scripts/release.sh`** + 本文件：版本号、CHANGELOG 骨架、tag（不推）

### 修复

- `packages/data/test/authz.test.ts` 的偶发失败（WP26）：「密文里读不到明文」原来断言的是
  base64 **文本**不含 `'+1'`，而 base64 字母表含 `+` 与数字，随机 IV / 密文有约 **1.2%**
  的概率恰好出现这两个字符——实测 20 万次得 1.232%。改为解码后比对**字节**，明文换成
  长哨兵；连跑 50 次稳定
- WP25 在真 OpenConnector 容器上逮到并修的 5 个真 bug：按 purpose 选模型的
  zod 4 `z.record(enum)` 是穷举校验导致整条 400；试连失败只翻译网关外层错误；后台刷新
  令牌的事件 `trace_id` 为空被内核拒；腾讯企业邮 MX 落到个人 QQ 预设；163 / 126 的
  `mxmail.netease.com` 无后缀匹配
- WP24：`Work.delegate` 用旧快照写回覆盖了回调挂上的卡片
- WP5：知识层的 UPSERT 与向量零相似度两个 bug

### 移除

- 三个只有 README、没有实现也没有 `package.json` 的空壳包（WP26）：`packages/blocks`
  （积木实际在 `packages/deck`）、`packages/identity`（身份实际在 `packages/api`）、
  `packages/dsh-plugins`（approval-answerer 与 presenters 已在 `dsh-adapter` 与 `deck`，
  另两件属延后项）。`packages/packages-local` 保留为占位并写明二阶段实现。
  `docs/34` §2 的拓扑同步改正为仓库的实际布局

### 已知未做

定时与流程（契约有实现无）、应用包执行器与 registry、多人身份与制度管理界面、
学习回路闭环、dsh 真 headless 子进程、realistic / soak 档、IM 投递、MCP 面、Postgres、
真账号端到端验收。顺序见 `docs/38` §2。

---

## 约定

- **接口冻结**（`docs/32` §2）：加字段、加 kind、加事件、加错误码走 minor；改语义要升
  major 并附迁移器
- 数据格式**并排发新版，永不就地改写**；读旧版靠迁移器
- 每条提交带 `Signed-off-by`（DCO）；提交信息用 conventional commits
