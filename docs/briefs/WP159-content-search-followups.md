# WP159 内容与搜索三项后续：去掉 Perplexity 并降价、改动卡初稿由模型写、违规宣称规则按市场

worktree `../agentsws-wt/wp159-seo-followups` · 分支 `wp/159-seo-followups`（从 main 新起）。先读 `_common.md`、`docs/briefs/reports/WP154.md`、`docs/briefs/reports/WP155.md`、`docs/81`、`packages/metering/src/pricing.json` 与 `cost-table.json`、`packages/seo-core`。

## Luoye 09-27 定
1. **不考虑 Perplexity**（用的人少、在走弱）：GEO 探测默认平台 = ChatGPT、Gemini、Google AI 概览；官方那一侧不再列 Perplexity（适配器代码可留，登记为不用；契约里的枚举值不删，只加不删）。
2. **AI 问答探测降价**：去掉 Perplexity 后最贵的一家成本约 $0.004 / 次，`data.search.ai_answer` 建议价改 **0.2 积分 / 平台·次**（毛利 ≥ 80% 按 cost-table 那条测试照算；`basis` 重写；`reviewed_at` 仍留空，价格等 Luoye 最终点头）。每周默认 6 个问题 × 3 个平台 = 3.6 积分，面板上的每周估算跟着变。
3. **改动卡初稿改由模型写**（WP154「要定」第 3 条：可以）：每天那张「5 件事」里要改标题 / 描述 / H1 / 开头两句 / 加小节的，由模型按品牌口吻与知识库写初稿（照 WP122 设计规范、品牌档案注入），规则版那份当兜底（模型不可用或超预算时用）；仍然全部出卡等人批；每天模型调用有上限，花费进用量。
4. **违规宣称规则按市场加**（第 4 条：可以）：在知识库的违规宣称规则表里按市场分组——美国（FTC：未经证实的功效 / 「Made in USA」/ 评价与代言披露）、欧盟 / 英国（ASA / UCPD：绝对化与误导性比较、环保宣称 green claims）、加拿大、澳大利亚，外加通用的绝对化用语与医疗功效；按品牌档案里的目标市场启用对应组；每条规则写清出处（官方指南链接）与一句人话；用户可在知识库里改 / 关。

## 验证（审核方全量用）
`vitest run packages/seo-core packages/metering packages/cloud-entry apps/server apps/workstation` + fast 模拟两个包三个运行时。

## 纪律
不联网调模型或服务商（全替身）；不跑批量清理命令；不读 .env*。截图 demo 端口 4449；Luoye 的本机服务在 4317，别碰。WP158 在并行（GSC / GA4 读数，也动 SEO 服务），改共享文件只动你那几处，收尾 merge main 冲突两边都留。
