/**
 * WP392（docs/104 §3.2 / §3.3）：竞品监控的**同一条管道**——同步监控源 → 到点 → 进料口读一次 → 和上一次快照比 → 入库。
 *
 * - 进料口适配器（`CompetitorIntakeAdapter`）每种来源一个：独立站 WP393、Amazon WP394。本单只有管道和接口；
 *   某类来源还没接上 = 那几条源照实标「还没接上」，不算失败、不显示成 0；
 * - 调度照 `reddit-watch`：一小时一拍、到点才读（`due.ts`）；新加的源马上读一次当底子；失败隔一小时再试；
 * - 自家的源（C8）先读，竞品那几条比价时就用得上自家的新价；
 * - 只读外部公开页面，不改用户任何外部账号，所以没有审批卡（docs/104 §3.4 第 5 条）；
 * - 一轮只跑一个；再要一轮就等那一轮（「立即读」也一样）。
 */
import {
  type BrandWatch,
  type CatalogReadResult,
  type CatalogSnapshotRow,
  type CompetitorChange,
  type CompetitorChangeQuery,
  type CompetitorIntakeAdapter,
  type CompetitorSourceKind,
  type CompetitorWatchRun,
  type CompetitorWatchRunPart,
  type CompetitorWatchSettings,
  type CompetitorWatchSource,
  type CompetitorWatchStore,
  type CompetitorWatchSummary,
  type CompetitorWatchView,
  type Iso8601,
  OWN_BRAND_COMPETITOR_ID,
  type WorkspaceId,
} from '@agentsws/contracts'
import { diffCatalog, type OwnRef } from '@agentsws/social-core'
import { dueSources, nextReadAt } from './due.js'
import { syncSources, wantedSources } from './sources.js'

export interface CompetitorWatchDeps {
  workspace_id: WorkspaceId
  store: CompetitorWatchStore
  now(): Iso8601
  newId(prefix: string): string
  tzOffsetMinutes(): number
  /** 唯一工作清单（GEO 关注设置那份；没有 = 还没设）。 */
  brandWatch(): Promise<Pick<BrandWatch, 'brand' | 'competitors'> | undefined>
  /** 这台机器接上了哪几种进料口（懒取：WP393 / WP394 装上才有）。 */
  adapters(): Partial<Record<CompetitorSourceKind, CompetitorIntakeAdapter>>
  /** 一轮跑完（简报 / 推送二期接这里）。 */
  onRun?(run: CompetitorWatchRun, changes: readonly CompetitorChange[]): void
}

export interface CompetitorWatchAssembly {
  readonly workspace_id: WorkspaceId
  /** 按关注设置同步监控源（读之前都会先同步一次）。 */
  sync(): Promise<CompetitorWatchSource[]>
  /** 定时那一拍：到点的才读。 */
  tick(): Promise<{ ran: boolean; run_id?: string; skipped?: string }>
  /** 现在读一次（不给 = 全部；正在跑的那一轮没结束就等它）。 */
  runNow(options?: {
    source_ids?: string[]
    trigger?: CompetitorWatchRun['trigger']
  }): Promise<CompetitorWatchRun>
  view(): Promise<CompetitorWatchView>
  changes(query?: CompetitorChangeQuery): CompetitorChange[]
  sources(): CompetitorWatchSource[]
  runs(limit?: number): CompetitorWatchRun[]
  settings(): CompetitorWatchSettings
  updateSettings(patch: Partial<CompetitorWatchSettings>): CompetitorWatchSettings
}

/** 一条源一行人话（失败那句；不提任何数据供应商名）。 */
const failText = (label: string, e: unknown): string => {
  const why = e instanceof Error ? e.message : String(e)
  return `${label} 这次没读到：${why}`.slice(0, 300)
}

const clampInt = (v: unknown, lo: number, hi: number): number | undefined =>
  typeof v === 'number' && Number.isFinite(v)
    ? Math.max(lo, Math.min(hi, Math.round(v)))
    : undefined

