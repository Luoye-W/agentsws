/**
 * `@agentsws/cloud` —— agentsws 云（49 M1 账号与令牌 / M3 服务入口的装配点）。
 *
 * `createCloudServer()` 装配账号层与工作区关联并返回一个可 listen 的句柄；
 * 直接 `node dist/index.js` 时启动并监听 `AGENTSWS_CLOUD_PORT`（默认 4400），
 * SIGTERM / SIGINT 优雅关闭。
 */
// WP115（65）：云端运营后台

export {
  cookieHeader,
  parseCookies,
  requireAdmin,
  requireCsrf,
  requireStaff,
  type StaffPrincipal,
  sameOrigin,
} from './admin/guard.js'
export {
  anchorFor,
  type GrantRunResult,
  nextCycleStart,
  planOrThrow,
  runDueGrants,
} from './admin/membership.js'
export {
  ADMIN_DIST_ENV,
  ADMIN_TITLE_ZH,
  adminCallbackPage,
  adminLoginPage,
  createAdminStore,
  type MountAdminPagesOptions,
  type MountedAdminPages,
  mountAdminPages,
} from './admin/mount.js'
export {
  ACCOUNT_SORTS,
  type AccountFilter,
  type AccountSort,
  accountCount,
  linksOfOrg,
  listAccounts,
  listOrgs,
  membersOfOrg,
  ORG_SORTS,
  type OrgFilter,
  type OrgSort,
  orgNames,
  resolveOrgByEmail,
} from './admin/queries.js'
export {
  ADMIN_BASE_PATH,
  ADMIN_BOOTSTRAP_TOKEN_ENV,
  ADMIN_CALLBACK_PATH,
  ADMIN_COOKIE_MAX_AGE_SECONDS,
  type AdminConsoleDeps,
  type AdminConsoleWallet,
  adminConsoleRoutes,
  tombstoneEmail,
  tombstoneOrg,
} from './admin/routes.js'
export { ADMIN_MIGRATION_V2 } from './admin/schema.js'
export {
  AdminStore,
  type AdminStoreOptions,
  type IssuedAdminSession,
  roleOf,
} from './admin/store.js'
export { BRAND_DISC, BRAND_GREEN, brandDisc, brandMark } from './brand.js'
export { type CallbackCheck, callbackWithToken, checkCallbackUrl } from './callback.js'
export {
  DEFAULT_NEWAPI_BASE_URL,
  ENTRY_ENV,
  type MountEntryOptions,
  type MountedEntry,
  mountEntry,
  walletDbPath,
} from './entry.js'
export {
  clientIpOf,
  cloudIdempotency,
  createMagicLinkLimiter,
  idempotencyScopeOf,
  MAGIC_LINK_KINDS,
  MAGIC_LINK_PER_EMAIL_HOUR,
  MAGIC_LINK_PER_IP_HOUR,
  type MagicLinkLimiter,
  type RateVerdict,
  rateLimited,
} from './guards.js'
export {
  KOL_DB_FILE,
  kolDbPath,
  type MountedKolPublic,
  type MountKolPublicOptions,
  mountKolPublic,
  sourcesFromEnv,
} from './kol-public.js'
export {
  type CloudMail,
  consoleMailSender,
  loginMail,
  MailDeliveryError,
  type MailSender,
  mailSenderFromEnv,
  NODE_ENV,
  SMTP_ENV,
  type SmtpMailSenderOptions,
  type SmtpTransport,
  smtpMailSender,
} from './mail.js'
export {
  BENCHMARK_MAX_AGE_MS,
  type Maintenance,
  type MaintenanceOptions,
  RESERVATION_MAX_AGE_MS,
  SWEEP_INTERVAL_MS,
  type SweepReport,
  startMaintenance,
} from './maintenance.js'
export { type IndexPageInfo, indexPage, type LoginOutcome, loginPage } from './pages.js'
export {
  ADMIN_TOKEN_ENV,
  ADMIN_TOKEN_MIN_BYTES,
  ADMIN_TOPUP_CAPABILITY,
  type AdminRouteDeps,
  type AdminWalletHandles,
  adminRoutes,
  adminRoutesFromEnv,
  DEFAULT_GRANT_DAYS,
} from './routes/admin.js'
export { type AuthRouteDeps, authRoutes, DEFAULT_CALLBACK_PATH } from './routes/auth.js'
export { type CloudHealthState, cloudHealthRoutes, type UpstreamHealth } from './routes/health.js'
export { type LinkRouteDeps, linkRoutes, ScopeSchema } from './routes/links.js'
export {
  buildCloudOpenApi,
  CLOUD_BASE_URL_ENV,
  CLOUD_DATA_DIR_ENV,
  CLOUD_PORT_ENV,
  type CloudServer,
  type CloudServerOptions,
  collectCloudRoutes,
  createCloudServer,
  DEFAULT_CLOUD_BASE_URL,
  DEFAULT_CLOUD_PORT,
  HOST,
  IDEMPOTENCY_DB_FILE,
  LEGACY_LOGIN_PATH,
  LOGIN_PATH,
} from './server.js'
export {
  chainVerifiers,
  type MountedStandby,
  type MountStandbyOptions,
  mountStandby,
  nodePackager,
  resolveServerEntry,
  STANDBY_CHILD_ENV,
  STANDBY_SUBDIR,
  STANDBY_TICK_MS,
  standbyRootOf,
} from './standby.js'
export {
  CLOUD_LOGIN_TTL_MS,
  CLOUD_SESSION_TTL_MS,
  type CloudSessionRow,
  CloudStore,
  type CloudStoreOptions,
  type CreateLinkInput,
  cloudDbPath,
  createCloudStore,
  hashToken,
  rowToLink,
  type VerifiedLogin,
} from './store.js'
export { sqliteTokenVerifier } from './verifier.js'
export { linkView, type WorkspaceLinkView } from './views.js'

