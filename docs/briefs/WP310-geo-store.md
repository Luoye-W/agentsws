# WP310 SEO / GEO 监测 O1：契约与存储（docs/99 §7 O1；决策 460–473，含 Luoye 10-14 的改动）

worktree `../agentsws-wt/wp310-geo-store` · 分支 `wp/310-geo-store`。先读 `_common.md`、`docs/99-SEO与GEO监测-v1.md`（全文）、`docs/briefs/reports/WP307.md`、`docs/96`、WP154 / 166 / 169 的 GEO 代码（`generateGeoQuestions`、`analyze.ts`、`seo-state.json`）。私有云同时在做 C1（WP309，Claude 回答 + 排名追踪 + 回答全文与引用原样带回），契约以本单为准、先合。

## Luoye 10-14 对 docs/99 的改动（以这里为准）
- **463 GEO 按 Prompt 追踪，不按关键词**：AI 从不同方向（如：品类推荐 / 选购指南 / 和竞品对比 / 使用场景 / 价格与性价比 / 口碑评价 / 带品牌名的直接提问 等）列出候选 Prompt，用户从中选**最相关的 5 个**（默认）持续追踪，也可以选 10 个或更多（档位 5 / 10 / 20，上限可配）。候选和已选分开存；改字 = 归档旧的 + 新建一条。SEO 的「关注关键词排名」（465）仍按关键词，是另一件事。
- **468 品牌词数据从 Google Search Console 自动取，每周一次**（品牌词查询的曝光 / 点击 / 平均排名），不走关键词概况的月搜索量。没连 GSC 就不显示这一块并提示去连。
- **473 回答全文、引用、周指标都长期保存**（本机），不设 13 个月上限；用户可导出、可删除。
- 其余照 docs/99：460（ChatGPT / Gemini / Claude + AI 概览，各自可关）、461、462、464–467、469、470、472。

## 要做（O1 只做契约与存储，指标 / 定时 / 界面是 O2 / O3）
1. 契约只加不删：`AiPlatform` 加 `claude`；`AiAnswerResult` 加可选 `answer_markdown`、`citations[]`（url / title / domain / position / where）、`model`、`via`；新增 `BrandWatch`（品牌名 + 别名、自家域名、竞品 3–5 个、**候选 Prompt 与已选 Prompt（按方向分组、默认选 5）**、关注关键词（SEO 排名用）、市场、关注的 AI、频率）；`GeoQuestion` 加 `topic`（方向）/ `branded` / `selected` / `archived_at`；能力目录加 `ai_answer.claude`、`seo.rank_check`。
2. `search-providers` 的 DataForSEO 适配器加 Claude（LLM Responses、强制联网、上限 1024；自带 key 那档也能用），ChatGPT / Gemini 带回全文与结构化引用（不再只留 600 字节选）。
3. `analyze.ts`：别名匹配、首次出现位置（排第几）、竞品出现、网址归一 `url_norm`、引用归类（我们 / 竞品 / 电商 / 媒体 / 论坛 / 视频，先内置表）。
4. docs/99 §5.5 的 SQLite 表与迁移（本机品牌目录）：一次运行、每格回答全文、每条引用；把 `seo-state.json` 里的问题清单与开关搬进来（老数据不丢）；**不做过期清理**；导出（JSON / CSV）与删除（按品牌 / 按时间段）。
5. Prompt 候选生成的**纯函数与存储形状**（按方向分组，不塞品牌名的占多数）；真正调模型推荐放 O2。
6. 测试：契约 roundtrip；适配器替身回包带回全文与引用（三家）；迁移不丢老问题；别名 / 排位 / 归一；导出删除。

## 纪律
不读 .env*；不碰 key / token；不调真实付费接口；不跑批量清理；不碰本机 4317；不连远程机器。用户可见文字不提 DataForSEO 等批发商名。不合 main、不打 tag、不发版（决策 381）。

## 验证
`scripts/verify-changed.sh` + 模拟三包 × stub/direct/dsh + gen 检查（本体 / 云契约 / SDK）+ 装包前冒烟；报告 `docs/briefs/reports/WP310.md`（决策号从 530 起）。
