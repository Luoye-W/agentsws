/**
 * `@agentsws/server` —— 协同服务进程。
 *
 * `createServer()` 装配内核与全部已合并模块并返回一个可 listen 的句柄；
 * 直接 `node dist/index.js` 时启动并监听，SIGTERM / SIGINT 优雅关闭。
 */
export { type AskOptions, createAskPort } from './ask.js'
export { type BackendCall, MemoryBackend } from './backend.js'
export {
  authOptionOf,
  CATALOG,
  type CatalogAuth,
  type CatalogAuthOption,
  type CatalogEntry,
  catalogEntry,
  serviceOfUpstream,
  UPSTREAM_TO_SERVICE,
} from './catalog.js'
export {
  CONNECT_URL_ENV,
  connectBaseUrl,
  DEFAULT_CONNECT_URL,
} from './connect-url.js'
export {
  type ConnectionsAssembly,
  type ConnectionsOptions,
  type ConnectLike,
  createConnections,
  createMailProbe,
  type MailAccount,
  type MailProbe,
  smokeDetail,
} from './connections.js'
export {
  type ApprovalDirectoryOptions,
  createApprovalDirectory,
  type HousekeepingDeps,
  type HousekeepingOutcome,
  runApprovalHousekeeping,
} from './housekeeping.js'
export {
  createModels,
  DEEPSEEK_KEY_ENV,
  ENV_PROVIDER_ID,
  humanizeModelError,
  MODEL_KEY_PREFIX,
  MODEL_TEMPLATES,
  type ModelProviderConfig,
  type ModelsAssembly,
  type ModelsOptions,
  modelIdOf,
  STUB_REF,
} from './models.js'
export { createOrg, type OrgAssembly, type OrgOptions } from './org.js'
export {
  createRuntime,
  hasModelProvider,
  type MatterRecordSource,
  type RuntimeAssembly,
  type RuntimeOptions,
} from './runtime.js'
export {
  buildReviewsFor,
  createScheduleAssembly,
  createSchedulePort,
  DEFAULT_RAW_RETENTION_DAYS,
  draftPlansFor,
  ensureSystemTasks,
  ensureTask,
  HANDLERS,
  HOUSEKEEPING_INTERVAL_MS,
  isMonthEnd,
  MAIL_POLL_INTERVAL_MS,
  type MailPollDeps,
  type MeetingPollDeps,
  nextMorningAt,
  nextTokenCheck,
  offsetToTz,
  type PlanDeps,
  pollMeetingSources,
  pruneRawStores,
  type RawPruneDeps,
  type RelayDeps,
  type ReviewDeps,
  registerApprovalHousekeeping,
  registerDailyPlan,
  registerIdempotencySweep,
  registerMailPoll,
  registerMeetingPoll,
  registerPlanRelay,
  registerRawPrune,
  registerReview,
  registerSkillsWeekly,
  registerTokenRefresh,
  type ScheduleAssembly,
  type ScheduleAssemblyOptions,
  type SchedulePlanOptions,
  type SchedulePortOptions,
  type SchedulePosition,
  ServerScheduleError,
  type SkillsWeeklyDeps,
  TOKEN_IDLE_INTERVAL_MS,
  TOKEN_REFRESH_LEAD_MS,
  type TokenRefreshDeps,
} from './schedule.js'
export {
  createSecretStore,
  parseSecretsKey,
  SECRETS_KEY_ENV,
  type SecretFields,
  type SecretRecord,
  type SecretStore,
  SecretStoreError,
  type SecretStoreOptions,
  sameKey,
} from './secret-store.js'
export {
  type Bootstrap,
  BUNDLED_ROLES,
  createServer,
  DEFAULT_PORT,
  HOST,
  type MountedWorld,
  type Server,
  type ServerOptions,
} from './server.js'
export {
  createShopifyBroker,
  exchangeClientCredentials,
  mapExchangeError,
  normalizeShopDomain,
  REFRESH_LEAD_MS,
  SHOPIFY_APP_PREFIX,
  type ShopifyBroker,
  ShopifyBrokerError,
  type ShopifyBrokerErrorCode,
  type ShopifyBrokerRecord,
  scrub,
} from './shopify-broker.js'
export { mountStatic, resolveAsset, type StaticOptions } from './static.js'
export {
  createWorkModel,
  createWorkPort,
  periodQueryRunner,
  type WorkPortOptions,
} from './work.js'
export {
  createWorkstationPort,
  emptyDataSource,
  type WorkstationDataSource,
  type WorkstationPortOptions,
} from './workstation.js'

import { pathToFileURL } from 'node:url'
import { createServer } from './server.js'

/** 进程入口：启动、打印 /v1/health、挂优雅关闭。 */
export async function main(): Promise<void> {
  // WP18：AGENTSWS_DATA_DIR 存在就整套走 SQLite；不给则全部内存档。
  // 旧名 AGENTSWS_DB_DIR 仍然认，避免已有脚本断掉。
  const dbDir = process.env.AGENTSWS_DATA_DIR ?? process.env.AGENTSWS_DB_DIR
  // 单机真账号档：给了工作台构建目录就一并托管（demo 之外也能开工作台）
  const staticDir = process.env.AGENTSWS_STATIC_DIR
  const server = await createServer({
    ...(dbDir === undefined ? {} : { dbDir }),
    ...(staticDir === undefined ? {} : { staticDir }),
  })
  await server.listen()
  let closing = false
  const shutdown = (signal: string): void => {
    if (closing) return
    closing = true
    process.stdout.write(`\n${signal} received, closing…\n`)
    server
      .close()
      .then(() => process.exit(0))
      .catch((err: unknown) => {
        process.stderr.write(`shutdown failed: ${String(err)}\n`)
        process.exit(1)
      })
  }
  process.on('SIGTERM', () => {
    shutdown('SIGTERM')
  })
  process.on('SIGINT', () => {
    shutdown('SIGINT')
  })
}

// 只有被当作进程入口执行时才监听；被 import（测试、CLI 内嵌）时什么都不做。
const entry = process.argv[1]
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  await main()
}
