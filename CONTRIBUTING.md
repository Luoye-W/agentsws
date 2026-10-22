# 贡献指南

> **In English.** Contributions are under the [DCO](https://developercertificate.org/),
> not a CLA: sign every commit with `git commit -s`. Before you open a PR, run
> `pnpm install --frozen-lockfile && pnpm exec tsc -b --force && pnpm exec biome check . &&
> pnpm exec vitest run` and
> `pnpm -s simulate --tier fast --pack packs/dtc-3c-3p --scenario 'scenarios/**/*.yml' --seed 42`
> — CI runs exactly that on ubuntu and macOS, and the simulation is a merge gate.
> The contracts in `packages/contracts` are **frozen**: adding fields and kinds is fine,
> changing the meaning of an existing one is not. Architecture:
> [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). Code of conduct:
> [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md). Security: [`SECURITY.md`](SECURITY.md) —
> never a public issue.

中文或英文提 issue、写 PR 都可以。本项目 Apache-2.0，贡献采用
**DCO（Developer Certificate of Origin）**，不需要签 CLA。

---

## 1. DCO：每个提交签一行

提交信息末尾要有：

```
Signed-off-by: 你的名字 <you@example.com>
```

用 `git commit -s` 会自动加。这一行表示你确认 <https://developercertificate.org/> 的内容：
你有权以本项目的许可证提交这段代码。

忘了签：最后一条用 `git commit --amend -s`，整条分支用 `git rebase --signoff origin/main`，
然后强推。`.github/workflows/dco.yml` 会检查 PR 里每个非合并提交。

## 2. 上手

需要 Node ≥ 22、pnpm ≥ 10。

```bash
pnpm install
pnpm build                                        # tsc -b
pnpm test                                         # vitest run
pnpm lint                                         # biome check .
pnpm simulate --tier fast --pack packs/dtc-3c-3p  # 8/8 才算基线正常
pnpm dev:demo                                     # 用合成世界跑起工作台，看真卡片
```

跑不通先看 README 与帮助文章（<https://agentsws.com/docs/>）。

## 3. 开发方式：一个任务包一个 worktree

我们自己按「任务包（WP）」推进，一个 WP = 一件事 + 它的测试 + 一条分支：

```bash
git worktree add ../agentsws-wt/wp42-my-thing -b wp/42-my-thing main
cd ../agentsws-wt/wp42-my-thing
pnpm install
# ……做事……
scripts/review-wp.sh ../agentsws-wt/wp42-my-thing packages/my-package
```

`scripts/review-wp.sh <worktree 目录> <包目录>` 会在那个 worktree 里跑构建 / lint /
测试 / 覆盖率，并**列出改到包目录之外的文件**——多个 WP 并行时这是最有用的一条输出。
合并用 `git merge --no-ff wp/...`；pnpm-lock 冲突以重新生成解决。

外部贡献者用 fork + 普通分支就行，分支名建议 `fix/…`、`feat/…`；`wp/<n>-<name>` 是我们
内部派工用的。派工单、讨论记录与决策过程不在这个仓库里；本仓只放代码、契约、用户帮助文章
（`docs/help/`）与英文架构说明。`scripts/check-no-internal-docs.mjs` 会拦下 `docs/` 白名单之外的文件。

## 4. 贡献什么

- **职责包 / 技能 / 模板**（声明类，最欢迎，也最容易合）：遵循 `package.yml`
  （`packages/contracts/src/packages.ts`）与 Agent Skills 格式，照 `role-packs/` 里现成的写；放
  `role-packs/` 或 `skills/`
- **模拟场景与合成数据**：场景 DSL 照 `packs/*/scenarios/` 里现成的写，放 `packs/<pack>/scenarios/`。
  一条能复现 bug 的场景 YAML 是最好的 bug 报告
- **连接器 / provider**：优先贡献到上游（dsh-channels、OpenConnector），本仓 `vendor/`
  只放过渡版本与契约测试
- **文档**：帮助文章（`docs/help/`）中英各一份，写法见下面「教程怎么写」；`README.md`（中文）与 `README.en.md`（英文）两份同步；`docs/ARCHITECTURE.md`、
  `SECURITY.md`、`CODE_OF_CONDUCT.md`、`.github/` 里的模板保持英文
- **契约与内核**：见下一节

### 教程怎么写（`docs/help/`，也是官网 agentsws.com/docs/ 与软件右栏「教程」）

教程以官网为主：官网每次部署出一份目录（`/help/index.json`）与每篇的纯文本，软件定时去拉，
工坊里的 AI 被问到「怎么用」时也在这份里查。所以一篇教程同时给三类读者：用户、搜索引擎、各家 AI。

中文那份头上：

```yaml
---
group: connect          # start / models / connect / channels / tools（官网目录分组）
order: 110              # 组内顺序
description: 一两句话直接给答案（不写「这篇讲……」）
positions: [web-ops]    # 归哪些岗位（都空 = 通用）
roles: [dtc.store]      # 归哪些职责
requires: next          # 可选：讲的是还没发版的功能就写 next，发版时换成版本号
aliases: [old-slug]     # 可选：改过名的旧 slug（官网自动留跳转）
---
# 标题
```

英文那份（`<slug>.en.md`）头上只写 `description`。

- **先给答案**：开头一两句把事说完，再展开步骤。
- **每段自己能看懂**：别用「它」「上面说的」，该说「Agents 工坊」「Shopify 卡」就说。
- 小标题写成问题或动作（「连不上怎么办」）；限制和前提（要哪一版、要不要登录、要不要钱）写清楚。
- 数字、版本、日期写死，不写「最近」「新版」。
- slug 定了不改；非改不可时把旧名写进新那篇的 `aliases`。
- **讲还没发版的功能**：头上写 `requires: next`。官网先用上一个正式版时的文字，新的一篇先不上；
  发版前跑 `node scripts/help-stamp-release.mjs <版本号>` 把 `next` 换成版本号。改错字、说清楚一点的修改不用写。

## 5. 契约改动规则（接口已冻结）

**接口层现在冻结，实现层按切片推进。**

| 改动 | 可以吗 |
|---|---|
| 加可选字段、加 `kind`、加事件类型、加错误码 | **可以**，说明用途与默认值即可 |
| 改已有字段的语义、改必填性、删字段、改事件含义 | **不可以**——那是升 major + 写迁移器的事，先开 issue 讨论并附迁移方案 |
| 在 `packages/contracts` 里写实现 | 不可以，那个包是纯类型 |

改了契约就要同步：一致性用例、至少两个实现（默认 + 替身）、以及契约文件头的说明。

## 6. 规则

- **每个 PR 一件事**；改动尽量待在一个包目录里
- **测试**：vitest，放各包的 `test/`；目标 100% 行覆盖，至少所有公开函数有用例
- TypeScript strict + `exactOptionalPropertyTypes`；ESM；`import type`；不用 `any`
- 时间经注入的 `Clock`，随机经注入的 seed，**不裸调 `Date.now()` / `Math.random()`**
- SQL 全部参数化；**不读别的包的表**
- 秘密只从环境变量或本机密钥库读；测试用假值
- **不提交任何凭据、真实客户数据、真实客户邮件**；要样本请用合成数据生成器
- 不引入新依赖；确实需要就在 PR 里单独说明理由与体积
- 提交信息用 conventional commits（`feat(scope): …` / `fix(scope): …` / `docs: …`），
  每条 `-s`

## 7. 合并前必须全绿

CI（`.github/workflows/ci.yml`）在 ubuntu 与 macOS 上按同样顺序跑一遍：

```bash
pnpm install --frozen-lockfile
pnpm exec tsc -b --force
pnpm exec biome check .
pnpm exec vitest run --coverage
pnpm -s simulate --tier fast --pack packs/dtc-3c-3p --scenario 'scenarios/**/*.yml' --seed 42
```

最后一步是**合并门禁**：8 条场景全过、六条不变量全绿、指标不劣化。它红了就是红了，
不看别的。审核清单在 PR 模板里逐条列好。

碰安全关键路径的改动（审批 / 账本 / 执行器 / 授权 / 围栏 / 凭据）请在 PR 里明确说明，
并对着 PR 模板里那一组勾选项逐条自查。

## 8. 安全问题

**不要开公开 issue。** 走 [`SECURITY.md`](SECURITY.md) 里的私密渠道。

## 后台模块发事件：自起 trace

没有请求上下文的模块（定时刷新、mDNS 回调、夜间扫描、邀请码核销）发事件时 `correlation.trace_id` 不能留空——内核会整条顶回，症状常常很远（活数据源整轮失败、局域网只能单向看见、保存表单变 400）。照 `apps/server/src/live-data.ts` 的做法：模块自己生成 `trc_<模块>_<时间>_<序号>`，网关在请求里调用时会覆盖成请求的 trace。回调里一律 try/catch，别让异常爬回调用方。
