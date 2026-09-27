/**
 * WP166：目标市场的服务端那几件事（真源是 `WorkspaceProfile.markets`，读写都经 onboarding）。
 *
 * 1. {@link marketsFromIntake}：品牌分析确认时，把档案卡上那一格（连出处）翻成 `setProfile` 的入参；
 * 2. {@link readStoreMarkets} + {@link reconcileStoreMarkets}：店铺（Shopify）连上后，读店里配的
 *    市场（Markets）/ 配送区域，用它**校正一次**，并把改了什么写成一句人话（界面上可见）；
 * 3. {@link createStoreMarketsSync}：把 2 接到"连接清单变了"那一声上——每条店铺连接只校正一次。
 *
 * 纪律：人改过的（`from: 'human'`）一概不动；店里读不到 / 读出来是"卖全世界"就不改、不编。
 * 这里每一跳都是**只读** Action（`list_markets` / `list_shipping_zones` 在
 * `packages/connect-adapter/action-side-effects.yml` 里都标着 `read`）。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BrandIntakeField, MarketsSource } from '@agentsws/contracts'
import { normalizeMarkets } from '@agentsws/contracts'
import type { DeckCard } from '@agentsws/deck'
import { actionsFor, labelsFor, layoutFor } from '@agentsws/deck'

/** 店里配的国家超过这个数就当"卖全世界"，不拿它校正（与官网那一路的国家切换同一个数）。 */
export const STORE_MARKETS_MAX = 25

/**
 * 品牌分析确认 → `setProfile` 的 `markets` / `markets_source`。
 *
 * - 这一格没有 → 什么都不给（沿用档案里原来的）；
 * - 人在档案卡上改过（`edited`）→ 出处是 `human`，**清空也算数**（给空数组）；
 * - 否则出处按证据：全是 Amazon 站点那一条 → `amazon`，其余 → `site`。
 */
export function marketsFromIntake(
  cell: BrandIntakeField<string[]> | undefined,
  at: string,
): { markets?: string[]; markets_source?: MarketsSource } {
  if (cell === undefined) return {}
  if (cell.edited === true)
    return { markets: [...cell.value], markets_source: { from: 'human', at } }
  if (cell.value.length === 0) return {}
  const amazonOnly = cell.evidence.every((e) => e.locator === 'url:host')
  return {
    markets: [...cell.value],
    markets_source: {
      from: amazonOnly ? 'amazon' : 'site',
      evidence: cell.evidence.map((e) => ({
        url: e.url,
        locator: e.locator,
        ...(e.quote === undefined ? {} : { quote: e.quote }),
      })),
      at,
    },
  }
}

const rec = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {}
const arr = (v: unknown): unknown[] => {
  if (Array.isArray(v)) return v
  const r = rec(v)
  if (Array.isArray(r.nodes)) return r.nodes
  if (Array.isArray(r.edges)) return r.edges.map((e) => rec(e).node)
  return []
}
const codeOf = (v: unknown): string | undefined => {
  const r = rec(v)
  const c = r.code ?? r.countryCode ?? r.country_code
  return typeof c === 'string' ? c : undefined
}

/** `list_markets` 的回包 → 启用着的市场里的国家（Shopify Markets；GraphQL 与 REST 两种形状都认）。 */
export function countriesOfMarkets(out: unknown): string[] {
  const list = arr(rec(out).markets ?? out)
  const codes: string[] = []
  for (const m of list) {
    const r = rec(m)
    if (r.enabled === false || r.status === 'DRAFT' || r.status === 'INACTIVE') continue
    // 老接口直接给 `regions`；新接口在 `conditions.regionsCondition.regions` 里
    const direct = arr(r.regions)
    const regions =
      direct.length > 0 ? direct : arr(rec(rec(r.conditions).regionsCondition).regions)
    for (const region of regions) codes.push(codeOf(region) ?? '')
  }
  return normalizeMarkets(codes)
}

