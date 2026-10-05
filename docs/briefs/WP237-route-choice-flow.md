# WP237 合并岗位后的「走哪条职责」：同岗位自己选、选择卡按钮对、选完要开跑（Windows 真机实测）

worktree `../agentsws-wt/wp237-routechoice` · 分支 `wp/237-routechoice`（从 main 新起）。先读 `_common.md`、事项路由（grep `matter.routed`、`route_choice`、`ambiguous`）、认领卡（`kind: claim`）与它在卡片流里的按钮、事项页时间线、WP234 / WP235（自建岗位装多条职责）、WP236（read_reddit 描述里写死的单价）、`.github/workflows/desktop-windows.yml` 的 update-e2e 作业。

## 现象（Fable 10-06 在 Luoye 的 Windows 真机 0.0.0-ci.7）
1. 公司页把「公共关系（pr.reddit）」合并进「社媒运营（social.reddit）」→ 自建岗位「Reddit 运营」（2 条职责，同一个人 Luoye）✓。
2. 在这个岗位「交给它」一件 Reddit 调研 → `matter.routed {ambiguous:true, candidates:[social.reddit 0.51, pr.reddit 0.49]}` → 出一张 `claim` 卡「这件事该走哪条职责 …… 这件事像『Reddit 运营』也像『Reddit 营销』，你定」。
3. 这张卡的按钮是「**认领 / 不是客户问题**」——和「走哪条职责」对不上；事项页时间线写着「你定」但**没有任何可点的选项**。
4. 点「认领」→ `approval.decided {approve}` → **之后什么都没发生**：没有 `run.started`，事项停在那儿。（Fable 随后在事项里发了一句「按 Reddit 运营这条来，开始吧。」看是否能推动——结果见报告前请自己复现。）

## 要做
1. **同一个人、同一个岗位里的几条职责打平时不问人**：按得分取最高的那条直接开跑，时间线写一句「按『Reddit 运营』来做的；要换成『Reddit 营销』点这里」（可一键改派并重跑）。只有候选职责分属**不同的人**时才出选择卡。
2. **选择卡要对路**：出卡时按钮就是候选职责（「走 Reddit 运营」「走 Reddit 营销」……），不是认领 / 不是客户问题；事项页上同样给这几个选项。
3. **选完要开跑**：人在卡上或事项页选了某条职责 → 事项钉到那条职责并**立即起一次运行**（用事项里原话）；查清现在批了 claim 为什么不派发，修好并加端到端测试（真路由：打平 → 同人自动开跑；不同人 → 出卡 → 选 → run.started）。
4. **#67（Fable 定）**：`read_reddit` 工具描述里的单价改成每次运行按价目表现填（取不到就不写数，只写「按条计费」）。
5. **CI**：`desktop-windows.yml` 的 update-e2e 作业 10-06 那次跑满 15 分钟被取消（run 37365141873）；看日志定位慢在哪，修或把超时放到 30 分钟（写清理由）。

## 纪律
不读 .env*；不跑批量清理命令；本机 4317 服务别碰；不连 Luoye 的 Windows（真机复测由 Fable 做）。

## 验证
`scripts/verify-changed.sh` + 模拟三包 × stub/direct/dsh + `gen-sdk` / `gen-ontology --check` + `open-repo-boundary`；截图：打平自动开跑的时间线、不同人时的选择卡；报告 `docs/briefs/reports/WP237.md`。