export function createCompetitorWatch(deps: CompetitorWatchDeps): CompetitorWatchAssembly {
  const { store } = deps
  let running: Promise<CompetitorWatchRun> | undefined

  const sync = async (): Promise<CompetitorWatchSource[]> => {
    const watch = await deps.brandWatch()
    if (watch === undefined) return store.sources()
    const settings = store.settings()
    const plan = syncSources(
      store.sources(),
      wantedSources(watch, { workspace_id: deps.workspace_id, every_hours: settings.every_hours }),
      deps.now(),
    )
    for (const id of plan.remove) {
      store.removeSource(id)
      store.removeSnapshot(id)
    }
    for (const id of plan.reset) store.removeSnapshot(id)
    for (const s of plan.put) {
      store.putSource(s)
      // Amazon 这一组少盯了几个 ASIN：快照里那几行一起拿掉（不然会被当成「下架」）
      if (s.kind === 'amazon_asin' && s.asins !== undefined) {
        const snap = store.snapshot(s.id)
        const keep = new Set(s.asins)
        if (snap?.rows.some((r) => !keep.has(r.product_key)))
          store.putSnapshot({ ...snap, rows: snap.rows.filter((r) => keep.has(r.product_key)) })
      }
    }
    return store.sources()
  }

  /** C8：竞品这一行对标自家哪一款（只有 Amazon 对标款写了 `vs_own`；自家价从自家那几条源的快照里找）。 */
  const ownRefOf = async (): Promise<
    ((row: CatalogSnapshotRow) => OwnRef | undefined) | undefined
  > => {
    const watch = await deps.brandWatch()
    if (watch === undefined) return undefined
    const vsOwn = new Map<string, string>()
    for (const c of watch.competitors)
      for (const it of c.amazon ?? [])
        if (it.vs_own !== undefined && it.vs_own.trim() !== '')
          vsOwn.set(`${c.id}|${it.asin.trim().toUpperCase()}`, it.vs_own.trim())
    if (vsOwn.size === 0) return undefined
    const own = new Map<string, CatalogSnapshotRow>()
    for (const s of store.sources())
      if (s.competitor_id === OWN_BRAND_COMPETITOR_ID)
        for (const r of store.snapshot(s.id)?.rows ?? [])
          if (r.removed !== true) {
            own.set(r.product_key.toUpperCase(), r)
            if (r.url !== undefined) {
              // 独立站商品 handle（`/products/<handle>`）也认
              const m = /\/products\/([^/?#]+)/u.exec(r.url)
              if (m?.[1] !== undefined) own.set(m[1].toUpperCase(), r)
            }
          }
    return (row) => {
      const key = vsOwn.get(`${row.competitor_id}|${row.product_key.toUpperCase()}`)
      if (key === undefined) return undefined
      const mine = own.get(key.toUpperCase())
      if (mine?.price === undefined) return undefined
      return {
        own_key: key,
        own_title: mine.title,
        own_price: mine.price,
        ...(mine.currency === undefined ? {} : { currency: mine.currency }),
      }
    }
  }

  const readOne = async (
    src: CompetitorWatchSource,
    adapter: CompetitorIntakeAdapter | undefined,
    ownRef: ((row: CatalogSnapshotRow) => OwnRef | undefined) | undefined,
  ): Promise<{ part: CompetitorWatchRunPart; changes: CompetitorChange[]; note?: string }> => {
    const now = deps.now()
    const base = { source_id: src.id, label: src.label, fetched: 0, fresh: 0, kept: 0, changes: 0 }
    if (adapter === undefined)
      return {
        part: { ...base, status: 'skipped', message: '这类来源这台电脑还没接上' },
        changes: [],
      }
    let got: CatalogReadResult
    try {
      got = await adapter.read(src, { workspace_id: deps.workspace_id, now })
    } catch (e) {
      got = { rows: [], complete: false, error: failText(src.label, e) }
    }
    if (got.error !== undefined && got.rows.length === 0) {
      store.putSource({ ...src, status: 'failed', last_try_at: now, last_error: got.error })
      return {
        part: { ...base, status: 'failed', message: got.error },
        changes: [],
        note: got.error,
      }
    }
    const rows = got.rows.map((r) => ({
      ...r,
      source_id: src.id,
      competitor_id: src.competitor_id,
    }))
    const previous = store.snapshot(src.id)
    const out = diffCatalog({
      workspace_id: deps.workspace_id,
      source: src,
      competitor: src.label,
      previous,
      read: { rows, complete: got.complete },
      now,
      new_within_days: store.settings().new_within_days,
      ...(ownRef === undefined || src.competitor_id === OWN_BRAND_COMPETITOR_ID ? {} : { ownRef }),
    })
    store.putSnapshot(out.snapshot)
    if (out.changes.length > 0) store.putChanges(out.changes)
    const next: CompetitorWatchSource = {
      ...src,
      status: 'ok',
      last_ok_at: now,
      last_try_at: now,
      last_fetched: rows.length,
      last_fresh: out.changes.length,
      last_complete: got.complete,
      last_rows: rows.length,
    }
    delete next.last_error
    if (got.via !== undefined) next.last_via = got.via
    else delete next.last_via
    store.putSource(next)
    const partial = got.complete ? undefined : `${src.label} 只读到一部分，这次不判下架`
    const message = [
      out.baseline ? '第一次读，只建了底子' : undefined,
      partial,
      ...(got.notes ?? []),
    ]
      .filter((x): x is string => x !== undefined)
      .join('；')
    return {
      part: {
        ...base,
        status: 'ok',
        fetched: rows.length,
        fresh: out.changes.length,
        kept: out.changes.length,
        changes: out.changes.length,
        complete: got.complete,
        ...(got.via === undefined ? {} : { via: got.via }),
        ...(out.baseline ? { baseline: true as const } : {}),
        ...(message === '' ? {} : { message }),
      },
      changes: out.changes,
      ...(partial === undefined ? {} : { note: partial }),
    }
  }

  const execute = async (
    ids: readonly string[] | undefined,
    trigger: CompetitorWatchRun['trigger'],
  ): Promise<CompetitorWatchRun> => {
    const all = await sync()
    const want = ids === undefined ? undefined : new Set(ids)
    // 自家的先读（竞品比价要用自家的新价）
    const list = all
      .filter((s) => s.paused !== true && (want === undefined || want.has(s.id)))
      .sort(
        (a, b) =>
          Number(b.competitor_id === OWN_BRAND_COMPETITOR_ID) -
            Number(a.competitor_id === OWN_BRAND_COMPETITOR_ID) || a.id.localeCompare(b.id),
      )
    const run: CompetitorWatchRun = {
      id: deps.newId('cwr'),
      workspace_id: deps.workspace_id,
      trigger,
      started_at: deps.now(),
      parts: [],
      changes: 0,
      notes: [],
    }
    store.putRun(run)
    const adapters = deps.adapters()
    const found: CompetitorChange[] = []
    let ownRef: Awaited<ReturnType<typeof ownRefOf>>
    let ownDone = false
    for (const src of list) {
      if (!ownDone && src.competitor_id !== OWN_BRAND_COMPETITOR_ID) {
        ownDone = true
        ownRef = await ownRefOf()
      }
      const r = await readOne(src, adapters[src.kind], ownRef)
      run.parts.push(r.part)
      found.push(...r.changes)
      if (r.note !== undefined) run.notes.push(r.note)
    }
    run.changes = found.length
    run.finished_at = deps.now()
    store.putRun(run)
    deps.onRun?.(run, found)
    return run
  }

  const runNow: CompetitorWatchAssembly['runNow'] = (options = {}) => {
    if (running !== undefined) return running
    const p = execute(options.source_ids, options.trigger ?? 'manual').finally(() => {
      running = undefined
    })
    running = p
    return p
  }

  const summaryOf = (sources: readonly CompetitorWatchSource[]): CompetitorWatchSummary => {
    const live = sources.filter((s) => s.paused !== true)
    const failed = live.filter((s) => s.status === 'failed')
    return {
      sources: live.length,
      competitors: new Set(live.map((s) => s.competitor_id)).size,
      ok: live.filter((s) => s.status === 'ok').length,
      failed: failed.length,
      partial: live.filter((s) => s.status === 'ok' && s.last_complete === false).length,
      unchecked: live.filter((s) => s.status === 'unchecked').length,
      failed_labels: [...new Set(failed.map((s) => s.label))],
    }
  }

  return {
    workspace_id: deps.workspace_id,
    sync,
    tick: async () => {
      const settings = store.settings()
      if (!settings.enabled) return { ran: false, skipped: 'disabled' }
      const sources = await sync()
      if (sources.length === 0) return { ran: false, skipped: 'no_sources' }
      const due = dueSources({
        now: deps.now(),
        tz_offset_minutes: deps.tzOffsetMinutes(),
        settings,
        sources,
      })
      if (due.length === 0) return { ran: false, skipped: 'not_due' }
      const run = await runNow({ source_ids: due, trigger: 'schedule' })
      return { ran: true, run_id: run.id }
    },
    runNow,
    view: async () => {
      const sources = await sync()
      const settings = store.settings()
      const adapters = deps.adapters()
      const next = nextReadAt({
        now: deps.now(),
        tz_offset_minutes: deps.tzOffsetMinutes(),
        settings,
        sources,
      })
      const last = store.runs(1)[0]
      return {
        settings,
        sources,
        summary: summaryOf(sources),
        ...(next === undefined ? {} : { next_read_at: next }),
        ...(last === undefined ? {} : { last_run: last }),
        missing_adapters: [...new Set(sources.map((s) => s.kind))].filter(
          (k) => adapters[k] === undefined,
        ),
      }
    },
    changes: (q) => store.changes(q),
    sources: () => store.sources(),
    runs: (limit) => store.runs(limit),
    settings: () => store.settings(),
    updateSettings: (patch) => {
      const cur = store.settings()
      const every = clampInt(patch.every_hours, 1, 24 * 14)
      const hour = clampInt(patch.day_start_hour, 0, 23)
      const days = clampInt(patch.new_within_days, 1, 90)
      const next: CompetitorWatchSettings = {
        enabled: typeof patch.enabled === 'boolean' ? patch.enabled : cur.enabled,
        every_hours: every ?? cur.every_hours,
        day_start_hour: hour ?? cur.day_start_hour,
        new_within_days: days ?? cur.new_within_days,
      }
      store.putSettings(next)
      for (const s of store.sources())
        if (s.every_hours !== next.every_hours)
          store.putSource({ ...s, every_hours: next.every_hours })
      return next
    },
  }
}