/** `list_shipping_zones` 的回包 → 配送区域里的国家（`*` 世界其他地区不算）。 */
export function countriesOfZones(out: unknown): string[] {
  const r = rec(out)
  const zones = arr(r.shipping_zones ?? r.zones ?? out)
  const codes: string[] = []
  for (const z of zones) for (const c of arr(rec(z).countries)) codes.push(codeOf(c) ?? '')
  return normalizeMarkets(codes.filter((c) => c !== '*'))
}

/** 一段国家码 → 中文国名（「美国、加拿大」）。 */
export function marketNames(codes: readonly string[]): string {
  let names: Intl.DisplayNames | undefined
  try {
    names = new Intl.DisplayNames(['zh-CN'], { type: 'region' })
  } catch {
    names = undefined
  }
  return codes.map((c) => names?.of(c) ?? c).join('、')
}

/**
 * 用店里配的市场校正档案里的那一份。回 `undefined` = 不改（人改过的 / 店里没读到 / "卖全世界" / 一样）。
 */
export function reconcileStoreMarkets(input: {
  current: readonly string[] | undefined
  source: MarketsSource | undefined
  store: readonly string[]
  from: 'markets' | 'shipping_zones'
  at: string
}): { markets: string[]; source: MarketsSource } | undefined {
  if (input.source?.from === 'human') return undefined
  const store = normalizeMarkets(input.store)
  if (store.length === 0 || store.length > STORE_MARKETS_MAX) return undefined
  const current = input.current ?? []
  const added = store.filter((c) => !current.includes(c))
  const removed = current.filter((c) => !store.includes(c))
  if (added.length === 0 && removed.length === 0) return undefined
  const where = input.from === 'markets' ? '店铺后台的「市场」' : '店铺后台的配送区域'
  const parts = [
    added.length === 0 ? '' : `加上了 ${marketNames(added)}`,
    removed.length === 0 ? '' : `去掉了 ${marketNames(removed)}`,
  ].filter((p) => p !== '')
  const note =
    current.length === 0
      ? `按${where}设成了 ${marketNames(store)}`
      : `按${where}校正：${parts.join('，')}`
  return {
    markets: store,
    source: {
      from: 'store',
      evidence: [{ url: 'store', locator: input.from, quote: store.join(' ') }],
      note,
      at: input.at,
    },
  }
}

/** 读店里配的市场用的那一小块连接器面（照 `site.ts` 的 `SiteConnectLike`）。 */
export interface StoreConnectLike {
  actions(service: string): Promise<{ id: string }[]>
  issueToken(input: {
    assignment_id: string
    kind: 'role-read'
    allowed_actions: string[]
    allowed_connections: string[]
    expires_in_seconds?: number
  }): Promise<{ token: string }>
  execute<T = unknown>(
    action_id: string,
    input: unknown,
    opts: { token: string; connection?: string },
  ): Promise<T>
}

/** 这条只读路用的分配 id（与建站巡检同一条纪律：它不是任何一个人的分配）。 */
const STORE_READ_ASSIGNMENT = 'asg_store_readonly'

/**
 * 在店铺连接上跑一组只读 Action。回一个 `run(name, input)`；没连 / 令牌签不下来回 `undefined`。
 * 一条读不到回 `undefined`（不抛）。
 */
export async function storeReader(
  connect: StoreConnectLike,
  connection: { id: string; service: string },
  names: readonly string[],
): Promise<((name: string, input?: unknown) => Promise<unknown>) | undefined> {
  let available: { id: string }[]
  try {
    available = await connect.actions(connection.service)
  } catch {
    return undefined
  }
  const idOf = (name: string): string | undefined =>
    available.find((a) => a.id === `${connection.service}.${name}` || a.id.endsWith(`.${name}`))?.id
  const allowed = names.map(idOf).filter((id): id is string => id !== undefined)
  if (allowed.length === 0) return undefined
  let token: string
  try {
    token = (
      await connect.issueToken({
        assignment_id: STORE_READ_ASSIGNMENT,
        kind: 'role-read',
        allowed_actions: allowed,
        allowed_connections: [connection.id],
        expires_in_seconds: 120,
      })
    ).token
  } catch {
    return undefined
  }
  return async (name, input = {}) => {
    const id = idOf(name)
    if (id === undefined) return undefined
    try {
      const out = await connect.execute(id, input, { token, connection: connection.id })
      return rec(out).data ?? out
    } catch {
      return undefined
    }
  }
}

