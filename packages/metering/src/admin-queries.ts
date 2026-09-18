/**
 * 后台看板的全部聚合（65 §9）。
 *
 * **一条纪律统领全篇：聚合在 SQL 里做，不把行拉进内存。** KOLAgents 的后台把
 * 全量 usage `SELECT *` 出来再在 Node 里 reduce——几万行的时候还行，几十万行的
 * 时候那一页要转八秒，而且它会把整张账本（含每一次调用的模型名）放进一个进程的
 * 堆里。这里每个函数都只回它自己那几行。
 *
 * 另一条：**这个文件只用 `prepare(sql).all/get/run` 这个同步子集**（{@link SqlDriver}），
 * 不用 better-sqlite3 的 `pragma` / `function` / `aggregate` / `backup`，聚合全用标准
 * SQLite SQL。WP114 正在把三处存储抽成一个同步的 SqlDriver 口（同一套 SQL 既跑
 * better-sqlite3 又跑 Cloudflare Durable Object SQLite），到时候这里换个类型就行。
 *
 * 口径三条，每个 KPI 都照它算：
 * - **收**：`SUM(credits)`，1 积分 = ¥1（49 M4），所以折成微元要 × 1_000_000。
 * - **支**：`SUM(COALESCE(cost_micros, 0))`。旧行没有这一列，当 0——那不是"未知"，
 *   是"那时候没记"，把它当未知会让近三十天的毛利里混进一段无法解释的空洞。
 * - **毛利** = 收 − 支，永远在**整数微元**上算，显示的时候才除。
 */

/** 一条预编译语句。参数与返回都刻意用 `unknown`——这一层不认识行的形状。 */
export interface SqlStatement {
  all(...params: unknown[]): unknown[]
  get(...params: unknown[]): unknown
  run(...params: unknown[]): { changes: number }
}

/** 同步的最小存储口。better-sqlite3 的 `Database` 直接满足它。 */
export interface SqlDriver {
  prepare(sql: string): SqlStatement
}

/** 1 积分 = ¥1 = 1_000_000 微元（49 M4）。SQL 里也用这个常数拼。 */
const MICROS_PER_CREDIT = 1_000_000

/**
 * 日期按 `Asia/Shanghai` 分桶，不按 UTC。
 *
 * 为什么：前期客户在中国，"9 月 15 日的消耗"指的是他们的 9 月 15 日。按 UTC 分
 * 会把每天早上八点前的调用算到前一天，于是日报永远对不上用户自己的感觉。
 * `+8 hours` 写死是有意的——`Asia/Shanghai` 1991 年之后没有夏令时。
 */
const DAY_EXPR = "substr(datetime(at, '+8 hours'), 1, 10)"

/** 聚合列那一串（每张表都一样，抽出来免得改口径时漏改一处）。 */
const AGG_COLUMNS = `
  COUNT(*)                                   AS calls,
  COALESCE(SUM(quantity), 0)                 AS quantity,
  COALESCE(SUM(credits), 0)                  AS credits,
  CAST(COALESCE(SUM(cost_micros), 0) AS INTEGER) AS cost_micros,
  CAST(COALESCE(SUM(input_tokens), 0) AS INTEGER)  AS input_tokens,
  CAST(COALESCE(SUM(output_tokens), 0) AS INTEGER) AS output_tokens
`

/** 不计入"用量"的那些能力：发额度不是花费（照 WP110 `admin.topup` 那条）。 */
export const NON_USAGE_CAPABILITIES: readonly string[] = ['admin.topup', 'admin.grant']

const NOT_ADMIN_TOPUP = `capability NOT IN ('admin.topup', 'admin.grant')`

/**
 * 管理员自己的调用**不进统计**（KefuAgent 那条）：自己测试把失败率顶到天上，
 * 看板从此没人信。`charge_status = 'admin_exempt'` 的行在所有聚合里都被滤掉。
 */
const NOT_EXEMPT = `COALESCE(charge_status, 'charged') <> 'admin_exempt'`

const BASE_WHERE = `at >= ? AND at <= ? AND ${NOT_ADMIN_TOPUP} AND ${NOT_EXEMPT}`

export interface Window {
  from: string
  to: string
}

export interface BreakdownRow {
  key: string
  calls: number
  quantity: number
  credits: number
  cost_micros: number
  input_tokens: number
  output_tokens: number
  margin_micros: number
}

interface RawAgg {
  key: string | null
  calls: number
  quantity: number
  credits: number
  cost_micros: number
  input_tokens: number
  output_tokens: number
}

