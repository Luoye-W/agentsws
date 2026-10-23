/**
 * WP393（docs/104 一期 A，C1 / C5 / C8，决策 887 / 888）：网站运营 · 店铺管理「竞品动向」——
 * 方案卡（设置目标 `store.competitor_watch`）、探平台、自家比价、简报那一段、现在读一次。
 *
 * - **方案卡**：用户说「帮我盯一下竞品上新和价格」（或第一次用这一面时 AI 主动问一次）→ 读唯一工作清单
 *   `BrandWatch.competitors`（空着就按品牌档案里的竞品种）→ 每家探一次平台 → 卡上列出盯哪几家、每家走哪条路
 *   （一行人话）、哪几种变化算要紧（AI 按品类建议，C5）、多久读一次（默认一天一次）、对标款（C8）。
 *   用户只点「就这样 / 改一下 / 先不设」。存下就先读一次当底子；读不到的在连接卡亮红点（WP392）。
 * - 只读外部公开页面、不碰用户的外部账号 → **不出审批卡**（docs/104 §5 第 4 条）。
 * - **自家比价**：自家价从已连店铺读；对标款第一次读完由 AI 配（人改过的不动）；没连店就只报竞品自己的变化，
 *   照实说「连上你的店才能比价」。
 * - **简报**：有用户确认过的「要紧」变化、或有哪家没读到，才出「竞品动向」那一段；没有就不出（docs/96 P3）。
 */
import { normalizeStoreUrl } from '@agentsws/brand-intake'
import {
  type BrandWatch,
  type BrandWatchCompetitor,
  type BrandWatchStore,
  COMPETITOR_STORE_ROUTE_TEXT,
  COMPETITOR_STORE_TARGET,
  type CompetitorStorePlan,
  type CompetitorStoreRoute,
  type CompetitorWatchRun,
  type CompetitorWatchStore,
  type Iso8601,
  type SetupField,
  type StoreProbeResult,
  type WorkspaceId,
} from '@agentsws/contracts'
import { competitorId } from '@agentsws/seo-core'
import {
  type CompetitorBriefSection,
  competitorBriefSection,
  describeChange,
  formatPairs,
  isImportantChange,
  type OwnRef,
  ownRefFromPairs,
  parsePairs,
} from '@agentsws/social-core'
import { SetupCardError, type SetupTarget } from '../setup-cards.js'
import {
  DEFAULT_SOURCE,
  MODEL_SOURCE,
  type SetupPlan,
  type SetupResearchKit,
} from '../setup-research.js'
import type { OwnShopRead } from './own-shop.js'
import type { CompetitorWatchAssembly } from './service.js'
import {
  modelSuggestion,
  type RivalRows,
  ruleSuggestion,
  suggestProductPairs,
} from './store-suggest.js'

const PLAN_KEY = 'store_plan'
/** 人在卡上把对标款清空了：AI 不再自动配。 */
const PAIRS_LOCKED_KEY = 'store_pairs_locked'
const PROBE_PREFIX = 'store_probe:'
/** 探平台的结果多久算新（一周内不再探）。 */
export const PROBE_FRESH_MS = 7 * 86_400_000
/** 方案卡上最多列几家。 */
export const PLAN_COMPETITORS_MAX = 8

export interface CompetitorStoreDeps {
  workspace_id: WorkspaceId
  store: CompetitorWatchStore
  now(): Iso8601
  /** WP392 那条管道（同一个品牌的那一份）。 */
  watch(): CompetitorWatchAssembly
  /** 唯一工作清单（GEO 关注设置那份）。 */
  brandWatch(): Promise<Pick<BrandWatch, 'brand' | 'competitors'> | undefined>
  /** 写回唯一工作清单的竞品（不把 GEO 的设定卡标成「已定」）。 */
  saveCompetitors(list: BrandWatchCompetitor[]): Promise<void>
  /** 品牌档案里的几样（品类、AI 查到的竞品）。 */
  profile(): {
    name?: string
    category?: string
    subcategory?: string
    competitors?: { name: string; url?: string }[]
  }
  /** 探平台（本机直接请求 → 被挡改走内置浏览器；算额度）。 */
  probe(url: string): Promise<StoreProbeResult>
  /** 自家店的商品（已连店铺；没连 = `connected: false`）。 */
  ownShop(): Promise<OwnShopRead>
  /** 问一次模型（对标款用；没模型不给）。 */
  ask?(prompt: string): Promise<string | undefined>
}

