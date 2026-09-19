/**
 * `KolTenantDO` —— 红人营销增值服务的**租户对象**，每个组织一个（WP118 / 67 §3）。
 *
 * 与 `KolPublicDO`（全局一个）刚好相反，理由也刚好相反：公共红人库是**跨租户
 * 共享的一层事实**，按组织切开就没有价值；这一份是**一个组织自己的数据**，
 * 不按组织切开就等于把所有人的红人库堆在一张表里，靠一列 `org_id` 和"别忘了
 * 加 where"来隔离。对象边界就是隔离边界——这是 DO 给的东西里最值钱的一样。
 *
 * 钱**不在这里**（与 WP116 同一条）：月费由这个对象打一条内部路由去
 * `WalletDO(org_id)`，那一侧同步做完预扣 + 结算再回一个"成了 / 没钱"。
 * 所以这个对象上没有一行碰余额的代码。
 *
 * **alarm 干一件事**：每天醒一次，把到点的月费扣掉（`runBilling` 幂等，
 * 重跑十遍也只扣一次）。为什么是每天而不是"到了 cycle 边界那一刻"：机器可能
 * 正好那会儿没醒着，而补扣本来就要支持（引擎会一次把落下的几期都算出来）。
 * 每天一次的代价是一次无事可做的唤醒，换来的是"不会漏一整个月"。
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import type { Clock, VerifiedCloudToken } from '@agentsws/contracts'
import {
  type KolCloudEnv,
  KolCloudService,
  KolCloudStore,
  mountKolCloudRoutes,
  type SubscriptionWallet,
} from '@agentsws/kol-cloud'
import { Hono } from 'hono'
import type { DoStorageLike } from './do-sql.js'
import { doSyncDb } from './do-sql.js'
import type { DoNamespaceLike, WorkerEnv } from './env.js'
import { principalFrom } from './internal.js'
import { remoteSubscriptionWallet } from './subscription-wallet.js'

/** 每天醒一次去扣该扣的（幂等，所以醒早醒晚都不会多扣）。 */
export const BILLING_SWEEP_MS = 24 * 60 * 60 * 1000

/** 这一次请求的 principal（与 `wallet-do.ts` 里那一个同样的理由用 ALS）。 */
const PRINCIPAL = new AsyncLocalStorage<VerifiedCloudToken>()

export interface KolTenantDoStateLike {
  readonly storage: DoStorageLike & {
    setAlarm(when: number): Promise<void> | void
    getAlarm(): Promise<number | null> | number | null
  }
}

export interface KolTenantDoOptions {
  clock?: Clock
  /** 测试注入：假的钱包（不起第二个 DO）。 */
  wallet?: SubscriptionWallet
}

export class KolTenantCore {
  readonly store: KolCloudStore
  readonly service: KolCloudService
  readonly #state: KolTenantDoStateLike
  readonly #app: Hono<KolCloudEnv>
  readonly #clock: Clock

  constructor(state: KolTenantDoStateLike, env: WorkerEnv, options: KolTenantDoOptions = {}) {
    this.#state = state
    this.#clock = options.clock ?? { now: () => new Date().toISOString() }
    /*
     * 迁移在第一次唤醒时同步跑完（`KolCloudStore` 的构造函数里就是一串
     * `CREATE TABLE IF NOT EXISTS`）。升级 = 再 deploy 一次，见 docs/64 §8。
     */
    this.store = new KolCloudStore(doSyncDb(state.storage))
    this.service = new KolCloudService({
      store: this.store,
      wallet: options.wallet ?? walletOf(env),
      now: () => this.#clock.now(),
    })

    /*
     * 令牌在这里不验第二遍：入口已经问过 `AccountsDO`（每次都问）。
     * 这个对象只信来自入口的调用——它在公网上没有地址。
     */
    const app = new Hono<KolCloudEnv>()
    mountKolCloudRoutes(app, {
      // 这个对象就是一个组织的全部：选哪一份服务没有第二种可能
      serviceOf: () => this.service,
      // eslint-disable-next-line @typescript-eslint/require-await -- 口子是异步的（Compose 形态要查库）
      verifier: async () => PRINCIPAL.getStore(),
    })
    this.#app = app
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    // 后台那两条（订阅一览 / 赠送月份）走内部路由，不进对外的路由表
    const adminRes = this.#handleAdmin(request, url)
    if (adminRes !== undefined) return adminRes

    const principal = principalFrom(request)
    if (principal !== undefined)
      // 记在**库里**，不是内存：闹钟可能在一个刚醒来、内存空空的对象上响
      this.store.setOwner({ org_id: principal.org_id, workspace_id: principal.workspace_id })
    const run = async (): Promise<Response> => {
      const res = await this.#app.fetch(request)
      await this.#armAlarm()
      return res
    }
    return principal === undefined ? run() : PRINCIPAL.run(principal, run)
  }

