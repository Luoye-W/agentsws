/**
 * `POST /v1/admin/topup`：管理员手动给某个组织发积分（WP110）。
 *
 * 为什么要有这一条：测试环境**不开 Stripe**（没给密钥就 501，那是现状也是有意的），
 * 但内测朋友得有额度才能跑模型。没有这条口子，唯一的办法是 SSH 进服务器手写 SQL——
 * 那会绕过钱包的两类积分规则，也不会留下任何账。
 *
 * 五条纪律：
 *
 * 1. **没配 `AGENTSWS_CLOUD_ADMIN_TOKEN` 这条路由根本不挂**（不是挂上去再拒）。
 *    挂着一条"密码是空串"的管理路由，与没有这条路由是两件完全不同的事。
 * 2. 令牌**至少 32 字节**，比对用 {@link secretEquals}（定长比较，不给计时旁路）。
 * 3. 发的是 **`granted`** 那一类积分（到期清零，49 §3），不是 `purchased`。
 *    内测送的额度不该变成"永不过期的钱"。
 * 4. **走钱包自己的 `topup`**，不直接写库：两类积分、先扣有期限的、幂等
 *    （同一个 `source_ref` 只入一次）那几条规矩只写一遍。
 * 5. **记一条 0 积分的计量事件**（照 WP61 免费动作那条先例）：用量看板要知道
 *    这笔额度是怎么来的。`credits: 0` 是因为发额度不是花费——记成花费会让
 *    用量总数凭空多出一块。
 *
 * 日志：只打组织 id 与积分数，**不打令牌、不打邮箱全称**（21 §1）。
 */

import {
  ApiError,
  type CloudRoute,
  cloudBody,
  cloudOk,
  cloudRoute,
  secretEquals,
} from '@agentsws/api'
import { type Clock, emailDomain, type WalletLot } from '@agentsws/contracts'
import { assertMeteringEvent, type Wallet, type WalletStore } from '@agentsws/metering'
import { z } from 'zod'
import type { CloudSnapshot } from '../store.js'

/** 管理员令牌的环境变量名。值不在仓库里，也不在任何日志里。 */
export const ADMIN_TOKEN_ENV = 'AGENTSWS_CLOUD_ADMIN_TOKEN'

/** 令牌最短多少字节。短于它就不是"运维不小心配短了"，是"这台机器不该开管理口"。 */
export const ADMIN_TOKEN_MIN_BYTES = 32

/** 手动充值记的那条计量事件的能力名。与价目表里的能力**不同名**——它不产生成本。 */
export const ADMIN_TOPUP_CAPABILITY = 'admin.topup'

/** 送的额度默认多久到期。90 天与贡献奖励那一档一致（49 §3）。 */
export const DEFAULT_GRANT_DAYS = 90

const TopupBody = z
  .object({
    /** 直接给组织 id。 */
    org_id: z.string().min(1).max(200).optional(),
    /** 或者给邮箱——内测时知道的是朋友的邮箱，不是组织 id。 */
    email: z.string().min(3).max(320).optional(),
    /** 1 积分 = ¥1（49 M4）。 */
    credits: z.number().positive().max(1_000_000),
    /** 多少天后清零；不给 = 90 天。`0` 不允许（那等于发了个当场作废的额度）。 */
    expires_in_days: z.number().int().positive().max(3650).optional(),
    /**
     * 对账用的幂等键（同一个只入一次）。重发同一条请求不该变成第二笔额度。
     */
    source_ref: z.string().min(1).max(200).optional(),
  })
  .refine((b) => b.org_id !== undefined || b.email !== undefined, {
    message: 'org_id 与 email 至少给一个',
  })

/** 钱包那两样；`mountEntry` 装完才有，所以这里收的是取值函数不是值。 */
export interface AdminWalletHandles {
  wallet: Wallet
  store: WalletStore
}

/**
 * 这条路由要问账号库的**全部三件事**（WP114 把入参从 `CloudStore` 收窄成这个口）。
 *
 * 为什么要收窄：Workers 形态里钱包与账号库在**两个** Durable Object 里，
 * 这条路由跑在钱包那一个里，手上没有账号库。组织是 Worker 在转发之前就解析好的
 * （`/__internal/resolve-org`），所以它给进来的是一个"已经验过"的极小实现。
 * `CloudStore` 结构上满足这个口，Compose 形态那边一个字都不用改。
 */
