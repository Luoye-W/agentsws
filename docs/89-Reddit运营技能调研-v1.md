# 89 · Reddit 运营技能调研 v1（开源技能、官方规则、四条职责要改什么）

| | |
|---|---|
| 状态 | 2026-10-05 WP217 交稿：**只调研、出建议**，职责 yml 与技能代码一行没动 |
| 来历 | Luoye 10-05：「Reddit 运营相关的职责，你去网上找找看有没有 Reddit 运营相关的 skills 我们可以参考应用的。」真实业务：给 INMO（AR 眼镜品牌）**代运营 Reddit**——官方论坛（自家 subreddit）与全站监控是常驻自动化 |
| 关联 | 56（社媒运营，`social.reddit`）、60（公共关系，`pr.reddit` / `pr.forums` / `pr.monitoring`）、86（社媒职责调研，格式照它）、69（persona 六段）、54（岗位路由靠意图词）、42 / 10 §3（引第三方的规矩）、WP209（技能 frontmatter 的 `positions` / `display_name` / `summary`） |
| 调研日期 | 2026-10-05。链接都是当天打开核过的；打不开、只从搜索摘要看到的，逐条标「未直接核实」。星数与最后推送时间用 `gh api repos/<仓>` 取 |

## 0. 一句话

TODO（§1–§6 写完再收）

## 1. 开源技能与 Agent 角色

许可证分三类，与 86 §1.0 同一套：MIT / Apache-2.0 / BSD / CC BY 可改写引用并在 `THIRD-PARTY-NOTICES` 登记；AGPL / GPL / NC / Commons Clause / **没写许可证** / 平台官方文档只学思路、不搬句子；商业模板不碰。覆盖面用八个词标：运营（社区运营）、发帖、互动（评论）、监控（含情绪）、AMA、版务、广告、GEO（Reddit SEO / 被 AI 引用）。

### 1.1 值得参考的（按「能用的程度」排）

