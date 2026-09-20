/**
 * `/v1/admin/*` —— 云端运营后台的接口（65 §4–§7）。
 *
 * 装配上与 WP110 的 `routes/admin.ts` 同一条路：一个工厂函数返回 `CloudRoute[]`，
 * 由 `index.ts` 塞进 `createCloudServer({ modules })`。鉴权档声明成 `admin`——
 * 网关对这一档**不装中间件**（钥匙只有路由包自己知道），守卫全在这个文件里。
 *
 * 读接口 `support` + `admin` 都能调，写接口只有 `admin`。**无权一律 404**。
 *
 * 一条贯穿全篇的纪律：**危险动作先写审计再执行**。执行到一半崩了，至少留着
 * "谁打算做什么"；执行成功再补一条 `done`。审计写失败永不抛（见 `store.ts`）。
 */

import {
  ApiError,
  type CloudEnv,
  type CloudRoute,
  cloudBody,
  cloudOk,
  cloudParam,
  cloudRoute,
  secretEquals,
} from '@agentsws/api'
import {
  ADMIN_CSRF_COOKIE,
  ADMIN_SESSION_ABSOLUTE_TTL_MS,
  ADMIN_SESSION_COOKIE,
  ADMIN_TREND_WINDOWS,
  type AdminHealthItem,
  type AdminKpi,
  type Clock,
  type CloudRole,
  COST_MICRO_UNIT,
  emailDomain,
  MAX_KOL_IMPORT_BATCH,
  type MembershipTerm,
} from '@agentsws/contracts'
import type { KolCloudAdminPort } from '@agentsws/kol-cloud'
import {
  assertChannel,
  KOL_CAPABILITIES,
  type KolAdminPort,
  parseNdjson,
} from '@agentsws/kol-public'
import {
  COST_TABLE,
  costTableNeedsReview,
  type LedgerFilter,
  type LedgerRow,
  planCycles,
  plans,
  signupBonus,
  termEndsAt,
  type UsageLedger,
  type Wallet,
  type WalletAdminPort,
} from '@agentsws/metering'
import type { Context } from 'hono'
import { z } from 'zod'
import { clientIpOf } from '../guards.js'
import { loginMail, type MailSender } from '../mail.js'
import type { CloudStore } from '../store.js'
import {
  cookieHeader,
  notThere,
  requireAdmin,
  requireCsrf,
  requireStaff,
  secureCookiesFor,
} from './guard.js'
import { anchorFor, planOrThrow, runDueGrants } from './membership.js'
import {
  accountCount,
  linksOfOrg,
  listAccounts,
  listOrgs,
  membersOfOrg,
  orgNames,
  resolveOrgByEmail,
} from './queries.js'
import type { AdminStore } from './store.js'

/** magic link 点开之后回到后台的那一页。 */
export const ADMIN_CALLBACK_PATH = '/admin/callback'
/** 后台首页。 */
export const ADMIN_BASE_PATH = '/admin'

/** 引导第一个管理员认的那把钥匙——与 WP110 手动充值**同一个**环境变量。 */
export const ADMIN_BOOTSTRAP_TOKEN_ENV = 'AGENTSWS_CLOUD_ADMIN_TOKEN'

/** 删号之后账号行改成的样子。`@deleted.invalid` 是一个保证不可路由的域。 */
export const tombstoneEmail = (account_id: string): string =>
  `deleted+${account_id}@deleted.invalid`
/** 匿名化之后计量流水挂到哪个 id 上。 */
export const tombstoneOrg = (org_id: string): string => `org_deleted_${org_id.slice(-8)}`

/**
 * 钱那一侧的句柄。
 *
 * `wallet` 是 Compose 形态下那个进程内的钱包（会员续发直接用它）；
 * `port` 是**两个形态共用**的那一层（Workers 形态下它是按组织打 `WalletDO`）。
 * 两个都可能没有：没装钱包的节点，那几条路由回 503，不假装。
 */
export interface AdminConsoleWallet {
  wallet: Wallet
  port: WalletAdminPort
}

export interface AdminConsoleDeps {
  clock: Clock
  /** 账号库（晚绑：建服务器时还没有）。 */
  accounts: () => CloudStore
  /** 后台库（同一个连接的另一层）。 */
  admin: () => AdminStore
  /** 钱那一侧。没装就回 `undefined`——那几条路由回 503，不假装。 */
  wallet: () => AdminConsoleWallet | undefined
  /**
   * 读账那一侧（65 §9）。Compose 形态直接查钱包库，Workers 形态查 `LedgerDO`
   * 那个只读副本——**同一个口，两份实现**，后台这一层不知道自己在哪个形态里。
   */
  ledger: () => UsageLedger | undefined
  /**
   * 公共红人库那一侧（WP116 §4）。Compose 形态直接查库，官方托管形态打那个
   * 单例 `KolPublicDO`——**同一个口，两份实现**。没接就回 `undefined`，
   * 那一页的路由回 503，不假装。
   */
  kol?: () => KolAdminPort | undefined
  /**
   * 红人营销增值服务那一口（WP118 / 67 §3）。没接就那一块显示"这个节点没开通"，
   * 不画一堆 0（与看板页、公共红人库页同一条）。
   */
  kolCloud?: () => KolCloudAdminPort | undefined
  /** 云的对外地址（CSRF 的 Origin 与 magic link 的落点都用它）。 */
  baseUrl: string
  mail: MailSender
  /** 引导第一个管理员那把钥匙；不配就**不挂** bootstrap 那条路由。 */
  bootstrapToken?: string | undefined
  /** 健康页那几项的取值（装配方注入，这里不自己探）。 */
  health?: () => { modules: Record<string, boolean>; probeUpstream?: () => Promise<unknown> }
  warn?: (line: string) => void
}

const DAY_MS = 24 * 60 * 60 * 1000

const windowOf = (clock: Clock, days: number): { from: string; to: string } => {
  const to = clock.now()
  return { from: new Date(Date.parse(to) - days * DAY_MS).toISOString(), to }
}

const intQuery = (c: Context<CloudEnv>, name: string, fallback: number): number => {
  const raw = c.req.query(name)
  if (raw === undefined || raw.trim() === '') return fallback
  const n = Number(raw)
  return Number.isFinite(n) ? Math.trunc(n) : fallback
}

const strQuery = (c: Context<CloudEnv>, name: string): string | undefined => {
  const raw = c.req.query(name)
  return raw === undefined || raw.trim() === '' ? undefined : raw.trim()
}

/** `admin` 档的 cookie 要不要带 Secure（见 `guard.ts` 的 {@link secureCookiesFor}）。 */
const secureCookies = secureCookiesFor

/* ------------------------------------------------------------------ */
/* 请求体                                                               */
/* ------------------------------------------------------------------ */

const BootstrapBody = z.object({ email: z.string().min(3).max(320) })
const LoginBody = z.object({ email: z.string().min(3).max(320) })
const BanBody = z.object({
  /** **必填**：三个月后回头看"为什么这个人被封了"必须有答案。 */
  reason: z.string().min(2).max(500),
  expires_at: z.string().min(4).max(40).optional(),
})
const RoleBody = z.object({ role: z.enum(['user', 'support', 'admin']) })
/** 赠送几个月。上限 24 与会员 term 一致——一个后台按钮不该能送出十年。 */
const KolGrantBody = z.object({ months: z.number().int().min(1).max(24) })
const DeleteBody = z.object({
  /** 手打一遍邮箱才算数（KefuAgent 那条）。粘贴 id 手滑删错人的成本太高。 */
  email_confirm: z.string().min(3).max(320),
  reason: z.string().min(2).max(500),
})
const SuspendBody = z.object({ reason: z.string().min(2).max(500) })
const GrantBody = z.object({
  /** 邮箱列表（粘贴进来的那一坨）或组织 id 列表，二选一，都给就都发。 */
  emails: z.array(z.string().min(3).max(320)).max(500).optional(),
  org_ids: z.array(z.string().min(1).max(200)).max(500).optional(),
  credits: z.number().positive().max(1_000_000),
  kind: z.enum(['granted', 'purchased']).default('granted'),
  expires_in_days: z.number().int().positive().max(3650).optional(),
  reason: z.string().min(2).max(500),
})
const RevokeGrantBody = z.object({
  lot_id: z.string().min(1).max(200),
  /**
   * 这一笔在哪个组织名下。
   *
   * Compose 形态下**可以不给**（一张表，按 lot_id 就找得到）；Workers 形态下
   * 钱按组织分在不同的对象里，不给就不知道该敲哪一扇门。前端从发放流水那一行
   * 里带过来，所以这不是负担。
   */
  org_id: z.string().min(1).max(200).optional(),
  reason: z.string().min(2).max(500),
})
const MembershipBody = z.object({
  org_id: z.string().min(1).max(200).optional(),
  email: z.string().min(3).max(320).optional(),
  plan_id: z.string().min(1).max(100),
  months: z.number().int().positive().max(60).optional(),
  until: z.string().min(4).max(40).optional(),
  /** 立刻发本 cycle 的积分（默认发——手动开通的人通常就是要他现在能用）。 */
  grant_now: z.boolean().default(true),
  note: z.string().max(500).optional(),
})
const CancelBody = z.object({ reason: z.string().min(2).max(500) })
/** 移除一个人要交代的那一句。**必填**——见 `admin-port.ts` 的注释。 */
const KolRemoveBody = z.object({ reason: z.string().min(2).max(500) })

