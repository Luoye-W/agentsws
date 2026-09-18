/**
 * 后台读账的两个口（65 §9 / docs/64）。
 *
 * ## 为什么需要一层口
 *
 * 两个形态的账**放在不同的地方**：
 *
 * | | Compose（自建） | Workers（官方托管） |
 * |---|---|---|
 * | 钱包 lots / 预扣 | `wallet.sqlite` 一张表 | 每个组织一个 `WalletDO` |
 * | 计量事件 | 同一张表 | 写在 `WalletDO`，**异步抄一份**到单例 `LedgerDO` |
 *
 * Workers 那一侧没有"跨全部组织的一张表"可查——DO 是按组织切开的，那正是它
 * 保住"钱的读写全同步"的原因。所以后台的总览 / 台账 / 亏本告警 / CSV **一律查
 * Ledger**（Compose 直接查钱包库，Workers 查那个只读副本），而余额与 lots 仍然
 * 按组织去问各自的 WalletDO。
 *
 * ## 为什么是异步口
 *
 * 钱的读写必须同步（`wallet.ts` 的头注释），但**读账不是**：后台那几页本来就
 * 要跨对象取数，异步是事实，藏不住。把它写成 Promise 也就顺手挡住了"有人拿
 * 这个口去扣钱"——它一条写钱的方法都没有。
 *
 * ## 副本的一致性
 *
 * `LedgerDO` 是**只增不改**的副本，幂等键是事件自己的 `event_id`。抄写走
 * `ctx.waitUntil`：**绝不阻塞也不回滚扣费**——抄失败的后果是看板少一行，
 * 扣费失败的后果是用户白用一次，两者不是一个量级。抄失败进本 DO 的待补队列，
 * 下一次 alarm 重投（重投是安全的，唯一索引挡住重复）。
 */

import type { MeteringEvent, WalletLot } from '@agentsws/contracts'
import type { SyncDb, SyncDbValue } from '@agentsws/core/sql/sync-db'
import {
  type BreakdownRow,
  breakdown,
  chargeHealth,
  dailyTrend,
  distinctValues,
  type GroupKey,
  type LedgerFilter,
  type LedgerRow,
  type LossSummary,
  ledger,
  lossAlert,
  type OrgUsage,
  type Totals,
  type TrendPoint,
  totals,
  usageByOrgs,
  type Window,
} from './admin-queries.js'

/**
 * 计量事件的**只读副本**那张表 + 待补队列。
 *
 * 与 `WALLET_MIGRATIONS` 里那张 `metering_events` 列一模一样，多两样：
 * - `event_id`：抄写的幂等键（`org_id|request_id|at|capability`，由源头算好带过来）；
 * - `ledger_outbox`：抄失败的那些行，alarm 时重投。**它在源头那一侧**（WalletDO），
 *   不在 Ledger 里——重投的责任属于写的那一方。
 */
export const LEDGER_MIGRATIONS = [
  {
    version: 1,
    sql: `
CREATE TABLE IF NOT EXISTS metering_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id      TEXT NOT NULL UNIQUE,
  capability    TEXT NOT NULL,
  unit          TEXT NOT NULL,
  quantity      REAL NOT NULL,
  credits       REAL NOT NULL,
  at            TEXT NOT NULL,
  org_id        TEXT NOT NULL,
  workspace_id  TEXT NOT NULL,
  request_id    TEXT NOT NULL,
  provider      TEXT,
  model         TEXT,
  input_tokens  REAL,
  output_tokens REAL,
  cost_micros   INTEGER,
  cost_currency TEXT,
  charge_status TEXT,
  account_id    TEXT
);

CREATE INDEX IF NOT EXISTS metering_events_org_at      ON metering_events (org_id, at);
CREATE INDEX IF NOT EXISTS metering_events_at          ON metering_events (at);
CREATE INDEX IF NOT EXISTS metering_events_provider_at ON metering_events (provider, at);
CREATE INDEX IF NOT EXISTS metering_events_cap_at      ON metering_events (capability, at);

-- 发放流水的副本：Workers 形态下后台要在一处看"谁被发过多少"，
-- 而 lots 本身在各自的 WalletDO 里。这一份同样只增不改。
CREATE TABLE IF NOT EXISTS ledger_lots (
  id         TEXT PRIMARY KEY NOT NULL,
  org_id     TEXT NOT NULL,
  kind       TEXT NOT NULL,
  credits    REAL NOT NULL,
  remaining  REAL NOT NULL,
  granted_at TEXT NOT NULL,
  expires_at TEXT,
  source_ref TEXT
);

CREATE INDEX IF NOT EXISTS ledger_lots_org  ON ledger_lots (org_id, granted_at);
CREATE INDEX IF NOT EXISTS ledger_lots_kind ON ledger_lots (kind, granted_at);
`,
  },
] as const

