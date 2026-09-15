/**
 * `@agentsws/cloud` —— agentsws 云（49 M1 账号与令牌 / M3 服务入口的装配点）。
 *
 * `createCloudServer()` 装配账号层与工作区关联并返回一个可 listen 的句柄；
 * 直接 `node dist/index.js` 时启动并监听 `AGENTSWS_CLOUD_PORT`（默认 4400），
 * SIGTERM / SIGINT 优雅关闭。
 */
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
  type MailSender,
  mailSenderFromEnv,
  SMTP_ENV,
} from './mail.js'
export { type AuthRouteDeps, authRoutes } from './routes/auth.js'
export { cloudHealthRoutes } from './routes/health.js'
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
import type { CloudTokenVerifier } from '@agentsws/contracts'
import { mountEntry } from './entry.js'
import { mountKolPublic } from './kol-public.js'
import { CLOUD_DATA_DIR_ENV, createCloudServer } from './server.js'
import { mountStandby } from './standby.js'

export async function main(): Promise<void> {
  const server = createCloudServer()
  const dataDir = process.env[CLOUD_DATA_DIR_ENV]
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
  await server.listen()
  let closing = false
  const shutdown = (signal: string): void => {
    if (closing) return
    closing = true
    process.stdout.write(`\n${signal} received, closing…\n`)
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
