# WP224 盈亏线 + 经营一页纸（docs/91 P1 第 5、6 条）

worktree `../agentsws-wt/wp224-economics` · 分支 `wp/224-economics`（从 main 新起）。先读 `_common.md`、`docs/91`（§2.2 #1 / #3、§4 P1 #5 #6、§5 可引进原文 #1 #2 与署名规矩）、`docs/57` §1 §6（止损）、`packages/roles/roles/ads/*.yml`（`stop_loss_roas_below`）、`packages/roles/roles/common/owner.yml`、事实卡（facts）的定义、秘书 / 定时推送那套（grep 「每周」「secretary」）。

## 背景（Luoye 10-05 定）
- docs/91 §7 #1：后台六样**不开新岗位、落成技能**，经营周报挂「公司设置与授权」（`common.owner`）。
- docs/91 §7 #2：广告止损线**先并排显示两周再定**——自动止损仍是 `stop_loss_roas_below: 1`，不改。

## 要做
1. **毛利率事实卡**：公司（品牌）事实里加「毛利率」一格（可按品类 / SKU 覆盖），负责人在公司页填；没填就是没填。
2. **技能 `unit-economics`**：落地成本、毛利瀑布（采购 + 头程 + 仓储 + 平台佣金 + 广告 + 尾程 + 退货损耗 + 汇率）、盈亏线 ROAS = 1 / 毛利率；改价 / 折扣要附算式与到期日。照 docs/91 §5 #1 #2 改写（只从英文原仓改写，首行写出处，登记 THIRD-PARTY-NOTICES / NOTICE / upstreams.yml），所有门槛数进公司层阈值或事实卡，不进技能正文。挂 `dtc.store`、投放四条。
3. **并排显示**：投放的止损卡与日报上，在现有 ROAS 旁边加一格「盈亏线 ROAS」（取不到毛利率就显示「没填毛利率」+ 去填的入口）；高于 1 低于盈亏线的 campaign 标一个提示图标（不自动停、不出新卡）。从合并那天起记两周的对照数据（各 campaign 按两条线分别会不会被停），两周后能出一张对照表给 Luoye 定。
4. **经营一页纸**：`common.owner` 加只读动作「本周经营一页纸」+ 技能 `weekly-review`（结构：情况 / 发现 / 影响 / 建议 / 下一步，每条发现带一个数和出处，≤ 500 词）。数字只从各岗位已有面板取（店铺日报、广告两口径、内容按页收入、社媒近 30 天、红人归因、客服量）；**取不到就写「没接」，不估**。秘书每周一早上推一次（时间可在设置里改），多品牌时每个品牌一份（WP215 每品牌调度）。
5. 界面少字（docs/36 §7）：一页纸是一张卡，数字带出处 tooltip。

## 纪律
不改自动止损线；不跑批量清理命令；不读 .env*；本机 4317 服务别碰。并行中：WP222 改 `ads/*.yml`（加 `request_design`）——你在同一批文件里只加你的字段，冲突留给 Fable。

## 验证
`scripts/verify-changed.sh` + fast 模拟三包 × stub/direct/dsh（有漂移逐条说明）+ `gen-sdk` / `gen-ontology --check` / `gen-cloud-contract --check` + `open-repo-boundary`；截图：公司页毛利率、投放日报并排两线、一页纸卡；报告 `docs/briefs/reports/WP224.md`。