/** Ledger 自己的版本号表名——它与别的表挤在同一个 DO 的库里（WP114 那个坑）。 */
export const LEDGER_MIGRATIONS_TABLE = '_ledger_migrations'

/**
 * 一条事件的幂等键。
 *
 * **没有时间戳之外的任何变量**，也不含随机数：同一条事件被重投一百次算出来的
 * 都是同一串，唯一索引把后 99 次挡回来。`at` 进键是因为同一个 `request_id`
 * 在流式重试的场合可能出现两次——那真是两次调用，不该被去重掉。
 */
export const eventIdOf = (e: MeteringEvent): string =>
  `${e.org_id}|${e.request_id}|${e.at}|${e.capability}`

/** 后台读账的那一个口。**一条写钱的方法都没有。** */
export interface UsageLedger {
  totals(w: Window): Promise<Totals>
  dailyTrend(w: Window): Promise<TrendPoint[]>
  breakdown(group: GroupKey, w: Window, limit?: number): Promise<BreakdownRow[]>
  lossAlert(w: Window, top?: number): Promise<LossSummary>
  chargeHealth(w: Window): Promise<{ status: string; rows: number }[]>
  page(filter: LedgerFilter): Promise<{ rows: LedgerRow[]; total: number }>
  distinctValues(group: GroupKey): Promise<string[]>
  usageByOrgs(org_ids: string[], w: Window): Promise<Map<string, OrgUsage>>
  /** 最后一条计量事件是什么时候进来的（健康页那一格）。 */
  lastEventAt(): Promise<string | undefined>
  /** 未消耗积分（两类分开）。Compose 查钱包库，Workers 查发放流水副本。 */
  outstanding(now: string): Promise<{ granted: number; purchased: number }>
  /** 发放流水一页（谁在什么时候被发了多少）。 */
  grants(f: {
    org_id?: string | undefined
    limit?: number | undefined
    offset?: number | undefined
  }): Promise<{ rows: Record<string, unknown>[]; total: number }>
  /** 即将到期的 `granted`。 */
  expiring(now: string, before: string, limit?: number): Promise<Record<string, unknown>[]>
  /** 一批组织各自的余额（Workers 形态下这一份是**副本算出来的近似值**）。 */
  balances(
    org_ids: string[],
    now: string,
  ): Promise<Map<string, { granted: number; purchased: number; approximate: boolean }>>
  /** 这些组织里充过钱的那几个（"付费过"徽章）。 */
  paidOrgs(org_ids: string[]): Promise<Set<string>>
}

/** 钱那一侧的写与真值读。按组织问——Workers 形态下一个组织一个对象。 */
export interface WalletAdminPort {
  /** 这个组织的真实余额（抽屉里显示的是它，不是副本的近似值）。 */
  balance(org_id: string): Promise<{ granted: number; purchased: number }>
  lots(org_id: string): Promise<WalletLot[]>
  /** 发一笔积分（幂等：同一个 `source_ref` 只入一次）。 */
  grant(args: {
    org_id: string
    credits: number
    kind: 'granted' | 'purchased'
    expires_at?: string | undefined
    source_ref?: string | undefined
  }): Promise<{ lot_id: string }>
  /** 撤回一笔 `granted` 里还没被消耗的部分。 */
  revoke(args: {
    org_id: string
    lot_id: string
    reason: string
    actor_account_id: string
    at: string
  }): Promise<{ revoked: number } | undefined>
  /** 删号时把这个组织的钱与账匿名化（行留着、数还对，但指不回人）。 */
  anonymize(org_id: string, tombstone: string): Promise<number>
}

/* ------------------------------------------------------------------ */
/* Compose 形态：钱包库就是账本                                          */
/* ------------------------------------------------------------------ */

const LOT_FIELDS = 'id, org_id, kind, credits, remaining, granted_at, expires_at, source_ref'

/**
 * 直接查一张 SQL 库的 Ledger（Compose 形态的 `wallet.sqlite`，
 * 也是 Workers 形态里 `LedgerDO` 自己那张库的实现）。
 *
 * `lotsTable` 是因为两处的发放流水表名不同：Compose 就是 `wallet_lots`（真表），
 * Workers 的 Ledger 里是 `ledger_lots`（副本）。SQL 只写一遍，表名当参数。
 */
