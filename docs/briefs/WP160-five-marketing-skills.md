# WP160 写五个营销技能（借 marketingskills 与 open-seo，翻译改写成中文 SKILL.md）

worktree `../agentsws-wt/wp160-skills` · 分支 `wp/160-skills`（从 main 新起）。先读 `_common.md`、docs/50 §0（按人切职责，不新建职责）、
范例 `packages/support-core/skills/customer-care/SKILL.md`（中文、frontmatter 顶格 `name / description / license / tier / version`、按 `##` 分段；附录进 `references/`——**先查清我们的加载器读不读 references/**：`packages/skills/src/{frontmatter,parse,registry}.ts`，读不到就并进正文）、
职责里已登记但没内容的技能：`packages/roles/roles/dtc/content.yml` 的 `seo-judgment`、`packages/roles/roles/ads/*.yml` 的 `ad-copywriting` 与 `audience-research`；以及邮件营销、红人五条职责的技能登记。

来源（两家都是 **MIT**，可以翻译改写，保留出处）：
- https://github.com/coreyhaines31/marketingskills （pinned `5b2c0007766c6a1cf1d53fd8fc73e979e0821022`）：`skills/{ai-seo,seo-audit,content-strategy,copy-editing,ad-creative,ads,customer-research,sms,emails,influencer-marketing}/SKILL.md` 及其 references、evals。
- https://github.com/every-app/open-seo （pinned `0ffff93101043aad7600a3b6a499a0cd2887ef49`）：`plugins/openseo/skills/*/SKILL.md` 里的判断规矩。
用 `gh api repos/<owner>/<repo>/contents/<path>?ref=<commit>` 读，不整仓克隆进本仓库。

## Luoye 09-27 定：先写这五个
1. **`seo-judgment`**（内容与搜索）：`ai-seo` + `seo-audit` 的页面部分 + `content-strategy` + `copy-editing` 的旧内容翻新附录；加 open-seo 的规矩——每条排名结论当场查一次 SERP、自然结果名次自己数（写成「#11（第 2 页）」）、查询失败算未知不许写成不在前 20、第三方流量估算不是实测、拿不到的数写「不知道」、按业务与人群挑词不追搜索量。
2. **`ad-copywriting`**（投放四条）：`ad-creative` + `ads`，重点「按表现数据迭代变体」。
3. **`audience-research`**（投放四条，品牌建档也可引用）：`customer-research`，重点「去评论区 / Reddit / 论坛挖买家原话」。
4. **邮件与短信**（`dtc.email-marketing` 上的技能；名字按现有登记，没有就新登记一个）：`sms`（TCPA / 10DLC / GDPR / CASL 合规、弃购 / 浏览弃购 / 售后模板）+ `emails` 的原则。
5. **红人营销**（`kol.*` 五条共用一个技能）：`influencer-marketing` + UGC 附录（FTC 披露、创意简报、合作条件、ROI）。

## 改写规矩（和我们冲突的一律改，见 Fable 调研结论）
- **所有发送 / 发布 / 花钱 / 上传一律出卡等人批**；删掉「授权后可自动执行」「批量 CSV 直接上传」「排期自动发」之类。自动化级别由职责 YAML 的 `automation` 管，技能文本不许授权。
- 「加统计数字 / 加专家引语提升引用率」→ 改成「数字只引事实卡，查不到就删；引语只用人给的原话」；没出处的行业数字（如「AI 概览出现在约 45% 的搜索」）不进正文，最多作为「行业说法」放附录并标来源不明。
- 结构化数据、AI 爬虫放行、llms.txt → 写明「交给建站开事项」，内容职责不改。
- 默认读 `.agents/product-marketing.md` → 换成我们的品牌档案、知识库事实卡与设计规范。
- 紧迫、稀缺、叠赠品等话术 → 注明要过发布前违规宣称检查（WP159 按市场分组）。
- 偏 SaaS 的例子换成跨境电商 DTC 的例子（3C 配件、家居、服饰等）。
- 每个文件 frontmatter 后第一行或文末写「改编自 coreyhaines31/marketingskills（MIT，© 2025 Corey Haines）」/「部分判断规矩改编自 every-app/open-seo（MIT）」；仓库根 `NOTICE` 各加一行；`upstreams.yml` 登记两条（`kind: ported`，pinned_commit 如上，watch releases）。

## 测试
- 技能能被加载器解析（段落、frontmatter），职责拿得到；evals 里有用的考题改写成我们的技能 / 模拟测试（至少每个技能 3 条：遵守出卡、数字不编、合规段在）。
- 守卫：技能文本里不出现「自动发送 / 自动发布 / 直接上传 / without approval」这类授权字样（写成测试）。
- fast 模拟两个包三个运行时不劣化（技能进 prompt 会动 token 基线的话按惯例 `--rewrite-baseline` 并写明）。

## 纪律
不联网调模型；不跑批量清理命令；不读 .env*。Luoye 的本机服务在 4317，别碰。WP158 / WP159 在并行（都动 SEO 服务 / 内容职责），改共享文件只动你那几处。
