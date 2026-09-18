// 57 §1 投放岗位的四个平台、五个对象与额度（WP75）。与 social.ts / kol.ts 一条都不共用：
// 那两边的主语是"号"（我们自己的 / 别人的），这边的主语是**广告账户**——一个独立的计费主体。
export * from './ads.js'
export * from './approval.js'
export * from './blocks.js'
export * from './changes.js'
export * from './channels.js'
export * from './cloud.js'
// 65 云端运营后台（WP115）：角色、后台会话、封禁与黑名单、审计、会员 term / cycle、看板形状
export * from './cloud-admin.js'
// 49 服务入口与积分（WP59）。令牌验证那份契约在 WP58 的 cloud.ts 里，不在这里。
export * from './cloud-entry.js'
export * from './common.js'
export * from './connect.js'
// 54（将改号 55）§4 第一层：连接目录（按职责模板的 `kind` 登记的总表，WP83）
export * from './connection-directory.js'
export * from './data.js'
// 58 §1 / §2 设计岗位的五条职责、三个对象与规格表（WP76）
export * from './design.js'
export * from './events.js'
export * from './identity.js'
export * from './join.js'
export * from './kernel.js'
export * from './knowledge.js'
// 48 §5.2 红人营销的六个对象与五条渠道（WP67）
export * from './kol.js'
// 48 §5.3 / 49 §6 WP61：云上的公共红人库服务（本地那六个红人对象在 kol.ts，WP67）
export * from './kol-public.js'
export * from './meetings.js'
export * from './model.js'
export * from './packages.js'
// 60 §1 / §2 公共关系的四条职责与四个对象（WP78）。与 social.ts 一条都不共用：
// `social.reddit` 是**我们自己的** subreddit，`pr.reddit` 是**别人的**。
export * from './pr.js'
export * from './roles.js'
export * from './run.js'
export * from './schedule.js'
// 59 §1 / §2 建站那一侧的三类对象（WP77）。与 social.ts 同一条理由：
// 面板、`/v1/site/*`、模拟世界与记录源四处要认同一个形状。
export * from './site.js'
export * from './skills.js'
// 56 §1 / §2 社媒运营的九条渠道与四个对象（WP72）。与 kol.ts 一条都不共用：
// 那边的主语是别人的账号（`Creator`），这边是我们自己的号（`SocialAccount`）。
export * from './social.js'
// 49 §6 WP60 / 48 L6：在线值守与聊天窗托管
export * from './standby.js'
export * from './work.js'
