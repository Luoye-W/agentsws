/**
 * `@agentsws/kol-cloud` —— **红人营销增值服务**（67 §3，WP118）。
 *
 * Luoye 09-19 定的话：这一块买的**不是云端备份**。它是为「红人营销以后不依赖
 * 本地 Agents 工坊也能跑起来」做的地基——像 KOLAgents 那样数据在云端，区别只是
 * 本地有一份、云端也有一份。30 积分 / 月。
 *
 * **一个库 + 一个路由包，不起服务**：由云侧挂上去（Compose 形态
 * `apps/cloud/src/kol-cloud.ts`，Workers 形态 `apps/cloud-worker` 的 `KolTenantDO`）。
 *
 * 与 `@agentsws/kol-public`（公共红人库）**零 import**：那边是跨租户的共享事实层，
 * 这边是一个组织自己的私有数据。两层之间没有任何一行共用的代码。
 *
 * 订阅机制不在这里：它在 `@agentsws/metering` 的通用订阅引擎里（一份引擎多个
 * 服务，客服增值服务 WP124 是第二个实例）。
 */
export type { KolCloudAdminPort, KolCloudSummary } from './admin-port.js'
export {
  authenticate,
  bearerToken,
  errorResponse,
  isKolCloudPath,
  KOL_CLOUD_PREFIX,
  KOL_CLOUD_SCOPE,
  type KolCloudRouteDeps,
  mountKolCloudRoutes,
} from './routes.js'
export { KolCloudService, type KolCloudServiceOptions } from './service.js'
export { KolCloudStore } from './store.js'
export {
  type KolCloudAuditRow,
  type KolCloudEnv,
  KolCloudError,
  type KolCloudErrorCode,
  type KolCloudPrincipal,
  type SqliteLike,
  type SubscriptionChargeOutcome,
  type SubscriptionWallet,
} from './types.js'
export { localSubscriptionWallet } from './wallet-port.js'
