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
import { mountEntry } from './entry.js'
import { CLOUD_DATA_DIR_ENV, createCloudServer } from './server.js'

export async function main(): Promise<void> {
  const server = createCloudServer()
  // 49 M3：服务入口（模型转发 + 钱包）挂在同一个进程、同一份令牌验证上
  const dataDir = process.env[CLOUD_DATA_DIR_ENV]
  mountEntry(server, dataDir === undefined ? {} : { dataDir })
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

const entry = process.argv[1]
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  await main()
}
