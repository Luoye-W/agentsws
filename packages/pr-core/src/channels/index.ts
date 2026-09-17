/**
 * 公共关系的三条渠道口（60 §2 末段）。
 *
 * 三条形状各不相同，因为三条渠道的**现实**不一样：
 *
 * - `reddit`：有官方接口，而且社媒那边已经把适配器写好了——这里只加三口
 *   （搜版 / 读版规 / 在别人的版里发），**不重写**；
 * - `forums-browser`：Quora / 知乎没有公开写接口，走第三栏受控浏览器，
 *   读走白名单、写先出卡、失效人接管（照 56 的 Facebook 群组）；
 * - `alerts`：Google Alerts 的 RSS + Reddit 全站搜，`fetch` 注入。
 *
 * 新闻稿**分发**没有第四条：那一侧的服务（美通社 / 商业资讯这一类）要合同、
 * 要账号、要钱，连接目录里登记为"待增加"（`apps/server/src/catalog.ts` 的
 * `PLANNED_CONNECTORS`）。在它接上之前，分发那一跳出的是一张卡 + 一份
 * 可复制的稿件正文（`renderRelease`），**不假装发出去了**。
 */
export * from './alerts.js'
export * from './forums-browser.js'
export * from './reddit.js'
