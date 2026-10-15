# WP335 SEO / GEO 监测 O3：看板与界面（docs/99 §5.4 / §5.6 / §7 O3；决策 659）

worktree `../agentsws-wt/wp335-geo-ui` · 分支 `wp/335-geo-ui`。先读 `_common.md`、`docs/99`（§5.4–5.6、§7 O3）、`docs/briefs/reports/WP321.md`（给 O3 的接口：`/v1/seo/watch*`、`geo_watch` 卡、metrics）、`docs/briefs/reports/WP310.md`、`docs/96`（组件目录与出现规则）、`docs/briefs/reports/WP331.md`（通用报告块）。

## 要做
1. 看板（按 docs/96 组件化）：数字 ×4（提及率、引用率、平均名次、声量份额）、趋势线、Prompt × AI 方格表、关注词排名表、被引用最多的站 Top 10（我们 / 竞品 / 站外）、我们 vs 竞品对比。
2. 右栏「一条回答」组件：全文默认折叠、品牌名高亮、编号引用列表、和上周比；需要的读口（按单条回答取原文与引用）本单补上。
3. 设置里的「关注设置」：替换手写面板 `geo-questions.tsx`；`geo_watch` 设定卡的「改」表单（改后批准把策略带回）。
4. **659**：品牌档案加一格「品类」，品牌分析时 AI 填、人可改；GEO 策略建议改为读它。
5. 简报一行；帮助文档 `docs/help/search-data.md` 删 Perplexity、加 Claude 一句，新写「AI 回答监测」教程（中英）。
6. 用户可见文字不提 DataForSEO 等批发商名（memory 规则）。

## 纪律
不读 .env*；不碰 key / token；不调真实付费接口；不连远程机器；不碰本机 4317；不跑批量清理；不用 pkill。界面少字；截图用别的端口、拍完停掉，不写 .review-ready。不合 main、不打 tag、不发版。测试用 `--maxWorkers=2 --testTimeout=120000`。

## 验证
`scripts/verify-changed.sh`（LC_ALL=en_US.UTF-8）+ 模拟三包 × stub/direct/dsh + gen 检查 + 装包前冒烟；报告 `docs/briefs/reports/WP335.md`（决策号 795–799）。