export interface AdminAccountsLookup {
  accountByEmail(email: string): { id: string } | undefined
  primaryOrg(account_id: string): { id: string } | undefined
  org(id: string): { id: string } | undefined
}

export interface AdminRouteDeps {
  clock: Clock
  /** 明文管理员令牌（由 {@link adminRoutesFromEnv} 从环境变量取）。 */
  token: string
  /** 账号库（邮箱 → 账号 → 组织）。 */
  accounts: () => AdminAccountsLookup
  /** 钱包；还没装好就回 `undefined`（这时路由回 503，不假装充上了）。 */
  wallet: () => AdminWalletHandles | undefined
  newRequestId?: () => string
  /** 审计行写哪儿；默认 stdout。 */
  log?: (line: string) => void
}

/**
 * 按环境变量决定挂不挂。
 *
 * 没配 → `undefined`（不挂）。配了但太短 → **抛**，不是悄悄不挂：
 * 运维以为自己开了管理口而实际上没开，比起不来危险得多。
 */
export function adminRoutesFromEnv(
  deps: Omit<AdminRouteDeps, 'token'> & { env: Record<string, string | undefined> },
): CloudRoute[] | undefined {
  const token = deps.env[ADMIN_TOKEN_ENV]?.trim()
  if (token === undefined || token === '') return undefined
  if (Buffer.byteLength(token, 'utf8') < ADMIN_TOKEN_MIN_BYTES)
    throw new Error(
      `${ADMIN_TOKEN_ENV} 太短（至少 ${String(ADMIN_TOKEN_MIN_BYTES)} 字节）：` +
        '用 `openssl rand -base64 48` 生成一个，别自己编。',
    )
  return adminRoutes({ ...deps, token })
}

export function adminRoutes(deps: AdminRouteDeps): CloudRoute[] {
  const log = deps.log ?? ((line: string) => process.stdout.write(line))
  let seq = 0
  const newRequestId =
    deps.newRequestId ??
    (() => `adm_${deps.clock.now().replace(/\D/g, '').slice(0, 14)}_${String(++seq)}`)

  return [
    cloudRoute(
      {
        method: 'post',
        path: '/v1/admin/topup',
        operationId: 'cloudAdminTopup',
        summary: '管理员手动给一个组织发积分（granted，带过期）。只认 admin 令牌',
        tag: 'cloud-admin',
        auth: 'admin',
        body: TopupBody,
        returns: '{ org_id, credits, kind: "granted", expires_at, lot_id }',
      },
      async (c) => {
        /*
         * 令牌比对在**进任何库之前**：路由的存在本身已经是公开信息（OpenAPI 里有），
         * 但它背后的一切都不该在验完之前被碰一下。
         */
        const raw = c.req.header('Authorization')
        const given =
          raw === undefined ? '' : raw.startsWith('Bearer ') ? raw.slice('Bearer '.length) : raw
        if (!secretEquals(given.trim(), deps.token))
          throw new ApiError('unauthenticated', '管理员令牌不对')

        const input = await cloudBody(c, TopupBody)
        const handles = deps.wallet()
        if (handles === undefined)
          throw new ApiError('provider_unavailable', '这个节点没装钱包，发不了积分')

        const accounts = deps.accounts()
        let org_id = input.org_id
        if (org_id === undefined) {
          const email = (input.email ?? '').trim().toLowerCase()
          const account = accounts.accountByEmail(email)
          const org = account === undefined ? undefined : accounts.primaryOrg(account.id)
          // 找不到就说找不到：这条路由只有管理员调得动，不存在"泄露邮箱存不存在"的问题
          if (org === undefined)
            throw new ApiError('not_found', '这个邮箱还没登录过云账号——让他先在本地关联一次')
          org_id = org.id
        } else if (accounts.org(org_id) === undefined) {
          throw new ApiError('not_found', '没有这个组织')
        }

        const days = input.expires_in_days ?? DEFAULT_GRANT_DAYS
        const expires_at = new Date(
          Date.parse(deps.clock.now()) + days * 24 * 60 * 60 * 1000,
        ).toISOString()
        const lot = handles.wallet.topup({
          org_id,
          credits: input.credits,
          kind: 'granted',
          expires_at,
          ...(input.source_ref === undefined ? {} : { source_ref: input.source_ref }),
        })

        const request_id = newRequestId()
        handles.store.appendEvent(
          assertMeteringEvent({
            capability: ADMIN_TOPUP_CAPABILITY,
            unit: 'credit',
            quantity: input.credits,
            // 发额度不是花费：记成花费会让用量总数凭空多出一块（WP61 免费动作同一条）
            credits: 0,
            at: deps.clock.now(),
            org_id,
            // 手动充值不属于任何一个工作区——它是给整个组织的
            workspace_id: 'admin',
            request_id,
          }),
        )
        // 审计行：组织、积分、到期、请求号。没有令牌，邮箱只到域名
        log(
          `[admin] topup org=${org_id} credits=${String(input.credits)} expires=${expires_at.slice(0, 10)} req=${request_id}` +
            `${input.email === undefined ? '' : ` via=${emailDomain(input.email)}`}\n`,
        )
        return cloudOk(
          c,
          {
            org_id,
            credits: input.credits,
            kind: 'granted' as const,
            expires_at,
            lot_id: lot.id,
            request_id,
          },
          201,
        )
      },
    ),
  ]
}

