# WP235 公司页岗位：真用户的岗位显示「还没人做」、合并对模板岗位不对路（Windows 真机实测）

worktree `../agentsws-wt/wp235-orgpos` · 分支 `wp/235-orgpos`（从 main 新起，已含 WP234）。先读 WP234 报告与 docs/54 §6（安放表 `org_placements`、`belongsTo`）、`apps/server/src/{positions,org,position-placements}.ts`、公司页岗位卡（workstation）。

## 现象（Fable 10-06 在 Luoye 的 Windows 真机 0.0.0-ci.6 上实测；工作区是 WP234 之前建的）
- Luoye 的分配：`pr.reddit`、`social.reddit`、`common.owner`（都在同一工作区，没有安放行——老分配）。
- 左栏「岗位」显示「公共关系」「社媒运营」（对），但 `GET /v1/org/positions` 里 pr、social-media 的 `holders` 都是 `[]`，公司页两张卡都写「还没人做这个岗位」（错）。只有 owner 有 holder。
- 公司页「岗位」页签把 11 个出厂模板全列出来（含「普通成员」），用户真正在做的岗位淹没在里面。
- 「合并到…」是对**整个模板岗位**操作（公共关系 5 条职责 → 合进某个模板），而 Luoye 只持有 pr.reddit 一条——他要的是把「自己手上的 pr.reddit + social.reddit」合成一个「Reddit 运营」岗位，不是把两个出厂模板合起来。

## 要做
1. **holders 修正**：老分配（无安放行）按 `belongsTo` 的老规则也要算进对应岗位的 holders；查清为什么现在是空（是只认安放行？还是要求持有模板的默认整包？），修好并加测试（老工作区：持有模板里一条职责就算这个岗位的 holder）。
2. **公司页「岗位」页签分两块**：上面「**你们的岗位**」——有人在做的岗位与自建岗位（按安放 / belongsTo 算），每张卡显示谁在做、他手上是哪几条职责；下面折叠的「**可以加的岗位（模板）**」——没人做的出厂模板。「普通成员」「负责人」不出现在岗位列表里（负责人在页顶身份卡）。
3. **合并 / 移动 / 拆出作用在「你们的岗位」上**（某人持有的那几条职责），不作用在出厂模板整包上：例「公共关系（Luoye 持有 pr.reddit）」合并到「社媒运营（Luoye 持有 social.reddit）」→ 得到一个自建岗位（默认名按职责建议，如「Reddit 运营」，可改），装 pr.reddit + social.reddit，左栏只剩这一个；模板本身不变。合并对话框里目标只列「你们的岗位」。
4. 端到端测试：造一个「老工作区」（两条跨模板分配、无安放行）→ 公司页 holders 正确 → 合并成一个自建岗位 → 左栏一个岗位、事项与记忆跟着走。
5. 顺手：桌面壳检查更新时，主源（dl.agentsws.com 未绑定）和备用源（GitHub 还没有发布）都查不到时，日志里是 ERROR 级堆栈——改成一行 INFO「还没有可用的更新源 / 暂无新版本」，界面按钮显示「已是最新」或不显示，不吓人（apps/desktop）。

## 纪律
不读 .env*；不跑批量清理命令；本机 4317 服务别碰；不连 Luoye 的 Windows（真机复测由 Fable 做）。

## 验证
`scripts/verify-changed.sh` + 模拟三包 × stub + `gen-sdk` / `gen-ontology --check` + `open-repo-boundary`；截图：公司页「你们的岗位 / 可以加的岗位」、合并对话框、合并后左栏；报告 `docs/briefs/reports/WP235.md`。