import { pathToFileURL } from 'node:url'
import { type CloudTokenVerifier, cloudBaseUrl } from '@agentsws/contracts'
import type { WalletStore } from '@agentsws/metering'
import { runDueGrants } from './admin/membership.js'
import { createAdminStore, mountAdminPages } from './admin/mount.js'
import { adminConsoleRoutes } from './admin/routes.js'
import type { AdminStore } from './admin/store.js'
import { DEFAULT_NEWAPI_BASE_URL, ENTRY_ENV, mountEntry } from './entry.js'
import { mountKolPublic } from './kol-public.js'
import { mailSenderFromEnv, SMTP_ENV } from './mail.js'
import { startMaintenance } from './maintenance.js'
import { ADMIN_TOKEN_ENV, type AdminWalletHandles, adminRoutesFromEnv } from './routes/admin.js'
import { CLOUD_DATA_DIR_ENV, createCloudServer } from './server.js'
import { mountStandby } from './standby.js'

/** New API 探活的结果缓存多久。够短能看出刚修好，够长不至于把 health 变成压测。 */
const UPSTREAM_PROBE_TTL_MS = 30_000
/** 探活超时。上游卡住不该把诊断口也拖住。 */
const UPSTREAM_PROBE_TIMEOUT_MS = 2_000

/**
 * New API 通不通。
 *
 * 打的是它的 `/models`——**不带我们那把内部令牌**：这一问只想知道"那一头有没有
 * 人应答"，带上密钥就等于每 30 秒把它往外递一次。401 / 403 一样算通
 * （有人应答就是通了），连不上、超时、DNS 不认才算不通。
 */
function upstreamProbe(
  env: Record<string, string | undefined>,
  clock: { now: () => string },
): () => Promise<{ reachable: boolean | 'unknown'; checked_at?: string }> {
  const base = (env[ENTRY_ENV.newapiBaseUrl] ?? DEFAULT_NEWAPI_BASE_URL).replace(/\/+$/, '')
  let cached: { reachable: boolean; checked_at: string } | undefined
  return async () => {
    const nowMs = Date.parse(clock.now())
    if (cached !== undefined && nowMs - Date.parse(cached.checked_at) < UPSTREAM_PROBE_TTL_MS)
      return cached
    let reachable = false
    try {
      const res = await fetch(`${base}/models`, {
        signal: AbortSignal.timeout(UPSTREAM_PROBE_TIMEOUT_MS),
      })
      reachable = res.status < 500
    } catch {
      reachable = false
    }
    cached = { reachable, checked_at: clock.now() }
    return cached
  }
}

