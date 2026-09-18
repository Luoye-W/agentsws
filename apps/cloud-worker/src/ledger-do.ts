/**
 * `LedgerDO` —— 计量事件的**只读副本**（单例，WP115 / 65 §9）。
 *
 * ## 为什么需要它
 *
 * Workers 形态把钱按组织切开（`WalletDO(org_id)`）——那正是"钱的读写全同步"
 * 这条纪律在云上还成立的原因。代价是：**没有一张跨全部组织的表**。而后台的
 * 总览、用量台账、亏本告警、CSV 导出问的全是"所有组织加起来怎么样"。
 *
 * 一万个组织挨个问一遍是不可能的（一次总览要一万次 DO 调用）。所以另开一个
 * 单例对象，**每条计量事件抄一份进来**，后台只读这一份。
 *
 * ## 三条纪律
 *
 * 1. **只增不改**。这里没有 UPDATE 计量事件的路由，也没有 DELETE。幂等键是
 *    事件自己的 `event_id`（由 `(org, request, at, capability)` 推出来），
 *    唯一索引把重投挡回来——所以"重投一百次"是安全的。
 * 2. **抄写绝不阻塞、绝不回滚扣费**。源头那一侧走 `ctx.waitUntil`：抄失败的
 *    后果是看板少一行，扣费失败的后果是用户白用一次，两者不是一个量级。
 *    失败的行进源头 DO 的待补队列，下一次 alarm 重投。
 * 3. **它不是账本的真源**。钱的真源永远是各自的 `WalletDO`；这一份是给人看的。
 *    所以后台抽屉里的余额与 lots 问的是真源，只有列表页与看板读副本（并标注）。
 *
 * ## `ledger_lots` 那一张
 *
 * 发放流水（"谁在什么时候被发了多少"）在 Workers 形态下也散在各 WalletDO 里，
 * 所以同样抄一份。它是 upsert（`remaining` 会变），因此**算出来的余额是近似值**——
 * 接口上有 `approximate: true`，界面上有一句话，不假装它是真值。
 */

import { migrate } from '@agentsws/api'
import type { MeteringEvent, WalletLot } from '@agentsws/contracts'
import {
  eventIdOf,
  LEDGER_MIGRATIONS,
  LEDGER_MIGRATIONS_TABLE,
  type LedgerWriter,
  sqlLedgerWriter,
  sqlUsageLedger,
  type UsageLedger,
} from '@agentsws/metering'
import { type DoStorageLike, doSyncDb } from './do-sql.js'

/** 单例 `LedgerDO` 的名字。只有这一个名字，所以只有这一个对象。 */
export const LEDGER_SINGLETON = 'ledger'

/** Ledger 的内部路由前缀（只有 Worker 与两个 DO 打得到——它在公网上没有地址）。 */
export const LEDGER_INTERNAL = {
  /** 抄一批事件进来。 */
  events: '/__internal/ledger/events',
  /** 抄一批 lot 进来。 */
  lots: '/__internal/ledger/lots',
  /** 后台的读账查询（方法名 + 参数，回 JSON）。 */
  query: '/__internal/ledger/query',
} as const

/** 一次抄写最多几条。批量是为了让 `waitUntil` 那一跳少一点。 */
export const LEDGER_COPY_BATCH = 100

export class LedgerCore {
  readonly book: UsageLedger
  readonly writer: LedgerWriter

  constructor(state: { storage: DoStorageLike }, options: { now?: () => string } = {}) {
    const db = doSyncDb(state.storage)
    const now = options.now ?? (() => new Date().toISOString())
    /*
     * 迁移在第一次唤醒时跑完（同步）。版本号表另起一个名字——这个对象里
     * 将来还可能住别的表，都叫 `_migrations` 的话先跑完的那个会让后跑的
     * 以为自己也跑过了（WP114 踩过的那个坑）。
     */
    migrate(db, [...LEDGER_MIGRATIONS], now(), { table: LEDGER_MIGRATIONS_TABLE })
    // 副本里发放流水那张表叫 `ledger_lots`，所以余额是近似值（`approximate: true`）
    this.book = sqlUsageLedger(db, { lotsTable: 'ledger_lots' })
    this.writer = sqlLedgerWriter(db)
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === LEDGER_INTERNAL.events && request.method === 'POST') {
      const events = (await request.json()) as (MeteringEvent & { event_id?: string })[]
      let copied = 0
      for (const e of events) if (this.writer.copyEvent(e)) copied += 1
      // `copied < events.length` 不是错：那是重投撞上了唯一索引，正是我们要的
      return Response.json({ received: events.length, copied })
    }

    if (url.pathname === LEDGER_INTERNAL.lots && request.method === 'POST') {
      const lots = (await request.json()) as WalletLot[]
      for (const lot of lots) this.writer.copyLot(lot)
      return Response.json({ received: lots.length })
    }

    if (url.pathname === LEDGER_INTERNAL.query && request.method === 'POST') {
      const { method, args } = (await request.json()) as { method: string; args: unknown[] }
      return this.#query(method, args)
    }

