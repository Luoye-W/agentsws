# WP191 社媒运营职责定义：调研开源知识 + 补 LinkedIn 运营 + 充实 YouTube / TikTok / X

worktree `../agentsws-wt/wp191-social-duties` · 分支 `wp/191-social-duties`（从 main 新起）。先读 `_common.md`、`docs/56`（社媒运营岗位与客服社群管理）、`docs/69`（角色定位六段骨架）、`docs/54`（岗位路由靠意图词）、`docs/42`（引第三方的评估规矩）、`packages/roles/positions/social-media.yml`、`packages/roles/roles/social/*.yml`（九条，Meta 那条注释最全）、`packages/social-core`、契约 `packages/contracts/src/social.ts`（`SOCIAL_CHANNELS` 是全仓唯一渠道清单）、`packages/roles/roles/b2b/outbound.yml`（LinkedIn 在 B2B 那边只出「请本人去发」的任务）。

## 背景（Luoye 09-29）
「社媒运营，继续增加，YouTube 运营，TikTok 运营，LinkedIn 运营，X 运营。然后网上找一下有没有开源的项目或者知识，我们要给社媒运营下的职责对应的定义。」
现状：YouTube / TikTok / X 三条已有（WP72），岗位默认只勾 Meta / TikTok / YouTube；**LinkedIn 运营没有**。三条已有的定义骨架与 Meta 相同，渠道特有部分偏薄。

## 第一段：调研（先交，写成 `docs/86-社媒运营职责定义-v1.md`）
1. 网上找能拿来定义「每个平台的运营职责」的**开源项目与公开知识**，至少覆盖：
   - 开源 Agent / 技能库里的社媒角色（例如 `msitarzewski/agency-agents` 的 TikTok / Instagram / Reddit / Twitter / LinkedIn 等营销角色、`coreyhaines31/marketingskills`、`wshobson/agents`、`anthropics/knowledge-work-plugins` 的 marketing 插件——以实际查到的为准，自己再找）；
   - 公开的职业标准（O*NET 的社媒相关职业任务条目、欧盟 ESCO 的 social media manager 等）；
   - 各平台官方的创作者 / 企业学院与规则（YouTube Creator Academy / 社区准则、TikTok Creator Academy / Business Center、LinkedIn Pages 最佳实践与 Marketing API、X Business / 自动化规则）；
   - 开源排期工具（Postiz、Mixpost 等）只看它们对每个平台的**能力与限制**怎么建模，不抄代码。
2. 每个来源写清：链接、许可证、能不能原样引进（MIT / Apache / CC BY 可以带署名引；CC BY-NC、无许可证、AGPL 只能学思路不能搬原文）、对我们有用的是哪几条。
3. 按平台（YouTube、TikTok、LinkedIn、X，顺带对照 Meta）整理成我们职责 yml 能用的定义：负责什么 / 不负责什么（按 docs/69 六段）、日常节奏、看哪些数、对外动作与每日额度、平台特有的坑（API 权限、审核、自动化禁令、账号风险）、意图词。
4. 结论段：每条职责要改什么、LinkedIn 那条怎么定，有要 Luoye 定的列出来（白话，少而准）。

## 第二段：落地（照第一段结论）
1. **新增 `social.linkedin`（LinkedIn 运营）**：管我们自己的公司主页（Company Page）与创始人 / 老板本人号的内容。按 LinkedIn 规矩：
   - 发帖走官方接口（个人号 `w_member_social`，公司主页要 Community Management API 审核）；连接器 `required: false`（没连也能排内容、起草、攒审批，发的时候才要）；接不上 / 审核没过的，发布卡变成「复制文案去 LinkedIn 发」的任务；
   - **不抓取、不自动加人、不自动私信**（LinkedIn 用户协议禁自动化；找客户、加人、私信归 B2B 岗位，且那边也只出本人去发的任务）；
   - 发布永远 L1 人审；每日额度按调研定（参考 LinkedIn 常见节奏）；
   - `SOCIAL_CHANNELS` 契约**只加不改**（加在内容账号组末尾）；`social-core` 加 `channels/linkedin.ts`（照 meta 那份的结构，替身测试不连真接口）；连接目录加 LinkedIn 卡（若已有同名卡就复用）；
   - 社媒运营岗位加上这条（`default: false`），B2B 岗位的 persona / 意图词里写清「公司主页内容归社媒运营的 LinkedIn 那条，找客户归我」，两边意图词分得开。
2. **充实 YouTube / TikTok / X 三条**（Meta 顺带核一遍）：按第一段结论补「这条渠道特有的部分」注释、persona 六段、grounding 意图词、quick_prompts、task_examples、额度；只加不改动作 id 与数据域；引了开源原文的在注释里署名与许可证。
3. 岗位默认勾选不动（Meta / TikTok / YouTube）；X 与 LinkedIn 默认不勾——除非调研给出强理由，写进报告交 Fable。
4. i18n、帮助文档（`docs/help` 里社媒运营那篇，中英）同步；本体 `gen-ontology` 重生成。
5. 模拟：社媒相关包里加一条 LinkedIn 场景（起草公司主页帖 → 出卡 → 没连接时变成「去 LinkedIn 发」任务）；其余零漂移，有漂移按惯例说明。

## 纪律
先交第一段（提交 docs/86 后在报告里报一声再做第二段，不用等回复）；契约只加不改；测试不连真接口；不跑批量清理命令；不读 .env*；**Luoye 的本机服务在 4317 别碰也别重启**；测试 `--maxWorkers=2`，起服务钩子超时的文件串行重跑确认。WP188（随便聊）在并行做，碰到 `i18n.ts` 冲突以对方为准、只加自己的键。

## 验证（审核方全量用）
`scripts/verify-changed.sh` + fast 模拟三个包 × stub + `gen-sdk` / `gen-ontology --check` / `gen-cloud-contract --check` + `scripts/open-repo-boundary.test.mjs`（vitest）；报告 `docs/briefs/reports/WP191.md`。
