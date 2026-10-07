# WP244 真机走 Rollout 首次设置碰到的几处体验问题（新开 Shopify 店、切品牌、空安排卡）

worktree `../agentsws-wt/wp244-polish` · 分支 `wp/244-polish`（从 main 新起，含 WP242）。先读 `_common.md`、WP240 / WP242 报告、`packages/brand-intake`、`apps/workstation/src/components/onboarding/`、品牌切换（侧栏「切换品牌」）、岗位页 v2（WP241：卡片流 / 工作四视图）、每日计划卡（「今天的安排」）。

## 现象（Fable 10-07 Windows 真机 ci.10）
1. **新开的 Shopify 店被读成「My Store」**：rolloutgear.com 是刚开的店，还是 Shopify 默认样子（店名 My Store、首页 Welcome to our store、Shopify 自动生成的隐私政策）。分析结果：品牌名 = My Store（`jsonld:Organization.name`，**confidence high**）、一句话 = My Store（og:description）、还把那份默认隐私政策当「读到 1 份政策，确认后进知识库」。应当认出「这是刚开的空店」：这几格不填、明说「店铺还是 Shopify 初始状态，品牌资料请自己填」，默认生成的政策不进知识库。
2. **政策摘要是原始页面文字**：摘要里带导航（Skip to content / Home Catalog Contact / Cart 0）和 `&ndash;` 这类没解码的实体。摘要要去掉页头导航、解码实体。
3. **新店的推荐没带建站**：第 ③ 步「推荐给你」只按官网分析给了店铺管理 / 内容与搜索 / 邮件营销 / 订单履约 / 客服；认出是空店时应把建站（Shopify 整站搭建、网页模板）放进推荐。
4. **切品牌后页面停在旧品牌的岗位地址**：在 INMO 的 `/positions/asg_55fab…` 切到 Rollout，地址不变、岗位名空白、内容全空。切品牌应跳到该品牌的首页（没设置完就进它的首次设置）。
5. **首次设置进度没记住第 ② 步**：第 ② 步「看着没问题」+「保存并继续」进了第 ③ 步后，重新登录回来又从第 ② 步开始（第 ② 步没打勾）。
6. **「今天的安排：0 条建议」也出成要你选的卡**（INMO Reddit 运营）：0 条就别出卡（或只在面板里一句「今天没有新安排」）。
7. **工作列表里「查完了」的事项仍在「进行中 · AI 在做」**：结果已出（「查完了。」）的事项应进已完成 / 待你看结果，不是一直挂进行中；另一条显示「这份活现在交不出来——不是没人干，是没接上」的也还挂进行中，应进「卡住了」并说缺什么。

## 要做
逐条修，每条一个测试；第 1 / 3 条用「Shopify 默认店」的页面夹具（店名 My Store、Welcome to our store、默认政策）。第 7 条先查清事项状态为什么没随运行结束更新（是 WP241 合成视图的分组规则问题还是事项本身没收口）。

## 纪律
不读 .env*；不跑批量清理命令；本机 4317 服务别碰；不连 Luoye 的 Windows。

## 验证
`scripts/verify-changed.sh` + 模拟三包 × stub + `gen-sdk` / `gen-ontology --check` + `open-repo-boundary`；改了的界面出截图；报告 `docs/briefs/reports/WP244.md`（要 Luoye 定的事单列）。