/** 读店里配的市场：先看「市场」（Markets），读不到再看配送区域。 */
export async function readStoreMarkets(
  connect: StoreConnectLike,
  connection: { id: string; service: string },
): Promise<{ codes: string[]; from: 'markets' | 'shipping_zones' } | undefined> {
  const run = await storeReader(connect, connection, ['list_markets', 'list_shipping_zones'])
  if (run === undefined) return undefined
  const markets = countriesOfMarkets(await run('list_markets'))
  if (markets.length > 0) return { codes: markets, from: 'markets' }
  const zones = countriesOfZones(await run('list_shipping_zones'))
  if (zones.length > 0) return { codes: zones, from: 'shipping_zones' }
  return undefined
}

const SYNC_FILE = 'markets-store.json'

/**
 * 店铺连上以后校正一次。`check()` 挂在"连接清单变了"那一声上：找到一条活着的店铺连接、
 * 这条连接还没校正过，就读一遍、校正、记下"这条连接校正过了"（下次不再读）。永不抛。
 */
export function createStoreMarketsSync(options: {
  connect: StoreConnectLike
  connection(): { id: string; service: string } | undefined
  current(): { markets?: string[]; markets_source?: MarketsSource }
  apply(markets: string[], source: MarketsSource): boolean
  now(): string
  dir?: string
  /**
   * WP169：真改了档案之后（没改不调）——宿主拿它给工作区所有者推一条通知。
   * 抛了也不影响校正本身。
   */
  onChanged?(change: { markets: string[]; source: MarketsSource }): void | Promise<void>
}): { check(): Promise<{ changed: boolean; note?: string } | undefined> } {
  let memory: { checked?: string[] } = {}
  const load = (): { checked?: string[] } => {
    if (options.dir === undefined) return memory
    try {
      return JSON.parse(readFileSync(join(options.dir, SYNC_FILE), 'utf8')) as {
        checked?: string[]
      }
    } catch {
      return {}
    }
  }
  const save = (s: { checked?: string[] }): void => {
    memory = s
    if (options.dir === undefined) return
    try {
      writeFileSync(join(options.dir, SYNC_FILE), `${JSON.stringify(s, null, 2)}\n`, 'utf8')
    } catch {
      // 记不下来下次再校正一次，不碍事
    }
  }
  let running: Promise<{ changed: boolean; note?: string } | undefined> | undefined
  const once = async (): Promise<{ changed: boolean; note?: string } | undefined> => {
    const connection = options.connection()
    if (connection === undefined) return undefined
    const state = load()
    if (state.checked?.includes(connection.id) === true) return undefined
    const store = await readStoreMarkets(options.connect, connection)
    // 读不到不记"校正过"：可能只是令牌还没就绪，下一次连接变化再试
    if (store === undefined) return undefined
    save({ ...state, checked: [...(state.checked ?? []), connection.id] })
    const cur = options.current()
    const next = reconcileStoreMarkets({
      current: cur.markets,
      source: cur.markets_source,
      store: store.codes,
      from: store.from,
      at: options.now(),
    })
    if (next === undefined) return { changed: false }
    const changed = options.apply(next.markets, next.source)
    if (changed) {
      try {
        await options.onChanged?.({ markets: next.markets, source: next.source })
      } catch {
        // 通知推不出去不回滚校正：档案出处里那一句照样在设置页可见
      }
    }
    return changed && next.source.note !== undefined
      ? { changed, note: next.source.note }
      : { changed }
  }
  return {
    check() {
      running ??= once()
        .catch(() => undefined)
        .finally(() => {
          running = undefined
        })
      return running
    },
  }
}

/* ------------------------------------------------------------------ */
/* WP169：店铺校正改了市场 → 给工作区所有者推一条通知                     */
/* ------------------------------------------------------------------ */

/** 校正通知在首页告警区挂几天（没人动就自己退场；人改过市场当场退场）。 */
export const STORE_MARKETS_NOTICE_DAYS = 7