/**
 * `GET /v1/admin/export`：账号与钱包的 JSON 快照（WP114）。
 *
 * 为什么要这条路由：两个部署形态的库长得完全不一样——Compose 形态是几个
 * sqlite 文件，Workers 形态是 Durable Object 里的库，**没有一个共同的"把文件
 * 拷过去"的动作**。搬家（Workers ↔ Compose）与"跑路"这两件事都靠这一份 JSON。
 *
 * 三条纪律：
 *
 * 1. 与充值那条**同一把钥匙、同一道闸**（admin token，定长比较，没配就不挂）；
 * 2. 里面**没有任何明文凭据**：令牌哈希在（不带它搬完家所有人都得重新关联一次），
 *    明文库里本来就没有；一次性登录与会话不导——让人重登一次比搬会话干净；
 * 3. 钱那一份是**积分批次**（lots），不是计量事件：事件是流水账，动辄几十万条，
 *    而且它不是"钱"——搬家要搬的是余额，不是历史。历史留在旧那一边。
 */
export interface AdminExportDeps {
  clock: Clock
  /** 明文管理员令牌（与充值那条同一把）。 */
  token: string
  /** 账号层的快照。 */
  accounts: () => { exportSnapshot(): CloudSnapshot }
  /**
   * 某个组织的积分批次。
   *
   * 写成**异步**是有意的：Compose 形态下钱包就在手边（同步的，包一层 Promise
   * 即可），Workers 形态下它在另一个 Durable Object 里，必须发一次请求。
   * 这里是导出，不是扣款——那条"钱的读写全同步"的纪律管的是 reserve / settle，
   * 不管一年跑一次的快照。
   */
  walletLots: (org_id: string) => Promise<WalletLot[]>
  log?: (line: string) => void
}

export function adminExportRoutes(deps: AdminExportDeps): CloudRoute[] {
  const log = deps.log ?? ((line: string) => process.stdout.write(line))
  return [
    cloudRoute(
      {
        method: 'get',
        path: '/v1/admin/export',
        operationId: 'cloudAdminExport',
        summary: '账号与钱包的 JSON 快照（跨部署形态搬家用）。只认 admin 令牌',
        tag: 'cloud-admin',
        auth: 'admin',
        returns: '{ at, accounts, orgs, members, links, wallets }',
      },
      async (c) => {
        const raw = c.req.header('Authorization')
        const given =
          raw === undefined ? '' : raw.startsWith('Bearer ') ? raw.slice('Bearer '.length) : raw
        if (!secretEquals(given.trim(), deps.token))
          throw new ApiError('unauthenticated', '管理员令牌不对')

        const snapshot = deps.accounts().exportSnapshot()
        const wallets: { org_id: string; lots: WalletLot[] }[] = []
        for (const org of snapshot.orgs)
          wallets.push({ org_id: org.id, lots: await deps.walletLots(org.id) })
        // 审计行：导了几个账号、几个组织。**没有邮箱、没有令牌、没有金额**
        log(
          `[admin] export accounts=${String(snapshot.accounts.length)} orgs=${String(snapshot.orgs.length)} at=${deps.clock.now()}\n`,
        )
        return cloudOk(c, { ...snapshot, wallets })
      },
    ),
  ]
}