/* ------------------------------------------------------------------ */

export function adminConsoleRoutes(deps: AdminConsoleDeps): CloudRoute[] {
  const warn = deps.warn ?? ((line: string) => process.stderr.write(line))
  const secure = secureCookies(deps.baseUrl)

  /** 读接口的守卫 + 一份上下文。 */
  const staff = (c: Context<CloudEnv>) => requireStaff(c, deps.admin())
  /** 写接口的守卫：admin + CSRF。**一个 handler 都不许自己判**。 */
  const writer = (c: Context<CloudEnv>) => {
    const admin = deps.admin()
    const principal = requireAdmin(c, admin)
    requireCsrf(c, admin, principal, deps.baseUrl)
    return principal
  }

  const walletOr503 = (): AdminConsoleWallet => {
    const handles = deps.wallet()
    if (handles === undefined)
      throw new ApiError('provider_unavailable', '这个节点没装钱包，这件事做不了')
    return handles
  }

  const ledgerOr503 = (): UsageLedger => {
    const found = deps.ledger()
    if (found === undefined)
      throw new ApiError('provider_unavailable', '这个节点没接账本，看不了账')
    return found
  }

  const kolOr503 = (): KolAdminPort => {
    const found = deps.kol?.()
    if (found === undefined)
      throw new ApiError('provider_unavailable', '这个节点没接公共红人库，这一页看不了')
    return found
  }

  const kolCloudOr503 = (): KolCloudAdminPort => {
    const found = deps.kolCloud?.()
    if (found === undefined)
      throw new ApiError('provider_unavailable', '这个节点没开通红人营销增值服务，这一块看不了')
    return found
  }

  /**
   * 搬家那条路由的守卫：**后台会话或运维令牌，认一个就行**（WP116 §3）。
   *
   * 为什么不只认会话：搬家是脚本干的活（`scripts/import-kol-public.mjs` 分块推
   * 几千行），而会话 + CSRF 是给浏览器设计的——让脚本模拟一次登录不但麻烦，
   * 还得把后台的登录邮箱放进脚本里。运维令牌是**带外**的那把钥匙，与
   * `/v1/admin/bootstrap` 认的是同一把（不另开第二把）。
   *
   * 走令牌那条**不查 CSRF**：CSRF 防的是"浏览器带着 cookie 被骗着发请求"，
   * 而这条路上根本没有 cookie。
   */
  const importer = (c: Context<CloudEnv>): { account_id: string; role: CloudRole; ip: string } => {
    const raw = c.req.header('Authorization')
    const given =
      raw === undefined ? '' : raw.startsWith('Bearer ') ? raw.slice('Bearer '.length) : raw
    if (
      deps.bootstrapToken !== undefined &&
      deps.bootstrapToken !== '' &&
      given.trim() !== '' &&
      secretEquals(given.trim(), deps.bootstrapToken)
    )
      return { account_id: 'system', role: 'admin', ip: clientIpOf(c) }
    const principal = writer(c)
    return {
      account_id: principal.session.account_id,
      role: principal.session.role,
      ip: principal.ip,
    }
  }

  const routes: CloudRoute[] = []

  /* ── 登录与会话 ──────────────────────────────────────────────────── */

  if (deps.bootstrapToken !== undefined && deps.bootstrapToken !== '') {
    routes.push(
      cloudRoute(
        {
          method: 'post',
          path: '/v1/admin/bootstrap',
          operationId: 'cloudAdminBootstrap',
          summary: '把一个邮箱提为 admin（第一个管理员；认运维令牌，不认后台会话）',
          tag: 'cloud-admin',
          auth: 'admin',
          body: BootstrapBody,
          returns: '{ account_id, role: "admin" }',
        },
        async (c) => {
          /*
           * 这条路由是"从零开始"的唯一入口：库里一个 admin 都没有的时候，
           * 后台的登录口对谁都回 404，于是必须有一把**带外**的钥匙。
           * 它认的是 WP110 已有的那个环境变量，不另开第二把。
           */
          const raw = c.req.header('Authorization')
          const given =
            raw === undefined ? '' : raw.startsWith('Bearer ') ? raw.slice('Bearer '.length) : raw
          if (!secretEquals(given.trim(), deps.bootstrapToken ?? ''))
            throw new ApiError('unauthenticated', '管理员令牌不对')
          const input = await cloudBody(c, BootstrapBody)
          const accounts = deps.accounts()
          const admin = deps.admin()
          // 没这个邮箱就建一个：引导时通常那个人还没登录过云
          const { account } = accounts.ensureAccount(input.email)
          admin.audit({
            action: 'admin.bootstrap',
            actor_account_id: 'system',
            actor_role: 'system',
            target_kind: 'account',
            target_id: account.id,
            outcome: 'intent',
            details: { email_domain: emailDomain(account.email) },
            ip: clientIpOf(c),
          })
          admin.setRole(account.id, 'admin')
          /*
           * **把他现有的会话全清掉**：提权之前签出去的那些凭据是以 `user` 的身份
           * 签的，留着等于给一张旧票据补了新权限。
           */
          admin.revokeSessionsOf(account.id)
          admin.revokeCloudSessionsOf(account.id)
          admin.audit({
            action: 'admin.bootstrap',
            actor_account_id: 'system',
            actor_role: 'system',
            target_kind: 'account',
            target_id: account.id,
            outcome: 'done',
            details: { email_domain: emailDomain(account.email) },
            ip: clientIpOf(c),
          })
          return cloudOk(c, { account_id: account.id, role: 'admin' as const }, 201)
        },
      ),
    )
  }

  routes.push(
    cloudRoute(
      {
        method: 'post',
        path: '/v1/admin/auth/magic-link',
        operationId: 'cloudAdminMagicLink',
        summary: '给后台账号发一封登录信（不是 staff 的邮箱：响应一模一样，但不发信）',
        tag: 'cloud-admin',
        auth: 'public',
        body: LoginBody,
        returns: '{ sent: true }',
      },
      async (c) => {
        const input = await cloudBody(c, LoginBody)
        const email = input.email.trim().toLowerCase()
        const accounts = deps.accounts()
        const admin = deps.admin()
        const account = accounts.accountByEmail(email)
        const role = account === undefined ? 'user' : admin.role(account.id)
        /*
         * 不是 staff 就**什么都不做**，但回的话与 staff 一模一样。
         * 回"这个邮箱不是管理员"等于把我们内部有哪些人一个个试出来。
         * 注意这里也**不建账号**——后台登录口不该成为一条免费的注册路径。
         */
        if (account !== undefined && (role === 'admin' || role === 'support')) {
          const issued = accounts.issueLogin(account.id)
          const link = `${deps.baseUrl}${ADMIN_CALLBACK_PATH}?token=${encodeURIComponent(issued.token)}`
          try {
            await deps.mail(loginMail(email, link, 15))
          } catch (err) {
            warn(`[admin-login] 信没发出去：${String(err)}\n`)
            throw new ApiError('provider_unavailable', '登录信没发出去，等一分钟再试一次。')
          }
        }
        return cloudOk(c, { sent: true })
      },
    ),

    cloudRoute(
      {
        method: 'get',
        path: '/v1/admin/me',
        operationId: 'cloudAdminMe',
        summary: '我是谁、什么角色、成本表核对过没有',
        tag: 'cloud-admin',
        auth: 'admin',
        returns: '{ account, role, cost_table }',
      },
      async (c) => {
        const { session } = staff(c)
        const account = deps.accounts().account(session.account_id)
        return cloudOk(c, {
          account: { id: session.account_id, email: account?.email ?? '' },
          role: session.role,
          expires_at: session.expires_at,
          cost_table: {
            as_of: COST_TABLE.as_of,
            last_verified_at: COST_TABLE.last_verified_at,
            needs_review: costTableNeedsReview(),
          },
        })
      },
    ),

    cloudRoute(
      {
        method: 'post',
        path: '/v1/admin/auth/logout',
        operationId: 'cloudAdminLogout',
        summary: '注销后台会话（清 cookie + 库里写 revoked_at）',
        tag: 'cloud-admin',
        auth: 'admin',
        returns: '{ revoked: true }',
      },
      async (c) => {
        const admin = deps.admin()
        const principal = requireStaff(c, admin)
        const raw = c.req.header('Cookie') ?? ''
        const token = /(?:^|;\s*)__Host-agentsws_admin=([^;]+)/.exec(raw)?.[1]
        if (token !== undefined) admin.revokeSession(decodeURIComponent(token))
        admin.audit({
          action: 'admin.logout',
          actor_account_id: principal.session.account_id,
          actor_role: principal.session.role,
          target_kind: 'account',
          target_id: principal.session.account_id,
          outcome: 'done',
          ip: principal.ip,
        })
        c.header(
          'Set-Cookie',
          cookieHeader(ADMIN_SESSION_COOKIE, '', { maxAgeSeconds: 0, httpOnly: true, secure }),
        )
        c.header(
          'Set-Cookie',
          cookieHeader(ADMIN_CSRF_COOKIE, '', { maxAgeSeconds: 0, httpOnly: false, secure }),
          { append: true },
        )
        return cloudOk(c, { revoked: true })
      },
    ),
  )

  /* ── 总览 ────────────────────────────────────────────────────────── */

  routes.push(
    cloudRoute(
      {
        method: 'get',
        path: '/v1/admin/overview',
        operationId: 'cloudAdminOverview',
        summary: '总览：KPI、日趋势（7 / 30 / 90）、按能力 / 供应商 / 模型、成本 Top 10、亏本告警',
        tag: 'cloud-admin',
        auth: 'admin',
        returns: 'AdminOverview',
      },
      async (c) => {
        staff(c)
        const admin = deps.admin()
        const book = ledgerOr503()
        const wanted = intQuery(c, 'window', 30)
        const days = ADMIN_TREND_WINDOWS.includes(wanted) ? wanted : 30
        const w = windowOf(deps.clock, days)
        const now = deps.clock.now()
        const w7 = windowOf(deps.clock, 7)
        const w30 = windowOf(deps.clock, 30)

        const t = await book.totals(w)
        const t7 = await book.totals(w7)
        const t30 = await book.totals(w30)
        const outstanding = await book.outstanding(now)
        const accounts7 = accountCount(admin, w7.from)
        const accounts30 = accountCount(admin, w30.from)

        const kpis: AdminKpi[] = [
          {
            key: 'accounts',
            value: accountCount(admin),
            delta_7d: accounts7,
            delta_30d: accounts30,
          },
          { key: 'active_orgs_7d', value: t7.orgs },
          { key: 'revenue_credits_30d', value: round2(t30.credits) },
          { key: 'cost_micros_30d', value: t30.cost_micros },
          {
            key: 'margin_micros_30d',
            value: Math.round(t30.credits * COST_MICRO_UNIT) - t30.cost_micros,
          },
          { key: 'input_tokens', value: t.input_tokens },
          { key: 'output_tokens', value: t.output_tokens },
          { key: 'calls', value: t.calls },
          {
            key: 'outstanding_credits',
            value: round2(outstanding.granted + outstanding.purchased),
          },
          { key: 'outstanding_granted', value: round2(outstanding.granted) },
          { key: 'outstanding_purchased', value: round2(outstanding.purchased) },
        ]

        const topOrgs = await book.breakdown('org', w30, 10)
        const names = orgNames(
          admin,
          topOrgs.map((r) => r.key),
        )

        return cloudOk(c, {
          window_days: days,
          from: w.from,
          to: w.to,
          kpis,
          trend: await book.dailyTrend(w),
          by_capability: await book.breakdown('capability', w),
          by_provider: await book.breakdown('provider', w),
          by_model: await book.breakdown('model', w, 20),
          top_orgs: topOrgs.map((r) => ({ ...r, org_name: names.get(r.key) ?? null })),
          loss: await book.lossAlert(w),
          charge_health: await book.chargeHealth(w),
          cost_table: {
            as_of: COST_TABLE.as_of,
            last_verified_at: COST_TABLE.last_verified_at,
            needs_review: costTableNeedsReview(),
          },
        })
      },
    ),
  )

  /* ── 用户 ────────────────────────────────────────────────────────── */

  routes.push(
    cloudRoute(
      {
        method: 'get',
        path: '/v1/admin/accounts',
        operationId: 'cloudAdminAccounts',
        summary: '用户列表：搜邮箱 / 筛角色与封禁 / 服务端排序分页',
        tag: 'cloud-admin',
        auth: 'admin',
        returns: 'AdminPage<AdminAccountRow>',
      },
      async (c) => {
        staff(c)
        const limit = Math.min(intQuery(c, 'limit', 50), 200)
        const offset = Math.max(intQuery(c, 'offset', 0), 0)
        const role = strQuery(c, 'role')
        const sort = strQuery(c, 'sort')
        const page = await listAccounts(deps.admin(), deps.ledger(), {
          q: strQuery(c, 'q'),
          ...(role === 'user' || role === 'support' || role === 'admin' ? { role } : {}),
          ...(strQuery(c, 'banned') === 'true' ? { banned: true } : {}),
          ...(sort === 'email' || sort === 'role' || sort === 'created_at' ? { sort } : {}),
          order: strQuery(c, 'order') === 'asc' ? 'asc' : 'desc',
          limit,
          offset,
        })
        return cloudOk(c, { ...page, limit, offset })
      },
    ),

    cloudRoute(
      {
        method: 'get',
        path: '/v1/admin/accounts/:id',
        operationId: 'cloudAdminAccount',
        summary: '一个用户的抽屉：组织、余额、近 30 天用量、封禁历史',
        tag: 'cloud-admin',
        auth: 'admin',
        params: [{ name: 'id', in: 'path', required: true, description: '账号 id' }],
        returns: '{ account, org, balance, usage_30d, ban }',
      },
      async (c) => {
        staff(c)
        const admin = deps.admin()
        const accounts = deps.accounts()
        const id = cloudParam(c, 'id')
        const account = accounts.account(id)
        if (account === undefined) throw new ApiError('not_found', '没有这个账号')
        const org = accounts.primaryOrg(id)
        const book = deps.ledger()
        const wallets = deps.wallet()
        const w = windowOf(deps.clock, 30)
        /*
         * 抽屉里的余额问的是**真值**（按组织去钱那一侧要），不是列表页那个
         * 副本算出来的近似值——点进来的人多半是要照着这个数做决定。
         */
        const balance =
          org === undefined || wallets === undefined
            ? { granted: 0, purchased: 0 }
            : await wallets.port.balance(org.id)
        const usage =
          book === undefined || org === undefined ? new Map() : await book.usageByOrgs([org.id], w)
        return cloudOk(c, {
          account: {
            id: account.id,
            email: account.email,
            role: admin.role(account.id),
            created_at: account.created_at,
            email_verified: admin.emailVerified(account.id),
          },
          org:
            org === undefined
              ? null
              : {
                  id: org.id,
                  name: org.name,
                  members: org.members.length,
                  suspended: admin.orgSuspension(org.id) !== undefined,
                },
          balance,
          usage_30d: usage.get(org?.id ?? '') ?? { calls: 0, credits: 0, cost_micros: 0 },
          ban: admin.activeBan(id) ?? null,
          memberships: org === undefined ? [] : admin.terms({ org_id: org.id, limit: 20 }),
        })
      },
    ),

    cloudRoute(
      {
        method: 'post',
        path: '/v1/admin/accounts/:id/ban',
        operationId: 'cloudAdminBanAccount',
        summary: '封禁（理由必填，可选到期）',
        tag: 'cloud-admin',
        auth: 'admin',
        params: [{ name: 'id', in: 'path', required: true, description: '账号 id' }],
        body: BanBody,
        returns: 'AccountBan',
      },
      async (c) => {
        const principal = writer(c)
        const admin = deps.admin()
        const id = cloudParam(c, 'id')
        const input = await cloudBody(c, BanBody)
        if (id === principal.session.account_id) throw new ApiError('invalid_input', '不能封自己')
        if (deps.accounts().account(id) === undefined)
          throw new ApiError('not_found', '没有这个账号')
        admin.audit({
          action: 'account.ban',
          actor_account_id: principal.session.account_id,
          actor_role: principal.session.role,
          target_kind: 'account',
          target_id: id,
          outcome: 'intent',
          details: { reason: input.reason, expires_at: input.expires_at ?? null },
          ip: principal.ip,
        })
        const ban = admin.ban({
          account_id: id,
          reason: input.reason,
          banned_by: principal.session.account_id,
          ...(input.expires_at === undefined ? {} : { expires_at: input.expires_at }),
        })
        // 封了就当场断线：留着一张有效会话的"封禁"只是一个标签
        const sessions = admin.revokeSessionsOf(id) + admin.revokeCloudSessionsOf(id)
        admin.audit({
          action: 'account.ban',
          actor_account_id: principal.session.account_id,
          actor_role: principal.session.role,
          target_kind: 'account',
          target_id: id,
          outcome: 'done',
          details: { sessions_revoked: sessions },
          ip: principal.ip,
        })
        return cloudOk(c, ban, 201)
      },
    ),

    cloudRoute(
      {
        method: 'post',
        path: '/v1/admin/accounts/:id/unban',
        operationId: 'cloudAdminUnbanAccount',
        summary: '解封（写 lifted_at，不删行）',
        tag: 'cloud-admin',
        auth: 'admin',
        params: [{ name: 'id', in: 'path', required: true, description: '账号 id' }],
        returns: '{ lifted: number }',
      },
      async (c) => {
        const principal = writer(c)
        const admin = deps.admin()
        const id = cloudParam(c, 'id')
        admin.audit({
          action: 'account.unban',
          actor_account_id: principal.session.account_id,
          actor_role: principal.session.role,
          target_kind: 'account',
          target_id: id,
          outcome: 'intent',
          ip: principal.ip,
        })
        const lifted = admin.unban(id, principal.session.account_id)
        admin.audit({
          action: 'account.unban',
          actor_account_id: principal.session.account_id,
          actor_role: principal.session.role,
          target_kind: 'account',
          target_id: id,
          outcome: 'done',
          details: { lifted },
          ip: principal.ip,
        })
        return cloudOk(c, { lifted })
      },
    ),

    cloudRoute(
      {
        method: 'post',
        path: '/v1/admin/accounts/:id/role',
        operationId: 'cloudAdminSetRole',
        summary: '改角色（只有 admin；不能改自己）',
        tag: 'cloud-admin',
        auth: 'admin',
        params: [{ name: 'id', in: 'path', required: true, description: '账号 id' }],
        body: RoleBody,
        returns: '{ account_id, role }',
      },
      async (c) => {
        const principal = writer(c)
        const admin = deps.admin()
        const id = cloudParam(c, 'id')
        const input = await cloudBody(c, RoleBody)
        /*
         * **不能改自己**：既挡住手滑把自己降成 user（那之后没人进得来），
         * 也挡住"临时给自己提一档"这种绕过双人复核的用法。
         */
        if (id === principal.session.account_id)
          throw new ApiError('invalid_input', '不能改自己的角色——让另一个管理员来改')
        if (deps.accounts().account(id) === undefined)
          throw new ApiError('not_found', '没有这个账号')
        const before = admin.role(id)
        if (before === 'admin' && input.role !== 'admin' && admin.adminCount() <= 1)
          throw new ApiError('invalid_input', '这是最后一个管理员，降级之后谁也进不来了')
        admin.audit({
          action: 'account.role_change',
          actor_account_id: principal.session.account_id,
          actor_role: principal.session.role,
          target_kind: 'account',
          target_id: id,
          outcome: 'intent',
          details: { from: before, to: input.role },
          ip: principal.ip,
        })
        admin.setRole(id, input.role as CloudRole)
        // 降级立刻生效：旧 cookie 不该再撑到过期
        admin.revokeSessionsOf(id)
        admin.audit({
          action: 'account.role_change',
          actor_account_id: principal.session.account_id,
          actor_role: principal.session.role,
          target_kind: 'account',
          target_id: id,
          outcome: 'done',
          details: { from: before, to: input.role },
          ip: principal.ip,
        })
        return cloudOk(c, { account_id: id, role: input.role })
      },
    ),

    cloudRoute(
      {
        method: 'post',
        path: '/v1/admin/accounts/:id/revoke-sessions',
        operationId: 'cloudAdminRevokeSessions',
        summary: '吊销这个人的全部会话与工作区令牌',
        tag: 'cloud-admin',
        auth: 'admin',
        params: [{ name: 'id', in: 'path', required: true, description: '账号 id' }],
        returns: '{ sessions, links }',
      },
      async (c) => {
        const principal = writer(c)
        const admin = deps.admin()
        const id = cloudParam(c, 'id')
        admin.audit({
          action: 'account.revoke_sessions',
          actor_account_id: principal.session.account_id,
          actor_role: principal.session.role,
          target_kind: 'account',
          target_id: id,
          outcome: 'intent',
          ip: principal.ip,
        })
        const sessions = admin.revokeSessionsOf(id) + admin.revokeCloudSessionsOf(id)
        const links = admin.revokeLinksOfOrgs(admin.soleOwnedOrgs(id))
        admin.audit({
          action: 'account.revoke_sessions',
          actor_account_id: principal.session.account_id,
          actor_role: principal.session.role,
          target_kind: 'account',
          target_id: id,
          outcome: 'done',
          details: { sessions, links },
          ip: principal.ip,
        })
        return cloudOk(c, { sessions, links })
      },
    ),

    cloudRoute(
      {
        method: 'post',
        path: '/v1/admin/accounts/:id/delete',
        operationId: 'cloudAdminDeleteAccount',
        summary: '删除账号（必须已封禁 → 手打邮箱 → 不能删自己与 admin；钱与账保留并匿名化）',
        tag: 'cloud-admin',
        auth: 'admin',
        params: [{ name: 'id', in: 'path', required: true, description: '账号 id' }],
        body: DeleteBody,
        returns: '{ deleted, orgs, anonymized_rows }',
      },
      async (c) => {
        const principal = writer(c)
        const admin = deps.admin()
        const accounts = deps.accounts()
        const id = cloudParam(c, 'id')
        const input = await cloudBody(c, DeleteBody)
        const account = accounts.account(id)
        if (account === undefined) throw new ApiError('not_found', '没有这个账号')

        /*
         * 五道护栏，顺序就是从"最不可逆"往回排（KOLAgents 的硬删除护栏，照搬 + 补一条）：
         * ① 不能删自己；② 不能删 admin（先降级再说）；③ 必须已经封禁——
         * 封禁是一个可撤的动作，删除不是，中间那一步给的是冷静时间；
         * ④ 手打一遍邮箱；⑤ 删之前**先写审计**。
         */
        if (id === principal.session.account_id) throw new ApiError('invalid_input', '不能删自己')
        if (admin.role(id) === 'admin')
          throw new ApiError('invalid_input', '不能删管理员——先把他降成 user')
        if (admin.activeBan(id) === undefined)
          throw new ApiError('invalid_input', '先封禁再删。封禁可以撤，删除不可以')
        if (input.email_confirm.trim().toLowerCase() !== account.email.trim().toLowerCase())
          throw new ApiError('invalid_input', '邮箱对不上——请手打一遍要删的那个邮箱')

        admin.audit({
          action: 'account.delete',
          actor_account_id: principal.session.account_id,
          actor_role: principal.session.role,
          target_kind: 'account',
          target_id: id,
          outcome: 'intent',
          details: { email_domain: emailDomain(account.email), reason: input.reason },
          ip: principal.ip,
        })

        const orgs = admin.soleOwnedOrgs(id)
        const links = admin.revokeLinksOfOrgs(orgs)
        admin.banEmail(account.email, input.reason, principal.session.account_id)
        /*
         * 钱与计量**保留并匿名化**（65 §5）：删掉的后果是历史收入随着删号一起
         * 缩水，而那一块钱是真收过的。所以只把 org_id 换成墓碑。
         */
        const wallets = deps.wallet()
        let anonymized = 0
        if (wallets !== undefined)
          for (const org of orgs) anonymized += await wallets.port.anonymize(org, tombstoneOrg(org))
        admin.tombstoneOrgs(orgs, '（已删除）')
        admin.tombstoneAccount(id, tombstoneEmail(id))

        // 删完再核一次：还在不在封禁名单上（删除谓词的二次校验，KOLAgents 那条）
        const stillBanned = admin.emailBanned(account.email)
        admin.audit({
          action: 'account.delete',
          actor_account_id: principal.session.account_id,
          actor_role: principal.session.role,
          target_kind: 'account',
          target_id: id,
          outcome: stillBanned ? 'done' : 'failed',
          details: {
            orgs: orgs.length,
            links,
            anonymized_rows: anonymized,
            email_blacklisted: stillBanned,
          },
          ip: principal.ip,
        })
        if (!stillBanned) warn(`[admin] 删号之后邮箱没进黑名单：${emailDomain(account.email)}\n`)
        return cloudOk(c, { deleted: true, orgs: orgs.length, links, anonymized_rows: anonymized })
      },
    ),
  )

  /* ── 组织 ────────────────────────────────────────────────────────── */

  routes.push(
    cloudRoute(
      {
        method: 'get',
        path: '/v1/admin/orgs',
        operationId: 'cloudAdminOrgs',
        summary: '组织列表：成员数、活令牌数、余额、近 30 天用量与成本',
        tag: 'cloud-admin',
        auth: 'admin',
        returns: 'AdminPage<AdminOrgRow>',
      },
      async (c) => {
        staff(c)
        const limit = Math.min(intQuery(c, 'limit', 50), 200)
        const offset = Math.max(intQuery(c, 'offset', 0), 0)
        const sort = strQuery(c, 'sort')
        const page = await listOrgs(deps.admin(), deps.ledger(), {
          q: strQuery(c, 'q'),
          ...(strQuery(c, 'suspended') === 'true' ? { suspended: true } : {}),
          ...(sort === 'name' || sort === 'created_at' ? { sort } : {}),
          order: strQuery(c, 'order') === 'asc' ? 'asc' : 'desc',
          limit,
          offset,
        })
        return cloudOk(c, { ...page, limit, offset })
      },
    ),

    cloudRoute(
      {
        method: 'get',
        path: '/v1/admin/orgs/:id',
        operationId: 'cloudAdminOrg',
        summary: '组织抽屉：成员、关联令牌（只有前缀与动作集）、钱包 lots、近 30 天用量',
        tag: 'cloud-admin',
        auth: 'admin',
        params: [{ name: 'id', in: 'path', required: true, description: '组织 id' }],
        returns: '{ org, members, links, lots, usage_30d, memberships }',
      },
      async (c) => {
        staff(c)
        const admin = deps.admin()
        const id = cloudParam(c, 'id')
        const org = deps.accounts().org(id)
        if (org === undefined) throw new ApiError('not_found', '没有这个组织')
        const book = deps.ledger()
        const wallets = deps.wallet()
        const w = windowOf(deps.clock, 30)
        const usage = book === undefined ? new Map() : await book.usageByOrgs([id], w)
        // 抽屉里的 lots 与余额都是**真值**（按组织去钱那一侧要）
        const lots = wallets === undefined ? [] : await wallets.port.lots(id)
        const balance =
          wallets === undefined ? { granted: 0, purchased: 0 } : await wallets.port.balance(id)
        return cloudOk(c, {
          org: {
            id: org.id,
            name: org.name,
            owner_account_id: org.owner_account_id,
            created_at: org.created_at,
            suspension: admin.orgSuspension(id) ?? null,
          },
          members: membersOfOrg(admin, id),
          links: linksOfOrg(admin, id),
          lots,
          balance,
          usage_30d: usage.get(id) ?? { calls: 0, credits: 0, cost_micros: 0 },
          memberships: admin.terms({ org_id: id, limit: 20 }),
        })
      },
    ),

    cloudRoute(
      {
        method: 'post',
        path: '/v1/admin/orgs/:id/suspend',
        operationId: 'cloudAdminSuspendOrg',
        summary: '停用组织（= 云端服务入口拒绝；不影响他本地的软件）',
        tag: 'cloud-admin',
        auth: 'admin',
        params: [{ name: 'id', in: 'path', required: true, description: '组织 id' }],
        body: SuspendBody,
        returns: '{ suspended: true }',
      },
      async (c) => {
        const principal = writer(c)
        const admin = deps.admin()
        const id = cloudParam(c, 'id')
        const input = await cloudBody(c, SuspendBody)
        if (deps.accounts().org(id) === undefined) throw new ApiError('not_found', '没有这个组织')
        admin.audit({
          action: 'org.suspend',
          actor_account_id: principal.session.account_id,
          actor_role: principal.session.role,
          target_kind: 'org',
          target_id: id,
          outcome: 'intent',
          details: { reason: input.reason },
          ip: principal.ip,
        })
        admin.suspendOrg(id, input.reason)
        admin.audit({
          action: 'org.suspend',
          actor_account_id: principal.session.account_id,
          actor_role: principal.session.role,
          target_kind: 'org',
          target_id: id,
          outcome: 'done',
          ip: principal.ip,
        })
        return cloudOk(c, { suspended: true })
      },
    ),

    cloudRoute(
      {
        method: 'post',
        path: '/v1/admin/orgs/:id/resume',
        operationId: 'cloudAdminResumeOrg',
        summary: '恢复组织',
        tag: 'cloud-admin',
        auth: 'admin',
        params: [{ name: 'id', in: 'path', required: true, description: '组织 id' }],
        returns: '{ suspended: false }',
      },
      async (c) => {
        const principal = writer(c)
        const admin = deps.admin()
        const id = cloudParam(c, 'id')
        admin.resumeOrg(id)
        admin.audit({
          action: 'org.resume',
          actor_account_id: principal.session.account_id,
          actor_role: principal.session.role,
          target_kind: 'org',
          target_id: id,
          outcome: 'done',
          ip: principal.ip,
        })
        return cloudOk(c, { suspended: false })
      },
    ),

    cloudRoute(
      {
        method: 'post',
        path: '/v1/admin/links/:id/revoke',
        operationId: 'cloudAdminRevokeLink',
        summary: '吊销一把工作区关联令牌',
        tag: 'cloud-admin',
        auth: 'admin',
        params: [{ name: 'id', in: 'path', required: true, description: '关联 id' }],
        returns: '{ revoked: true }',
      },
      async (c) => {
        const principal = writer(c)
        const admin = deps.admin()
        const id = cloudParam(c, 'id')
        const link = deps.accounts().revokeLink(id)
        if (link === undefined) throw new ApiError('not_found', '没有这条关联')
        admin.audit({
          action: 'link.revoke',
          actor_account_id: principal.session.account_id,
          actor_role: principal.session.role,
          target_kind: 'link',
          target_id: id,
          outcome: 'done',
          details: { org_id: link.cloud_org_id, workspace_id: link.workspace_id },
          ip: principal.ip,
        })
        return cloudOk(c, { revoked: true })
      },
    ),
  )

  /* ── 用量台账 ────────────────────────────────────────────────────── */

  const ledgerFilterOf = (c: Context<CloudEnv>) => ({
    from: strQuery(c, 'from'),
    to: strQuery(c, 'to'),
    org_id: strQuery(c, 'org_id'),
    capability: strQuery(c, 'capability'),
    provider: strQuery(c, 'provider'),
    model: strQuery(c, 'model'),
    charge_status: strQuery(c, 'charge_status'),
    loss_only: strQuery(c, 'loss_only') === 'true',
  })

  routes.push(
    cloudRoute(
      {
        method: 'get',
        path: '/v1/admin/usage',
        operationId: 'cloudAdminUsage',
        summary: '用量台账：筛组织 / 能力 / 供应商 / 模型 / 状态 / 时间，服务端分页',
        tag: 'cloud-admin',
        auth: 'admin',
        returns: 'AdminPage<AdminUsageRow> + loss',
      },
      async (c) => {
        staff(c)
        const book = ledgerOr503()
        const limit = Math.min(intQuery(c, 'limit', 50), 500)
        const offset = Math.max(intQuery(c, 'offset', 0), 0)
        const f = ledgerFilterOf(c)
        const page = await book.page({ ...f, limit, offset })
        const names = orgNames(deps.admin(), [...new Set(page.rows.map((r) => r.org_id))])
        const w = { from: f.from ?? windowOf(deps.clock, 30).from, to: f.to ?? deps.clock.now() }
        return cloudOk(c, {
          rows: page.rows.map((r) => ({ ...r, org_name: names.get(r.org_id) ?? null })),
          total: page.total,
          limit,
          offset,
          loss: await book.lossAlert(w),
        })
      },
    ),

    cloudRoute(
      {
        method: 'get',
        path: '/v1/admin/usage/filters',
        operationId: 'cloudAdminUsageFilters',
        summary: '台账筛选器的取值（表里真出现过的，不是我们以为会有的）',
        tag: 'cloud-admin',
        auth: 'admin',
        returns: '{ capabilities, providers, models }',
      },
      async (c) => {
        staff(c)
        const book = ledgerOr503()
        return cloudOk(c, {
          capabilities: await book.distinctValues('capability'),
          providers: await book.distinctValues('provider'),
          models: await book.distinctValues('model'),
        })
      },
    ),

    cloudRoute(
      {
        method: 'get',
        path: '/v1/admin/usage/export.csv',
        operationId: 'cloudAdminUsageExport',
        summary: 'CSV 导出（流式；记一条审计）',
        tag: 'cloud-admin',
        auth: 'admin',
        returns: 'text/csv',
      },
      async (c) => {
        const principal = staff(c)
        const book = ledgerOr503()
        const admin = deps.admin()
        const f = ledgerFilterOf(c)
        admin.audit({
          action: 'usage.export',
          actor_account_id: principal.session.account_id,
          actor_role: principal.session.role,
          target_kind: 'system',
          target_id: 'usage',
          outcome: 'done',
          // 筛选条件进审计（谁导了哪一段），**导出的内容不进**
          details: { ...f },
          ip: principal.ip,
        })
        const header =
          'at,org_id,workspace_id,capability,provider,model,unit,quantity,input_tokens,output_tokens,credits,cost_micros,cost_currency,charge_status,request_id\n'
        /*
         * 流式：一批五百行推一段，不把十万行同时放进堆里。两个旧后台都是
         * 一次 `SELECT *` 再 `map`，那正是它们在数据长起来之后变慢的地方。
         */
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            const encoder = new TextEncoder()
            controller.enqueue(encoder.encode(header))
            for await (const rows of ledgerPages(book, f))
              controller.enqueue(encoder.encode(rows.map(csvLine).join('')))
            controller.close()
          },
        })
        return new Response(stream, {
          status: 200,
          headers: {
            'content-type': 'text/csv; charset=utf-8',
            'content-disposition': 'attachment; filename="agentsws-usage.csv"',
            'cache-control': 'no-store',
          },
        })
      },
    ),
  )

  /* ── 积分与会员 ──────────────────────────────────────────────────── */

  routes.push(
    cloudRoute(
      {
        method: 'get',
        path: '/v1/admin/credits',
        operationId: 'cloudAdminCredits',
        summary: '发放流水、手动会员 term 列表、即将到期',
        tag: 'cloud-admin',
        auth: 'admin',
        returns: '{ grants, terms, expiring, plans, signup_bonus }',
      },
      async (c) => {
        staff(c)
        const book = ledgerOr503()
        const admin = deps.admin()
        const limit = Math.min(intQuery(c, 'limit', 50), 200)
        const offset = Math.max(intQuery(c, 'offset', 0), 0)
        const now = deps.clock.now()
        const soon = new Date(Date.parse(now) + 14 * DAY_MS).toISOString()
        const grants = await book.grants({ org_id: strQuery(c, 'org_id'), limit, offset })
        const orgIds = new Set<string>((grants.rows as { org_id: string }[]).map((r) => r.org_id))
        const terms = admin.terms({ org_id: strQuery(c, 'org_id'), limit: 100 })
        for (const t of terms) orgIds.add(t.org_id)
        const names = orgNames(admin, [...orgIds])
        return cloudOk(c, {
          grants: {
            rows: (grants.rows as { org_id: string }[]).map((r) => ({
              ...r,
              org_name: names.get(r.org_id) ?? null,
            })),
            total: grants.total,
            limit,
            offset,
          },
          terms: terms.map((t: MembershipTerm) => ({
            ...t,
            org_name: names.get(t.org_id) ?? null,
            cycles: admin.cyclesOf(t.id).length,
            granted_cycles: admin.cyclesOf(t.id).filter((x) => x.granted_at !== undefined).length,
          })),
          expiring: await book.expiring(now, soon),
          plans: plans(),
          /*
           * WP121（70 §2）：注册赠送。**单独一格**，不混进上面那张发放流水——
           * 那张表是"谁按了发放按钮"，这一格是"系统自己送出去了多少"，两个数
           * 回答的是两个问题（这个月烧了多少拉新钱 / 运营手动发了多少）。
           */
          signup_bonus: { ...admin.signupBonusTotals(), rule: signupBonus() ?? null },
        })
      },
    ),

    cloudRoute(
      {
        method: 'post',
        path: '/v1/admin/credits/grant',
        operationId: 'cloudAdminGrantCredits',
        summary: '发积分（默认 granted，可批量；理由必填；逐个幂等）',
        tag: 'cloud-admin',
        auth: 'admin',
        body: GrantBody,
        returns: '{ granted: [...], skipped: [...] }',
      },
      async (c) => {
        const principal = writer(c)
        const admin = deps.admin()
        const { port } = walletOr503()
        const input = await cloudBody(c, GrantBody)
        const now = deps.clock.now()
        const days = input.expires_in_days ?? 90
        const expires_at =
          input.kind === 'purchased'
            ? undefined
            : new Date(Date.parse(now) + days * DAY_MS).toISOString()

        const targets: { org_id: string; label: string }[] = []
        for (const email of input.emails ?? []) {
          const found = resolveOrgByEmail(admin, email)
          if (found === undefined) {
            targets.push({ org_id: '', label: email })
            continue
          }
          targets.push({ org_id: found.org_id, label: emailDomain(found.email) })
        }
        for (const org_id of input.org_ids ?? []) targets.push({ org_id, label: org_id })
        if (targets.length === 0) throw new ApiError('invalid_input', '一个收件人都没有')

        admin.audit({
          action: 'credits.grant',
          actor_account_id: principal.session.account_id,
          actor_role: principal.session.role,
          target_kind: 'system',
          target_id: 'batch',
          outcome: 'intent',
          details: {
            recipients: targets.length,
            credits: input.credits,
            kind: input.kind,
            reason: input.reason,
          },
          ip: principal.ip,
        })

        const granted: { org_id: string; lot_id: string; credits: number }[] = []
        const skipped: { label: string; why: string }[] = []
        for (const t of targets) {
          if (t.org_id === '') {
            skipped.push({ label: t.label, why: '这个邮箱还没登录过云账号' })
            continue
          }
          try {
            /*
             * **逐个幂等**：`source_ref` 由「管理员 + 收件人 + 这一批的理由 + 今天」
             * 推出来，同一批重放（网络抖了、按了两次）不会变成第二笔额度。
             * 里面**没有时间戳**，只有日期——KefuAgent 就是在这里栽的。
             */
            const source_ref = `admgrant:${principal.session.account_id}:${t.org_id}:${now.slice(0, 10)}:${hash8(input.reason)}`
            const lot = await port.grant({
              org_id: t.org_id,
              credits: input.credits,
              kind: input.kind,
              ...(expires_at === undefined ? {} : { expires_at }),
              source_ref,
            })
            granted.push({ org_id: t.org_id, lot_id: lot.lot_id, credits: input.credits })
          } catch (err) {
            skipped.push({ label: t.label, why: err instanceof Error ? err.message : '发不出去' })
          }
        }

        admin.audit({
          action: 'credits.grant',
          actor_account_id: principal.session.account_id,
          actor_role: principal.session.role,
          target_kind: 'system',
          target_id: 'batch',
          outcome: 'done',
          details: { granted: granted.length, skipped: skipped.length, credits: input.credits },
          ip: principal.ip,
        })
        return cloudOk(c, { granted, skipped }, 201)
      },
    ),

    cloudRoute(
      {
        method: 'post',
        path: '/v1/admin/credits/revoke',
        operationId: 'cloudAdminRevokeCredits',
        summary: '撤回一笔已发积分里还没被消耗的部分（两个旧后台都没有，这里补上）',
        tag: 'cloud-admin',
        auth: 'admin',
        body: RevokeGrantBody,
        returns: '{ lot_id, revoked }',
      },
      async (c) => {
        const principal = writer(c)
        const admin = deps.admin()
        const { port } = walletOr503()
        const input = await cloudBody(c, RevokeGrantBody)
        admin.audit({
          action: 'credits.revoke',
          actor_account_id: principal.session.account_id,
          actor_role: principal.session.role,
          target_kind: 'system',
          target_id: input.lot_id,
          outcome: 'intent',
          details: { reason: input.reason },
          ip: principal.ip,
        })
        /*
         * 撤回与那条**负向流水**一起做，在钱那一侧（Workers 形态下它们必须
         * 落在同一个 `WalletDO` 里，否则两件事会分家）。能力名 `admin.grant`，
         * 与 `admin.topup` 一样被排除在"用量"之外（见 `admin-queries.ts` 的
         * `NON_USAGE_CAPABILITIES`），所以不会把总用量拉低。
         */
        let out: { revoked: number } | undefined
        try {
          out = await port.revoke({
            org_id: input.org_id ?? '',
            lot_id: input.lot_id,
            reason: input.reason,
            actor_account_id: principal.session.account_id,
            at: deps.clock.now(),
          })
        } catch (err) {
          /*
           * 钱那一侧说不行（比如官方托管形态下没给 `org_id`，不知道该敲哪扇门）：
           * **把它的原话端出来**。翻成"没有这一笔"会让人去找一笔本来就在的积分。
           */
          throw new ApiError('invalid_input', err instanceof Error ? err.message : '撤不了')
        }
        if (out === undefined)
          throw new ApiError('not_found', '没有这一笔 granted 积分（充值买的不能撤）')
        admin.audit({
          action: 'credits.revoke',
          actor_account_id: principal.session.account_id,
          actor_role: principal.session.role,
          target_kind: 'system',
          target_id: input.lot_id,
          outcome: 'done',
          details: { revoked: out.revoked },
          ip: principal.ip,
        })
        return cloudOk(c, { lot_id: input.lot_id, revoked: out.revoked })
      },
    ),

    cloudRoute(
      {
        method: 'post',
        path: '/v1/admin/membership/start',
        operationId: 'cloudAdminStartMembership',
        summary: '手动开通会员（档位 + 月数或绝对到期日；按 cycle 幂等发积分）',
        tag: 'cloud-admin',
        auth: 'admin',
        body: MembershipBody,
        returns: '{ term, cycles, granted }',
      },
      async (c) => {
        const principal = writer(c)
        const admin = deps.admin()
        const { wallet } = walletOr503()
        const input = await cloudBody(c, MembershipBody)
        let org_id = input.org_id
        if (org_id === undefined) {
          const found =
            input.email === undefined ? undefined : resolveOrgByEmail(admin, input.email)
          if (found === undefined)
            throw new ApiError('not_found', '这个邮箱还没登录过云账号——让他先在本地关联一次')
          org_id = found.org_id
        }
        if (deps.accounts().org(org_id) === undefined)
          throw new ApiError('not_found', '没有这个组织')

        let plan: ReturnType<typeof planOrThrow>
        try {
          plan = planOrThrow(input.plan_id)
        } catch (err) {
          throw new ApiError('invalid_input', err instanceof Error ? err.message : '档位不对')
        }
        const now = deps.clock.now()
        // **调档沿用旧 anchor**：不然从月付换年付的那个月会发两次
        const anchor_at = anchorFor(admin, org_id, now)
        let ends_at: string
        try {
          ends_at = termEndsAt(anchor_at, { months: input.months, until: input.until })
        } catch (err) {
          throw new ApiError('invalid_input', err instanceof Error ? err.message : 'term 算不出来')
        }
        if (Date.parse(ends_at) <= Date.parse(now))
          throw new ApiError('invalid_input', '到期日在过去——这个会员开完当场就结束了')

        admin.audit({
          action: 'membership.start',
          actor_account_id: principal.session.account_id,
          actor_role: principal.session.role,
          target_kind: 'org',
          target_id: org_id,
          outcome: 'intent',
          details: { plan_id: plan.id, ends_at, grant_now: input.grant_now },
          ip: principal.ip,
        })

        const term = admin.createTerm({
          org_id,
          plan_id: plan.id,
          anchor_at,
          starts_at: now,
          ends_at,
          status: 'active',
          created_by: principal.session.account_id,
          created_at: now,
          ...(input.note === undefined ? {} : { note: input.note }),
        })
        const planned = planCycles({ term_id: term.id, plan, anchor_at, ends_at })
        admin.putCycles(
          planned.map((p) => ({
            term_id: term.id,
            org_id,
            index: p.index,
            starts_at: p.starts_at,
            ends_at: p.ends_at,
            grant_key: p.grant_key,
            credits: p.credits,
          })),
        )
        // 立刻发的那一笔走的是**同一条**续发通道，不是第二段代码
        const run = input.grant_now
          ? runDueGrants(admin, wallet, deps.clock, { warn })
          : { granted: 0, credits: 0, lots: [] }
        admin.audit({
          action: 'membership.start',
          actor_account_id: principal.session.account_id,
          actor_role: principal.session.role,
          target_kind: 'org',
          target_id: org_id,
          outcome: 'done',
          details: { term_id: term.id, cycles: planned.length, granted_now: run.granted },
          ip: principal.ip,
        })
        return cloudOk(c, { term, cycles: planned.length, granted: run.granted }, 201)
      },
    ),

    cloudRoute(
      {
        method: 'post',
        path: '/v1/admin/membership/:id/cancel',
        operationId: 'cloudAdminCancelMembership',
        summary: '取消会员（term 即刻结束；已发积分不回收）',
        tag: 'cloud-admin',
        auth: 'admin',
        params: [{ name: 'id', in: 'path', required: true, description: 'term id' }],
        body: CancelBody,
        returns: '{ cancelled: true }',
      },
      async (c) => {
        const principal = writer(c)
        const admin = deps.admin()
        const id = cloudParam(c, 'id')
        const input = await cloudBody(c, CancelBody)
        const term = admin.term(id)
        if (term === undefined) throw new ApiError('not_found', '没有这个 term')
        admin.audit({
          action: 'membership.cancel',
          actor_account_id: principal.session.account_id,
          actor_role: principal.session.role,
          target_kind: 'org',
          target_id: term.org_id,
          outcome: 'intent',
          details: { term_id: id, reason: input.reason },
          ip: principal.ip,
        })
        admin.cancelTerm(id, principal.session.account_id, deps.clock.now())
        admin.audit({
          action: 'membership.cancel',
          actor_account_id: principal.session.account_id,
          actor_role: principal.session.role,
          target_kind: 'org',
          target_id: term.org_id,
          outcome: 'done',
          details: { term_id: id },
          ip: principal.ip,
        })
        return cloudOk(c, { cancelled: true })
      },
    ),
  )

  /* ── 健康与审计 ──────────────────────────────────────────────────── */

  routes.push(
    cloudRoute(
      {
        method: 'get',
        path: '/v1/admin/health',
        operationId: 'cloudAdminHealth',
        summary: '健康：发信 / 上游 / 计量管线 / 定时 / 备份 —— 每项写明「它测量了什么」',
        tag: 'cloud-admin',
        auth: 'admin',
        returns: 'AdminHealthItem[]',
      },
      async (c) => {
        staff(c)
        const admin = deps.admin()
        const book = deps.ledger()
        const now = deps.clock.now()
        const modules = deps.health?.().modules ?? {}
        const lastEvent = book === undefined ? undefined : await book.lastEventAt()
        const lastAudit =
          admin.db.prepare<{ at: string | null }>('SELECT MAX(at) AS at FROM admin_audit').get()
            ?.at ?? undefined
        const staleMs =
          lastEvent === undefined
            ? Number.POSITIVE_INFINITY
            : Date.parse(now) - Date.parse(lastEvent)

        const items: AdminHealthItem[] = [
          {
            key: 'mail',
            label_zh: '登录邮件投递',
            measures_zh:
              '测量的是「这个进程配了 SMTP 没有」，不是「上一封信真的送达了」——送达要看邮件服务商那边的退信。绿了只说明我们有一条出口。',
            status: modules.mail === true ? 'ok' : 'warn',
            detail: modules.mail === true ? '已配 SMTP' : '没配 SMTP：登录信发不出去',
          },
          {
            key: 'entry',
            label_zh: '服务入口（模型与钱包）',
            measures_zh:
              '测量的是 /v1/ai 与 /v1/wallet 这两组路由挂上了没有。没挂 = 用户的模型调用会 404。',
            status: modules.entry === true ? 'ok' : 'bad',
          },
          {
            key: 'metering',
            label_zh: '计量管线',
            measures_zh:
              '测量的是「最后一条计量事件是什么时候写进去的」。超过 24 小时没有新行，要么真没人用，要么结算那一步在某个地方悄悄失败了——这两件事看起来一模一样，所以它只是黄灯，不是红灯。',
            status: book === undefined ? 'unknown' : staleMs < 24 * 60 * 60 * 1000 ? 'ok' : 'warn',
            ...(lastEvent === undefined ? {} : { at: lastEvent }),
          },
          {
            key: 'membership',
            label_zh: '会员续发',
            measures_zh:
              '测量的是「现在有几个 cycle 已经到点但还没发」。这个数常年为 0 才对；不为 0 说明定时没跑或者发的时候一直在失败。',
            status: admin.dueCycles(now, 50).length === 0 ? 'ok' : 'warn',
            detail: `待发 ${String(admin.dueCycles(now, 50).length)} 个 cycle`,
          },
          {
            key: 'audit',
            label_zh: '审计写入',
            measures_zh:
              '测量的是「审计表最后一次被写是什么时候」。审计写失败是不抛的（不该因为日志写不进去就让封禁失败），所以只能靠这一格发现它坏了。',
            status: lastAudit === undefined ? 'warn' : 'ok',
            ...(lastAudit === undefined ? {} : { at: lastAudit }),
          },
          {
            key: 'cost_table',
            label_zh: '成本价目核对',
            measures_zh:
              '测量的是「成本表有没有人核对过」。没核对过时，后台里所有「我方成本」与「毛利」都是按公开价填的参考值，不是财务事实。',
            status: costTableNeedsReview() ? 'warn' : 'ok',
            detail: `价目 as_of ${COST_TABLE.as_of}，核对于 ${COST_TABLE.last_verified_at ?? '从未'}`,
          },
          {
            key: 'backup',
            label_zh: '备份',
            measures_zh:
              '**这一格现在永远是 unknown**：备份是 docs/61 里那个 cron + `deploy/backup.sh` 干的，它不往库里写任何东西，所以这个进程没有办法知道它昨晚跑没跑。要它变绿得让 backup.sh 留一个时间戳文件，那是下一个 WP。',
            status: 'unknown',
          },
        ]
        return cloudOk(c, { items, at: now })
      },
    ),

    cloudRoute(
      {
        method: 'get',
        path: '/v1/admin/audit',
        operationId: 'cloudAdminAudit',
        summary: '审计（只读分页）',
        tag: 'cloud-admin',
        auth: 'admin',
        returns: 'AdminPage<AuditEntry>',
      },
      async (c) => {
        staff(c)
        const limit = Math.min(intQuery(c, 'limit', 50), 200)
        const offset = Math.max(intQuery(c, 'offset', 0), 0)
        const page = deps.admin().auditPage({
          limit,
          offset,
          action: strQuery(c, 'action'),
          target_id: strQuery(c, 'target_id'),
        })
        return cloudOk(c, { ...page, limit, offset })
      },
    ),
  )

  /* ── 红人营销增值服务（WP118 / 67 §3）──────────────────────────────── */

  routes.push(
    cloudRoute(
      {
        method: 'get',
        path: '/v1/admin/orgs/:org_id/kol-service',
        operationId: 'cloudAdminKolService',
        summary:
          '一个组织的红人营销增值服务：订阅状态 / 到期 / 云端对象数 / 最近同步 / 最近几笔扣费',
        tag: 'cloud-admin',
        auth: 'admin',
        returns: 'KolCloudSummary',
      },
      async (c) => {
        staff(c)
        return cloudOk(c, await kolCloudOr503().summary(c.req.param('org_id') ?? ''))
      },
    ),

    cloudRoute(
      {
        method: 'post',
        path: '/v1/admin/orgs/:org_id/kol-service/grant',
        operationId: 'cloudAdminKolServiceGrant',
        summary: '给一个组织赠送 N 个月增值服务（那几期 0 积分，照样走一遍流程）',
        tag: 'cloud-admin',
        auth: 'admin',
        body: KolGrantBody,
        returns: 'ServiceSubscription',
      },
      async (c) => {
        // 送钱的动作走 `writer`（会话 + CSRF），不是只读的 `staff`
        const principal = writer(c)
        const input = await cloudBody(c, KolGrantBody)
        const org_id = c.req.param('org_id') ?? ''
        const next = await kolCloudOr503().grant(org_id, input.months)
        /*
         * 赠送是**送钱**，所以进审计（与手动发积分同一条）：一个月 30 积分，
         * 送十个月就是 300，这种事必须留一行谁在什么时候做的。
         */
        deps.admin().audit({
          action: 'kol_service.grant',
          actor_account_id: principal.session.account_id,
          actor_role: principal.session.role,
          target_kind: 'org',
          target_id: org_id,
          outcome: 'done',
          details: { months: input.months },
          ip: principal.ip,
        })
        return cloudOk(c, next)
      },
    ),
  )

  /* ── 公共红人库（WP116 §4）────────────────────────────────────────── */

  routes.push(
    cloudRoute(
      {
        method: 'get',
        path: '/v1/admin/kol',
        operationId: 'cloudAdminKolStats',
        summary: '公共红人库那一页的数：总量 / 按平台 / 近 7·30 天新增 / reveal 与上游成本',
        tag: 'cloud-admin',
        auth: 'admin',
        returns: '{ library, usage }',
      },
      async (c) => {
        staff(c)
        const library = await kolOr503().stats()
        /*
         * 「reveal 次数与积分」「上游调用次数与成本」来自**计量事件**，不是库里
         * 的行数——库只知道有多少人，不知道谁查过谁。没接账本就只有库那一半，
         * 那一格显示"看不了账"而不是 0（65 §9 同一条）。
         */
        const book = deps.ledger()
        const w = windowOf(deps.clock, 30)
        const rows = book === undefined ? [] : await book.breakdown('capability', w, 200)
        return cloudOk(c, {
          library,
          usage: {
            window: w,
            available: book !== undefined,
            rows: rows.filter((r) => KOL_CAPABILITIES.includes(r.key)),
          },
        })
      },
    ),

    cloudRoute(
      {
        method: 'get',
        path: '/v1/admin/kol/creators',
        operationId: 'cloudAdminKolCreators',
        summary: '搜库里的红人（名字 / handle / 类目、按平台、有没有联系方式、只看搬来的）',
        tag: 'cloud-admin',
        auth: 'admin',
        returns: 'AdminPage<PublicCreatorCard>',
      },
      async (c) => {
        staff(c)
        const limit = Math.min(intQuery(c, 'limit', 50), 200)
        const offset = Math.max(intQuery(c, 'offset', 0), 0)
        const channel = strQuery(c, 'channel')
        const hasContact = strQuery(c, 'has_contact')
        const page = await kolOr503().search({
          limit,
          offset,
          q: strQuery(c, 'q'),
          ...(channel === undefined ? {} : { channel: assertChannel(channel) }),
          ...(hasContact === undefined ? {} : { has_contact: hasContact === 'true' }),
          ...(strQuery(c, 'imported_only') === 'true' ? { imported_only: true } : {}),
        })
        return cloudOk(c, { ...page, limit, offset })
      },
    ),

    cloudRoute(
      {
        method: 'post',
        path: '/v1/admin/kol/creators/:channel/:handle/remove',
        operationId: 'cloudAdminKolRemove',
        summary: '从库中移除一个人（opt-out：删掉全部行，而且以后搬家也搬不回来）',
        tag: 'cloud-admin',
        auth: 'admin',
        body: KolRemoveBody,
        returns: '{ removed }',
      },
      async (c) => {
        const principal = writer(c)
        const admin = deps.admin()
        const api = kolOr503()
        const input = await cloudBody(c, KolRemoveBody)
        const channel = assertChannel(c.req.param('channel'))
        const handle = (c.req.param('handle') ?? '').toLowerCase()
        const target = `${channel}/${handle}`
        admin.audit({
          action: 'kol.remove',
          actor_account_id: principal.session.account_id,
          actor_role: principal.session.role,
          target_kind: 'system',
          target_id: target,
          outcome: 'intent',
          details: { reason: input.reason },
          ip: principal.ip,
        })
        const out = await api.remove({
          channel,
          handle,
          reason: input.reason,
          removed_by: principal.session.account_id,
        })
        admin.audit({
          action: 'kol.remove',
          actor_account_id: principal.session.account_id,
          actor_role: principal.session.role,
          target_kind: 'system',
          target_id: target,
          outcome: 'done',
          details: { removed: out.removed },
          ip: principal.ip,
        })
        return cloudOk(c, out)
      },
    ),

    cloudRoute(
      {
        method: 'post',
        path: '/v1/admin/kol/import',
        operationId: 'cloudAdminKolImport',
        summary: '搬家：收一批 NDJSON（分块推、可重跑、幂等键 = 渠道 + 原生 id）',
        tag: 'cloud-admin',
        auth: 'admin',
        returns: 'KolImportResult',
      },
      async (c) => {
        const principal = importer(c)
        const admin = deps.admin()
        const api = kolOr503()
        /*
         * 正文是 **NDJSON**（`text/plain` 那样一行一条），不是 JSON 数组：
         * 七百行里有一行坏了，JSON.parse 整块就全废；NDJSON 坏一行只废一行。
         * 也认 `{ records: [...] }` ——脚本之外手动试一下时那样写更顺手。
         */
        const raw = await c.req.text()
        const records = kolImportRecordsOf(raw)
        if (records.length > MAX_KOL_IMPORT_BATCH)
          throw new ApiError(
            'invalid_input',
            `一趟最多 ${String(MAX_KOL_IMPORT_BATCH)} 行（这一趟 ${String(records.length)} 行）。脚本会自己分块。`,
          )
        const out = await api.import(records)
        admin.audit({
          action: 'kol.import',
          actor_account_id: principal.account_id,
          actor_role: principal.role,
          target_kind: 'system',
          target_id: 'kol_public',
          outcome: 'done',
          // **不记任何一行的内容**（里面有真实邮箱）——只记数
          details: {
            received: out.received,
            inserted: out.inserted,
            updated: out.updated,
            skipped: out.skipped,
            rejected: out.rejected.length,
          },
          ip: principal.ip,
        })
        return cloudOk(c, out)
      },
    ),
  )

  return routes
}

