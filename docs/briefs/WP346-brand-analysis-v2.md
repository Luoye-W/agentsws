# WP346 品牌分析第二版：补齐人群 / 关键词 / 定位 / 竞品，下游统一读档案（Luoye 10-15 定，决策 872）

worktree `../agentsws-wt/wp346-brandintake` · 分支 `wp/346-brandintake`（从 main 拉；收尾前合一次最新 main）。先读 `_common.md`、`docs/70`、`packages/brand-intake/src/*`、`packages/contracts/src/brand-intake.ts`（`BrandIntakeProfile`）、`apps/server/src/brand-intake.ts`、`brand-knowledge.ts`、`onboarding.ts`、`apps/workstation/src/components/onboarding/brand-profile-card.tsx`、`profile-form.tsx`、`pages/settings.tsx`；下游：`apps/server/src/reddit-watch/suggest.ts`（WP340）、`geo-monitor.ts`、`kol-service.ts`、广告相关（WP315 / 316）。

**移植来源（Luoye 自己的代码，默认移植不重写）**：`/Users/yeluo/Documents/KOLAgents/src/influencer/services/enrichment.ts`（`previewBrandFromUrl` / `analyzeBrand` / `applyBrandEnrichment` / `analyzeProduct`）、`src/influencer/services/product-scrape.ts`。只移植分析提示词与字段逻辑；MkSaaS 模板部分不能进开源仓；不引 Apify / Jina（我们已有自己的抓取）。注意它的 bug：`audienceNotes` 生成了但预览没带上——别照搬。

## 要做
1. **档案补字段**（AI 归纳，一律标「请确认」，人改了才算）：目标人群（谁买、谁付钱、顾虑）、关键词（品牌 / 品类 / 场景，分组）、价格带、子品类、品牌定位一段（保留现有一句话介绍）、主要竞品（AI 建议 3–6 个、带一句理由，两边都没有的新格子）；商品卡补规格、原价 / 售价分开。
2. **模型那一步**：用品牌自己的默认模型（没有就跳过 AI 格子、照旧出解析结果）；一次分析一次调用为主，计入积分并沿用现有封顶；提示词只喂抓到的页面文字，不联网另查（竞品是模型建议，标明「AI 建议」）。
3. **确认卡**：首次设置第 ② 步的档案卡与设置页「品牌档案」都显示新格子，可逐格改；AI 格子旁标「AI 建议」。
4. **老品牌重跑**：设置页「重新分析一次」（贴网址或用档案里的官网），结果按格子对比显示「现在 / 新的」，人逐格采纳；不自动覆盖人改过的格子。还没有真实用户，不做老数据兼容迁移（决策 530 / 532）。
5. **下游统一读档案**：Reddit 巡查建议（WP340 `suggest.ts`）、GEO 追踪问题建议、红人搜索关键词、广告关键词建议都改成优先读档案里的人群 / 关键词 / 竞品，读不到再自己猜。
6. **docs/70** 补一节。

## 测试
- brand-intake 包：用本地 HTML 夹具 + stub 模型回复测新格子解析、封顶、模型没接时退化。
- 服务端：确认后写进档案；重跑只出对比不覆盖；下游四处读到档案值（各一条）。
- 工作台：档案卡新格子、AI 标、逐格采纳。
- 模拟三包照跑。截图：首次设置档案卡、设置页重跑对比。

## 纪律
不读 .env*；不碰 key / token；不调真实付费接口；不抓真实网站（测试只用夹具）；不连远程机器；不碰本机 4317；不跑批量清理；不用 pkill。不提 DataForSEO 等数据商；不在界面写客户名。不合 main、不打 tag、不发版（决策 381）。测试用 `--maxWorkers=2 --testTimeout=120000`；验证日志写独立文件。

## 验证
`scripts/verify-changed.sh`（LC_ALL=en_US.UTF-8）+ 模拟三包 × stub/direct/dsh + gen 检查 + 装包前冒烟 + 开源仓边界检查；报告 `docs/briefs/reports/WP346.md`（决策号 878–882）。