  /**
   * 每天醒一次扣该扣的。
   *
   * 扣不上**不重排**成更短的间隔：用户这会儿没钱，一小时后大概率还是没钱，
   * 而每小时失败一次会把审计表塞满。宽限期是 30 天，每天试一次足够了。
   */
  async alarm(): Promise<{ charged: number }> {
    const who = this.store.owner()
    if (who === undefined) {
      // 还不知道自己是谁（对象刚建起来就被叫醒）：下次再说
      await this.#armAlarm(true)
      return { charged: 0 }
    }
    const charges = await this.service.runBilling(who)
    await this.#armAlarm(true)
    return { charged: charges.filter((c) => c.status === 'paid').length }
  }

  /** 排一次闹钟。已经排过的不动（`force` 是 alarm 自己续的那一次）。 */
  async #armAlarm(force = false): Promise<void> {
    if (!force) {
      const current = await this.#state.storage.getAlarm()
      if (current !== null && current !== undefined) return
    }
    await this.#state.storage.setAlarm(Date.parse(this.#clock.now()) + BILLING_SWEEP_MS)
  }

  /** 运营后台那两条（在 `AccountsDO` 那边按组织逐个来问）。 */
  #handleAdmin(request: Request, url: URL): Response | undefined {
    if (url.pathname === KOL_TENANT_INTERNAL.summary) {
      const org_id = url.searchParams.get('org') ?? ''
      const sub = this.service.subscription(org_id)
      return Response.json({
        subscription: { ...sub, status: this.service.liveStatus(org_id) },
        object_count: this.store.count(),
        pending_conflicts: this.store.openConflictCount(),
        last_sync_at: this.store.lastSyncAt(sub.service_id) ?? null,
        charges: this.store.charges(12),
      })
    }
    if (url.pathname === KOL_TENANT_INTERNAL.grant && request.method === 'POST') {
      const org_id = url.searchParams.get('org') ?? ''
      const months = Number(url.searchParams.get('months') ?? '0')
      if (org_id === '' || !Number.isInteger(months) || months < 1)
        return Response.json({ error: '赠送月数要是 1 以上的整数' }, { status: 400 })
      /*
       * 后台赠送可能发生在这个组织**还没来过一次请求**的时候（先赠送、再让用户
       * 去开通）。那时库里还不知道自己是谁，而闹钟一响就要扣费——所以在这里
       * 把归属补上。工作区填 `system`：赠送那几期是 0 积分，不会产生计量事件；
       * 真有要扣钱的那一天，用户自己来过一次，这一格早就被真的工作区号盖掉了。
       */
      if (this.store.owner() === undefined)
        this.store.setOwner({ org_id, workspace_id: 'system' })
      return Response.json(this.service.grantMonths(org_id, months))
    }
    return undefined
  }
}

/** 租户对象的内部路由名。 */
export const KOL_TENANT_INTERNAL = {
  /** 后台抽屉那一块（订阅状态、云端对象数、最近同步、最近几笔扣费）。 */
  summary: '/__internal/kol/tenant/summary',
  /** 后台赠送 N 个月。 */
  grant: '/__internal/kol/tenant/grant',
} as const

/**
 * 钱那一跳：打这个组织的 `WalletDO`。
 *
 * 没绑 `WALLET` 就回一个**永远扣不上**的钱包（而不是"永远扣得上"）：装配缺了
 * 一半的时候，宁可让订阅停在宽限里，也不能白给服务。
 */
function walletOf(env: WorkerEnv): SubscriptionWallet {
  return {
    async charge(args) {
      const ns = env.WALLET as DoNamespaceLike | undefined
      if (ns === undefined)
        return { ok: false, reason: '这台机器上还没接钱包，这一次没扣成（钱一分没动）。' }
      return remoteSubscriptionWallet({
        wallet: ns.get(ns.idFromName(args.org_id)),
        origin: env.AGENTSWS_CLOUD_BASE_URL ?? 'https://cloud.agentsws.com',
      }).charge(args)
    },
  }
}