/**
 * 搬家那条路由的正文：NDJSON 一行一条，也认 `{ records: [...] }`。
 *
 * **坏行不在这里抛**：原样带给 `importKolRecords` 去数，返回体里那句
 * "这一行不是一个对象 × 3" 才是搬家的人真正需要的答复。
 */
export function kolImportRecordsOf(raw: string): unknown[] {
  const text = raw.trim()
  if (text === '') return []
  if (text.startsWith('{') && text.includes('"records"')) {
    try {
      const parsed = JSON.parse(text) as { records?: unknown }
      if (Array.isArray(parsed.records)) return parsed.records
    } catch {
      // 不是一整块 JSON 就当 NDJSON 处理（下面那一行）
    }
  }
  if (text.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(text)
      if (Array.isArray(parsed)) return parsed
    } catch {
      /* 同上 */
    }
  }
  return parseNdjson(text)
}

/* ------------------------------------------------------------------ */

const round2 = (n: number): number => Math.round(n * 100) / 100

/** 理由 → 八位稳定短串（幂等键的一部分；**不是**安全用途，所以不用 sha256）。 */
function hash8(raw: string): string {
  let h = 5381
  for (const ch of raw) h = ((h * 33) ^ (ch.codePointAt(0) ?? 0)) >>> 0
  return h.toString(16).padStart(8, '0')
}

