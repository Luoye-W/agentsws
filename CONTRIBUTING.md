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
**DCO（Developer Certificate of Origin）**，不需要签 CLA（定案见 `docs/33` §2.3）。

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

跑不通先看 README 的「30 分钟跑通」。

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
合并用 `git merge --no-ff wp/...`；pnpm-lock 冲突以重新生成解决（`docs/35` §3）。

外部贡献者用 fork + 普通分支就行，分支名建议 `fix/…`、`feat/…`；`wp/<n>-<name>` 是我们
内部派工用的。

## 4. 贡献什么

- **职责包 / 技能 / 模板**（声明类，最欢迎，也最容易合）：遵循
  `docs/23-应用包与市场API规范-v1.md` 的 `package.yml` 与 Agent Skills 格式；放
  `role-packs/` 或 `skills/`
- **模拟场景与合成数据**：`docs/26` 的场景 DSL，放 `packs/<pack>/scenarios/`。
  一条能复现 bug 的场景 YAML 是最好的 bug 报告
- **连接器 / provider**：优先贡献到上游（dsh-channels、OpenConnector），本仓 `vendor/`
  只放过渡版本与契约测试
- **文档**：中文设计文档保持中文；`README` 顶部摘要、`docs/ARCHITECTURE.md`、
  `SECURITY.md`、`CODE_OF_CONDUCT.md`、`.github/` 里的模板保持英文
- **契约与内核**：见下一节

## 5. 契约改动规则（接口已冻结）

`docs/32` §2 定的：**接口层现在冻结，实现层按切片推进。**

| 改动 | 可以吗 |
|---|---|
| 加可选字段、加 `kind`、加事件类型、加错误码 | **可以**，说明用途与默认值即可 |
| 改已有字段的语义、改必填性、删字段、改事件含义 | **不可以**——那是升 major + 写迁移器的事，先开 issue 讨论并附迁移方案 |
| 在 `packages/contracts` 里写实现 | 不可以，那个包是纯类型 |

改了契约就要同步：一致性用例、至少两个实现（默认 + 替身）、以及对应的中文规范文档
（14–29 里的那一份）。

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
不看别的。审核清单见 `docs/35` §3，PR 模板里已经逐条列好。

碰安全关键路径的改动（审批 / 账本 / 执行器 / 授权 / 围栏 / 凭据）请在 PR 里明确说明，
并对着 PR 模板里那一组勾选项逐条自查。

## 8. 安全问题

**不要开公开 issue。** 走 [`SECURITY.md`](SECURITY.md) 里的私密渠道。
