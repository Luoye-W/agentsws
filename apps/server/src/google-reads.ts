/**
 * WP158：Search Console 与 GA4 的**真读数**（每个品牌一份；docs/82）。
 *
 * 照 WP46（`live-data.ts`）的四条纪律：
 *
 * 1. **读走 OpenConnector 的只读 Action**（`google_search_console.*` / `google_analytics.*`），
 *    不自己打 Google 的 HTTP。
 * 2. **令牌只在连接器里**：Google 的 access / refresh token 从不进这个进程。我们每次读现签一张
 *    120 秒的 `role-read` 执行令牌（只许这几个读口、只许这一条连接），用完立刻吊销；
 *    它不进库、不进日志、不进事件、不进模型。
 * 3. **按天缓存、只在内存**：同一天的重复读（面板刷新、手动跑一轮）吃缓存；换了站点 / 连接 /
 *    过了一天才重拉。事件里只有条数与原因码，没有一行数据。
 * 4. **上游失败保留上一份** + 一条人话（`@agentsws/seo-core` 的 `googleFailureText`）；
 *    配额用尽当天不再重试，其它失败 30 分钟后才再试。
 *
 * 选哪个站点 / 媒体资源记在品牌目录的 `google-reads.json`（只有站点 URL 与媒体资源 id）；
 * 只有一个可选时自动选上，不问。
 */
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Clock, EventEnvelope, GscRow, SitePage, WorkspaceId } from '@agentsws/contracts'
import type { SearchDeckData } from '@agentsws/deck'
import {
  classifyGoogleError,
  type DateWindow,
  dateInZone,
  type Ga4EventRow,
  type Ga4LandingRow,
  type Ga4Totals,
  type GoogleReadFailure,
  GSC_MAX_PAGES,
  GSC_ROW_LIMIT,
  GSC_TIME_ZONE,
  type GscDimension,
  type GscKeyedRow,
  type GscWeeks,
  ga4Events,
  ga4EventsRequest,
  ga4LandingRequest,
  ga4LandingRows,
  ga4PropertyOptions,
  ga4Totals,
  ga4TotalsRequest,
  googleFailureText,
  gscProbeRequest,
  gscQueryRequest,
  gscRollup,
  gscSiteOptions,
  gscWeeks,
  INSPECT_MAX_PAGES,
  indexStatusOf,
  joinWeeks,
  type LandingConversion,
  latestFinalDate,
  type SearchConsolePort,
  searchAnalyticsRows,
  sitePagesFrom,
} from '@agentsws/seo-core'
import { catalogEntry } from './catalog.js'

/** 两条读各用一个 assignment（吊销按 assignment 来，两边并发时不互相吊销）。 */
export const GSC_READ_ASSIGNMENT = 'asg_google_gsc'
export const GA4_READ_ASSIGNMENT = 'asg_google_ga4'
const TOKEN_TTL_SECONDS = 120
const STATE_FILE = 'google-reads.json'
/** 非配额的失败，隔多久才再试一次（别让面板每刷新一次就打一次上游）。 */
const RETRY_AFTER_MS = 30 * 60_000

export const GSC_SERVICES = new Set(['gsc', 'google_search_console'])
export const GA4_SERVICES = new Set(['ga4', 'google_analytics'])

export const GSC_PICK_SITE =
  'Search Console 连上了，还没选是哪个站点：在「内容与搜索」面板上选一下，选好立刻读。'
export const GA4_PICK_PROPERTY = 'GA4 连上了，还没选是哪个媒体资源：在面板上选一下，选好立刻读。'

/** 执行只读 Action 要的那一小块连接器面（同 `site.ts` 的 `SiteConnectLike`，多一个吊销）。 */
export interface GoogleConnectLike {
  actions(service: string): Promise<{ id: string; side_effect?: string }[]>
  issueToken(input: {
    assignment_id: string
    kind: 'role-read'
    allowed_actions: string[]
    allowed_connections: string[]
    expires_in_seconds?: number
  }): Promise<{ token: string }>
  execute(
    action_id: string,
    input: unknown,
    opts: { token: string; connection?: string },
  ): Promise<unknown>
  revokeTokens?(assignment_id: string): Promise<unknown>
}