export interface ReadNowResult {
  ok: boolean
  message: string
  needs_setup?: string
  read?: {
    competitor: string
    status: string
    rows: number
    changes: number
    baseline?: boolean
    complete?: boolean
    message?: string
  }[]
  changes?: string[]
  important?: string[]
}

export interface CompetitorStoreAssembly {
  plan(): CompetitorStorePlan | undefined
  setupTarget(): SetupTarget
  /** 探平台工具：探一家、写进竞品清单。 */
  find(input: { competitor?: string; url?: string }): Promise<
    | {
        ok: true
        competitor?: string
        url: string
        platform: StoreProbeResult['platform']
        how: string
        reason?: string
        saved: boolean
      }
    | { ok: false; message: string }
  >
  /** 现在读一次（还没配好 → `needs_setup`）。 */
  readNow(input: { competitor?: string }): Promise<ReadNowResult>
  /** C8：这一轮的比价口（对标款 + 自家现价；没连店 / 没配对标款 = `undefined`）。 */
  ownRef(): Promise<
    ((row: import('@agentsws/contracts').CatalogSnapshotRow) => OwnRef | undefined) | undefined
  >
  /** 一轮读完：第一次读完自动配对标款（人改过 / 清空过的不动）。 */
  afterRun(run: CompetitorWatchRun): Promise<void>
  /** 简报那一段（方案没确认过、没有要紧的、也没有哪家没读到 → 不出）。 */
  brief(now?: Iso8601): CompetitorBriefSection | undefined
  /** 存下方案后「先读一次当底子」那一轮（测试等它）。 */
  pending(): Promise<unknown> | undefined
}

export const routeText = (route: CompetitorStoreRoute): string =>
  COMPETITOR_STORE_ROUTE_TEXT[route].zh

const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

/** 已存的平台 → 走哪条路（没探过 / 探不出就按「读的时候再探」说）。 */
const routeOfStore = (s: BrandWatchStore, via?: string): string =>
  s.platform === 'other'
    ? routeText('unsupported')
    : s.platform === 'unknown'
      ? '上次没探出来，读的时候再探一次'
      : via === 'browser'
        ? routeText('browser')
        : routeText('direct')

const fieldKey = (id: string): string => `store__${id}`

type ToggleKey = 'cheaper_than_own' | 'new_products' | 'discounts' | 'stock'
const TOGGLES: readonly [ToggleKey, string][] = [
  ['cheaper_than_own', '降价后比你便宜就算要紧'],
  ['new_products', '上新算要紧'],
  ['discounts', '开始打折算要紧'],
  ['stock', '断货 / 补货算要紧'],
]

const EVERY = [
  { value: '24', label: '每天一次' },
  { value: '12', label: '每 12 小时' },
  { value: '168', label: '每周一次' },
]

interface Candidate {
  id: string
  name: string
  url?: string
  saved?: BrandWatchStore
  /** 档案里种的（清单里还没有）。 */
  seeded: boolean
}

