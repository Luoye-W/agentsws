# WP220 融合两份开源研究技能：last30days → 公共关系岗位；social-media-research → 社媒运营岗位

worktree `../agentsws-wt/wp220-research-skills` · 分支 `wp/220-research-skills`（从 main 新起）。先读 `_common.md`、`docs/42`（引第三方）、`docs/89`（Reddit 调研 + 附录全量清单；Reddit 取数要官方批准、不许未授权抓取）、`docs/86`（社媒职责调研）、`docs/60`（公共关系岗位）、`docs/56`（社媒运营）、`packages/roles/roles/pr/*.yml`、`packages/roles/roles/social/*.yml`、`packages/skills`（bundled、THIRD-PARTY-NOTICES、WP209 frontmatter、`seo-judgment` 改编多个上游技能的先例）、取数能力：dsh 官方网页搜索（WP179）、接口管理能力目录（WP192，私有仓云端；开源侧 `packages/contracts` 的数据能力与本机客户端）、`upstreams.yml`。

## 背景（Luoye 10-05）
从 Reddit 相关开源技能清单里挑中：
- **mvanhorn/last30days-skill**（⭐63k，MIT）：「研究任意话题在 Reddit、X、YouTube、HN、Polymarket 与全网最近 30 天的讨论，然后综合」——Luoye：非常值得**公共关系**岗位参考。
- **ScrapeCreators/social-media-research-skills**（⭐3.2k，MIT）：爆款帖、评论挖掘、竞品拆解、广告库——Luoye：非常值得**社媒运营**参考。

## 要做
1. **读透两份源码**（克隆到会话临时目录，不进仓库）：方法论（步骤、打分 / 排序、去重、时间窗、产出格式）、各自**怎么取数**（哪些站、用什么接口 / 第三方服务、要不要 key、是否抓取）、提示词结构、许可证与版权行。
2. **融合方式：保留方法论与产出，换掉取数层**：
   - 改编成我们自己的技能（如 `trend-research`〔给公共关系〕与 `social-research`〔给社媒运营〕，名字你定），正文用我们的结构（WP209 frontmatter、少字、出卡规则），在 THIRD-PARTY-NOTICES 署名、`upstreams.yml` 登记两个上游（上游更新时走 WP219 的审核流程）；MIT 允许改编，原文复用的段落保留版权行；
   - **取数一律走我们合规的口**：官方网页搜索（WP179）、接口管理里已有 / 可配的能力（WP192：SERP、Apify 社媒类 actor 等）、各平台官方接口（有授权时）；**不直接抓 Reddit / X、不调未授权的第三方抓取服务**；Reddit 在拿到官方批准前那一路标「待授权」照实跳过并在报告里说明（docs/89）；需要而我们还没有的取数能力，列成「接口管理待接能力清单」交 Fable（不在本单接）；
   - 产出：一份可读的研究报告（带出处链接与时间、按话题 / 情绪 / 平台分组）+ 可进卡片流的建议（如「这个话题值得回应」「这条帖子在扩散」），照出卡规则。
3. **挂到职责**：last30days 改编版挂公共关系岗位里做舆情 / 话题 / 媒体的那几条（`pr.monitoring` 必挂，其余按内容判断）；social-media-research 改编版挂社媒运营各渠道职责（按需加载）；quick_prompts / task_examples 各加一两条（如「这周 INMO 在 Reddit 和 X 上大家在聊什么」「拆一下竞品这个月的爆款帖」）。
4. 测试：技能 frontmatter / 挂载、取数只走白名单能力（替身）、Reddit 未授权时跳过且不报错、产出格式；模拟零漂移或加一条研究场景（按需，说明）。

## 纪律
许可证照 docs/42；不直接抓取任何平台；不读 .env*；不用上下文密钥；测试不连真接口；不跑批量清理命令；本机 4317 服务别碰；验证日志唯一文件名；WP216 / WP219 并行，冲突两边都留。

## 验证
`scripts/verify-changed.sh` + fast 模拟三包 stub + `gen-ontology --check` + `check-upstreams --check` + `open-repo-boundary`；报告 `docs/briefs/reports/WP220.md`（含两份源码的取数方式与我们的替换对照、待接能力清单）。