export interface GoogleReadsOptions {
  workspace_id: WorkspaceId
  clock: Clock
  /** 这个品牌的连接清单（非凭据面）。 */
  connections(): { id: string; service: string; status: string }[]
  connect: GoogleConnectLike
  appendEvent?(e: Omit<EventEnvelope, 'id' | 'at'> & { at?: string }): void
  /** 品牌目录（选择记在这里；内存档没有）。 */
  dir?: string
  /** 测试用：一页多少行（默认 25 000）。 */
  gscRowLimit?: number
}

/** 选择器那一块（一个源）。 */
export interface GoogleSourceView {
  connected: boolean
  selected?: string
  selected_label?: string
  options: { id: string; label: string }[]
  needs_pick: boolean
  /** 上一次没读到的人话。 */
  note?: string
  stale?: boolean
  window?: DateWindow
}

export interface GoogleSourcesView {
  gsc: GoogleSourceView
  ga4: GoogleSourceView
}

export interface GoogleReads {
  /** 给 `seo-service` 的 Search Console 口（读当天缓存；没有就现拉）。 */
  searchConsole(): SearchConsolePort
  /** GA4 落地页（自然搜索）；没连 / 没选 / 读不到又没缓存 = `undefined`。 */
  ga4Conversions(): Promise<LandingConversion[] | undefined>
  /** GA4 为什么没有数（没连不说；连了没选 / 读不到说一句）。 */
  ga4Note(): string | undefined
  sources(): Promise<GoogleSourcesView>
  select(input: { gsc_site?: string | undefined; ga4_property?: string | undefined }): Promise<{
    view: GoogleSourcesView
    gsc_changed: boolean
    ga4_changed: boolean
  }>
  /** 面板那几块（同步，只读缓存）。 */
  deckData(): SearchDeckData | undefined
  /** 读之前拉新（当天有缓存就是空操作）。**永不抛**。 */
  ensureFresh(): Promise<void>
  /** 连接清单变了：下一次读之前重拉。 */
  invalidate(): void
}

// ── 内部状态 ───────────────────────────────────────────────────────────

interface Selection {
  gsc_site?: string
  gsc_connection?: string
  ga4_property?: string
  ga4_connection?: string
}

interface GscCache {
  key: string
  connection_id: string
  site_url: string
  weeks: GscWeeks
  rows: GscRow[]
  pages: SitePage[]
  queries: ReturnType<typeof gscRollup>
  by_page: ReturnType<typeof gscRollup>
}

interface Ga4Cache {
  key: string
  connection_id: string
  property_id: string
  window: DateWindow
  landing: Ga4LandingRow[]
  current?: Ga4Totals
  previous?: Ga4Totals
  events: Ga4EventRow[]
  currency?: string
}

