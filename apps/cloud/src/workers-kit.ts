/**
 * `@agentsws/cloud/workers-kit` —— 云侧那些**没有一行 Node 专有代码**的零件。
 *
 * 为什么要这个桶（WP114）：包的主入口 `index.ts` 里有值守（`node:child_process`）、
 * SMTP（`node:net`）、better-sqlite3（原生模块）这些在 Cloudflare Workers 上
 * 根本不存在的东西。Workers 那一头 import 主入口就会把它们全拖进打包产物。
 *
 * 所以这里显式列出 Workers 形态用得上的那一份清单——**列表本身就是边界**：
 * 有人往云侧加了一样 Node 专有的东西又想给 Workers 用，会在这个文件上撞一下，
 * 而不是在部署之后撞。
 *
 * 这个文件只转出，不定义任何新东西。
 */

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
  ADMIN_TITLE_ZH,
  type AdminWebDeps,
  adminCallbackPage,
  adminLoginPage,
  mountAdminWebRoutes,
} from './admin/pages.js'
/*
 * WP115 的后台（65）。**只列没有 Node 专有代码的那几个**：
 * `admin/mount.ts` 读磁盘上的 `dist`，Workers 形态用不上（那边是 wrangler 的
 * `[assets]`），所以它不在这张清单里——这张清单本身就是边界。
 */
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
export { ADMIN_MIGRATION_V2, ADMIN_MIGRATION_V3 } from './admin/schema.js'
export {
  AdminStore,
  type AdminStoreOptions,
  type IssuedAdminSession,
  roleOf,
} from './admin/store.js'
export {
  buildCloudApp,
  buildCloudOpenApi,
  type CloudApp,
  type CloudAppDeps,
  collectCloudRoutes,
  createCloudHono,
  LEGACY_LOGIN_PATH,
  LOGIN_PATH,
} from './app.js'
export { BRAND_DISC, BRAND_GREEN, brandDisc, brandMark } from './brand.js'
export { type CallbackCheck, callbackWithToken, checkCallbackUrl } from './callback.js'
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
  type CloudMail,
  consoleMailSender,
  loginMail,
  MailDeliveryError,
  type MailSender,
} from './mail.js'
export {
  CLOUDFLARE_MAIL_FROM_ENV,
  type CloudflareEmailBinding,
  type CloudflareEmailSenderOptions,
  cloudflareEmailSender,
  cloudflareMailReady,
  cloudflareMailSenderFromEnv,
  type MailFrom,
  parseMailFrom,
} from './mail-cloudflare.js'
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
  DEFAULT_GRANT_DAYS,
} from './routes/admin.js'
export { type AuthRouteDeps, authRoutes, DEFAULT_CALLBACK_PATH } from './routes/auth.js'
export { type CloudHealthState, cloudHealthRoutes, type UpstreamHealth } from './routes/health.js'
export { type LinkRouteDeps, linkRoutes, ScopeSchema } from './routes/links.js'
export {
  grantSignupBonus,
  type SignupBonusHooks,
  type SignupBonusLedger,
  type SignupBonusOutcome,
  type SignupBonusPort,
  type SignupBonusSkip,
} from './signup-bonus.js'
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
export { sqliteTokenVerifier } from './verifier.js'
export { linkView, type WorkspaceLinkView } from './views.js'