export function sqlUsageLedger(db: SyncDb, options: { lotsTable?: string } = {}): UsageLedger {
  const lots = options.lotsTable ?? 'wallet_lots'
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(lots)) throw new Error(`表名只能是标识符：${lots}`)
  // 副本那一份算出来的余额是近似值（remaining 只在抄写的那一刻是准的）
  const approximate = lots !== 'wallet_lots'
  return {
    totals: async (w) => totals(db, w),
    dailyTrend: async (w) => dailyTrend(db, w),
    breakdown: async (group, w, limit) => breakdown(db, group, w, limit),
    lossAlert: async (w, top) => lossAlert(db, w, top),
    chargeHealth: async (w) => chargeHealth(db, w),
    page: async (filter) => ledger(db, filter),
    distinctValues: async (group) => distinctValues(db, group),
    usageByOrgs: async (org_ids, w) => usageByOrgs(db, org_ids, w),

    async lastEventAt() {
      return (
        db.prepare<{ at: string | null }>('SELECT MAX(at) AS at FROM metering_events').get()?.at ??
        undefined
      )
    },

    async outstanding(now) {
      const rows = db
        .prepare<{ kind: string; credits: number }>(
          `SELECT kind, COALESCE(SUM(remaining), 0) AS credits FROM ${lots}
            WHERE remaining > 0 AND (expires_at IS NULL OR expires_at > ?)
            GROUP BY kind`,
        )
        .all(now)
      const pick = (k: string): number => rows.find((r) => r.kind === k)?.credits ?? 0
      return { granted: pick('granted'), purchased: pick('purchased') }
    },

    async grants(f) {
      const where = f.org_id === undefined || f.org_id === '' ? '' : ' AND org_id = ?'
      const params: SyncDbValue[] = f.org_id === undefined || f.org_id === '' ? [] : [f.org_id]
      const total =
        db
          .prepare<{ n: number }>(
            `SELECT COUNT(*) AS n FROM ${lots} WHERE kind = 'granted'${where}`,
          )
          .get(...params)?.n ?? 0
      const rows = db
        .prepare(
          `SELECT ${LOT_FIELDS} FROM ${lots} WHERE kind = 'granted'${where}
            ORDER BY granted_at DESC LIMIT ? OFFSET ?`,
        )
        .all(...params, Math.min(f.limit ?? 50, 500), f.offset ?? 0)
      return { rows, total }
    },

    async expiring(now, before, limit = 100) {
      return db
        .prepare(
          `SELECT ${LOT_FIELDS} FROM ${lots}
            WHERE remaining > 0 AND expires_at IS NOT NULL AND expires_at > ? AND expires_at <= ?
            ORDER BY expires_at LIMIT ?`,
        )
        .all(now, before, limit)
    },

    async balances(org_ids, now) {
      const out = new Map<string, { granted: number; purchased: number; approximate: boolean }>()
      if (org_ids.length === 0) return out
      const holes = org_ids.map(() => '?').join(', ')
      const rows = db
        .prepare<{ org_id: string; kind: string; credits: number }>(
          `SELECT org_id, kind, COALESCE(SUM(remaining), 0) AS credits FROM ${lots}
            WHERE org_id IN (${holes}) AND remaining > 0 AND (expires_at IS NULL OR expires_at > ?)
            GROUP BY org_id, kind`,
        )
        .all(...org_ids, now)
      for (const r of rows) {
        const cur = out.get(r.org_id) ?? { granted: 0, purchased: 0, approximate }
        if (r.kind === 'granted') cur.granted = r.credits
        else cur.purchased = r.credits
        out.set(r.org_id, cur)
      }
      return out
    },

    async paidOrgs(org_ids) {
      if (org_ids.length === 0) return new Set()
      const holes = org_ids.map(() => '?').join(', ')
      return new Set(
        db
          .prepare<{ org_id: string }>(
            `SELECT DISTINCT org_id FROM ${lots} WHERE kind = 'purchased' AND org_id IN (${holes})`,
          )
          .all(...org_ids)
          .map((r) => r.org_id),
      )
    },
  }
}

/** Ledger 那一侧的写：抄一条事件 / 抄一笔 lot。**只增不改，重投安全。** */
export interface LedgerWriter {
  /** 回 true = 这一条是新写进去的；false = 幂等键已经在了（重投）。 */
  copyEvent(event: MeteringEvent & { event_id?: string }): boolean
  /** lots 的副本按 id upsert（`remaining` 会变，所以这一张是"最后一次看到的样子"）。 */
  copyLot(lot: WalletLot): void
}