const toBreakdown = (r: RawAgg, fallbackKey: string): BreakdownRow => ({
  key: r.key === null || r.key === '' ? fallbackKey : r.key,
  calls: r.calls,
  quantity: r.quantity,
  credits: r.credits,
  cost_micros: r.cost_micros,
  input_tokens: r.input_tokens,
  output_tokens: r.output_tokens,
  margin_micros: Math.round(r.credits * MICROS_PER_CREDIT) - r.cost_micros,
})

/**
 * 按某一列分组的通用聚合（能力 / 供应商 / 模型 / 组织）。
 *
 * `column` **不是**用户输入——它只能是下面 `GROUPABLE` 里那几个名字。SQL 里
 * 拼列名是一条真正的注入路径，所以这里做白名单而不是转义。
 */
export const GROUPABLE = {
  capability: 'capability',
  provider: 'provider',
  model: 'model',
  org: 'org_id',
  workspace: 'workspace_id',
} as const

export type GroupKey = keyof typeof GROUPABLE

export function breakdown(db: SqlDriver, group: GroupKey, w: Window, limit = 50): BreakdownRow[] {
  const column = GROUPABLE[group]
  const rows = db
    .prepare(
      `SELECT ${column} AS key, ${AGG_COLUMNS}
         FROM metering_events
        WHERE ${BASE_WHERE}
        GROUP BY ${column}
        ORDER BY credits DESC, calls DESC
        LIMIT ?`,
    )
    .all(w.from, w.to, limit) as RawAgg[]
  // key 为 null 的那些行是"记账时还不知道供应商"，显示成 `未知` 而不是悄悄丢掉
  return rows.map((r) => toBreakdown(r, 'unknown'))
}

export interface TrendPoint {
  day: string
  credits: number
  cost_micros: number
  calls: number
  input_tokens: number
  output_tokens: number
}

/** 日趋势。**窗口是参数**（7 / 30 / 90 可切）——KOLAgents 把 30 天写死在 SQL 里了。 */
export function dailyTrend(db: SqlDriver, w: Window): TrendPoint[] {
  return db
    .prepare(
      `SELECT ${DAY_EXPR} AS day,
              COUNT(*) AS calls,
              COALESCE(SUM(credits), 0) AS credits,
              CAST(COALESCE(SUM(cost_micros), 0) AS INTEGER) AS cost_micros,
              CAST(COALESCE(SUM(input_tokens), 0) AS INTEGER) AS input_tokens,
              CAST(COALESCE(SUM(output_tokens), 0) AS INTEGER) AS output_tokens
         FROM metering_events
        WHERE ${BASE_WHERE}
        GROUP BY day
        ORDER BY day`,
    )
    .all(w.from, w.to) as TrendPoint[]
}

export interface Totals {
  calls: number
  credits: number
  cost_micros: number
  input_tokens: number
  output_tokens: number
  orgs: number
}