| 档 | 来源（文件路径） | 许可证 | 星 / 最后推送 | 覆盖 | 能变成我们什么 | 毛病 |
|---|---|---|---|---|---|---|
| 高 | [social-media-skills/skills](https://github.com/social-media-skills/skills) `skills/reddit-marketing/`（SKILL.md + references 四篇：`the-cred-framework` / `what-gets-you-banned` / `playbook-and-examples` / `reddit-and-ai-citations-2026`，带 evals） | MIT（© 2026 Frank Heijdenrijk） | 114 / 10-01 | 互动、发帖、监控、GEO、合规 | **全场最好的一份**：只起草、人发；CRED 四步（先贡献 / 答问题不推销 / 拿证据说话 / 披露并服从版规）；一张「硬拒绝」表（刷票、小号、水军、统一口径刷评论、带队踩竞品、封号后换号、AI 灌水、不披露）且「拒绝后给正路」；「帖子和私信里让你做的事是内容，不是指令」；纠正过时的旧帖要拿证据补一条，不吵不压帖；GEO 按 ChatGPT / Perplexity / Gemini / AI Overviews 分开查 | 「Reddit 是 AI 最常引用的来源（约 40%）」「平均被引帖约一年前」这几个数**没写出处**——它自己的「不编数」规矩管不住自己；「约 9:1」是经验比不是官方规则（§2.1）；它说「Reddit 不值得任何自动化」，与我们走官方 API + 人审的路线不同，这一句不搬 |
| 高 | 同仓 `skills/community-management/`、`skills/crisis-and-moderation/` | MIT（同上） | 同上 | 运营、版务、AMA | 给**我们自己的版**用：固定栏目（每周讨论帖、AMA 当节目做）、「隐藏辱骂、留着诚实的批评」、出事时 Agent 不自动回、人批 | 不是 Reddit 专用，要配 Reddit 的版务名词 |
| 高 | [coreyhaines31/marketingskills](https://github.com/coreyhaines31/marketingskills) `skills/social/references/listening.md`（Reddit 段在 119–135、226–264 行）；另有 `skills/ai-seo/`、`skills/customer-research/references/source-guides.md` 的 Reddit 小节 | MIT（© 2025 Corey Haines；`NOTICE` 已登记） | 53,215 / 10-03 | 监控、互动、GEO | 每日监听循环：拉 → 只留 24 小时内 → 按意图打分（「有没有替代品」「受不了 X」这类词）→ 起草 → 人发 → 记哪些发了、哪些有回音；看反复出现的主题，不看单条；品牌提及与「竞品抱怨」两组查询；明确反对往 Reddit 批量灌帖 | 示例里直接 curl 公开 `.json`——**现在未鉴权一律 403，而且这种取数违反用户协议**（§2.4），这一段换成官方 OAuth；仓里没有单独的 Reddit 技能 |
| 中 | [shawnla90/gtm-coding-agent](https://github.com/shawnla90/gtm-coding-agent) `skills/reddit-engage/SKILL.md` | MIT | 151 / 09-02 | 互动 | 最干净的人审队列：每条机会的状态 `scouted → drafted → approved / rejected → posted`，**一条一条批，每批一条就落盘**，宁可少发 | 「不主动提产品名、让个人简介去推广」偏向隐藏身份——**对品牌官方号不适用**；依赖商业产品 Clearbox 的机会队列 |
| 中 | [msitarzewski/agency-agents](https://github.com/msitarzewski/agency-agents) `marketing/marketing-reddit-community-builder.md`（86 §1.1 已列过这个仓） | MIT | 156,859 / 10-04 | 运营、发帖、互动、监控、AMA、广告 | 四阶段骨架（摸版 → 内容 → 声誉 → AMA / 系列）、跟版主建关系、AMA 准备清单、出事诚实回应、「对身份坦白」 | **拍脑袋数字最多**：「90/10」「多个相关账号合计 10,000+ karma」「赞同率 85%+」「每条评论平均 5+ 赞」「AMA 500+ 问题」「自然流量 +15%」「80%+ 正面」——其中「多个账号合计 karma」**会把人往小号上引**，karma 与点赞当 KPI 会把人往养号刷赞上引；全文没有一句明确禁止刷票与小号。**结构可借，指标一个不搬** |
| 中 | [jonathimer/devmarketing-skills](https://github.com/jonathimer/devmarketing-skills) `skills/reddit-engagement/SKILL.md` | MIT | 87 / 03-03 | 互动、发帖、广告 | 先评论后发帖、**带披露的回帖模板**、明确禁止多账号刷票 | 各版订阅数没出处；把「10:1」当通则；建议用户名别带公司名——与品牌官方号的需求相反；面向开发者版 |
| 中 | [redditapis/redditapis-skills](https://github.com/redditapis/redditapis-skills) `subreddit-fit-check/SKILL.md` | MIT | 0 / 09-06 | 运营（选版、读版规） | 每个版给「绿 / 黄 / 红 / 判不准」的自我推广结论，**并引出依据的那一条版规原文**——与我们 `parseSubredditRules`「结论带原因」同一个思路，多了「判不准」一档 | 依赖商业数据转售方 redditapis.com，合规存疑；零星 |
| 工具 | [reddit/devvit](https://github.com/reddit/devvit)（官方示例在 `packages/apps`：`comment-nuke`、`remind-me`、`three-strikes` 等） | BSD-3-Clause | 212 / 10-01 | 版务 | **Reddit 官方的版务 / 应用平台**：跑在 Reddit 自己的服务器上，以「版内应用」身份做事。我们自己的版要做自动版务（三振出局、批量清评论），这是最合规的路 | 是 TypeScript 应用平台，不是技能；要在 Reddit 上建应用、装到版里 |
| 工具 | [FoxxMD/context-mod](https://github.com/FoxxMD/context-mod) | MIT | 56 / 05-12 | 版务 | 按发帖人历史判刷屏（跨版刷同一链接）、规则写在版的 wiki 里 | 小众，基于 snoowrap |
| 工具 | [praw-dev/praw](https://github.com/praw-dev/praw) | BSD-2-Clause | 4,270 / 09-29 | 监控、版务、发帖 | 官方 API 的 Python 封装，看它怎么处理限流与 fullname 可对照我们的 `social-core` 适配器 | 商业使用一样受 Data API 条款管 |
| MCP | [karanb192/reddit-mcp-buddy](https://github.com/karanb192/reddit-mcp-buddy) | MIT | 844 / 08-17 | 监控（只读） | 配了凭据走官方 OAuth，不配走公开 RSS；只读的浏览 / 搜索 / 帖子详情 / 用户分析 | RSS 那条路的条款问题见 §2.4 |
| MCP | [jordanburke/reddit-mcp-server](https://github.com/jordanburke/reddit-mcp-server) | MIT | 281 / 09-27 | 监控、发帖、互动 | 必须官方 OAuth，能发、回、改、删；**SAFE_MODE**（写之前延迟 + 重复内容检测）值得学 | 用户名密码换令牌（password grant）那条路我们不用 |

另有一批只学思路的：[alirezarezvani/claude-skills](https://github.com/alirezarezvani/claude-skills) 的 `research/pulse`（MIT，27,626 星；引用纪律好——只引这一轮真拿到的来源，但 Reddit 那段走未鉴权 JSON）、[mvanhorn/last30days-skill](https://github.com/mvanhorn/last30days-skill)（MIT，63,534 星；README 写明改走免密 RSS 与网页抓取、第三方归档，与用户协议冲突）、[anthropics/knowledge-work-plugins](https://github.com/anthropics/knowledge-work-plugins) `marketing/skills/competitive-brief`（Apache-2.0；只一句「Reddit 是情绪来源」）、[wshobson/agents](https://github.com/wshobson/agents) `social-publishing`（MIT；包的是商业发布 API）、[Hawstein/mcp-server-reddit](https://github.com/Hawstein/mcp-server-reddit) / [adhikasp/mcp-reddit](https://github.com/adhikasp/mcp-reddit)（MIT；默认走未鉴权接口，后者 2025-05 起停更）、[GeLi2001/reddit-mcp](https://github.com/GeLi2001/reddit-mcp) 与 [openslow/reddit-skill](https://github.com/openslow/reddit-skill)（**无许可证**，官方 OAuth 只读）、[elophanto/EloPhanto](https://github.com/elophanto/EloPhanto) `skills/reddit-marketing`（许可证 NOASSERTION；改自 agency-agents，那串数字原样带着）、[toolbox-team/reddit-moderator-toolbox](https://github.com/toolbox-team/reddit-moderator-toolbox)（Apache-2.0，**已归档、不维护**）。

查过、没有 Reddit 内容的：anthropics/skills、VoltAgent/awesome-claude-code-subagents、travisvn/awesome-claude-skills、f/prompts.chat（零星提及）、VoltAgent/awesome-agent-skills（只收了 last30days）；marketingskills 的 `skills/social/references/platforms.md` **没有 Reddit 段**。ComposioHQ/awesome-claude-skills 指向的 `reddit-automation` 在仓里 404，它的副本依赖商业 Composio MCP、带投票与发帖能力，只学思路。

### 1.2 排除的（写明为什么）

Luoye 的红线：**刷票、开小号、隐藏身份去推广，一律排除**。下面这些不是"质量差"，是做法本身违反 Reddit 规则（规则原文见 §2.1）——引进来等于把封号写进产品。

| 来源 | 许可证 | 它做什么 | 违反哪条 |
|---|---|---|---|
| [oh-ashen-one/reddit-growth-skill](https://github.com/oh-ashen-one/reddit-growth-skill)（156 星） | 无 | 浏览器直接替人发帖（刻意绕开 API）；要求「装成普通社区成员、绝不说自己是品牌方」；带养号预热 | Reddit Rules 第 5 条（误导他人 / 冒充）、第 2 条（不真实参与）；未登记的自动化账号 |
| [ubermensch1218/reddit-campaign-cli](https://github.com/ubermensch1218/reddit-campaign-cli) | MIT | Chrome 扩展 + AI 自动「攒 karma、种评论」，带「友好用户」「好奇新人」等多套人设 | 第 2 条（内容操纵、养号）、第 5 条（水军人设） |
| [LingoWise/reddit-skills](https://github.com/LingoWise/reddit-skills) | MIT | 模拟真人延迟与滚动来**躲机器人检测**，能自动点赞点踩 | 第 2 条（刷票）；用户协议（规避安全功能） |
| [1146345502/reddit-skills](https://github.com/1146345502/reddit-skills)（15 星） | MIT | 浏览器扩展接真账号，Agent「以普通用户身份」点赞、点踩、评论 | 第 2 条（自动投票）；未标注的自动化 |
| [awiseguy88/openclaw-reddit-automation-pro](https://github.com/awiseguy88/openclaw-reddit-automation-pro) | 商业许可 | 按关键词自动评论、「按条件智能投票」 | 第 2 条（刷票）；且不开源 |
| [ykdojo/claude-code-tips](https://github.com/ykdojo/claude-code-tips) `skills/reddit-fetch` | 「All Rights Reserved」 | 借搜索引擎跳转拿 cookie，**绕过 Reddit 的网络安全拦截**去抓 `.json` | 用户协议（未经同意抓取、干扰安全功能）；许可证也不让用 |
| [8TrafficAI/reddit-skills](https://github.com/8TrafficAI/reddit-skills) | MIT | 用已登录的浏览器发帖（默认空跑，加 `--yes` 才发） | 边缘：不算明目张胆，但绕开 API 与 Reddit 给自动化账号的标识。只学「发完回去看有没有被 AutoMod 吞掉」这一招 |
| AsapChun/RedditMarketingScript | — | 搜索摘要写「对用户批量营销」（**未直接核实**，没打开仓库） | 第 2 条（刷屏） |

还有一类「半排除」：[kevin-vaghasiya/reddit-marketing-skill](https://github.com/kevin-vaghasiya/reddit-marketing-skill)（MIT，2 星）目标写的是「悄悄地营销」、要求产出读不出是 AI 写的；它的披露段（不许冒充第三方推荐）可取，但「以创始人口吻、藏起 AI 生成」不适合代运营。gtm-coding-agent 的「不主动提产品名」同理只取队列、不取这一句。

### 1.3 好的来源共有的做法（用我们自己的话归纳）

1. **每次进一个版先读版规、侧栏与 wiki**，结论引出依据的那一条原文；说不清就问版主，或走版里指定的推广帖 / 每周帖。（social-media-skills CRED「D」、subreddit-fit-check、devmarketing）
2. **身份透明**：一个真人一个号；提到自家产品时一开口就说明「我是 X 团队的」；绝不扮路人好评，绝不用小号或团队刷同一句话。（social-media-skills `what-gets-you-banned`、agency-agents、kevin-vaghasiya 的披露段）
3. **先答真问题**，产品只是选项之一；竞品更合适就直说。（CRED「R」、listening.md）
4. **拿证据说话**：文档、截图、具体数据；纠正过时帖子写清「以前是这样、现在改了」再附证据。（CRED「E」、playbook 例 2）
5. **Agent 只起草，人一条条批**；状态逐条落盘；出事时 Agent 不自动回。（gtm reddit-engage、crisis-and-moderation）
6. **每日监听循环**：拉 → 只留新鲜的 → 按意图打分 → 起草 → 人发 → 记结果；看反复出现的主题。（listening.md）
7. **不重复、不刷屏**：同一内容不跨版发，回复每次重写，写之前延迟 + 查重。（gtm、jordanburke SAFE_MODE）
8. **自家版靠栏目与透明版规**：每周固定帖、AMA 当节目；隐藏辱骂、保留诚实批评；刷屏交给 AutoModerator / Devvit 应用。（community-management、ContextMod）
9. **AI 引用占比只当信号、不当 KPI**：分引擎查、写日期、自己复核，不把预算押在一个渠道上。（marketingskills `ai-seo`）

## 2. 官方规则与平台事实

只取事实、用自己的话写（官方页面默认版权所有，只学思路）。redditinc.com 的条款页直接打开读；Reddit 帮助中心（support.reddithelp.com）的网页对抓取回 403，改读它公开的文章 JSON 接口（`/api/v2/help_center/en-us/articles/<id>.json`），下表链接给的是正常网页地址，日期是文章的「最后编辑」。reddit.com 本站（wiki、r/IAmA 版规、r/redditdev 公告）对未登录请求一律回 403 或登录页，**没能直接核**的逐条标出。

### 2.1 内容规则、垃圾与「9:1」

| 事实 | 出处（日期） |
|---|---|
| Reddit Rules 第 2 条：守各版规矩、**真实参与**、不刷屏不操纵内容；第 5 条：可以不用真名，但**不许误导他人、不许冒充个人或组织**；第 8 条：别弄坏网站（含未授权抓取）。原 `content-policy` 地址已跳到这一页 | [Reddit Rules](https://redditinc.com/policies/reddit-rules)（页面无日期） |
| 垃圾 = 重复或不请自来的动作，**手动的也算**；列明的有：为曝光或赚钱批量发帖、用机器人或生成式 AI 刷内容、在一个或多个版里反复推销产品的机器人、自动注册账号。发自家链接要「留意频率」或去买广告——**没有任何数字比例**；什么算垃圾由各版版主定 | [Spam](https://support.reddithelp.com/hc/en-us/articles/360043504051-Spam)（2026-05-19） |
| 禁止用多个账号、刷票服务或自动化改票；禁止成群或用机器人协同投票；禁止自动刷 karma；禁止换号绕开版内或全站封禁；在多个同类版被反复举报或封，本身就算「扰乱社区」 | [Disrupting Communities](https://support.reddithelp.com/hc/en-us/articles/360043066412-Disrupting-Communities)（2026-05-19） |
| 违规例子里点名「一个组织用多个**看似无关的账号**」；AI 生成的内容不许装成人写的，鼓励打标 | [Manipulated Content and Misleading Behavior](https://support.reddithelp.com/hc/en-us/articles/41180423371156)（2026-05-19） |
| 可以有多个账号，但用其中多个给同一条内容投票就是刷票 | [Is it ok to create multiple accounts?](https://support.reddithelp.com/hc/en-us/articles/204535759)（2026-03-29） |
| **「9:1」不是官方规则**：Reddiquette 自称「许多用户价值观的非正式表达」，把 9:1 叫作「常用的经验法则」，同页还说别在你的工作有利益冲突的地方当版主；老的 `wiki/selfpromotion`（「10% 以下」那页）挂着「不再更新」的横幅（只看到 2024-06 的存档快照） | [Reddiquette](https://support.reddithelp.com/hc/en-us/articles/205926439-Reddiquette)（2025-08-18）；selfpromotion 页**本站未直接核实**，看的是存档 |

### 2.2 品牌账号、Reddit Pro、披露

| 事实 | 出处（日期） |
|---|---|
| **Reddit Pro**：免费、beta，给符合条件的企业，所有英语国家可用，不是广告工具 | [What is Reddit Pro?](https://support.reddithelp.com/hc/en-us/articles/24368510335892)（2026-03-30）、[business.reddit.com/pro](https://www.business.reddit.com/pro) |
| 开 Pro 的企业账号要守：**说清代表哪个品牌、绝不装成别家或普通消费者**、不扒用户身份不给个人建档、不针对或报复批评者、不拿好处换好评 | [Sign up for Reddit Pro](https://support.reddithelp.com/hc/en-us/articles/24368958859668)（2026-10-02） |
| **Pro 的 Trends = 官方关键词监控**：实时、关键词数不限，有「热门讨论」AI 摘要；只覆盖公开、非 NSFW、英文内容（删了的、私密版、聊天、modmail 不在内）；数据只许内部用，**不许手动或用工具下载别人的帖子与评论**；部分功能与 Sprinklr 打通 | [Trends](https://support.reddithelp.com/hc/en-us/articles/47619216411284)（2026-05-28） |
| Pro 其它：队友只能给**只读**席位（beta）；只能导出**自己**帖子的数；Pro 账号能给自己主页和**自己当版主的版**排期发帖、能开主页 AMA | [Dashboard](https://support.reddithelp.com/hc/en-us/articles/47618399765396)、[Performance](https://support.reddithelp.com/hc/en-us/articles/47618462633364)、[Profile](https://support.reddithelp.com/hc/en-us/articles/24389311835028)（2026-03 至 05） |
| **认证灰勾**：Pro 企业公测、免费、Persona 核身份；企业名要与显示名一致；只证明身份，不影响排序与版务 | [Verified profiles](https://support.reddithelp.com/hc/en-us/articles/42763717293716)（2026-07-09） |
| **Brand Affiliate 标签**：用户可给单条帖子 / 评论标「有偿或商业」，但法律要求的披露仍由用户自己负责 | [Brand affiliate tag](https://support.reddithelp.com/hc/en-us/articles/23972085214484)（2024-02-22） |
| 冒充规则里明列「**给自家品牌建官方社区**」是允许的；未经授权用别家名义发优惠是违规 | [Impersonation](https://support.reddithelp.com/hc/en-us/articles/360043075032)（2026-10-01） |
| 抽奖要 Reddit 许可、公布正式规则并声明与 Reddit 无关；不面向未成年人 | [Running promotions](https://support.reddithelp.com/hc/en-us/articles/22755369815700)（2026-08-05） |
| 美国 FTC：任何「实质关联」（员工、亲属、拿钱或拿东西的人）都要**清楚显眼地**披露，披露贴着推荐本身；平台自带的标签工具**未必够**，责任在品牌和发言人。2024 年假评论最终规则：禁止假评论与 AI 编的评论、**禁止不披露的内部人评论**（高管、员工、代理）、禁止买粉买播放 | [FTC 背书指南问答](https://www.ftc.gov/business-guidance/resources/ftcs-endorsement-guides-what-people-are-asking)、[FTC 假评论规则（2024-08-14）](https://www.ftc.gov/news-events/news/press-releases/2024/08/federal-trade-commission-announces-final-rule-banning-fake-reviews-testimonials)（美国政府作品） |

### 2.3 版主、AMA

| 事实 | 出处（日期） |
|---|---|
| **版主守则第 2 条：品牌官方版必须清楚标「official」**，不是官方的要标「unofficial」；第 4 条：要活跃、人手够 | [Moderator Code of Conduct](https://redditinc.com/policies/moderator-code-of-conduct)（2025-06-05 生效） |
| **第 5 条：不许因第三方给的报酬做版务**（卖置顶、卖「广告位」都点名）；明文允许「公司员工建立并维护版，只要不收报酬」，帮助页把「公司或品牌管一个版」列为允许 | 同上；[Rule 5 帮助页](https://support.reddithelp.com/hc/en-us/articles/27031261124884)（2025-01-30） |
| 用户协议 §8：版主不得为第三方的任何报酬、对价、礼物做版务；不得未经 Reddit 书面同意代表一个版与第三方签约 | [User Agreement](https://redditinc.com/policies/user-agreement)（2026-07-01 生效） |
| 认领闲置版（r/redditrequest）：号满 90 天、帖子与评论 karma 各 100、验证邮箱 + 两步验证、现任版主 30 天不活跃且先私信过；15 天一次 | [r/redditrequest 条件](https://support.reddithelp.com/hc/en-us/articles/29184583611284)（2025-06-05） |
| **AutoModerator 变了**：新建的版、或从没用过 AutoMod 的版，**它的处置动作（举报、过滤、删除、标垃圾、批准）不再可用**，改用 Rules 与 Automations 工具 | [Automoderator](https://support.reddithelp.com/hc/en-us/articles/15484574206484)（2026-09-30） |
| 版务工具：Post & Comment Guidance（发帖前按正则提示）、Crowd Control、Ban Evasion 过滤、**Reputation 过滤**（基于 Contributor Quality Score）、Harassment 过滤（用大模型）、Mod Insights、Devvit 应用；每个版主最多管 5 个周访客过 10 万的版 | [工具总览](https://support.reddithelp.com/hc/en-us/articles/15484384020756)（2026-08-06）及各工具页（2026） |
| **原生 AMA 帖**：最多提前 21 天排期、最多 5 位共同主持、预约提醒、已答 / 未答分栏；证明照片可选；先联系那个版的版主；**必须本人答，不能别人代答、不能预写答案** | [What is an AMA](https://support.reddithelp.com/hc/en-us/articles/115002427523)（2026-06-02） |
| 版主侧 AMA 清单：提前至少 48 小时确认嘉宾用户名与证明照，把嘉宾设为批准用户、免过滤，结束后锁评论 | [AMA checklist](https://support.reddithelp.com/hc/en-us/articles/26342824868756)（2026-05-28） |
| r/IAmA 自己的版规（要证明、同一话题三个月一次、不许送礼）| **未直接核实**（只看到镜像摘要） |

### 2.4 Data API 条款、取数与限流（监控最要紧的一节）

| 事实 | 出处（日期） |
|---|---|
| **Responsible Builder Policy：用 API 取任何 Reddit 数据之前要先申请、拿到明确批准**；同一用途不许开多个账号或多次申请；**商业用途要书面批准**；自动化账号要注册、挂「App」标签，且只做 App 的事；不刷票刷 karma、不跨版发相同内容；没书面批准不卖、不分享数据、不拿去训练模型；不推断敏感特征、不反查用户身份 | [Responsible Builder Policy](https://support.reddithelp.com/hc/en-us/articles/42728983564564)（2025-10-28 建，2026-06-05 改） |
| 自助申请 API 于 2025-11-11 关闭、已有的不受影响 | **未直接核实**（r/redditdev 公告只看到镜像与第三方 README） |
| **商业用途 = 「企业使用、替企业使用、或作为收费产品的一部分」**——代运营品牌监控属于商业用途，要先拿许可、签协议；不许把 Reddit 内容放在广告旁边；批量导出默认受限，解限可能收费；**官方没有公开价目** | [Developer Platform & Accessing Reddit Data](https://support.reddithelp.com/hc/en-us/articles/14945211791892)（2026-05-28） |
| Developer Terms §4.1：没有书面批准，不许「企业或替企业」或在收费产品里用；§4.2：不许隐瞒取数方式与用途（含一个用途开多个应用）、不许超限、不许拿 API 训练模型 / 建索引 / 爬；删了的内容尽快删；**不与任何第三方共享 Reddit 数据**；凭据不许共享；静态数据要加密 | [Developer Terms](https://redditinc.com/policies/developer-terms)（2026-03-24 修订） |
| Data API Terms §3.1：商业用途要另签协议；§3.2：没书面批准不许拿它挣钱、不许超出批准用途保留数据；终止时连同衍生物（含模型）一起删 | [Data API Terms](https://redditinc.com/policies/data-api-terms)（2026-07-20 修订） |
| **限流**：必须走 OAuth（不走 OAuth 的流量会被拦）；免费档**每个 OAuth client id 每分钟 100 次，按 10 分钟窗口平均**，看 `X-Ratelimit-Used / Remaining / Reset` 三个头；UA 格式 `<平台>:<应用 id>:<版本> (by /u/<用户名>)`，「永远别谎报 UA」；**Reddit 上删了的内容你也要删（含账号删后的作者信息），强烈建议 48 小时内** | [Data API Wiki](https://support.reddithelp.com/hc/en-us/articles/16160319875092)（2026-05-11） |
| 用户协议：未经 Reddit 事先书面同意的抓取一律禁止；未经书面协议不许商业利用服务或内容；代表企业接受协议 = 你有权约束这家企业 | [User Agreement](https://redditinc.com/policies/user-agreement)（2026-07-01 生效） |
| **RSS 与 `.json` 不是豁免**：找不到任何官方页面允许拿它们做商业监控；上面几条（禁抓取、非 OAuth 流量拦截、「别弄坏网站」把未授权抓取列为违规）都管得着——这是我们的推断，条款原文已核 | 同上三页 |
| 公开内容政策：非商业用随意，商业用途「来找我们谈」；授权方要停用已删内容 | [Public Content Policy](https://support.reddithelp.com/hc/en-us/articles/26410290525844)（2025-05-29） |
| **官方数据合作方**（用 Reddit 企业 API / Firehose，邀请制、面向 B2B 软件公司）：Hootsuite（含 Talkwalker）、ICE、Meltwater、Quid、Sprinklr、Sprout Social；Brandwatch 不在名单 | [Data partners](https://www.business.reddit.com/solutions/data-partners-overview) |
| Reddit for Researchers：只给有伦理审批的学术机构、非商业 | [Reddit for Researchers](https://support.reddithelp.com/hc/en-us/articles/49381918834964)（2026-05-18） |
| 2023-06 宣布超出免费额度按每千次 0.24 美元 | **未直接核实**（新闻与镜像；现行官方页没有价目） |

### 2.5 广告与账号风险

| 事实 | 出处（日期） |
|---|---|
| 广告全部人审；声明要可核实、不许夸大、**不许伪装成非广告**；落地页要与广告一致；医疗器械要 FDA 批准——只在 INMO 讲视力 / 近视矫正这类功效时才相关（推断） | [广告政策总览](https://business.reddithelp.com/s/article/Reddit-Advertising-Policy-Overview)、[欺骗性广告](https://business.reddithelp.com/s/article/deceptive-untrue-or-misleading-advertising-policy)、[医疗](https://business.reddithelp.com/s/article/healthcare-products-and-services-policy) |
| 广告下的评论**默认关**，开了以后广告主能锁、批、删、置顶、标垃圾（要广告账号管理员权限） | [Managing ads with comments on](https://business.reddithelp.com/s/article/Managing-ads-with-comments-on) |
| Ads API 对所有开发者开放、**不用白名单或审批**（scope：`adsread` / `adsedit` / `adsconversions` / `adsdatadeletion`）；2026-12-08 起小时报表只能查 7 天以内 | [Ads API v3](https://ads-api.reddit.com/docs/v3/) |
| 被封（垃圾、不真实、换号）后不能投票发帖评论聊天；版主被永封会失去版主身份；被「标成垃圾」（俗称 shadowban）时内容与主页别人看不见；两种都走 reddit.com/appeals 申诉，含「被误连到别的垃圾号」 | [Banned for spam](https://support.reddithelp.com/hc/en-us/articles/360045734911)（2026-10-02）、[Flagged for spam](https://support.reddithelp.com/hc/en-us/articles/360045309012)（2025-08-14） |
| 新号或低 karma 号、对垃圾敏感的版会限频（「You're doing that too much」）；各版可设最低号龄、karma、验证邮箱，**门槛故意不公开** | [Rate limit](https://support.reddithelp.com/hc/en-us/articles/204579879)（2024-11-06）、[Poster Eligibility](https://support.reddithelp.com/hc/en-us/articles/35317229808660)（2026-03-28） |
| **Contributor Quality Score**：官方五档分，看处罚历史、网络与地点信号、验证情况；版主可在 AutoMod 里按它过滤 | [CQS](https://support.reddithelp.com/hc/en-us/articles/19023371170196)（2026-06-23） |
| **自动化账号必须挂「App」标签**（在 developers.reddit.com 注册）；Reddit 测到自动化行为会要求 7 天内用通行密钥证明是真人，否则被标成 App、可能限制发帖；「别弄坏网站」禁止装成人的应用、自动发不请自来的私信、**用自动化或 Agent 方式注册账号** | [Apps and the App label](https://support.reddithelp.com/hc/en-us/articles/45376380316052)（2026-03-25）、[Verify you're human](https://support.reddithelp.com/hc/en-us/articles/50051922501268)（2026-06-29）、[Don't break the site](https://support.reddithelp.com/hc/en-us/articles/360043512931)（2026-05-28） |
| 账号不许未经书面同意出售、转让；**没找到明文禁止多名员工共用一个品牌号**；API 凭据不许共享 | User Agreement、Developer Terms |

## 3. 对照我们现有四条 Reddit 相关职责

TODO

## 4. 建议引进的开源技能

TODO

## 5. 自写一份「Reddit 运营」技能的大纲

TODO

## 6. 要 Luoye 定的事（少而准）

TODO

## 7. 署名与声明

TODO
