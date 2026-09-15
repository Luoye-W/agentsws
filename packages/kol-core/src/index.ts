/**
 * `@agentsws/kol-core`（48 §5.2）：跨渠道共用的**能力**，不是职责。
 *
 * 同 `support-core` 的纪律：纯逻辑 + 注入 IO。这个包里没有 `Date.now()`、
 * 没有 `fetch`、没有模型调用、碰不到一个凭据。五条渠道职责（`packages/roles`
 * 的 `roles/kol/*.yml`）与服务进程那一侧调它。
 *
 * 十个模块按"能力"归类而不是按职责（48 §5.2 那句话的落点）：
 *
 * | 模块 | 干什么 |
 * |---|---|
 * | `stages` | 合作与交付物的阶段机（**全仓唯一**一份合法迁移表） |
 * | `scoring` | 打分：五项，每一项可解释 |
 * | `outreach` | 开发信起草、禁承诺自查、序列与日配额 |
 * | `replies` | 回复分类（封闭六类）与陌生来信 |
 * | `merge` | 同一人合并：**只出建议卡，不自动合** |
 * | `campaign` | campaign 向导：只出挑人清单，不出动作 |
 * | `attribution` | UTM 生成 / 解析、联盟码、订单归因 |
 * | `import` | Excel / CSV 导入：列映射 + 去重 + 渠道识别 |
 * | `urls` | 五个渠道的链接解析 |
 * | `channels` | 渠道适配器接口（YouTube / Instagram 有实现，其余三条待 WP68） |
 * | `public-library` | 云端公共红人库客户端接口（真接线等 WP61） |
 */
export * from './attribution.js'
export * from './campaign.js'
export * from './channels/index.js'
export * from './import.js'
export * from './merge.js'
export * from './outreach.js'
export * from './public-library.js'
export * from './replies.js'
export * from './scoring.js'
export * from './stages.js'
export * from './urls.js'