/**
 * CSV 导出的分页游标：**一页一页取**，不一次全要。
 *
 * 导出十万行不该让这个进程的堆里同时躺着十万个对象——上游那两个后台都是
 * 一次 `SELECT *` 然后 `map`，那正是它们在数据长起来之后变慢的地方。
 */
async function* ledgerPages(
  book: UsageLedger,
  filter: LedgerFilter,
  batchSize = 500,
): AsyncGenerator<LedgerRow[]> {
  let offset = filter.offset ?? 0
  for (;;) {
    const { rows } = await book.page({ ...filter, limit: batchSize, offset })
    if (rows.length === 0) return
    yield rows
    if (rows.length < batchSize) return
    offset += rows.length
  }
}

/** CSV 一行。**每个字段都引起来并转义**——模型名里真的会有逗号。 */
function csvLine(r: LedgerRow): string {
  const cells = [
    r.at,
    r.org_id,
    r.workspace_id,
    r.capability,
    r.provider,
    r.model,
    r.unit,
    r.quantity,
    r.input_tokens,
    r.output_tokens,
    r.credits,
    r.cost_micros,
    r.cost_currency,
    r.charge_status,
    r.request_id,
  ]
  return `${cells.map(csvCell).join(',')}\n`
}

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return ''
  const s = String(v)
  /*
   * 以 `=`、`+`、`-`、`@` 开头的单元格在 Excel 里会被当公式执行（CSV 注入）。
   * 前面加一个单引号是最小的解法，而这张表里 `-` 开头是真会出现的（撤回的负数）。
   */
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s
  return `"${safe.replaceAll('"', '""')}"`
}

/** 后台会话 cookie 的最大寿命（秒）。 */
export const ADMIN_COOKIE_MAX_AGE_SECONDS = Math.floor(ADMIN_SESSION_ABSOLUTE_TTL_MS / 1000)

export { notThere }
