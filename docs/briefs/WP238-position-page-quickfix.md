# WP238 岗位页两处快修：「连上就能开工」误报 + 权限清单藏深（Windows 真机 Luoye 反馈）

worktree `../agentsws-wt/wp238-posfix` · 分支 `wp/238-posfix`（从 main 新起）。先读 `_common.md`、`apps/workstation/src/pages/position.tsx` 及「连上这 N 个就能开工」卡与面板里「我们自己的 subreddit」那块的组件、服务端给岗位算「缺哪些连接」的逻辑（grep「就能开工」「requires」「connectors」「missing」）、能力来源（docs/75「数据从哪里来」、`/v1/settings/capability-sources`、云端接口中台健康 `data:*`、WP220 Reddit 两路）、docs/36 §7（少字）。

## 现象（Luoye 10-06，Windows 真机 ci.8，岗位「Reddit 运营」）
1. 顶部出一张「连上这 1 个就能开工：Reddit API · 可选 · 要它的活儿：Reddit 运营、Reddit 营销 · 去连接」。但 Luoye 用的是「Agents 工坊接口」，Reddit 取数已经走接口中台（上一轮调研真取到了数），根本不用自己连 Reddit API；而且标着「可选」却放在「就能开工」标题下，像是前提条件。
2. 「面板」页签里「我们自己的 subreddit」那块直接摆出「能看什么 / 能做什么 / 挂着的技能」：`social_account · read / stage · assigned · internal`、`approve_member · staged_change → community_member`、`brand-voice · open · always` 这类内部 id——这是给开发看的权限声明，不是给运营看的。

## 要做
1. **「就能开工」只列真缺的必需项**：
   - 一个连接要的能力，若已由其它来源满足（云端接口中台对应能力健康为 true、或品牌已选「用 Agents 工坊的」那一档、或另一条已连的连接已覆盖），就**不算缺**、不出现；
   - 「可选」项**一律不进**这张卡（它们只在连接页按职责列出）；
   - 全都满足 → 整张卡不显示（不留空壳）。
   - 判定放服务端一处（岗位视图返回 `missing_required` 时已扣掉被满足的），工作台只照着画；加测试：Reddit 走接口中台时不缺、只有可选项时不出卡、真缺必需项时照出。
2. **权限 / 本体声明藏深**：「能看什么 / 能做什么 / 挂着的技能」从面板里拿走，挪进岗位（或职责）设置里的一个默认折叠的「高级 · 这条职责能做什么」区；展示时把 id 翻成人话（例：「看社群成员 · 可提议改动」「回帖子 · 要人批」「技能：品牌语气（常驻）」），原始 id 只在 tooltip / 「开发者视图」开关里出现。
3. 面板里其它「还没登记号 / 群发没有去处」这类空状态，统一成一行灰字 + 一个去处按钮（docs/36 §7），不再占大卡。
4. 截图前后对比（岗位页顶部、面板）。

## 纪律
不读 .env*；不跑批量清理命令；本机 4317 服务别碰；不连 Luoye 的 Windows。不做岗位页整体重排（另有设计稿在出），只修这两处与空状态。

## 验证
`scripts/verify-changed.sh` + fast 模拟三包 × stub + `gen-sdk` / `gen-ontology --check` + `open-repo-boundary`；报告 `docs/briefs/reports/WP238.md`。
