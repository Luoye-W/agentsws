# WP154 「内容与博客」升级成「内容与搜索」：SEO + GEO 的每日判断循环

worktree `../agentsws-wt/wp154-content-search` · 分支 `wp/154-content-search`（从 main 新起）。先读 `_common.md`、docs/50 §0（**职责按「人」切**，Luoye 09-26 定）、
Luoye 收藏的文章 `/Users/yeluo/Documents/Luoye/Clippings/how we 47x'd our SEO in 2 weeks.md`（循环：读 → 判断 → 修 → 写 → 衡量；六个信号；先修再写；点击之后看转化）、
`packages/roles/roles/dtc/content.yml`、`packages/deck/src/blocks.ts`（`GSC_BLOCKS` / `GA4_BLOCKS`）、`packages/kol-core/src/attribution.ts`（Shopify `landing_site` 归因写法）、`docs/briefs/WP155-search-data-serp-geo.md`（**搜索数据契约**，WP155 并行在做）。
GEO 参考 https://github.com/yaojingang/GEOFlow ——**它是 AGPL-3.0，我们是 Apache-2.0，代码一行都不许搬，只借思路**。

## Luoye 09-26 定
- SEO 与 GEO **不新建职责**，并进 `dtc.content`：中小公司里写内容的人就是顺手做 SEO 的人。职责 id 不变，显示名改「内容与搜索」，说明改成「博客与页面内容、SEO 与 AI 搜索可见度（GEO）」。
- 岗位名「网站运营」**不改**。
- 搜索结果与 AI 平台问答数据用第三方（WP155）。

## 要做
1. **职责模板**：连接——店铺（必需）、Search Console（**推荐**：没连时面板与每日卡明说「接上才看得到」）、GA4（可选）。技能与人设照「SEO 难的是判断不是写字」「先修再写」「不堆数据」重写；新动作（全部出卡，额度照现有 listing_edit / publish_post 的写法）：改页面标题 / 描述 / H1 / 开头两句、加小节、调整内链。
2. **每日读一遍 Search Console**（定时，早上一次；工作区时区）：只算六个信号——排名 3–20 的非品牌词、曝光 > 500 且点击率 < 0.5%、周环比点击降 30%、有排名但没有专门页面的查询、搜索意图与页面类型不符、7 个词以上的长尾。其余数据不上卡。
3. **每天一张卡「今天值得动的 5 件事」**：每件 = 信号 + 查询 / 页面 + 证据数字 + 建议动作；按「先修再写」排序（能改现有页面的排前面）；动作分流：
   - 改现有页面元信息 / 开头 / 小节 / 内链 → 本职责出改动卡；
   - 需要新页面 → 先（若 WP155 已接）查一次 SERP 看排前面的是不是对的人群，是才出「新页面选题」卡（写和发仍归本职责，每天发布上限照旧 2 篇，分批发）；
   - 跳转 / 规范网址 / 没被收录 → 交给「建站」岗位（开一件事项 + 说明）；
   - 需要站外被提及 → 交给「公关」岗位（Reddit / 论坛 / 新闻稿）。
4. **收入归因（文章第三步）**：按页面并排「点击 / 订单 / 收入」——订单用 Shopify 的 `landing_site`（没接 GA4 也能算）；接了 GA4 再补落地页转化率。面板上「点击多但没订单」「点击少但出订单」两类单独标出来；每周一张小结卡。
5. **GEO**：每周一次，拿一组买家会问的问题（从品牌档案 + 排名前列的查询自动生成，用户可在面板里改）调 `SearchDataPort.aiAnswers` 探测各平台：我们有没有被提到、引用了哪些站、提到了哪些竞品；缺位的出建议卡（改哪页 / 交公关）。站点门面（llms.txt、结构化数据、允许 AI 爬虫）出一件交给「建站」的事项，不在本职责里改。
6. **内容质检门禁（借 GEOFlow 的思路，自己写）**：发布前自动检查——事实能对到品牌知识库、数字有出处、没有违规宣称（绝对化用语、医疗功效等，规则表放知识库可改）；不过就挡在草稿，卡上说明哪句有问题。
7. **WP155 还没合进来时**：用契约里的 `SearchDataPort` 接一个替身；`status().configured === false` 时 SERP 检查与 GEO 探测跳过，卡上一句人话「搜索数据接口还没接」，其余照跑。
8. **模拟包**：dtc-3c-3p 加一个场景「每日 SEO 卡」（替身 GSC 数据 → 卡里恰好 5 件、顺序符合先修再写、没有数据倾倒），按惯例三个运行时 `--rewrite-baseline` 并写明哪些指标为什么变。

## 纪律
不联网、不接真 GSC / GA4 / 服务商；不跑批量清理命令；不读 .env*；不部署。Luoye 的本机服务在 4317，别碰；截图 demo 端口 4444。

## 验证（审核方全量用）
`vitest run packages/roles packages/deck packages/kol-core apps/server apps/workstation packages/simulation` + fast 模拟两个包三个运行时 + `gen-sdk` / `gen-ontology --check`。
