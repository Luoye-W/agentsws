// WP317（docs/101 §5.1④）：广告素材流水线
export * from './ad-creative.js'
// 57 §1 投放岗位的四个平台、五个对象与额度（WP75）。与 social.ts / kol.ts 一条都不共用：
// 那两边的主语是"号"（我们自己的 / 别人的），这边的主语是**广告账户**——一个独立的计费主体。
export * from './ads.js'
export * from './ads-wiring.js'
// WP394（docs/104 一期 B）：Amazon 竞品对标款（Agent 标识、配送邮编、方案卡「什么算重要」）
export * from './amazon-competitor.js'
// WP397（docs/106 §13）：Amazon 库存补货公式与 FBA 赔偿复核算式（数由公式算，不让模型估）
export * from './amazon-inventory.js'
// WP398（docs/106 §13 A8）：Amazon 词库（联想词 + 竞品 / 自家 Listing 拆词、竞品有你没有的差距）
export * from './amazon-keywords.js'
// WP396（docs/106 §13）：自家 Amazon Listing 体检（读前台、按规则表判、只出建议）
export * from './amazon-listing.js'
export * from './amazon-reimbursement.js'
export * from './answer.js'
export * from './approval.js'
// docs/84 B2B 岗位的五条职责、九类对象与报价授权（WP171）
export * from './b2b.js'
export * from './blocks.js'
// 71 每个品牌一份 DESIGN.md（WP122）。格式逐字对齐 google-labs-code/design.md
// （Apache-2.0，alpha）；我们在规范的裸值外面多一层出处 / 把握度 / 冲突。
export * from './brand-design.js'
// 70 §3 贴一个网址自动分析（WP121）。中心是 `BrandIntakeField`：自动填出来的格子
// 拖着出处、把握度与"用户改过没有"走——与用户自己填的格子不是一回事。
export * from './brand-insights.js'
export * from './brand-intake.js'
export * from './byo-data-source.js'
export * from './changes.js'
export * from './channels.js'
// WP164：聊天转发器的协议、owner 面与访客面（开源侧与官方托管转发器之间的约定）
export * from './chat-relay.js'
export * from './cloud.js'
// 65 云端运营后台（WP115）：角色、后台会话、封禁与黑名单、审计、会员 term / cycle、看板形状
export * from './cloud-admin.js'
// WP194：成员 / 岗位额度（公司共用余额上的每月上限）
export * from './cloud-allocation.js'
// WP164（docs/83 §2）：云端对外契约的路由表；`cloud-openapi.json` 由它生成
export * from './cloud-api.js'
// 49 服务入口与积分（WP59）。令牌验证那份契约在 WP58 的 cloud.ts 里，不在这里。
export * from './cloud-entry.js'
export * from './common.js'
// WP393：店铺管理「竞品动向」（探平台 / 方案 / 自家商品）
export * from './competitor-store.js'
// WP392（docs/104）：竞品监控积木（快照、变化、进料口适配器、存储接口；和信息监控共用监控源）
export * from './competitor-watch.js'
// WP144 / docs/80：电脑操控（官方 dsh-computer-use + Cua Driver MCP 提供方）的设置与授权卡
export * from './computer-use.js'
export * from './connect.js'
// 54（将改号 55）§4 第一层：连接目录（按职责模板的 `kind` 登记的总表，WP83）
export * from './connection-directory.js'
// WP405（私有 docs/107）：岗位更新订阅（订阅、按订阅放行的官方内容、更新摘要）
export * from './content-digest.js'
export * from './content-official.js'
// WP219（docs/90）：第三方内容更新（内容包格式、签名常量、卡与设置）
export * from './content-updates.js'
export * from './data.js'
// WP192（docs/83 §4）：官方数据接口的统一能力口（同步调用 + 异步任务）
export * from './data-service.js'
// 58 §1 / §2 设计岗位的五条职责、三个对象与规格表（WP76）
export * from './design.js'
// WP136（docs/79）：dsh 的「场景」（Profile）——Agents 工坊是其中一个，其余由 DeepSeek 官方维护
export * from './dsh-scenes.js'
export * from './economics.js'
export * from './events.js'
export * from './execution.js'
export * from './feedback.js'
// WP336（决策 810–812）：当场回答的 ```dsh-ui 写法（dsh-genui 渲染层）——白名单过滤与给模型的规矩
export * from './genui.js'
// WP341（决策 847）：genui 完全融合——动作写法、口令格、媒体来源、表单交上来的结构化回话
export * from './genui-host.js'
export * from './genui-reply.js'
export * from './geo-quality.js'
// WP164：托管实例对外的状态形状（从 packages/hosted 挪来）
export * from './hosted.js'
// WP165（docs/83 §2）：托管实例的容器环境变量契约（云上写、容器里的 apps/server 读）
export * from './hosted-env.js'
export * from './identity.js'
// WP268（决策 213）：生图 / 改图的工具参数、挑图卡与超额卡、上限
export * from './images.js'
export * from './join.js'
export * from './kernel.js'
export * from './knowledge.js'
// 48 §5.2 红人营销的六个对象与五条渠道（WP67）
export * from './kol.js'
export * from './kol-cloud.js'
// 48 §5.3 / 49 §6 WP61：云上的公共红人库服务（本地那六个红人对象在 kol.ts，WP67）
export * from './kol-public.js'
// WP166：目标市场一处定、处处用（国家码清单、归一化、出处）
export * from './markets.js'
// WP259：「交给它」长文本拆成标题 + 完整原文（工作台与服务端共用一条规矩）
export * from './matter-chat.js'
export * from './meetings.js'
export * from './message-rules.js'
// WP113（63）：消息——统一收件处。v1 只有邮箱一种来源，但数据模型按"来源可扩"建
export * from './messages.js'
export * from './model.js'
// WP429：站内通知（铃铛）——「告诉你一声」的事，不是卡
export * from './notifications.js'
// WP180：官方插件（装 / 升级 / 卸载出卡、只从审过的清单装）与配置写回
export * from './official-plugins.js'
// WP323（docs/102 §5）：发出记录与记录去处（去处的种类是藏在通用机制后面的适配器）
export * from './outbound.js'
// WP249（决策 81 / 89）：自家版待处理（版务队列 + Reddit 官方号浏览器通道的状态）
export * from './own-sub.js'
export * from './packages.js'
// WP216：建站平台 → 官方技能 / 官方工具 / 官方 CLI（平台专属那一套的唯一真源）
export * from './platform-kits.js'
// WP234（docs/54 §6.3）：岗位划分建议——一份算法，工作台第 ③ 步与服务端同用
export * from './position-plan.js'
// WP241（docs/54 §7）：岗位页「工作」——工作项视图的形状与分组规则，前后端同用
export * from './position-work.js'
// 60 §1 / §2 公共关系的四条职责与四个对象（WP78）。与 social.ts 一条都不共用：
// `social.reddit` 是**我们自己的** subreddit，`pr.reddit` 是**别人的**。
export * from './pr.js'
// WP387：你的浏览器替你建 / 导入 Google 提醒
export * from './pr-alerts.js'
export * from './pr-watch.js'
export * from './premium-theme.js'
// WP165（docs/83 §2）：公开价目 `GET /v1/pricing`（价目只放云上，本机缓存一份离线显示）
export * from './pricing-catalog.js'
// WP402（决策 1140 / 1146）：读外部网页取数据的备用路（内置浏览器 → 云端 → 你自己的浏览器 → 照实说）
export * from './read-chain.js'
// WP246（决策 87 / 88）：取数路线「首选 → 备选 + 体检」、Reddit 读号
export * from './read-routes.js'
// WP328：Reddit 每日巡查（收件箱 / 自家版块 / 外部关键词）、待处理、周报汇总
export * from './reddit-watch.js'
// WP329（docs/102 §2.3）：Reddit 写——AI 起草 → 发出去卡 → 插件填草稿、人点发送 → 读回 → 发出记录
export * from './reddit-write.js'
// WP331（决策 691）：报告积木的共用形状（巡查条目、发布出来的报告；不认平台、不认客户）
export * from './report.js'
// WP404（docs/107）：岗位内容的白名单、内容文件与外置规则表的形状
export * from './role-content.js'
export * from './roles.js'
export * from './run.js'
// WP236：运行的空闲超时 / 总时长线、停的原因与看门狗
export * from './run-limits.js'
export * from './schedule.js'
// 59 §1 / §2 建站那一侧的三类对象（WP77）。与 social.ts 同一条理由：
// 面板、`/v1/site/*`、模拟世界与记录源四处要认同一个形状。
// WP155（docs/81）：搜索数据接口——SERP + AI 平台问答探测（SEO / GEO 共用）
export * from './search-data.js'
// WP154「内容与搜索」：六个信号、每日 5 件事、收入归因、GEO、发布前质检的形状
export * from './seo.js'
// WP389（docs/105 §7）：工坊服务——服务目录、订单（托管 / 结算 / 退回）、报价、凭证、消息、验收
export * from './service-order.js'
export * from './setup-card.js'
// WP265：云端 Shopify 一键授权（私有云 WP263）在本机这一侧的约定（不进 CloudApi，决策 191）
export * from './shopify-cloud.js'
export * from './site.js'
// WP381：网站 / 商品体检（AI 爬虫、原始 HTML、商品信息一致性、ChatGPT 购物评估）与 AI 来源流量
export * from './site-health.js'
export * from './skills.js'
// 56 §1 / §2 社媒运营的九条渠道与四个对象（WP72）。与 kol.ts 一条都不共用：
// 那边的主语是别人的账号（`Creator`），这边是我们自己的号（`SocialAccount`）。
export * from './social.js'
// 49 §6 WP60 / 48 L6：在线值守与聊天窗托管
export * from './standby.js'
// 67 §3 WP118：按月订阅的增值服务（一份引擎，红人是第一个实例，客服 WP124 在后）
export * from './subscription.js'
export * from './task-text.js'
// WP427：团队通道（发起人电脑 ↔ 工坊云的长连接、邀请码登记与查找、申请人换登录）
export * from './team-link.js'
export * from './work.js'