export async function main(): Promise<void> {
  const env = process.env
  const clock = { now: () => new Date().toISOString() }
  /*
   * 管理员充值那条路由要钱包，而钱包要等 `mountEntry` 装完——与 verifier 同一个
   * 局面，解法也同一个：**晚绑那一跳**。路由声明在建服务器时就得有（OpenAPI 与
   * 中间件读的是同一份），它闭包进去的是一个取值函数，不是值。
   */
  let walletHandles: AdminWalletHandles | undefined
  const admin = adminRoutesFromEnv({
    env,
    clock,
    accounts: () => server.store,
    wallet: () => walletHandles,
  })
  /*
   * WP115 的后台也是一个路由包，也要晚绑：它要账号库（还没建）、后台库（要账号库
   * 的连接）与钱包（要 `mountEntry`）。三样都用取值函数闭包进去。
   */
  let adminStore: AdminStore | undefined
  let meterDb: { prepare(sql: string): never } | undefined
  const console_ = adminConsoleRoutes({
    clock,
    accounts: () => server.store,
    admin: () => {
      if (adminStore === undefined) throw new Error('后台库还没建起来')
      return adminStore
    },
    wallet: () => walletHandles,
    meter: () => meterDb as never,
    baseUrl: cloudBaseUrl(env),
    mail: mailSenderFromEnv(env),
    ...(env[ADMIN_TOKEN_ENV] === undefined ? {} : { bootstrapToken: env[ADMIN_TOKEN_ENV] }),
    health: () => server.health,
  })
  const server = createCloudServer({
    modules: admin === undefined ? [console_] : [admin, console_],
  })
  adminStore = createAdminStore(server, clock)
  const dataDir = env[CLOUD_DATA_DIR_ENV]
  /*
   * 两个模块互相要对方的一样东西：入口要值守的子进程令牌验证器（子进程也用
   * `/v1/ai/*`），值守要入口的钱包与价目。解法不是把它们合成一个模块，而是
   * **晚绑定那一跳**：入口拿到的 verifier 是一个闭包，第一跳永远是账号库，
   * 第二跳等值守装好了再有。装配期的先后不该逼着两个模块合并。
   */
  let childVerifier: CloudTokenVerifier | undefined
  const entry = mountEntry(server, {
    ...(dataDir === undefined ? {} : { dataDir }),
    verifier: async (token) =>
      (await server.verifyToken(token)) ?? (await childVerifier?.(token)) ?? undefined,
  })
  // 49 §6 WP60：值守（子进程编排 + 订阅 + 公网反向代理）
  const standby = mountStandby(server, {
    wallet: entry.wallet,
    pricing: entry.pricing,
    ...(dataDir === undefined ? {} : { dataDir }),
  })
  childVerifier = standby.childTokens.verifier()
  // 48 §5.3 / WP61：公共红人库（`/v1/data/kol/*`，鉴权要 `data` 动作集）
  const kol = mountKolPublic(server, {
    wallet: entry.wallet,
    pricing: entry.pricing,
    ...(dataDir === undefined ? {} : { dataDir }),
  })
  walletHandles = { wallet: entry.wallet, store: entry.store }
  /*
   * 后台的聚合直接打钱包那张 sqlite。内存档没有 `db`，那时后台的看板页回 503
   * ——比画一堆 0 诚实（那几个 0 看起来像"没人用"，而不是"这里看不到"）。
   */
  meterDb = (entry.store as { db?: unknown }).db as typeof meterDb
  mountAdminPages(server, {
    admin: () => adminStore as AdminStore,
    clock,
    baseUrl: server.baseUrl,
    env,
  })

  /*
   * 挂完了才有资格说"挂上了"。首页与 `/v1/cloud/health` 读的是同一个对象
   * （`server.health`），所以这几行一写，两处当场都对。
   */
  server.health.modules = {
    entry: true,
    standby: true,
    kol_public: true,
    mail: (env[SMTP_ENV.url] ?? '').trim() !== '',
    admin_topup: admin !== undefined,
    admin_console: true,
  }
  server.health.probeUpstream = upstreamProbe(env, clock)

  /*
   * WP110：进程内定时清理（孤儿预扣 / 过期幂等键 / 陈旧基准缓存）。
   * 起来先扫一遍——上一次崩溃留下的孤儿预扣正占着用户的积分。
   */
  const maintenance = startMaintenance({
    clock,
    wallet: entry.store as WalletStore & { sweepReservations?(olderThan: string): number },
    idempotency: server.idempotency,
    kol: kol.store,
    // WP115：会员 cycle 的续发搭在这一拍上（幂等，重跑安全）
    also: () => {
      runDueGrants(adminStore as AdminStore, entry.wallet, clock)
    },
  })
  maintenance.runOnce()

  await server.listen()
  let closing = false
  const shutdown = (signal: string): void => {
    if (closing) return
    closing = true
    process.stdout.write(`\n${signal} received, closing…\n`)
    maintenance.close()
    void standby.close()
    kol.close()
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

const entry = process.argv[1]
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  await main()
}
