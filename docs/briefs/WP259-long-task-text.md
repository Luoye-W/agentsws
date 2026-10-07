# WP259 「交给它」超过 120 字被静默拒收（400 title too big）——整段话都要交给 AI，出错要说人话

worktree `../agentsws-wt/wp259-longtext` · 分支 `wp/259-longtext`（从 main 新起）。先读 `_common.md`、`apps/workstation/src/components/work/use-position-open.ts`（open / withRole / pick 三条提交路）、`apps/workstation/src/lib/api.ts`（`openMatterAtPosition`、`createMatterWithRole`）、`apps/server/src/positions.ts` 的 `open`（`text = title + summary` 只用于路由；`work.createMatter` 存 summary）、事项首轮运行怎么拼给 AI 的任务文本（查清 summary 有没有进运行）、契约里 matter `title` 的 120 上限。

## 现象（Fable 10-07 Windows 真机 ci.15，Rollout 建站岗位「交给它」）
输入一段 173 字的需求（多行），点「交给它」：`POST /v1/matters` → **400 `title: Too big: expected string to have <=120 characters`**，界面上**没有任何提示**，按钮照样可点，文本还在框里——普通用户会以为点了没反应。压到 105 字才开出事项。

## 要做
1. **长文本照收**：所有「交给它 / 用这条职责开 / 首页命令面板交给某岗位」入口，文本超过标题上限或多行时：标题取第一句 / 前 ~40 字加「…」，**完整原文**作为事项描述 / 首轮任务文本；路由用完整原文判。
2. **完整原文必须进 AI 首轮运行**：查清 summary 现在有没有进运行的任务文本；没有就补上（事项时间线第一条显示用户原话全文）。加端到端测试：200 字多行需求 → 首轮运行收到的任务含全文。
3. **出错要说人话**：这几个入口任何提交失败都在框下显示一句人话（含服务端 `message`），不再静默；按钮在提交中显示进行态。
4. 服务端兜底：直接调接口传超长 title 的，也按 1 的规则截断并把原文放进 summary，而不是 400（契约只加不删）。
5. 测试覆盖：超长、多行、正好 120、空白；失败提示显示。

## 纪律
不读 .env*；不跑批量清理命令；本机 4317 服务别碰；不连远程机器。

## 验证
`scripts/verify-changed.sh` + 模拟三包 × stub + `gen-sdk` / `gen-ontology --check` + `open-repo-boundary`；报告 `docs/briefs/reports/WP259.md`。