export function sqlLedgerWriter(db: SyncDb): LedgerWriter {
  const insertEvent = db.prepare(
    `INSERT OR IGNORE INTO metering_events
       (event_id, capability, unit, quantity, credits, at, org_id, workspace_id, request_id,
        provider, model, input_tokens, output_tokens, cost_micros, cost_currency,
        charge_status, account_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const upsertLot = db.prepare(
    `INSERT INTO ledger_lots (${LOT_FIELDS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET remaining = excluded.remaining`,
  )
  return {
    copyEvent(event) {
      const id = event.event_id ?? eventIdOf(event)
      const out = insertEvent.run(
        id,
        event.capability,
        event.unit,
        event.quantity,
        event.credits,
        event.at,
        event.org_id,
        event.workspace_id,
        event.request_id,
        event.provider ?? null,
        event.model ?? null,
        event.input_tokens ?? null,
        event.output_tokens ?? null,
        event.cost_micros ?? null,
        event.cost_currency ?? null,
        event.charge_status ?? null,
        event.account_id ?? null,
      )
      return out.changes > 0
    },
    copyLot(lot) {
      upsertLot.run(
        lot.id,
        lot.org_id,
        lot.kind,
        lot.credits,
        lot.remaining,
        lot.granted_at,
        lot.expires_at ?? null,
        lot.source_ref ?? null,
      )
    },
  }
}

/* ------------------------------------------------------------------ */
/* Compose 形态的钱那一侧：一张库就是全部组织                            */
/* ------------------------------------------------------------------ */

export interface SqlWalletAdminPortOptions {
  db: SyncDb
  /** 发积分走钱包自己的 `topup`（两类积分、幂等那几条规矩只写一遍）。 */
  wallet: {
    topup(args: {
      org_id: string
      credits: number
      kind: 'granted' | 'purchased'
      expires_at?: string | undefined
      source_ref?: string | undefined
    }): WalletLot
    balance(org_id: string): { granted: number; purchased: number }
  }
  /** 撤回时记那一条负向流水。 */
  appendEvent(e: MeteringEvent): void
}

/**
 * Compose 形态的 {@link WalletAdminPort}：一张 `wallet.sqlite` 装着全部组织。
 *
 * Workers 形态的那一份在 `apps/cloud-worker`（按组织打各自的 `WalletDO`）。
 * 两份的**签名一模一样**，所以后台那一层不知道自己在哪个形态里——这正是
 * 这个口存在的全部理由。
 */
export function sqlWalletAdminPort(options: SqlWalletAdminPortOptions): WalletAdminPort {
  const db = options.db
  return {
    async balance(org_id) {
      return options.wallet.balance(org_id)
    },

    async lots(org_id) {
      return db
        .prepare<{
          id: string
          org_id: string
          kind: string
          credits: number
          remaining: number
          granted_at: string
          expires_at: string | null
          source_ref: string | null
        }>(
          `SELECT ${LOT_FIELDS} FROM wallet_lots WHERE org_id = ? ORDER BY granted_at DESC LIMIT 200`,
        )
        .all(org_id)
        .map((r) => ({
          id: r.id,
          org_id: r.org_id,
          kind: r.kind === 'granted' ? ('granted' as const) : ('purchased' as const),
          credits: r.credits,
          remaining: r.remaining,
          granted_at: r.granted_at,
          ...(r.expires_at === null ? {} : { expires_at: r.expires_at }),
          ...(r.source_ref === null ? {} : { source_ref: r.source_ref }),
        }))
    },

    async grant(args) {
      return { lot_id: options.wallet.topup(args).id }
    },

    async revoke(args) {
      const lot = db
        .prepare<{ org_id: string; remaining: number }>(
          `SELECT org_id, remaining FROM wallet_lots WHERE id = ? AND kind = 'granted'`,
        )
        .get(args.lot_id)
      if (lot === undefined) return undefined
      const revoked = Math.max(0, lot.remaining)
      /*
       * 清零与那条负向流水在**同一个事务**里：分开做的话，中间崩一下就会
       * 出现"钱少了但账上查不到为什么"。
       */
      db.transaction(() => {
        if (revoked > 0)
          db.prepare('UPDATE wallet_lots SET remaining = 0 WHERE id = ?').run(args.lot_id)
        options.appendEvent({
          capability: 'admin.grant',
          unit: 'credit',
          quantity: -revoked,
          credits: 0,
          at: args.at,
          org_id: lot.org_id,
          workspace_id: 'admin',
          request_id: `revoke_${args.lot_id}`,
          charge_status: 'skipped',
          provider: 'internal',
          account_id: args.actor_account_id,
        })
      })
      return { revoked }
    },

    async anonymize(org_id, tombstone) {
      let changed = 0
      db.transaction(() => {
        changed += db
          .prepare(
            `UPDATE metering_events SET org_id = ?, workspace_id = 'deleted', account_id = NULL
              WHERE org_id = ?`,
          )
          .run(tombstone, org_id).changes
        changed += db
          .prepare('UPDATE wallet_lots SET org_id = ? WHERE org_id = ?')
          .run(tombstone, org_id).changes
        changed += db
          .prepare(
            `UPDATE wallet_reservations SET org_id = ?, workspace_id = 'deleted' WHERE org_id = ?`,
          )
          .run(tombstone, org_id).changes
      })
      return changed
    },
  }
}