    return new Response('null', { status: 404, headers: { 'content-type': 'application/json' } })
  }

  /**
   * 后台那几个读查询。
   *
   * **白名单派发**：`method` 是外面（其实是 AccountsDO）给的字符串，直接
   * `this.book[method]` 会让"随便调一个方法"变成可能。这里一条一条列出来。
   */
  async #query(method: string, args: unknown[]): Promise<Response> {
    const book = this.book
    /*
     * 参数原样转发。**不校验形状**是有意的：这条路只有 `AccountsDO` 打得到
     * （DO 在公网上没有地址，入口 Worker 对 `/__internal/` 一律 404），而那一头
     * 传过来的就是 `UsageLedger` 的签名。真要校验，得把那十四个签名抄一遍，
     * 而抄一遍就意味着两处会漂。
     */
    /*
     * `null` 还原成 `undefined`。
     *
     * JSON 没有 `undefined`：`JSON.stringify(['x', w, undefined])` 出来的是
     * `["x",{…},null]`。不还原的话 `limit` 会变成 `null`，默认参数不生效，
     * `LIMIT NULL` 当场 SQLITE_MISMATCH——这一条是真踩出来的。
     */
    // biome-ignore lint/suspicious/noExplicitAny: 内部 RPC 的参数就是上面那个口的签名
    const a = args.map((v) => (v === null ? undefined : v)) as any[]
    switch (method) {
      case 'totals':
        return Response.json(await book.totals(a[0]))
      case 'dailyTrend':
        return Response.json(await book.dailyTrend(a[0]))
      case 'breakdown':
        return Response.json(await book.breakdown(a[0], a[1], a[2]))
      case 'lossAlert':
        return Response.json(await book.lossAlert(a[0], a[1]))
      case 'chargeHealth':
        return Response.json(await book.chargeHealth(a[0]))
      case 'page':
        return Response.json(await book.page(a[0]))
      case 'distinctValues':
        return Response.json(await book.distinctValues(a[0]))
      case 'usageByOrgs':
        // Map 过不了 JSON——转成数组对，调用方那一头再拼回来
        return Response.json([...(await book.usageByOrgs(a[0], a[1]))])
      case 'lastEventAt':
        return Response.json((await book.lastEventAt()) ?? null)
      case 'outstanding':
        return Response.json(await book.outstanding(a[0]))
      case 'grants':
        return Response.json(await book.grants(a[0]))
      case 'expiring':
        return Response.json(await book.expiring(a[0], a[1], a[2]))
      case 'balances':
        return Response.json([...(await book.balances(a[0], a[1]))])
      case 'paidOrgs':
        return Response.json([...(await book.paidOrgs(a[0]))])
      default:
        return new Response(JSON.stringify({ code: 'not_found', message: `没有 ${method}` }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        })
    }
  }
}

/** 打 `LedgerDO` 的那一跳（把它包成 {@link UsageLedger}，后台那一层看不出区别）。 */
export function remoteUsageLedger(
  stub: { fetch(request: Request): Promise<Response> },
  origin = 'https://do.internal',
): UsageLedger {
  const call = async <T>(method: string, args: unknown[], fallback: T): Promise<T> => {
    const res = await stub.fetch(
      new Request(`${origin}${LEDGER_INTERNAL.query}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ method, args }),
      }),
    )
    /*
     * 读不到就回**空**，不抛。后台少一张表比整页 500 好——而且这一层读的是
     * 副本，副本挂了不代表钱出了问题，那句话要由健康页去说，不是由一个 500。
     */
    if (!res.ok) return fallback
    return (await res.json()) as T
  }
  return {
    totals: (w) =>
      call('totals', [w], {
        calls: 0,
        credits: 0,
        cost_micros: 0,
        input_tokens: 0,
        output_tokens: 0,
        orgs: 0,
      }),
    dailyTrend: (w) => call('dailyTrend', [w], []),
    breakdown: (group, w, limit) => call('breakdown', [group, w, limit], []),
    lossAlert: (w, top) =>
      call('lossAlert', [w, top], { rows: 0, loss_micros: 0, worst_micros: 0, worst: [] }),
    chargeHealth: (w) => call('chargeHealth', [w], []),
    page: (filter) => call('page', [filter], { rows: [], total: 0 }),
    distinctValues: (group) => call('distinctValues', [group], []),
    usageByOrgs: async (ids, w) =>
      new Map(await call<[string, never][]>('usageByOrgs', [ids, w], [])),
    lastEventAt: async () => (await call<string | null>('lastEventAt', [], null)) ?? undefined,
    outstanding: (now) => call('outstanding', [now], { granted: 0, purchased: 0 }),
    grants: (f) => call('grants', [f], { rows: [], total: 0 }),
    expiring: (now, before, limit) => call('expiring', [now, before, limit], []),
    balances: async (ids, now) =>
      new Map(await call<[string, never][]>('balances', [ids, now], [])),
    paidOrgs: async (ids) => new Set(await call<string[]>('paidOrgs', [ids], [])),
  }
}

/** 把一批事件抄给 Ledger。回 false = 没抄成（调用方把它们塞进待补队列）。 */
export async function copyEventsTo(
  stub: { fetch(request: Request): Promise<Response> },
  events: MeteringEvent[],
  origin = 'https://do.internal',
): Promise<boolean> {
  if (events.length === 0) return true
  try {
    const res = await stub.fetch(
      new Request(`${origin}${LEDGER_INTERNAL.events}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(events.map((e) => ({ ...e, event_id: eventIdOf(e) }))),
      }),
    )
    return res.ok
  } catch {
    return false
  }
}

/** 把一批 lot 抄给 Ledger（发放流水的副本）。 */
export async function copyLotsTo(
  stub: { fetch(request: Request): Promise<Response> },
  lots: WalletLot[],
  origin = 'https://do.internal',
): Promise<boolean> {
  if (lots.length === 0) return true
  try {
    const res = await stub.fetch(
      new Request(`${origin}${LEDGER_INTERNAL.lots}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(lots),
      }),
    )
    return res.ok
  } catch {
    return false
  }
}