interface SourceState<C> {
  cache?: C
  stale: boolean
  /** 连接或选择变了：下一次读之前必须重拉（不管当天有没有缓存）。 */
  dirty: boolean
  note?: string
  failed?: { key: string; kind: GoogleReadFailure; at: number }
  inflight?: Promise<void>
  /** 下拉里的选项（按连接 + 天缓存）。 */
  options?: { key: string; list: { id: string; label: string }[] }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** 失败原因进事件前截短，并抹掉任何像令牌的东西（令牌守卫：宁可多抹，不可漏一个）。 */
export function scrubDetail(e: unknown, secrets: readonly string[] = []): string {
  let raw = e instanceof Error ? e.message : String(e)
  for (const s of secrets) if (s !== '') raw = raw.split(s).join('[令牌]')
  raw = raw
    .replace(/Bearer\s+[\w.~+/=-]+/gi, 'Bearer [令牌]')
    .replace(/ya29\.[\w.-]+/g, '[令牌]')
    .replace(/1\/\/[\w.-]{20,}/g, '[令牌]')
    .replace(/(access_token|refresh_token|id_token|token)(["'\s:=]+)[\w.~+/=-]{8,}/gi, '$1$2[令牌]')
  return raw.length > 200 ? `${raw.slice(0, 200)}…` : raw
}

export function createGoogleReads(options: GoogleReadsOptions): GoogleReads {
  const { clock, workspace_id } = options
  const rowLimit = options.gscRowLimit ?? GSC_ROW_LIMIT
  const gsc: SourceState<GscCache> = { stale: false, dirty: false }
  const ga4: SourceState<Ga4Cache> = { stale: false, dirty: false }

  // ── 选择（只有站点 URL 与媒体资源 id，没有任何凭据）────────────────────
  let memorySel: Selection = {}
  const loadSel = (): Selection => {
    if (options.dir === undefined) return memorySel
    try {
      const raw = JSON.parse(readFileSync(join(options.dir, STATE_FILE), 'utf8')) as unknown
      return isRecord(raw) ? (raw as Selection) : {}
    } catch {
      return {}
    }
  }
  const saveSel = (sel: Selection): void => {
    memorySel = sel
    if (options.dir === undefined) return
    writeFileSync(join(options.dir, STATE_FILE), `${JSON.stringify(sel, null, 2)}\n`, 'utf8')
  }

  let traceSeq = 0
  const emit = (type: string, payload: Record<string, unknown>): void => {
    traceSeq += 1
    try {
      options.appendEvent?.({
        schema_version: 1,
        workspace_id,
        type,
        actor: { kind: 'system', id: 'google-reads' },
        correlation: { trace_id: `trc_google_${Date.parse(clock.now()).toString(36)}_${traceSeq}` },
        payload,
      })
    } catch {
      // 记不上事件不该把已经读回来的数作废
    }
  }

  const active = (services: Set<string>) =>
    options.connections().find((c) => services.has(c.service) && c.status === 'active')
  const upstreamOf = (service: string): string => {
    const up = catalogEntry(service)?.upstream
    return up === undefined || up === 'local' ? service : up
  }
  const day = (): string => dateInZone(Date.parse(clock.now()), GSC_TIME_ZONE)
  const nowMs = (): number => Date.parse(clock.now())

  /**
   * 现签一张只读令牌 → 跑 `fn` → 一定吊销。`fn` 拿到的 `run(bare, input)` 只认这几个读口；
   * 目录里找不到的读口回 `undefined`（调用方自己决定缺了它算不算失败）。
   */
  const withReadToken = async <T>(
    conn: { id: string; service: string },
    base_assignment: string,
    bare: readonly string[],
    fn: (
      run: (name: string, input: unknown) => Promise<unknown>,
      has: (name: string) => boolean,
    ) => Promise<T>,
  ): Promise<T> => {
    const actions = await options.connect.actions(upstreamOf(conn.service))
    const ids = new Map<string, string>()
    for (const name of bare) {
      const hit = actions.find((a) => a.side_effect === 'read' && a.id.endsWith(`.${name}`))
      if (hit !== undefined) ids.set(name, hit.id)
    }
    if (ids.size === 0)
      throw Object.assign(new Error(`连接器目录里没有 ${upstreamOf(conn.service)} 的读口`), {
        code: 'action_unavailable',
      })
    /*
     * 吊销是按 assignment 一把全吊的：几个品牌同时读、或者「选一下」触发的重读撞上每日读数，
     * 共用一个 assignment 就会把别人手里正在用的令牌也吊掉。所以每次读用一个独有的
     * assignment（固定前缀 + 连接 + 随机尾），吊销只吊自己这一张。（Fable 终审补）
     */
    const assignment_id = `${base_assignment}_${conn.id}_${randomUUID().slice(0, 8)}`
    const { token } = await options.connect.issueToken({
      assignment_id,
      kind: 'role-read',
      allowed_actions: [...ids.values()],
      allowed_connections: [conn.id],
      expires_in_seconds: TOKEN_TTL_SECONDS,
    })
    const secrets = [token]
    try {
      return await fn(
        async (name, input) => {
          const id = ids.get(name)
          if (id === undefined) throw new Error(`连接器目录里没有 ${name}`)
          try {
            const out = await options.connect.execute(id, input, { token, connection: conn.id })
            return isRecord(out) && out.data !== undefined ? out.data : out
          } catch (e) {
            // 上游的话原样往上抛之前先抹掉令牌（这句话之后会进事件与卡）
            const err = new Error(scrubDetail(e, secrets))
            const code = isRecord(e) && typeof e.code === 'string' ? e.code : undefined
            throw code === undefined ? err : Object.assign(err, { code })
          }
        },
        (name) => ids.has(name),
      )
    } finally {
      try {
        await options.connect.revokeTokens?.(assignment_id)
      } catch {
        // 吊销失败不该把这一轮变成失败：令牌 120 秒后自己过期
      }
    }
  }

  /** 该不该现在去拉（当天有缓存 / 刚失败过 → 不拉）。 */
  const shouldPull = <C extends { key: string }>(state: SourceState<C>, key: string): boolean => {
    if (state.cache?.key === key && !state.dirty) return false
    const f = state.failed
    if (f !== undefined && f.key === key && !state.dirty) {
      if (f.kind === 'quota') return false
      if (nowMs() - f.at < RETRY_AFTER_MS) return false
    }
    return true
  }

  /** 失败了：保留上一份（同一条连接、同一个站点的才算"上一份"），记一句人话与一条事件。 */
  const fail = <C extends { connection_id: string }>(
    source: 'gsc' | 'ga4',
    state: SourceState<C>,
    conn: { id: string },
    key: string,
    same: (c: C) => boolean,
    e: unknown,
  ): void => {
    const kind = classifyGoogleError(e)
    if (state.cache !== undefined && !same(state.cache)) delete state.cache
    state.stale = state.cache !== undefined
    state.note = googleFailureText(source, kind, state.cache !== undefined)
    state.failed = { key, kind, at: nowMs() }
    emit('data.refresh_failed', {
      source,
      connection_id: conn.id,
      reason: kind,
      detail: scrubDetail(e),
      kept_cached: state.cache !== undefined,
    })
  }

  // ── Search Console ─────────────────────────────────────────────────────

  /** 这条连接上选的站点（换了连接 = 没选；那个站点是上一个账号的）。 */
  const gscSite = (conn: { id: string }): string | undefined => {
    const sel = loadSel()
    return sel.gsc_connection === conn.id ? sel.gsc_site : undefined
  }
  const ga4Property = (conn: { id: string }): string | undefined => {
    const sel = loadSel()
    return sel.ga4_connection === conn.id ? sel.ga4_property : undefined
  }

  /** 下拉里的选项（按连接 + 天缓存；读不到给空，并记一句）。 */
  const listOptions = async (
    source: 'gsc' | 'ga4',
    conn: { id: string; service: string },
  ): Promise<{ id: string; label: string }[]> => {
    const state = source === 'gsc' ? gsc : ga4
    const key = `${conn.id}|${day()}`
    if (state.options?.key === key && !state.dirty) return state.options.list
    try {
      const list =
        source === 'gsc'
          ? await withReadToken(conn, GSC_READ_ASSIGNMENT, ['list_sites'], async (run) =>
              gscSiteOptions(await run('list_sites', {})).map((o) => ({
                id: o.site_url,
                label: o.label,
              })),
            )
          : await withReadToken(conn, GA4_READ_ASSIGNMENT, ['list_properties'], async (run) =>
              ga4PropertyOptions(await run('list_properties', { pageSize: 200 })).map((o) => ({
                id: o.property_id,
                label: o.label,
              })),
            )
      state.options = { key, list }
      return list
    } catch (e) {
      state.note = googleFailureText(source, classifyGoogleError(e), false)
      return state.options?.list ?? []
    }
  }

  /** 没选但只有一个可选 → 自动选上（不问）。回选中的那个。 */
  const autoPick = async (
    source: 'gsc' | 'ga4',
    conn: { id: string; service: string },
  ): Promise<string | undefined> => {
    const current = source === 'gsc' ? gscSite(conn) : ga4Property(conn)
    if (current !== undefined) return current
    const list = await listOptions(source, conn)
    if (list.length !== 1 || list[0] === undefined) return undefined
    const id = list[0].id
    saveSel(
      source === 'gsc'
        ? { ...loadSel(), gsc_site: id, gsc_connection: conn.id }
        : { ...loadSel(), ga4_property: id, ga4_connection: conn.id },
    )
    return id
  }

  /** 一段日期的「查询 × 页面」，翻到行数不满一页为止（最多 `GSC_MAX_PAGES` 页）。 */
  const pullWindow = async (
    run: (name: string, input: unknown) => Promise<unknown>,
    site_url: string,
    window: DateWindow,
  ): Promise<{ rows: GscKeyedRow[]; complete: boolean }> => {
    const dims: GscDimension[] = ['query', 'page']
    const rows: GscKeyedRow[] = []
    for (let page = 0; page < GSC_MAX_PAGES; page += 1) {
      const payload = await run(
        'query_search_analytics',
        gscQueryRequest({
          site_url,
          window,
          dimensions: dims,
          start_row: page * rowLimit,
          row_limit: rowLimit,
        }),
      )
      const got = searchAnalyticsRows(payload, dims)
      rows.push(...got)
      if (got.length < rowLimit) return { rows, complete: true }
    }
    return { rows, complete: false }
  }

  const pullGsc = async (conn: { id: string; service: string }, site_url: string, key: string) =>
    withReadToken(
      conn,
      GSC_READ_ASSIGNMENT,
      ['query_search_analytics', 'inspect_url'],
      async (run, has): Promise<GscCache> => {
        const latest = latestFinalDate(
          await run('query_search_analytics', gscProbeRequest(site_url, nowMs())),
        )
        const weeks = gscWeeks({ now_ms: nowMs(), latest_final: latest })
        const current = await pullWindow(run, site_url, weeks.current)
        const previous = await pullWindow(run, site_url, weeks.previous)
        const rows = joinWeeks(current.rows, previous.rows, previous.complete)
        // 网址检查：按曝光排前 10 页（每站点每天 2 000 次额度）；一页查不到就不写那一格
        const status: Record<string, SitePage['index_status']> = {}
        if (has('inspect_url')) {
          const top = gscRollup(rows, 'page')
            .sort((a, b) => b.impressions - a.impressions)
            .slice(0, INSPECT_MAX_PAGES)
          for (const p of top) {
            try {
              const s = indexStatusOf(
                await run('inspect_url', { siteUrl: site_url, inspectionUrl: p.key }),
              )
              if (s !== undefined) status[p.key] = s
            } catch (e) {
              if (classifyGoogleError(e) === 'quota') break
            }
          }
        }
        return {
          key,
          connection_id: conn.id,
          site_url,
          weeks,
          rows,
          pages: sitePagesFrom(rows, status),
          queries: gscRollup(rows, 'query'),
          by_page: gscRollup(rows, 'page'),
        }
      },
    )

  const ensureGsc = async (): Promise<void> => {
    const conn = active(GSC_SERVICES)
    if (conn === undefined) {
      delete gsc.cache
      gsc.stale = false
      delete gsc.note
      return
    }
    const site = await autoPick('gsc', conn)
    if (site === undefined) return
    const key = `${conn.id}|${site}|${day()}`
    if (!shouldPull(gsc, key)) return
    if (gsc.inflight !== undefined) return gsc.inflight
    gsc.inflight = (async () => {
      try {
        const cache = await pullGsc(conn, site, key)
        gsc.cache = cache
        gsc.stale = false
        delete gsc.note
        delete gsc.failed
        emit('data.refreshed', {
          source: 'gsc',
          connection_id: conn.id,
          rows: cache.rows.length,
          pages: cache.pages.length,
          window_end: cache.weeks.current.end,
        })
      } catch (e) {
        fail('gsc', gsc, conn, key, (c) => c.connection_id === conn.id && c.site_url === site, e)
      } finally {
        gsc.dirty = false
        delete gsc.inflight
      }
    })()
    return gsc.inflight
  }

  // ── GA4 ────────────────────────────────────────────────────────────────

  /**
   * GA4 问的是与 GSC **同一周**（有 GSC 缓存就用它探出来的那一周），好让点击与会话对得上；
   * 落地页那张是必须的，总量与事件表各自读不到就空着（不拖垮整次）。
   */
  const pullGa4 = async (conn: { id: string; service: string }, property_id: string, key: string) =>
    withReadToken(conn, GA4_READ_ASSIGNMENT, ['run_report'], async (run): Promise<Ga4Cache> => {
      const weeks = gsc.cache?.weeks ?? gscWeeks({ now_ms: nowMs() })
      const landing = ga4LandingRows(
        await run('run_report', ga4LandingRequest(property_id, weeks.current)),
      )
      const optional = async <T>(f: () => Promise<T>): Promise<T | undefined> => {
        try {
          return await f()
        } catch {
          return undefined
        }
      }
      const totals = await optional(async () =>
        ga4Totals(
          await run('run_report', ga4TotalsRequest(property_id, weeks.current, weeks.previous)),
        ),
      )
      const events = await optional(async () =>
        ga4Events(await run('run_report', ga4EventsRequest(property_id, weeks.current))),
      )
      const currency = landing.currency ?? totals?.currency
      return {
        key,
        connection_id: conn.id,
        property_id,
        window: weeks.current,
        landing: landing.rows,
        events: events ?? [],
        ...(totals?.current === undefined ? {} : { current: totals.current }),
        ...(totals?.previous === undefined ? {} : { previous: totals.previous }),
        ...(currency === undefined ? {} : { currency }),
      }
    })

  const ensureGa4 = async (): Promise<void> => {
    const conn = active(GA4_SERVICES)
    if (conn === undefined) {
      delete ga4.cache
      ga4.stale = false
      delete ga4.note
      return
    }
    const property = await autoPick('ga4', conn)
    if (property === undefined) return
    const key = `${conn.id}|${property}|${day()}`
    if (!shouldPull(ga4, key)) return
    if (ga4.inflight !== undefined) return ga4.inflight
    ga4.inflight = (async () => {
      try {
        const cache = await pullGa4(conn, property, key)
        ga4.cache = cache
        ga4.stale = false
        delete ga4.note
        delete ga4.failed
        emit('data.refreshed', {
          source: 'ga4',
          connection_id: conn.id,
          rows: cache.landing.length,
          events: cache.events.length,
          window_end: cache.window.end,
        })
      } catch (e) {
        fail(
          'ga4',
          ga4,
          conn,
          key,
          (c) => c.connection_id === conn.id && c.property_id === property,
          e,
        )
      } finally {
        ga4.dirty = false
        delete ga4.inflight
      }
    })()
    return ga4.inflight
  }

  // ── 对外 ───────────────────────────────────────────────────────────────

  const viewOf = async (source: 'gsc' | 'ga4'): Promise<GoogleSourceView> => {
    const conn = active(source === 'gsc' ? GSC_SERVICES : GA4_SERVICES)
    if (conn === undefined) return { connected: false, options: [], needs_pick: false }
    const state = source === 'gsc' ? gsc : ga4
    const list = await listOptions(source, conn)
    const selected = source === 'gsc' ? gscSite(conn) : ga4Property(conn)
    const window = source === 'gsc' ? gsc.cache?.weeks.current : ga4.cache?.window
    return {
      connected: true,
      options: list,
      needs_pick: selected === undefined,
      ...(selected === undefined ? {} : { selected }),
      ...(selected === undefined
        ? {}
        : { selected_label: list.find((o) => o.id === selected)?.label ?? selected }),
      ...(state.note === undefined ? {} : { note: state.note }),
      ...(state.stale ? { stale: true } : {}),
      ...(window === undefined ? {} : { window }),
    }
  }

  const ensureFresh = async (): Promise<void> => {
    try {
      await ensureGsc()
      await ensureGa4()
    } catch {
      // 永不抛：面板照常出，上游挂了用上一份
    }
  }

  return {
    searchConsole: () => ({
      connected: () => active(GSC_SERVICES) !== undefined,
      rows: async () => {
        await ensureFresh()
        const conn = active(GSC_SERVICES)
        if (conn !== undefined && gscSite(conn) === undefined) throw new Error(GSC_PICK_SITE)
        if (gsc.cache !== undefined) return gsc.cache.rows.map((r) => ({ ...r }))
        throw new Error(gsc.note ?? googleFailureText('gsc', 'other', false))
      },
      pages: async () => (gsc.cache?.pages ?? []).map((p) => ({ ...p })),
      note: () => (gsc.stale ? gsc.note : undefined),
    }),

    async ga4Conversions() {
      await ensureFresh()
      if (ga4.cache === undefined) return undefined
      return ga4.cache.landing.flatMap((r) =>
        r.conversion_rate === undefined
          ? []
          : [
              {
                page: r.page,
                conversion_rate: r.conversion_rate,
                sessions: r.sessions,
                purchases: r.purchases,
                revenue: r.revenue,
              },
            ],
      )
    },

    ga4Note() {
      const conn = active(GA4_SERVICES)
      if (conn === undefined) return undefined
      if (ga4Property(conn) === undefined) return GA4_PICK_PROPERTY
      return ga4.note
    },

    async sources() {
      return { gsc: await viewOf('gsc'), ga4: await viewOf('ga4') }
    },

    async select(input) {
      const gscConn = active(GSC_SERVICES)
      const ga4Conn = active(GA4_SERVICES)
      let sel = loadSel()
      let gsc_changed = false
      let ga4_changed = false
      if (input.gsc_site !== undefined && gscConn !== undefined) {
        const list = await listOptions('gsc', gscConn)
        // 下拉里有的才认（读不到清单时照收——不能因为上游一时没回就不让人选）
        if (list.length > 0 && !list.some((o) => o.id === input.gsc_site))
          throw Object.assign(new Error('这个站点不在这个 Google 账号能读的清单里'), {
            code: 'invalid_input',
          })
        gsc_changed = gscSite(gscConn) !== input.gsc_site
        sel = { ...sel, gsc_site: input.gsc_site, gsc_connection: gscConn.id }
      }
      if (input.ga4_property !== undefined && ga4Conn !== undefined) {
        const list = await listOptions('ga4', ga4Conn)
        if (list.length > 0 && !list.some((o) => o.id === input.ga4_property))
          throw Object.assign(new Error('这个媒体资源不在这个 Google 账号能读的清单里'), {
            code: 'invalid_input',
          })
        ga4_changed = ga4Property(ga4Conn) !== input.ga4_property
        sel = { ...sel, ga4_property: input.ga4_property, ga4_connection: ga4Conn.id }
      }
      saveSel(sel)
      // 选了立刻重读（换了站点 GA4 那一周也跟着换，所以两边都重来）
      if (gsc_changed || ga4_changed) {
        gsc.dirty = gsc_changed || gsc.dirty
        ga4.dirty = true
        delete gsc.failed
        delete ga4.failed
      }
      await ensureFresh()
      return {
        view: { gsc: await viewOf('gsc'), ga4: await viewOf('ga4') },
        gsc_changed,
        ga4_changed,
      }
    },

    deckData() {
      const gscConn = active(GSC_SERVICES)
      const ga4Conn = active(GA4_SERVICES)
      if (gscConn === undefined && ga4Conn === undefined) return undefined
      const out: SearchDeckData = {}
      if (gscConn !== undefined) {
        const site = gscSite(gscConn)
        const c = gsc.cache
        out.gsc = {
          ...(site === undefined ? { needs_pick: true } : {}),
          ...(site === undefined
            ? {}
            : { site_label: gsc.options?.list.find((o) => o.id === site)?.label ?? site }),
          ...(gsc.note === undefined ? {} : { note: gsc.note }),
          ...(c === undefined ? {} : { window: c.weeks.current }),
          queries: c?.queries ?? [],
          pages: c?.by_page ?? [],
        }
      }
      if (ga4Conn !== undefined) {
        const property = ga4Property(ga4Conn)
        const c = ga4.cache
        out.ga4 = {
          ...(property === undefined ? { needs_pick: true } : {}),
          ...(property === undefined
            ? {}
            : {
                property_label: ga4.options?.list.find((o) => o.id === property)?.label ?? property,
              }),
          ...(ga4.note === undefined ? {} : { note: ga4.note }),
          ...(c === undefined ? {} : { window: c.window }),
          ...(c?.currency === undefined ? {} : { currency: c.currency }),
          ...(c?.current === undefined ? {} : { current: c.current }),
          ...(c?.previous === undefined ? {} : { previous: c.previous }),
          events: c?.events ?? [],
        }
      }
      return out
    },

    ensureFresh,

    invalidate() {
      gsc.dirty = true
      ga4.dirty = true
    },
  }
}