/** 一个窗口里的总数（总览那几张 KPI 卡）。 */
export function totals(db: SqlDriver, w: Window): Totals {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS calls,
              COALESCE(SUM(credits), 0) AS credits,
              CAST(COALESCE(SUM(cost_micros), 0) AS INTEGER) AS cost_micros,
              CAST(COALESCE(SUM(input_tokens), 0) AS INTEGER) AS input_tokens,
              CAST(COALESCE(SUM(output_tokens), 0) AS INTEGER) AS output_tokens,
              COUNT(DISTINCT org_id) AS orgs
         FROM metering_events
        WHERE ${BASE_WHERE}`,
    )
    .get(w.from, w.to) as Totals | undefined
  return row ?? { calls: 0, credits: 0, cost_micros: 0, input_tokens: 0, output_tokens: 0, orgs: 0 }
}

/** 还没被消耗掉的积分（`granted` / `purchased` 分开；过期的不算）。 */
export function outstandingCredits(
  db: SqlDriver,
  now: string,
): { granted: number; purchased: number } {
  const rows = db
    .prepare(
      `SELECT kind, COALESCE(SUM(remaining), 0) AS credits
         FROM wallet_lots
        WHERE remaining > 0 AND (expires_at IS NULL OR expires_at > ?)
        GROUP BY kind`,
    )
    .all(now) as { kind: string; credits: number }[]
  const pick = (k: string): number => rows.find((r) => r.kind === k)?.credits ?? 0
  return { granted: pick('granted'), purchased: pick('purchased') }
}

export interface LossRow {
  capability: string
  model: string | null
  loss_micros: number
  at: string
}

export interface LossSummary {
  rows: number
  loss_micros: number
  worst_micros: number
  worst: LossRow[]
}

/**
 * 亏本告警：**收的比成本少**的那些行（KOLAgents 那条，照搬）。
 *
 * 免费的动作（`credits = 0` 且成本也 0）不算亏本——它们本来就是送的。
 * 真正要报的是"收了钱，但没覆盖成本"与"免费送出去了一次有成本的调用"。
 *
 * 0 行时前端**整张卡不渲染**：一张永远显示"一切正常"的卡，人三天之后就不看了。
 */
export function lossAlert(db: SqlDriver, w: Window, top = 5): LossSummary {
  const lossExpr = `(cost_micros - CAST(credits * ${String(MICROS_PER_CREDIT)} AS INTEGER))`
  const where = `${BASE_WHERE} AND cost_micros IS NOT NULL AND ${lossExpr} > 0`
  const summary = db
    .prepare(
      `SELECT COUNT(*) AS rows,
              CAST(COALESCE(SUM(${lossExpr}), 0) AS INTEGER) AS loss_micros,
              CAST(COALESCE(MAX(${lossExpr}), 0) AS INTEGER) AS worst_micros
         FROM metering_events WHERE ${where}`,
    )
    .get(w.from, w.to) as { rows: number; loss_micros: number; worst_micros: number } | undefined
  const worst = db
    .prepare(
      `SELECT capability, model, CAST(${lossExpr} AS INTEGER) AS loss_micros, at
         FROM metering_events WHERE ${where}
        ORDER BY loss_micros DESC LIMIT ?`,
    )
    .all(w.from, w.to, top) as LossRow[]
  return {
    rows: summary?.rows ?? 0,
    loss_micros: summary?.loss_micros ?? 0,
    worst_micros: summary?.worst_micros ?? 0,
    worst,
  }
}

/** 扣费健康：各 `charge_status` 多少条。`admin_exempt` 在这里**要**露出来。 */
export function chargeHealth(db: SqlDriver, w: Window): { status: string; rows: number }[] {
  return db
    .prepare(
      `SELECT COALESCE(charge_status, 'charged') AS status, COUNT(*) AS rows
         FROM metering_events
        WHERE at >= ? AND at <= ? AND ${NOT_ADMIN_TOPUP}
        GROUP BY status ORDER BY rows DESC`,
    )
    .all(w.from, w.to) as { status: string; rows: number }[]
}

/* ------------------------------------------------------------------ */
/* 用量台账（服务端分页 / 筛选 / 排序）                                  */
/* ------------------------------------------------------------------ */

export interface LedgerFilter {
  from?: string | undefined
  to?: string | undefined
  org_id?: string | undefined
  capability?: string | undefined
  provider?: string | undefined
  model?: string | undefined
  charge_status?: string | undefined
  /** 只看亏本的那些行。 */
  loss_only?: boolean | undefined
  limit?: number | undefined
  offset?: number | undefined
}

export interface LedgerRow {
  id: number
  at: string
  org_id: string
  workspace_id: string
  capability: string
  provider: string | null
  model: string | null
  unit: string
  quantity: number
  input_tokens: number | null
  output_tokens: number | null
  credits: number
  cost_micros: number | null
  cost_currency: string | null
  charge_status: string | null
  request_id: string
}

/** 条件拼装：**每一条都是占位符**，一个值都不往 SQL 串里拼。 */
function ledgerWhere(f: LedgerFilter): { sql: string; params: unknown[] } {
  const clauses: string[] = ['at >= ?', 'at <= ?']
  const params: unknown[] = [
    f.from ?? '0000-01-01T00:00:00.000Z',
    f.to ?? '9999-12-31T23:59:59.999Z',
  ]
  if (f.org_id !== undefined && f.org_id !== '') {
    clauses.push('org_id = ?')
    params.push(f.org_id)
  }
  if (f.capability !== undefined && f.capability !== '') {
    clauses.push('capability = ?')
    params.push(f.capability)
  }
  if (f.provider !== undefined && f.provider !== '') {
    clauses.push('provider = ?')
    params.push(f.provider)
  }
  if (f.model !== undefined && f.model !== '') {
    clauses.push('model = ?')
    params.push(f.model)
  }
  if (f.charge_status !== undefined && f.charge_status !== '') {
    clauses.push("COALESCE(charge_status, 'charged') = ?")
    params.push(f.charge_status)
  }
  if (f.loss_only === true)
    clauses.push(
      `cost_micros IS NOT NULL AND (cost_micros - CAST(credits * ${String(MICROS_PER_CREDIT)} AS INTEGER)) > 0`,
    )
  return { sql: clauses.join(' AND '), params }
}

/** 台账一页。**永远带 total**：没有总数的分页器只能一页一页点过去。 */
export function ledger(db: SqlDriver, f: LedgerFilter): { rows: LedgerRow[]; total: number } {
  const { sql, params } = ledgerWhere(f)
  const total = (
    db.prepare(`SELECT COUNT(*) AS n FROM metering_events WHERE ${sql}`).get(...params) as
      | { n: number }
      | undefined
  )?.n
  const rows = db
    .prepare(
      `SELECT rowid AS id, at, org_id, workspace_id, capability, provider, model, unit,
              quantity, input_tokens, output_tokens, credits, cost_micros, cost_currency,
              charge_status, request_id
         FROM metering_events WHERE ${sql}
        ORDER BY at DESC, rowid DESC
        LIMIT ? OFFSET ?`,
    )
    .all(...params, Math.min(f.limit ?? 50, 500), f.offset ?? 0) as LedgerRow[]
  return { rows, total: total ?? 0 }
}

/**
 * CSV 导出用的游标：**一批一批取**，不一次性 `all()`。
 *
 * 导出十万行不该让这个进程的堆里同时躺着十万个对象——上游那两个后台都是
 * 一次 `SELECT *` 然后 `map`，那正是它们在数据长起来之后变慢的地方。
 */
export function* ledgerBatches(
  db: SqlDriver,
  f: LedgerFilter,
  batchSize = 500,
): Generator<LedgerRow[]> {
  let offset = f.offset ?? 0
  for (;;) {
    const { rows } = ledger(db, { ...f, limit: batchSize, offset })
    if (rows.length === 0) return
    yield rows
    if (rows.length < batchSize) return
    offset += rows.length
  }
}

/** 台账筛选器里那几个下拉的取值（表里真出现过的，不是我们以为会有的）。 */
export function distinctValues(db: SqlDriver, group: GroupKey, limit = 100): string[] {
  const column = GROUPABLE[group]
  return (
    db
      .prepare(
        `SELECT DISTINCT ${column} AS v FROM metering_events
          WHERE ${column} IS NOT NULL AND ${column} <> '' ORDER BY v LIMIT ?`,
      )
      .all(limit) as { v: string }[]
  ).map((r) => r.v)
}

/* ------------------------------------------------------------------ */
/* 组织维度                                                             */
/* ------------------------------------------------------------------ */

export interface OrgUsage {
  org_id: string
  calls: number
  credits: number
  cost_micros: number
}

/** 一批组织在窗口里的用量（组织列表那一页用；**一次查完，不在循环里查**）。 */
export function usageByOrgs(db: SqlDriver, org_ids: string[], w: Window): Map<string, OrgUsage> {
  const out = new Map<string, OrgUsage>()
  if (org_ids.length === 0) return out
  // 占位符按数量生成——id 是我们自己库里出来的，但拼进 SQL 的永远只能是 `?`
  const holes = org_ids.map(() => '?').join(', ')
  const rows = db
    .prepare(
      `SELECT org_id, COUNT(*) AS calls, COALESCE(SUM(credits), 0) AS credits,
              CAST(COALESCE(SUM(cost_micros), 0) AS INTEGER) AS cost_micros
         FROM metering_events
        WHERE org_id IN (${holes}) AND ${BASE_WHERE}
        GROUP BY org_id`,
    )
    .all(...org_ids, w.from, w.to) as OrgUsage[]
  for (const r of rows) out.set(r.org_id, r)
  return out
}

/** 一批组织的余额（两类分开）。同上：一次查完。 */
export function balancesByOrgs(
  db: SqlDriver,
  org_ids: string[],
  now: string,
): Map<string, { granted: number; purchased: number }> {
  const out = new Map<string, { granted: number; purchased: number }>()
  if (org_ids.length === 0) return out
  const holes = org_ids.map(() => '?').join(', ')
  const rows = db
    .prepare(
      `SELECT org_id, kind, COALESCE(SUM(remaining), 0) AS credits
         FROM wallet_lots
        WHERE org_id IN (${holes}) AND remaining > 0 AND (expires_at IS NULL OR expires_at > ?)
        GROUP BY org_id, kind`,
    )
    .all(...org_ids, now) as { org_id: string; kind: string; credits: number }[]
  for (const r of rows) {
    const cur = out.get(r.org_id) ?? { granted: 0, purchased: 0 }
    if (r.kind === 'granted') cur.granted = r.credits
    else cur.purchased = r.credits
    out.set(r.org_id, cur)
  }
  return out
}

/** 这个组织充过钱没有（"付费过"那个徽章）。 */
export function paidOrgIds(db: SqlDriver, org_ids: string[]): Set<string> {
  if (org_ids.length === 0) return new Set()
  const holes = org_ids.map(() => '?').join(', ')
  return new Set(
    (
      db
        .prepare(
          `SELECT DISTINCT org_id FROM wallet_lots
            WHERE kind = 'purchased' AND org_id IN (${holes})`,
        )
        .all(...org_ids) as { org_id: string }[]
    ).map((r) => r.org_id),
  )
}

/** 一个组织的全部 lot（组织抽屉里那张"钱包 lots"）。 */
export function lotsOfOrg(db: SqlDriver, org_id: string, limit = 200): unknown[] {
  return db
    .prepare(
      `SELECT id, kind, credits, remaining, granted_at, expires_at, source_ref
         FROM wallet_lots WHERE org_id = ? ORDER BY granted_at DESC LIMIT ?`,
    )
    .all(org_id, limit)
}

/** 即将到期的 `granted`（积分与会员那一页的第三块）。 */
export function expiringSoon(db: SqlDriver, now: string, before: string, limit = 100): unknown[] {
  return db
    .prepare(
      `SELECT id, org_id, kind, remaining, granted_at, expires_at, source_ref
         FROM wallet_lots
        WHERE remaining > 0 AND expires_at IS NOT NULL AND expires_at > ? AND expires_at <= ?
        ORDER BY expires_at LIMIT ?`,
    )
    .all(now, before, limit)
}

/** 发放流水：所有 `granted` 的 lot（谁在什么时候被发了多少）。 */
export function grantLedger(
  db: SqlDriver,
  f: { org_id?: string | undefined; limit?: number | undefined; offset?: number | undefined },
): { rows: unknown[]; total: number } {
  const where = f.org_id === undefined || f.org_id === '' ? '' : ' AND org_id = ?'
  const params = f.org_id === undefined || f.org_id === '' ? [] : [f.org_id]
  const total = (
    db
      .prepare(`SELECT COUNT(*) AS n FROM wallet_lots WHERE kind = 'granted'${where}`)
      .get(...params) as { n: number } | undefined
  )?.n
  const rows = db
    .prepare(
      `SELECT id, org_id, credits, remaining, granted_at, expires_at, source_ref
         FROM wallet_lots WHERE kind = 'granted'${where}
        ORDER BY granted_at DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, Math.min(f.limit ?? 50, 500), f.offset ?? 0)
  return { rows, total: total ?? 0 }
}