export function createCompetitorStore(deps: CompetitorStoreDeps): CompetitorStoreAssembly {
  const { store } = deps
  let pending: Promise<unknown> | undefined
  const readPlan = (): CompetitorStorePlan | undefined =>
    store.kv<CompetitorStorePlan | null>(PLAN_KEY) ?? undefined
  const writePlan = (p: CompetitorStorePlan): void => store.setKv(PLAN_KEY, p)

  /** 探平台（一周内探过的直接用；结果按问的地址和落点各记一份）。 */
  const probeCached = async (url: string, fresh = false): Promise<StoreProbeResult> => {
    const origin = normalizeStoreUrl(url) ?? url.trim()
    const hit = store.kv<StoreProbeResult>(`${PROBE_PREFIX}${origin}`)
    if (
      !fresh &&
      hit !== undefined &&
      Date.parse(deps.now()) - Date.parse(hit.checked_at) < PROBE_FRESH_MS
    )
      return hit
    const r = await deps.probe(origin)
    store.setKv(`${PROBE_PREFIX}${origin}`, r)
    if (r.url !== origin) store.setKv(`${PROBE_PREFIX}${r.url}`, r)
    return r
  }

  /** 方案卡上列哪几家：清单里的；清单空着就按品牌档案种（C3：不另建清单）。 */
  const candidates = async (): Promise<Candidate[]> => {
    const list = (await deps.brandWatch())?.competitors ?? []
    if (list.length > 0)
      return list.slice(0, PLAN_COMPETITORS_MAX).map((c) => {
        const url =
          c.store?.url ?? (c.domains[0] === undefined ? undefined : `https://${c.domains[0]}`)
        return {
          id: c.id,
          name: c.name,
          ...(url === undefined ? {} : { url }),
          ...(c.store === undefined ? {} : { saved: c.store }),
          seeded: false,
        }
      })
    const seen = new Set<string>()
    const out: Candidate[] = []
    for (const c of deps.profile().competitors ?? []) {
      const name = c.name.trim()
      const id = competitorId(name)
      if (name === '' || seen.has(id)) continue
      seen.add(id)
      out.push({ id, name, ...(c.url === undefined ? {} : { url: c.url }), seeded: true })
    }
    return out.slice(0, PLAN_COMPETITORS_MAX)
  }

  const viaOf = (id: string): string | undefined =>
    store.sources().find((s) => s.id === `cw_shop_${id}`)?.last_via

  /** 竞品那几家的快照行（对标款用）。 */
  const rivals = async (): Promise<RivalRows[]> => {
    const names = new Map(((await deps.brandWatch())?.competitors ?? []).map((c) => [c.id, c.name]))
    return store
      .sources()
      .filter((s) => s.kind === 'shop_catalog' && s.competitor_id !== '_own')
      .map((s) => ({
        competitor_id: s.competitor_id,
        name: names.get(s.competitor_id) ?? s.label,
        rows: (store.snapshot(s.id)?.rows ?? []).filter((r) => r.removed !== true),
      }))
      .filter((r) => r.rows.length > 0)
  }

  const namesMap = async (): Promise<Map<string, string>> =>
    new Map(((await deps.brandWatch())?.competitors ?? []).map((c) => [c.id, c.name]))

  const toggle = (key: string, label: string, value: boolean | undefined): SetupField => ({
    key,
    label,
    kind: 'toggle',
    ...(value === undefined ? {} : { suggested: value ? 'true' : 'false' }),
    required: false,
  })

  const target: SetupTarget = {
    id: COMPETITOR_STORE_TARGET,
    name: '竞品动向',
    why: '我打算盯这几家竞品的独立站：每家走哪条路写在下面；哪几种变化算要紧是按你的品类给的建议。点「就这样」我就先读一次当底子，之后有要紧的才进每天简报。',
    async fields() {
      const plan = readPlan()
      const cands = await candidates()
      const settings = store.settings()
      const fields: SetupField[] = cands.map((c) => ({
        key: fieldKey(c.id),
        label: c.name,
        kind: 'url',
        placeholder: 'https://…（空着 = 不盯这家）',
        required: false,
        ...(c.saved === undefined
          ? {}
          : {
              suggested: c.saved.url,
              suggested_why: routeOfStore(c.saved, viaOf(c.id)),
              sources: [{ kind: 'saved' as const, label: '竞品清单' }],
            }),
      }))
      fields.push({
        key: 'more',
        label: '再加几家',
        kind: 'text',
        placeholder: '名字 + 官网，如：Rad Power radpowerbikes.com；逗号或分号分开',
        required: false,
      })
      fields.push({
        key: 'price_drop_pct',
        label: '降价多少算要紧（%）',
        kind: 'number',
        ...(plan?.rules.price_drop_pct === undefined
          ? {}
          : { suggested: String(plan.rules.price_drop_pct) }),
        required: false,
      })
      for (const [k, label] of TOGGLES)
        fields.push(toggle(k, label, plan === undefined ? undefined : plan.rules[k] === true))
      fields.push({
        key: 'every_hours',
        label: '多久读一次',
        kind: 'select',
        options: EVERY.some((e) => e.value === String(settings.every_hours))
          ? EVERY
          : [
              ...EVERY,
              { value: String(settings.every_hours), label: `每 ${settings.every_hours} 小时` },
            ],
        suggested: String(settings.every_hours),
        ...(plan === undefined ? { suggested_why: '默认一天一次' } : {}),
        required: true,
      })
      const pairsText = plan === undefined ? '' : formatPairs(plan.pairs, await namesMap())
      fields.push({
        key: 'pairs',
        label: '对标款（竞品款 = 你的款）',
        kind: 'text',
        placeholder: 'Aventon · Level 3 = Ranger；一行一对',
        ...(pairsText === '' ? {} : { suggested: pairsText }),
        required: false,
      })
      return fields
    },
    async satisfied() {
      return readPlan() !== undefined
    },
    research: (kit) => research(kit),
    apply: (values) => apply(values),
  }

  async function research(kit: SetupResearchKit): Promise<SetupPlan> {
    const plan: SetupPlan = {}
    const cands = await candidates()
    if (cands.length === 0) {
      kit.note('竞品清单和品牌档案里都还没有竞品：在「再加几家」里写上名字和官网就能盯')
      plan.more = { needs_you: true, why: '还不知道盯哪几家，写上名字和官网' }
    }
    for (const c of cands) {
      if (c.saved !== undefined && c.saved.platform !== 'unknown') continue
      if (c.url === undefined) {
        plan[fieldKey(c.id)] = { needs_you: true, why: '档案里没有它的官网，填上就能盯' }
        continue
      }
      const r = await probeCached(c.url)
      const how =
        r.route === 'unsupported' && r.reason !== undefined ? r.reason : routeText(r.route)
      kit.note(`${c.name}：${how}`, { kind: 'web', label: hostOf(r.url), url: r.url })
      plan[fieldKey(c.id)] = {
        value: r.route === 'unreachable' ? '' : r.url,
        why: r.route === 'blocked' && r.reason !== undefined ? `${how}（${r.reason}）` : how,
        sources: [{ kind: 'web', label: hostOf(r.url), url: r.url }],
        ...(r.route === 'unreachable' ? { needs_you: true } : {}),
      }
    }
    const own = await deps.ownShop()
    const facts = await kit
      .profile()
      .catch(() => ({}) as Awaited<ReturnType<SetupResearchKit['profile']>>)
    const category =
      facts.subcategory ?? facts.category ?? deps.profile().subcategory ?? deps.profile().category
    const input = {
      ...(category === undefined ? {} : { category }),
      own: own.products,
      connected: own.connected,
    }
    const s = (await modelSuggestion((p) => kit.ask(p), input)) ?? ruleSuggestion(input)
    const src = s.by === 'model' ? [MODEL_SOURCE] : [DEFAULT_SOURCE]
    if (s.rules.price_drop_pct !== undefined)
      plan.price_drop_pct = { value: String(s.rules.price_drop_pct), why: s.why, sources: src }
    for (const [k] of TOGGLES)
      plan[k] = {
        value: s.rules[k] === true ? 'true' : 'false',
        ...(k === 'cheaper_than_own' && !own.connected
          ? { why: '连上你的店才能比价' }
          : k === 'stock' && s.rules.stock !== true
            ? { why: '断货补货多半是个别款式，先不算' }
            : {}),
        sources: src,
      }
    plan.every_hours = { value: '24', why: '默认一天一次', sources: [DEFAULT_SOURCE] }
    if (!own.connected) plan.pairs = { why: '连上你的店才能比价，先只报竞品自己的变化' }
    else {
      const rv = await rivals()
      if (rv.length === 0) plan.pairs = { why: '第一次读完我按标题和价位配好对标款，你随时能改' }
      else {
        const brand = (await deps.brandWatch())?.brand.name ?? deps.profile().name ?? ''
        const got = await suggestProductPairs((p) => kit.ask(p), {
          rivals: rv,
          own: own.products,
          own_brand: brand,
          keep: readPlan()?.pairs ?? [],
        })
        const text = formatPairs(got.pairs, await namesMap())
        plan.pairs = {
          ...(text === '' ? {} : { value: text }),
          why:
            got.by === 'model'
              ? 'AI 按标题和品类配的，点「修改」就按你的'
              : '按标题和价位配的，点「修改」就按你的',
          sources: got.by === 'model' ? [MODEL_SOURCE] : [DEFAULT_SOURCE],
        }
      }
    }
    return plan
  }

  /** 「再加几家」：`名字 官网` 一项，逗号 / 分号 / 换行分开；只写官网就拿域名当名字。 */
  const parseMore = (raw: string): { items: { name: string; url: string }[]; bad: string[] } => {
    const items: { name: string; url: string }[] = []
    const bad: string[] = []
    for (const part of raw.split(/[,，;；\n]/u)) {
      const t = part.trim()
      if (t === '') continue
      const words = t.split(/\s+/u)
      const last = words[words.length - 1] ?? ''
      const url = normalizeStoreUrl(last)
      if (url === undefined) {
        bad.push(t)
        continue
      }
      const host = hostOf(url)
      const name = words.slice(0, -1).join(' ').trim() || host.split('.')[0] || host
      items.push({ name, url })
    }
    return { items, bad }
  }

  async function apply(values: Record<string, string>): Promise<void> {
    const cands = await candidates()
    const list = [...((await deps.brandWatch())?.competitors ?? [])]
    const storeOf = async (name: string, raw: string): Promise<BrandWatchStore> => {
      const origin = normalizeStoreUrl(raw)
      if (origin === undefined)
        throw new SetupCardError('invalid_input', `${name} 的官网地址认不出：${raw}`)
      const r = await probeCached(origin)
      const found = r.platform === 'shopify' || r.platform === 'woocommerce'
      return { url: found ? r.url : origin, platform: r.platform, checked_at: r.checked_at }
    }
    for (const c of cands) {
      const raw = values[fieldKey(c.id)]?.trim() ?? ''
      const at = list.findIndex((x) => x.id === c.id)
      if (raw === '') {
        // 空着 = 不盯这家（清单里的竞品留着，只去掉店址那一格）
        if (at >= 0 && list[at]?.store !== undefined) {
          const { store: _s, ...rest } = list[at] as BrandWatchCompetitor
          list[at] = rest
        }
        continue
      }
      const s =
        c.saved !== undefined &&
        normalizeStoreUrl(raw) === normalizeStoreUrl(c.saved.url) &&
        c.saved.platform !== 'unknown'
          ? c.saved
          : await storeOf(c.name, raw)
      if (at >= 0) list[at] = { ...(list[at] as BrandWatchCompetitor), store: s }
      else list.push({ id: c.id, name: c.name, aliases: [], domains: [hostOf(s.url)], store: s })
    }
    const more = parseMore(values.more ?? '')
    if (more.bad.length > 0)
      throw new SetupCardError(
        'invalid_input',
        `「再加几家」认不出：${more.bad.slice(0, 3).join('、')}。写成「名字 官网」，如 Rad Power radpowerbikes.com。`,
      )
    for (const m of more.items) {
      const id = competitorId(m.name)
      if (list.some((x) => x.id === id || x.name.toLowerCase() === m.name.toLowerCase())) continue
      list.push({
        id,
        name: m.name,
        aliases: [],
        domains: [hostOf(m.url)],
        store: await storeOf(m.name, m.url),
      })
    }
    const pctRaw = values.price_drop_pct?.trim() ?? ''
    const pct = Number(pctRaw)
    if (pctRaw !== '' && (!Number.isFinite(pct) || pct <= 0 || pct > 90))
      throw new SetupCardError('invalid_input', '降价幅度写 1–90 之间的数（不填 = 不按幅度算）。')
    const rules: CompetitorStorePlan['rules'] = {
      ...(pctRaw === '' ? {} : { price_drop_pct: Math.round(pct * 10) / 10 }),
    }
    for (const [k] of TOGGLES) rules[k] = values[k] === 'true'
    const cur = readPlan()
    const names = new Map(list.map((c) => [c.id, c.name]))
    const curText = formatPairs(cur?.pairs ?? [], names)
    const pairsText = values.pairs?.trim() ?? ''
    let pairs = cur?.pairs ?? []
    if (pairsText !== curText) {
      if (pairsText === '') {
        pairs = []
        store.setKv(PAIRS_LOCKED_KEY, true)
      } else {
        const own = await deps.ownShop()
        const got = parsePairs(pairsText, { rivals: await rivals(), own: own.products })
        if (got.bad.length > 0)
          throw new SetupCardError(
            'invalid_input',
            `对标款里这几对认不出：${got.bad.slice(0, 3).join('、')}。写成「竞品 · 款 = 你的款」。`,
          )
        pairs = got.pairs
        store.setKv(PAIRS_LOCKED_KEY, false)
      }
    }
    await deps.saveCompetitors(list)
    const facts = deps.profile()
    const category = facts.subcategory ?? facts.category
    writePlan({
      rules,
      pairs,
      confirmed_at: deps.now(),
      ...(category === undefined ? {} : { category }),
    })
    const every = Number(values.every_hours)
    const cw = deps.watch()
    if (Number.isFinite(every) && every > 0) cw.updateSettings({ every_hours: every })
    // 存下就先读一次当底子（第一次读只建底子、不报上新；读不到的在连接卡亮红点）
    pending = cw.runNow({ trigger: 'added' }).catch(() => undefined)
  }

  const findCompetitor = (list: readonly BrandWatchCompetitor[], q: string | undefined) => {
    const k = q?.trim().toLowerCase()
    if (k === undefined || k === '') return undefined
    return list.find(
      (c) =>
        c.id.toLowerCase() === k ||
        c.name.toLowerCase() === k ||
        c.aliases.some((a) => a.toLowerCase() === k) ||
        c.domains.some((d) => d.toLowerCase() === k),
    )
  }

  return {
    plan: readPlan,
    setupTarget: () => target,
    async find(input) {
      const list = [...((await deps.brandWatch())?.competitors ?? [])]
      const c = findCompetitor(list, input.competitor)
      const url =
        input.url?.trim() ||
        c?.store?.url ||
        (c?.domains[0] === undefined ? undefined : `https://${c.domains[0]}`)
      if (url === undefined || url === '')
        return {
          ok: false,
          message:
            input.competitor === undefined
              ? '给一个官网地址，或者说是竞品清单里的哪一家。'
              : `竞品清单里没有「${input.competitor}」的官网：给一个地址就能探。`,
        }
      const r = await probeCached(url, true)
      let saved = false
      if (c !== undefined && r.route !== 'unreachable') {
        const found = r.platform === 'shopify' || r.platform === 'woocommerce'
        const origin = normalizeStoreUrl(url) ?? r.url
        const next = list.map((x) =>
          x.id === c.id
            ? {
                ...x,
                store: {
                  url: found ? r.url : origin,
                  platform: r.platform,
                  checked_at: r.checked_at,
                },
              }
            : x,
        )
        await deps.saveCompetitors(next)
        saved = true
      }
      return {
        ok: true,
        ...(c === undefined ? {} : { competitor: c.name }),
        url: r.url,
        platform: r.platform,
        how: r.route === 'unsupported' && r.reason !== undefined ? r.reason : routeText(r.route),
        ...(r.reason === undefined ? {} : { reason: r.reason }),
        saved,
      }
    },
    async readNow(input) {
      if (readPlan() === undefined)
        return {
          ok: false,
          message: '还没定盯哪几家：先出一张方案卡，你点头我就读。',
          needs_setup: COMPETITOR_STORE_TARGET,
        }
      const cw = deps.watch()
      const all = (await cw.sync()).filter((s) => s.kind === 'shop_catalog' && s.paused !== true)
      const q = input.competitor?.trim().toLowerCase()
      const ids = all
        .filter(
          (s) =>
            q === undefined ||
            q === '' ||
            s.competitor_id.toLowerCase() === q ||
            s.label.toLowerCase() === q,
        )
        .map((s) => s.id)
      if (ids.length === 0)
        return {
          ok: false,
          message:
            q === undefined || q === ''
              ? '竞品清单里还没有写了官网的竞品。'
              : `竞品清单里没有「${input.competitor}」的官网。`,
          ...(q === undefined || q === '' ? { needs_setup: COMPETITOR_STORE_TARGET } : {}),
        }
      const run = await cw.runNow({ source_ids: ids, trigger: 'manual' })
      const changes = store
        .changes({ since: run.started_at })
        .filter((c) => ids.includes(c.source_id))
      const rules = readPlan()?.rules
      return {
        ok: true,
        message: run.parts.every((p) => (p as { baseline?: boolean }).baseline === true)
          ? '第一次读，只建了底子（不报上新），下一次起和这次比。'
          : `读完了，比出 ${changes.length} 条变化。`,
        read: run.parts.map((p) => ({
          competitor: p.label,
          status: p.status,
          rows: p.fetched,
          changes: p.changes,
          ...(p.baseline === true ? { baseline: true } : {}),
          ...(p.complete === undefined ? {} : { complete: p.complete }),
          ...(p.message === undefined ? {} : { message: p.message }),
        })),
        changes: changes.slice(0, 30).map((c) => describeChange(c, { withCompetitor: true })),
        important: changes
          .filter((c) => isImportantChange(c, rules))
          .map((c) => describeChange(c, { withCompetitor: true })),
      }
    },
    async ownRef() {
      const plan = readPlan()
      if (plan === undefined || plan.pairs.length === 0) return undefined
      const own = await deps.ownShop()
      return own.connected ? ownRefFromPairs(plan.pairs, own.products) : undefined
    },
    async afterRun(_run) {
      const plan = readPlan()
      if (plan === undefined || store.kv<boolean>(PAIRS_LOCKED_KEY) === true) return
      const rv = await rivals()
      // 已经配过的竞品不再配（AI 配的也留着，免得每天翻来覆去）；没配过的那几家才配
      const paired = new Set(plan.pairs.map((p) => p.competitor_id))
      const fresh = rv.filter((r) => !paired.has(r.competitor_id))
      if (fresh.length === 0) return
      const own = await deps.ownShop()
      if (!own.connected || own.products.length === 0) return
      const brand = (await deps.brandWatch())?.brand.name ?? deps.profile().name ?? ''
      const got = await suggestProductPairs(deps.ask, {
        rivals: fresh,
        own: own.products,
        own_brand: brand,
        keep: [],
      })
      if (got.pairs.length === 0) return
      writePlan({ ...plan, pairs: [...plan.pairs, ...got.pairs] })
    },
    brief(now) {
      const plan = readPlan()
      if (plan === undefined) return undefined
      const t = Date.parse(now ?? deps.now())
      const since = new Date(t - 86_400_000).toISOString()
      const changes = store.changes({ since, source_kind: 'shop_catalog' })
      const failed = store
        .sources()
        .filter(
          (s) =>
            s.kind === 'shop_catalog' &&
            s.paused !== true &&
            s.status === 'failed' &&
            s.platform !== 'other',
        )
        .map((s) => s.label)
      return competitorBriefSection({ changes, rules: plan.rules, failed })
    },
    pending: () => pending,
  }
}
