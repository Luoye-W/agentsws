# WP217 Reddit 运营技能调研（先出结论，再定引进）

worktree `../agentsws-wt/wp217-reddit` · 分支 `wp/217-reddit`（从 main 新起）。先读 `_common.md`、`docs/42`（引第三方评估）、`docs/86`（社媒职责调研，里面已列 agency-agents 的 Reddit 角色等）、`docs/60`（公共关系岗位）、`docs/56`（社媒运营）、现有 Reddit 相关职责：`packages/roles/roles/social/reddit.yml`（我们自己的 subreddit 运营）、`pr/reddit.yml`、`pr/forums.yml`、`pr/monitoring.yml`、`ads/`（如有 Reddit 广告）、`packages/skills/bundled/*`（技能格式与 THIRD-PARTY-NOTICES）、WP209 的技能分组字段。

## 背景（Luoye 10-05）
「Reddit 运营相关的职责，你去网上找找看有没有 Reddit 运营相关的 skills 我们可以参考应用的。」真实业务：给 INMO（AR 眼镜品牌）**代运营 Reddit**——官方论坛（自家 subreddit）与全站监控是常驻自动化。

## 要做（这一单只调研 + 出建议，不改职责与技能代码）
1. **开源技能 / Agent 角色**：找所有能用的 Reddit 运营类 skills（Claude Skills / SKILL.md 仓库、agent 角色库、提示词库、awesome 列表、MCP 服务器里的 Reddit 工具说明等），每个写：链接、许可证、star / 活跃度、覆盖什么（社区运营、发帖、评论互动、监控 / 舆情、AMA、版主工作、Reddit 广告、Reddit SEO / GEO 被 AI 引用）、能不能原样引进（MIT / Apache / CC BY 可带署名；AGPL / NC / 无许可证只学思路）、质量判断（有没有拍脑袋数字、有没有违背 Reddit 规矩的做法如刷票 / 小号 / 隐藏身份推广——**这类直接排除并写明**）。
2. **官方规则与平台事实**（只取事实，标出处）：Reddit 内容政策与反垃圾规则（自我推广比例、Reddiquette、各版规优先）、品牌账号与 Reddit Pro / 官方品牌工具、版主工具、AMA 官方做法、**Reddit Data API 条款与商业用途收费 / 限流**（我们的监控怎么合规取数：官方 API / 第三方数据商 / 公开 RSS 等各自的条款）、Reddit Ads、账号风险（shadowban、karma 门槛、新号限制）。
3. **对照我们现有四条 Reddit 相关职责**：每条现在怎么写的、调研后缺什么 / 要改什么（persona 六段、额度、意图词、出卡规则、监控节奏与关键词、给 INMO 这种「代运营」场景要注意的：以品牌官方身份透明发言、披露、合规）。
4. **建议**：值得原样引进的 1–3 份技能（理由 + 许可证），以及我们自写一份「Reddit 运营」技能的大纲（段落：先读什么、版规怎么查、发帖 / 评论 / AMA 怎么做、监控与升级、不做什么、出卡规则、常见错）。写进 `docs/89-Reddit运营技能调研-v1.md`。
5. 结论段：要 Luoye 定的事（少而准）。

## 纪律
只看公开页面与仓库，不注册不登录；不拷许可证不兼容的原文；不读 .env*；不跑批量清理命令；本机 4317 服务别碰。

## 验证
`open-repo-boundary`（vitest）；报告 `docs/briefs/reports/WP217.md`。