/** 点开去哪：设置页「公司档案」那一张（工作台按 `#company` 滚到那里）。 */
export const MARKETS_SETTINGS_PATH = '/settings#company'

/** 一次校正留下的那条通知（记在品牌目录里，重启还在）。 */
export interface StoreMarketsNotice {
  id: string
  /** 那一句人话（= 档案出处里的 `note`）。 */
  note: string
  markets: string[]
  /** = 档案出处的 `at`：出处还是这一次，通知才算没被处理。 */
  at: string
  /** 工作区所有者（只推给他）。 */
  owner: string
  /** 所有者那条 `common.owner` 分配（卡属于哪个岗位；找不到是空串）。 */
  position_id: string
}

const NOTICE_FILE = 'markets-notice.json'

/**
 * 校正通知：照 36 §2.2b「`system_alert` → 通知 + 告警块」那条现成的路走（06 §1.2 首页告警条），
 * 不是卡——它不要人拍板，只要人知道、要改去设置页改。
 *
 * - `push`：校正真改了市场才调（没改不推）；新的一条顶掉旧的；
 * - `alerts(person, source)`：只给所有者；档案出处已经不是这一次（人改过 / 又校正了一次）或过了
 *   {@link STORE_MARKETS_NOTICE_DAYS} 天就不再出。
 */
export function createStoreMarketsNotices(options: { dir?: string; now(): string }): {
  push(notice: StoreMarketsNotice): void
  current(): StoreMarketsNotice | undefined
  alerts(person_id: string, source: MarketsSource | undefined): DeckCard[]
} {
  let memory: StoreMarketsNotice | undefined
  const load = (): StoreMarketsNotice | undefined => {
    if (options.dir === undefined) return memory
    try {
      return JSON.parse(readFileSync(join(options.dir, NOTICE_FILE), 'utf8')) as StoreMarketsNotice
    } catch {
      return undefined
    }
  }
  return {
    push(notice) {
      memory = notice
      if (options.dir === undefined) return
      try {
        writeFileSync(
          join(options.dir, NOTICE_FILE),
          `${JSON.stringify(notice, null, 2)}\n`,
          'utf8',
        )
      } catch {
        // 记不下来只是重启后不再提醒，不碍事
      }
    },
    current: load,
    alerts(person_id, source) {
      const n = load()
      if (n === undefined || n.owner !== person_id) return []
      if (source?.from !== 'store' || source.at !== n.at) return []
      const age = Date.parse(options.now()) - Date.parse(n.at)
      if (!(age < STORE_MARKETS_NOTICE_DAYS * 86_400_000)) return []
      return [storeMarketsNoticeCard(n)]
    },
  }
}

/** 通知 → 首页告警区那一行（`system_alert`，点「去处理」到设置页公司档案）。 */
export function storeMarketsNoticeCard(n: StoreMarketsNotice): DeckCard {
  const title = `目标市场按店铺后台改了：${n.note.replace(/^按店铺后台的(「市场」|配送区域)(校正：)?/, '')}`
  const summary = `${n.note}。不对的话去设置页「公司档案」改。`
  const actions = actionsFor('system_alert', 'pending')
  return {
    id: n.id,
    kind: 'system_alert',
    layout: layoutFor('system_alert'),
    status: 'pending',
    priority_band: 'P3',
    priority: 'queue',
    risk_class: 'low',
    title,
    summary,
    content_variants: { zh_summary: summary },
    position_id: n.position_id,
    role_id: 'common.owner',
    channel: 'system',
    source: 'system',
    highlights: [],
    evidence_chips: [],
    entity_chips: [],
    available_actions: actions,
    action_labels: labelsFor('system_alert', actions),
    detail: {
      payload: { kind: 'markets_store_sync', open_path: MARKETS_SETTINGS_PATH, markets: n.markets },
      precheck: {},
      citations: [],
      links: { children: [] },
      created_at: n.at,
      updated_at: n.at,
      proposer: { kind: 'system', id: 'markets_store' },
      enrichment: { dropped_refs: 0 },
    },
    dedupe_key: `markets_store|${n.at}`,
    snooze_count: 0,
    merge_count: 1,
    version: 1,
  }
}
