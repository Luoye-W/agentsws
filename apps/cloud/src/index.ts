/**
 * `@agentsws/cloud` —— agentsws 云（49 M1 账号与令牌 / M3 服务入口的装配点）。
 *
 * `createCloudServer()` 装配账号层与工作区关联并返回一个可 listen 的句柄；
 * 直接 `node dist/index.js` 时启动并监听 `AGENTSWS_CLOUD_PORT`（默认 4400），
 * SIGTERM / SIGINT 优雅关闭。
 */
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
  NODE_ENV,
  SMTP_ENV,
} from './mail.js'
export {
  CLOUDFLARE_MAIL_FROM_ENV,
  type CloudflareEmailBinding,
  type CloudflareEmailSenderOptions,
  type CloudflareMailFromEnvOptions,
  cloudflareEmailSender,
  cloudflareMailReady,
  cloudflareMailSenderFromEnv,
  type MailFrom,
  parseMailFrom,
} from './mail-cloudflare.js'
export {
  mailSenderFromEnv,
  type SmtpMailSenderOptions,
  type SmtpTransport,
  smtpMailSender,
} from './mail-smtp.js'
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
  type AdminAccountsLookup,
  type AdminExportDeps,
  type AdminRouteDeps,
  type AdminWalletHandles,
  adminExportRoutes,
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
  type CloudSnapshot,
  CloudStore,
  type CloudStoreDeps,
  type CreateLinkInput,
  createCloudStoreOn,
  hashToken,
  rowToLink,
  type VerifiedLogin,
} from './store.js'
export {
  type CloudStoreOptions,
  cloudDbPath,
  createCloudStore,
  openCloudDb,
} from './store-node.js'
export { sqliteTokenVerifier } from './verifier.js'
export { linkView, type WorkspaceLinkView } from './views.js'

import { pathToFileURL } from 'node:url'
import type { CloudRoute } from '@agentsws/api'
import type { CloudTokenVerifier } from '@agentsws/contracts'
import type { Wallet, WalletStore } from '@agentsws/metering'
import { DEFAULT_NEWAPI_BASE_URL, ENTRY_ENV, mountEntry } from './entry.js'
import { mountKolPublic } from './kol-public.js'
import { SMTP_ENV } from './mail.js'
import { startMaintenance } from './maintenance.js'
import {
  ADMIN_TOKEN_ENV,
  type AdminWalletHandles,
  adminExportRoutes,
  adminRoutesFromEnv,
} from './routes/admin.js'
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
   * WP114 的跨平台退路：同一把 admin 钥匙再开一条只读的导出口。
   * 没配钥匙就一条都不挂（`adminRoutesFromEnv` 回 undefined 时这里也不拼）。
   */
  const adminToken = env[ADMIN_TOKEN_ENV]?.trim()
  const adminExport =
    admin === undefined || adminToken === undefined || adminToken === ''
      ? undefined
      : adminExportRoutes({
          clock,
          token: adminToken,
          accounts: () => server.store,
          // Compose 形态下钱包就在手边，同步取一把包成 Promise
          walletLots: async (org_id) => walletHandles?.store.lots(org_id) ?? [],
        })
  const modules = [admin, adminExport].filter((m): m is CloudRoute[] => m !== undefined)
  const server = createCloudServer(modules.length === 0 ? {} : { modules })
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
   * 挂完了才有资格说"挂上了"。首页与 `/v1/cloud/health` 读的是同一个对象
   * （`server.health`），所以这几行一写，两处当场都对。
   */
  server.health.modules = {
    entry: true,
    standby: true,
    kol_public: true,
    mail: (env[SMTP_ENV.url] ?? '').trim() !== '',
    admin_topup: admin !== undefined,
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