/**
 * 撤回一笔已发放积分里**还没被消耗**的部分。
 *
 * 两个旧后台都没有这个动作——发错了只能再发一笔负的，而钱包里没有负的 lot。
 * 这里的做法是把这一个 lot 的 `remaining` 清零并回报清掉了多少，调用方据此
 * 记一条审计与一条负向流水。**已经花掉的那部分不追**：那笔调用真的发生过。
 */
export function revokeRemaining(db: SqlDriver, lot_id: string): { revoked: number } | undefined {
  const lot = db
    .prepare(
      `SELECT id, org_id, kind, credits, remaining FROM wallet_lots WHERE id = ? AND kind = 'granted'`,
    )
    .get(lot_id) as { remaining: number } | undefined
  if (lot === undefined) return undefined
  if (lot.remaining <= 0) return { revoked: 0 }
  db.prepare('UPDATE wallet_lots SET remaining = 0 WHERE id = ?').run(lot_id)
  return { revoked: lot.remaining }
}

/**
 * 删号之后把这个组织的钱与账**匿名化**，而不是删掉（65 §5）。
 *
 * 删掉的后果是历史收入随着删号一起缩水，而那一块钱是真收过的。所以把
 * `org_id` / `workspace_id` / `account_id` 换成一个墓碑 id，行还在、数还对，
 * 但再也指不回任何一个人。
 */
export function anonymizeOrg(db: SqlDriver, org_id: string, tombstone: string): number {
  const a = db
    .prepare(
      `UPDATE metering_events SET org_id = ?, workspace_id = 'deleted', account_id = NULL
        WHERE org_id = ?`,
    )
    .run(tombstone, org_id).changes
  const b = db
    .prepare('UPDATE wallet_lots SET org_id = ? WHERE org_id = ?')
    .run(tombstone, org_id).changes
  const c = db
    .prepare(`UPDATE wallet_reservations SET org_id = ?, workspace_id = 'deleted' WHERE org_id = ?`)
    .run(tombstone, org_id).changes
  return a + b + c
}
