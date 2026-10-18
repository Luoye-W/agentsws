/**
 * WP394（docs/104 一期 B，C5 / C6 / C8，决策 887 / 888）：亚马逊店铺运营「竞品动向」——
 * 方案卡（设置目标 `amazon.competitor_watch`）、现在读一次。
 *
 * - **方案卡**：用户说「帮我盯 Amazon 上的竞品」（或第一次进岗位时 AI 主动问一次）→ 读唯一工作清单
 *   `BrandWatch.competitors`（空着就按品牌档案里的竞品种）→ 用内置浏览器在 Amazon 搜「品牌名 + 品类」，
 *   按品牌对得上、评论多、和自家商品同类，每家建议几个对标款（默认最多 5 个，C6 不定死）、各对标自家哪一款（`vs_own`）。
 *   自家 ASIN 从关注设置那一格读（`BrandWatch.brand.amazon`，和 WP396 自家 Listing 体检同一格），读不到就要
 *   一个店铺 / 商品链接（不让用户从零列）。卡上还有：哪几种变化算重要（AI 按品类建议，C5 不预设）、多久读一次。
 *   用户只点「就这样 / 改一下 / 先不设」。存下就先读一次当底子。
 * - 只读 Amazon 前台公开页面，不登录、不碰 Seller Central → **不出审批卡**。
 * - 技术上限：一个品牌最多 100 个 ASIN（和云端接口一致），不另定规矩。
 */
import {
  type AmazonBenchmarkPick,
  amazonHostOfMarket,
  classifyAmazonUrl,
  isImportantAmazonChange,
  suggestAmazonBenchmarks,
  suggestAmazonRules,
} from '@agentsws/brand-intake'
import {
  AMAZON_ASINS_MAX,
  AMAZON_COMPETITOR_TARGET,
  type AmazonCompetitorPlan,
  type AmazonImportanceRules,
  type BrandWatch,
  type BrandWatchAmazonItem,
  type BrandWatchCompetitor,
  type CompetitorWatchStore,
  type Iso8601,
  type SetupField,
  type WorkspaceId,
} from '@agentsws/contracts'
import { competitorId } from '@agentsws/seo-core'
import type { AmazonFrontReader } from '../amazon-front/reader.js'
import { SetupCardError, type SetupTarget } from '../setup-cards.js'
import {
  DEFAULT_SOURCE,
  MODEL_SOURCE,
  type SetupPlan,
  type SetupResearchKit,
} from '../setup-research.js'
import type { CompetitorWatchAssembly } from './service.js'

const PLAN_KEY = 'amazon_plan'
/** 挑对标款时搜到的卡片（apply 时给 ASIN 配上标题）。 */
const PICKS_KEY = 'amazon_picks'
/** 走云端扣的积分流水（「这次扣了多少」那一句用）。 */
export const AMAZON_CREDITS_KEY = 'amazon_credits'
/** 方案卡上最多列几家。 */
export const AMAZON_PLAN_COMPETITORS_MAX = 8
/** 每家默认最多建议几个对标款（C6：只是建议，卡上能改）。 */
export const AMAZON_PICKS_PER_COMPETITOR = 5

const ASIN_RE = /^[A-Z0-9]{10}$/
const fieldKey = (id: string): string => `amz__${id}`
const MARKETS = ['US', 'CA', 'MX', 'GB', 'DE', 'FR', 'IT', 'ES', 'JP', 'AU', 'IN'] as const
const EVERY = [
  { value: '24', label: '每天一次' },
  { value: '48', label: '每两天一次' },
  { value: '168', label: '每周一次' },
]
type RuleToggle = 'cheaper_than_own' | 'discounts' | 'stock'
type RuleNumber = 'price_drop_pct' | 'rating_below' | 'bsr_move_pct'
// WP420（自查 U15）：标签改短（标签列窄，长的折成两三行）；「算重要」的意思在卡头那一句里说一次
const TOGGLES: readonly [RuleToggle, string][] = [
  ['cheaper_than_own', '比我便宜'],
  ['discounts', '优惠券 / 划线价'],
  ['stock', '断货 / 补货'],
]
const NUMBERS: readonly [RuleNumber, string, number, number][] = [
  ['price_drop_pct', '降价线（%）', 1, 90],
  ['rating_below', '评分线（星）', 1, 5],
  ['bsr_move_pct', '排名线（%）', 1, 1000],
]

export interface AmazonCompetitorDeps {
  workspace_id: WorkspaceId
  store: CompetitorWatchStore
  now(): Iso8601
  watch(): CompetitorWatchAssembly
  brandWatch(): Promise<Pick<BrandWatch, 'brand' | 'competitors'> | undefined>
  /** 写回唯一工作清单（竞品的 Amazon 格 + 自家 ASIN；不把 GEO 的设定卡标成「已定」）。 */
  saveWatch(patch: {
    competitors: BrandWatchCompetitor[]
    brand_amazon: BrandWatchAmazonItem[]
  }): Promise<void>
  /** 品牌档案里的几样（品类、目标市场、AI 查到的竞品、读到过的自家 ASIN）。 */
  profile(): {
    name?: string
    category?: string
    subcategory?: string
    markets?: string[]
    competitors?: { name: string }[]
    asins?: { asin: string; title?: string }[]
  }
  /** 读前台那一块（没有 = 这台没有桌面壳：方案卡上要人填 ASIN）。 */
  reader(): AmazonFrontReader | undefined
}

/** 这一次读完交回去的（工具出参，白名单）。 */
export interface AmazonReadNowResult {
  needs_setup?: string
  message?: string
  read?: { label: string; status: string; via?: string; note?: string }[]
  changes?: {
    competitor: string
    kind: string
    title: string
    url?: string
    before?: unknown
    after?: unknown
    pct?: number
    vs_own?: { own: string; diff: number; currency?: string }
    important: boolean
  }[]
  /** 这一次走云端扣了多少积分（没走云端不给）。 */
  credits?: number
  /** 要对用户说的那一句（被拦了、扣了积分、哪家没读到）。 */
  say?: string
}

export interface AmazonCompetitorAssembly {
  plan(): AmazonCompetitorPlan | undefined
  setupTarget(): SetupTarget
  readNow(input: { competitor?: string }): Promise<AmazonReadNowResult>
  /** 一次读里走云端扣的积分记一笔（适配器调）。 */
  noteCredits(source_id: string, credits: number): void
}

/** 「B0X = B0OWN；B0Y」一格 → 几款（`vs_own` 可空）；认不出的那几段另交回。 */
export function parseAmazonPairs(raw: string): {
  items: { asin: string; vs_own?: string }[]
  bad: string[]
} {
  const items: { asin: string; vs_own?: string }[] = []
  const bad: string[] = []
  for (const part of raw.split(/[;；\n,，、]+/u)) {
    const t = part.trim()
    if (t === '') continue
    const [left = '', right] = t.split(/\s*[=＝]\s*/u)
    const asin = asinOf(left)
    const own = right === undefined || right.trim() === '' ? undefined : asinOf(right)
    if (asin === undefined || (right !== undefined && right.trim() !== '' && own === undefined)) {
      bad.push(t)
      continue
    }
    if (items.some((x) => x.asin === asin)) continue
    items.push(own === undefined ? { asin } : { asin, vs_own: own })
  }
  return { items, bad }
}

/** 一段字 → ASIN（直接写的、或商品链接里的）；认不出回 `undefined`。 */
function asinOf(raw: string): string | undefined {
  const t = raw.trim()
  if (ASIN_RE.test(t.toUpperCase())) return t.toUpperCase()
  const e = /^https?:\/\//i.test(t) ? classifyAmazonUrl(t) : undefined
  return e?.kind === 'amazon_listing' ? e.asin : undefined
}

const formatPicks = (picks: readonly { asin: string; vs_own?: string }[]): string =>
  picks.map((p) => (p.vs_own === undefined ? p.asin : `${p.asin} = ${p.vs_own}`)).join('；')

const clampNum = (
  raw: string | undefined,
  lo: number,
  hi: number,
  label: string,
): number | undefined => {
  const t = raw?.trim() ?? ''
  if (t === '') return undefined
  const n = Number(t)
  if (!Number.isFinite(n) || n < lo || n > hi)
    throw new SetupCardError(
      'invalid_input',
      `${label}写 ${lo}–${hi} 之间的数（不填 = 不按这一条算）。`,
    )
  return Math.round(n * 10) / 10
}

/** 模型给的「什么算重要」（JSON）；认不出回 `undefined`（退到规则版）。 */
function rulesFromModel(
  text: string | undefined,
): { rules: AmazonImportanceRules; why: string } | undefined {
  const raw = text === undefined ? undefined : /\{[\s\S]*\}/.exec(text)?.[0]
  if (raw === undefined) return undefined
  try {
    const j = JSON.parse(raw) as Record<string, unknown>
    const n = (v: unknown, lo: number, hi: number): number | undefined =>
      typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : undefined
    const rules: AmazonImportanceRules = {}
    const pd = n(j.price_drop_pct, 1, 90)
    if (pd !== undefined) rules.price_drop_pct = pd
    const rb = n(j.rating_below, 1, 5)
    if (rb !== undefined) rules.rating_below = rb
    const bm = n(j.bsr_move_pct, 1, 1000)
    if (bm !== undefined) rules.bsr_move_pct = bm
    for (const [k] of TOGGLES) {
      const v = j[k]
      if (typeof v === 'boolean') rules[k] = v
    }
    const why =
      typeof j.why === 'string' && j.why.trim() !== '' ? j.why.trim().slice(0, 200) : undefined
    if (Object.keys(rules).length === 0 || why === undefined) return undefined
    return { rules, why }
  } catch {
    return undefined
  }
}

export function createAmazonCompetitor(deps: AmazonCompetitorDeps): AmazonCompetitorAssembly {
  const { store } = deps
  const readPlan = (): AmazonCompetitorPlan | undefined =>
    store.kv<AmazonCompetitorPlan | null>(PLAN_KEY) ?? undefined
  const picksOf = (): Record<string, AmazonBenchmarkPick[]> =>
    store.kv<Record<string, AmazonBenchmarkPick[]>>(PICKS_KEY) ?? {}
  const savePicks = (id: string, picks: AmazonBenchmarkPick[]): void =>
    store.setKv(PICKS_KEY, { ...picksOf(), [id]: picks })

  const marketOf = (markets: readonly string[] | undefined): string => {
    const saved = readPlan()?.marketplace
    if (saved !== undefined) return saved
    const hit = (markets ?? [])
      .map((m) => m.trim().toUpperCase())
      .find((m) => amazonHostOfMarket(m) !== undefined)
    return hit === 'UK' ? 'GB' : (hit ?? 'US')
  }

  /** 方案卡上列的几家：唯一工作清单里的；空着就按品牌档案里的竞品种。 */
  const candidates = async (): Promise<
    { id: string; name: string; aliases: string[]; saved: BrandWatchAmazonItem[] }[]
  > => {
    const listed = (await deps.brandWatch())?.competitors ?? []
    const src =
      listed.length > 0
        ? listed.map((c) => ({ id: c.id, name: c.name, aliases: c.aliases, saved: c.amazon ?? [] }))
        : (deps.profile().competitors ?? []).map((c) => ({
            id: competitorId(c.name),
            name: c.name,
            aliases: [] as string[],
            saved: [] as BrandWatchAmazonItem[],
          }))
    return src.slice(0, AMAZON_PLAN_COMPETITORS_MAX)
  }

  /** 自家几款（标题、价）：先看自家那条源的快照，没有就用档案里读到过的。 */
  /** WP420（自查 B5）：按品牌名搜一页，标题里带品牌名、不是广告位的前几款当自家候选。 */
  const ownByBrandName = async (
    mk: string,
    name: string | undefined,
  ): Promise<BrandWatchAmazonItem[]> => {
    const reader = deps.reader()
    const brand = (name ?? '').trim()
    if (brand === '' || reader === undefined || !reader.ready()) return []
    const got = await reader.searchCards({ marketplace: mk, query: brand }).catch(() => undefined)
    if (got?.status !== 'ok') return []
    return ownCandidatesFromCards(got.cards, brand).map((c) => ({
      marketplace: mk,
      asin: c.asin,
      label: c.title.slice(0, 80),
    }))
  }

  const ownList = (mk: string, own: readonly BrandWatchAmazonItem[]) => {
    const rows = store.snapshot(`cw_amz__own_${mk}`)?.rows ?? []
    const fromProfile = new Map(
      (deps.profile().asins ?? []).map((a) => [a.asin.toUpperCase(), a.title]),
    )
    return own
      .filter((o) => o.marketplace.toUpperCase() === mk)
      .map((o) => {
        const r = rows.find((x) => x.product_key === o.asin.toUpperCase())
        const title = r?.title ?? o.label ?? fromProfile.get(o.asin.toUpperCase())
        return {
          asin: o.asin.toUpperCase(),
          ...(title === undefined ? {} : { title }),
          ...(r?.price === undefined ? {} : { price: r.price }),
        }
      })
  }

  const toggle = (key: string, label: string, value: boolean | undefined): SetupField => ({
    key,
    label,
    kind: 'toggle',
    ...(value === undefined ? {} : { suggested: value ? 'true' : 'false' }),
    required: false,
  })

  const target: SetupTarget = {
    id: AMAZON_COMPETITOR_TARGET,
    name: 'Amazon 竞品',
    why: '我打算盯这几家竞品在 Amazon 上的对标款：每家几款、各对标你哪一款写在下面；下面几条线（越过就算重要）是按你的品类给的建议。点「就这样」我就先读一次当底子，之后每天读一次。',
    async fields() {
      const plan = readPlan()
      const watch = await deps.brandWatch()
      const mk = marketOf(deps.profile().markets)
      const own = (watch?.brand.amazon ?? []).filter((o) => o.marketplace.toUpperCase() === mk)
      const fields: SetupField[] = [
        {
          key: 'marketplace',
          label: '哪个站',
          kind: 'select',
          options: MARKETS.map((m) => ({ value: m, label: amazonHostOfMarket(m) ?? m })),
          suggested: mk,
          required: true,
        },
        {
          key: 'own',
          label: '你的商品',
          kind: 'text',
          placeholder: 'B0XXXXXXXX；或贴一个你的店铺 / 商品链接',
          ...(own.length === 0
            ? {}
            : {
                suggested: own.map((o) => o.asin).join('；'),
                sources: [{ kind: 'saved' as const, label: '关注设置' }],
              }),
          required: false,
        },
      ]
      for (const c of await candidates()) {
        const saved = c.saved.filter((i) => i.marketplace.toUpperCase() === mk)
        fields.push({
          key: fieldKey(c.id),
          label: c.name,
          kind: 'text',
          placeholder: 'ASIN = 对标你的 ASIN；一对一段，空着 = 不盯这家',
          ...(saved.length === 0
            ? {}
            : {
                suggested: formatPicks(
                  saved.map((i) => ({
                    asin: i.asin,
                    ...(i.vs_own === undefined ? {} : { vs_own: i.vs_own }),
                  })),
                ),
                sources: [{ kind: 'saved' as const, label: '竞品清单' }],
              }),
          required: false,
        })
      }
      fields.push({
        key: 'more',
        label: '再加几家',
        kind: 'text',
        placeholder: '竞品名字，逗号分开（我去 Amazon 上找对标款）',
        required: false,
      })
      for (const [k, label] of NUMBERS) {
        const v = plan?.rules[k]
        fields.push({
          key: k,
          label,
          kind: 'number',
          ...(typeof v === 'number' ? { suggested: String(v) } : {}),
          required: false,
        })
      }
      for (const [k, label] of TOGGLES)
        fields.push(toggle(k, label, plan === undefined ? undefined : plan.rules[k] === true))
      const every = String(store.settings().every_hours)
      fields.push({
        key: 'every_hours',
        label: '多久读一次',
        kind: 'select',
        options: EVERY.some((e) => e.value === every)
          ? EVERY
          : [...EVERY, { value: every, label: `每 ${every} 小时` }],
        suggested: every,
        ...(plan === undefined ? { suggested_why: '默认一天一次' } : {}),
        required: true,
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
    const facts = await kit
      .profile()
      .catch(() => ({}) as Awaited<ReturnType<SetupResearchKit['profile']>>)
    const prof = deps.profile()
    const mk = marketOf(facts.markets ?? prof.markets)
    plan.marketplace = {
      value: mk,
      why:
        (facts.markets ?? prof.markets ?? []).length > 0
          ? '按品牌的目标市场'
          : '没写目标市场，先按美国站',
      sources: [
        (facts.markets ?? prof.markets ?? []).length > 0
          ? { kind: 'profile', label: '品牌档案' }
          : DEFAULT_SOURCE,
      ],
    }
    const watch = await deps.brandWatch()
    const savedOwn = (watch?.brand.amazon ?? []).filter((o) => o.marketplace.toUpperCase() === mk)
    const profAsins = (prof.asins ?? []).filter((a) => ASIN_RE.test(a.asin.toUpperCase()))
    let own: BrandWatchAmazonItem[] = savedOwn
    if (savedOwn.length === 0 && profAsins.length > 0) {
      own = profAsins.slice(0, 10).map((a) => ({
        marketplace: mk,
        asin: a.asin.toUpperCase(),
        ...(a.title === undefined ? {} : { label: a.title.slice(0, 80) }),
      }))
      plan.own = {
        value: own.map((o) => o.asin).join('；'),
        why: '品牌档案里读到的你的商品',
        sources: [{ kind: 'profile', label: '品牌档案' }],
      }
    } else if (savedOwn.length === 0) {
      /*
       * WP420（自查 B5）：自家 ASIN 不知道时，先按品牌名在 Amazon 搜一页给候选（和 Listing 体检那张卡同一个做法），
       * 标题里带品牌名、不是广告位的前几款——人看一眼勾掉不对的就行，不让他从零贴链接。
       */
      const found = await ownByBrandName(mk, watch?.brand.name ?? prof.name)
      if (found.length > 0) {
        own = found
        plan.own = {
          value: found.map((o) => o.asin).join('；'),
          why: `按品牌名在 Amazon 搜到的，看一眼去掉不是你的`,
          sources: [
            {
              kind: 'web',
              label: `${amazonHostOfMarket(mk) ?? 'Amazon'} 搜「${watch?.brand.name ?? prof.name ?? ''}」`,
            },
          ],
        }
      } else
        plan.own = {
          needs_you: true,
          why: '贴一个你在 Amazon 上的店铺或商品链接，我从那里读你卖哪几款（对标、比价用）',
        }
    }
    const reader = deps.reader()
    // 自家几款的标题和价：快照里没有（还没读过）就用内置浏览器读一下前台页（最多 5 页，算进额度）
    const mine: { asin: string; title?: string; price?: number }[] = []
    for (const o of ownList(mk, own)) {
      if (o.price === undefined && mine.length < 5 && reader?.ready() === true) {
        const got = await reader.readFacts({ marketplace: mk, asin: o.asin })
        if (got.status === 'ok') {
          mine.push({
            asin: o.asin,
            ...(got.facts.title === undefined ? {} : { title: got.facts.title }),
            ...(got.facts.price === undefined ? {} : { price: got.facts.price }),
          })
          continue
        }
      }
      mine.push(o)
    }
    const category = facts.subcategory ?? facts.category ?? prof.subcategory ?? prof.category
    const brandName = watch?.brand.name ?? prof.name
    const cands = await candidates()
    if (cands.length === 0)
      plan.more = { needs_you: true, why: '还不知道盯哪几家：写上竞品名字，我去 Amazon 上找对标款' }
    let stop: string | undefined
    for (const c of cands) {
      if (c.saved.some((i) => i.marketplace.toUpperCase() === mk)) continue
      if (reader === undefined || !reader.ready() || stop !== undefined) {
        plan[fieldKey(c.id)] = {
          needs_you: true,
          why:
            stop ??
            (reader === undefined
              ? '这台电脑没有工坊内置浏览器，填上要盯的 ASIN（= 对标你的哪一款）'
              : 'Amazon 前几个小时要过人机验证，内置浏览器先不读；填上要盯的 ASIN 也行'),
        }
        continue
      }
      const query = [c.name, category].filter((x) => x !== undefined && x !== '').join(' ')
      const got = await reader.searchCards({ marketplace: mk, query })
      if (got.status !== 'ok') {
        if (got.status === 'blocked' || got.status === 'quota')
          stop =
            got.status === 'blocked'
              ? 'Amazon 要人机验证，后面几家没搜（不绕）；填上 ASIN 也行'
              : '内置浏览器这一小时的额度用完了，后面几家没搜；填上 ASIN 也行'
        plan[fieldKey(c.id)] = {
          needs_you: true,
          why: stop ?? got.message ?? '这家没搜成，填上 ASIN 也行',
        }
        if (stop !== undefined) kit.note(stop)
        continue
      }
      const picks = suggestAmazonBenchmarks({
        competitor: c,
        cards: got.cards,
        own: mine,
        ...(brandName === undefined ? {} : { own_brand: brandName }),
        max: AMAZON_PICKS_PER_COMPETITOR,
      })
      savePicks(c.id, picks)
      const host = amazonHostOfMarket(mk) ?? 'Amazon'
      const src = {
        kind: 'web' as const,
        label: `${host} 搜「${query}」`,
        url: `https://${host}/s?k=${encodeURIComponent(query)}`,
      }
      kit.note(`${c.name}：在 Amazon 上搜「${query}」挑了 ${picks.length} 款`, src)
      plan[fieldKey(c.id)] =
        picks.length === 0
          ? { needs_you: true, why: `在 Amazon 上没搜到 ${c.name} 自家的同类商品，填上 ASIN 也行` }
          : {
              value: formatPicks(picks),
              // WP420（自查 U15）：每款一行「短名 · $价格 · ★评分」，不再一大段「B0…：EcoFlow 自家的，3,120 条评论；…」
              why: picks.map((p) => pickLine(p.asin, got.cards)).join('\n'),
              sources: [src],
            }
    }
    const model = rulesFromModel(
      await kit
        .ask(
          `品类：${category ?? '没写'}。给一个 Amazon 卖家盯竞品对标款时，哪几种变化值得提醒的起步建议（用户会改）。` +
            '只回 JSON：{"price_drop_pct":数,"cheaper_than_own":真假,"discounts":真假,"stock":真假,"rating_below":数,"bsr_move_pct":数或省略,"why":"一句中文理由"}',
        )
        .catch(() => undefined),
    )
    const s = model ?? suggestAmazonRules(category)
    const src = model === undefined ? [DEFAULT_SOURCE] : [MODEL_SOURCE]
    // WP420（自查 U15）：几格共用的那句理由只放在第一格（以前「降价」「评分」下面是同一句）
    let whyShown = false
    for (const [k] of NUMBERS) {
      const v = s.rules[k]
      if (typeof v !== 'number') continue
      plan[k] = { value: String(v), ...(whyShown ? {} : { why: s.why }), sources: src }
      whyShown = true
    }
    for (const [k] of TOGGLES)
      plan[k] = {
        value: s.rules[k] === true ? 'true' : 'false',
        ...(k === 'cheaper_than_own' && own.length === 0 ? { why: '填上你的商品才能比价' } : {}),
        sources: src,
      }
    plan.every_hours = { value: '24', why: '默认一天一次', sources: [DEFAULT_SOURCE] }
    return plan
  }

  /** 「你的商品」那一格：ASIN / 商品链接直接认；店铺链接用内置浏览器读一页卡片。 */
  async function parseOwn(raw: string, mk: string): Promise<BrandWatchAmazonItem[]> {
    const out: BrandWatchAmazonItem[] = []
    const bad: string[] = []
    const add = (asin: string, label?: string): void => {
      if (out.some((o) => o.asin === asin)) return
      out.push({
        marketplace: mk,
        asin,
        ...(label === undefined ? {} : { label: label.slice(0, 80) }),
      })
    }
    for (const part of raw.split(/[\s;；,，、]+/u)) {
      const t = part.trim()
      if (t === '') continue
      const asin = asinOf(t)
      if (asin !== undefined) {
        add(asin)
        continue
      }
      const e = /^https?:\/\//i.test(t) ? classifyAmazonUrl(t) : undefined
      if (e?.kind !== 'amazon_storefront') {
        bad.push(t)
        continue
      }
      const reader = deps.reader()
      if (reader === undefined)
        throw new SetupCardError(
          'invalid_input',
          '这台电脑没有工坊内置浏览器，读不了店铺链接；直接写几个 ASIN 吧。',
        )
      const got = await reader.readStorefront(t)
      if (got.status !== 'ok')
        throw new SetupCardError(
          'invalid_input',
          `店铺链接这次没读成（${got.message ?? got.status}）；直接写几个 ASIN 也行。`,
        )
      for (const it of got.items.slice(0, 10)) add(it.asin, it.title)
    }
    if (bad.length > 0)
      throw new SetupCardError(
        'invalid_input',
        `「你的商品」里认不出：${bad.slice(0, 3).join('、')}。写 ASIN（10 位字母数字）或贴 Amazon 链接。`,
      )
    return out
  }

  let pending: Promise<unknown> | undefined

  async function apply(values: Record<string, string>): Promise<void> {
    const mk = (values.marketplace ?? 'US').trim().toUpperCase()
    if (amazonHostOfMarket(mk) === undefined)
      throw new SetupCardError('invalid_input', `认不出这个站：${mk}`)
    const watch = await deps.brandWatch()
    const own = await parseOwn(values.own ?? '', mk)
    const list: BrandWatchCompetitor[] = [...(watch?.competitors ?? [])]
    const picks = picksOf()
    const labelOf = (cid: string, asin: string): string | undefined =>
      picks[cid]?.find((p) => p.asin === asin)?.title.slice(0, 80)
    const setAmazon = (
      c: { id: string; name: string; aliases: string[] },
      items: BrandWatchAmazonItem[],
    ) => {
      const at = list.findIndex((x) => x.id === c.id)
      const cur = at >= 0 ? (list[at] as BrandWatchCompetitor) : undefined
      const keep = (cur?.amazon ?? []).filter((i) => i.marketplace.toUpperCase() !== mk)
      const next = [...keep, ...items]
      const base: BrandWatchCompetitor = cur ?? {
        id: c.id,
        name: c.name,
        aliases: c.aliases,
        domains: [],
      }
      const { amazon: _old, ...rest } = base
      const merged: BrandWatchCompetitor = next.length === 0 ? rest : { ...rest, amazon: next }
      if (at >= 0) list[at] = merged
      else if (next.length > 0) list.push(merged)
    }
    for (const c of await candidates()) {
      const got = parseAmazonPairs(values[fieldKey(c.id)] ?? '')
      if (got.bad.length > 0)
        throw new SetupCardError(
          'invalid_input',
          `${c.name} 那一格认不出：${got.bad.slice(0, 3).join('、')}。写成「ASIN = 你的 ASIN」，一对一段。`,
        )
      setAmazon(
        c,
        got.items.map((i) => {
          const label = labelOf(c.id, i.asin)
          return {
            marketplace: mk,
            asin: i.asin,
            ...(label === undefined ? {} : { label }),
            ...(i.vs_own === undefined ? {} : { vs_own: i.vs_own }),
          }
        }),
      )
    }
    // 再加几家：写名字，我去 Amazon 上找对标款（内置浏览器读不了就只记名字，下次方案卡再挑）
    const reader = deps.reader()
    const mine = ownList(mk, own)
    for (const name of (values.more ?? '').split(/[,，;；、\n]+/u).map((x) => x.trim())) {
      if (name === '' || list.some((x) => x.name.toLowerCase() === name.toLowerCase())) continue
      const c = { id: competitorId(name), name, aliases: [] as string[] }
      let items: BrandWatchAmazonItem[] = []
      if (reader?.ready() === true) {
        const got = await reader.searchCards({ marketplace: mk, query: name })
        if (got.status === 'ok')
          items = suggestAmazonBenchmarks({
            competitor: c,
            cards: got.cards,
            own: mine,
            max: AMAZON_PICKS_PER_COMPETITOR,
          }).map((p) => ({
            marketplace: mk,
            asin: p.asin,
            label: p.title.slice(0, 80),
            ...(p.vs_own === undefined ? {} : { vs_own: p.vs_own }),
          }))
      }
      if (items.length > 0) setAmazon(c, items)
      else list.push({ id: c.id, name, aliases: [], domains: [] })
    }
    const total =
      own.length +
      list.reduce(
        (n, c) => n + (c.amazon ?? []).filter((i) => i.marketplace.toUpperCase() === mk).length,
        0,
      )
    if (total > AMAZON_ASINS_MAX)
      throw new SetupCardError(
        'invalid_input',
        `一个品牌最多盯 ${AMAZON_ASINS_MAX} 个 ASIN（现在 ${total} 个），去掉几个再存。`,
      )
    const rules: AmazonImportanceRules = {}
    for (const [k, label, lo, hi] of NUMBERS) {
      const v = clampNum(values[k], lo, hi, label)
      if (v !== undefined) rules[k] = v
    }
    for (const [k] of TOGGLES) rules[k] = values[k] === 'true'
    const otherOwn = (watch?.brand.amazon ?? []).filter((o) => o.marketplace.toUpperCase() !== mk)
    await deps.saveWatch({ competitors: list, brand_amazon: [...otherOwn, ...own] })
    const prof = deps.profile()
    const category = prof.subcategory ?? prof.category
    store.setKv(PLAN_KEY, {
      rules,
      confirmed_at: deps.now(),
      marketplace: mk,
      ...(category === undefined ? {} : { category }),
    } satisfies AmazonCompetitorPlan)
    const cw = deps.watch()
    const every = Number(values.every_hours)
    if (Number.isFinite(every) && every > 0) cw.updateSettings({ every_hours: every })
    // 存下就先读一次当底子（第一次读只建底子；读不到的在连接卡亮红点）
    await cw.sync()
    const ids = cw
      .sources()
      .filter((s) => s.kind === 'amazon_asin')
      .map((s) => s.id)
    if (ids.length > 0)
      pending = cw.runNow({ trigger: 'added', source_ids: ids }).catch(() => undefined)
  }

  type CreditEntry = { at: Iso8601; source_id: string; credits: number; seq?: number }
  const creditLog = (): CreditEntry[] => store.kv<CreditEntry[]>(AMAZON_CREDITS_KEY) ?? []
  const lastSeq = (): number => creditLog().reduce((n, e) => Math.max(n, e.seq ?? 0), 0)
  /** 记号之后记的那几笔加起来（一轮读完问「这次扣了多少」）。 */
  const creditsAfter = (mark: number): number =>
    Math.round(
      creditLog()
        .filter((e) => (e.seq ?? 0) > mark)
        .reduce((n, e) => n + e.credits, 0) * 100,
    ) / 100

  return {
    plan: readPlan,
    setupTarget: () => target,
    noteCredits(source_id, credits) {
      if (!(credits > 0)) return
      const entry: CreditEntry = { at: deps.now(), source_id, credits, seq: lastSeq() + 1 }
      store.setKv(AMAZON_CREDITS_KEY, [...creditLog(), entry].slice(-200))
    },
    async readNow(input) {
      const plan = readPlan()
      if (plan === undefined)
        return {
          needs_setup: AMAZON_COMPETITOR_TARGET,
          message:
            '还没定盯哪些 Amazon 对标款：先出一张方案卡（每家几款、各对标你哪一款、什么算重要）',
        }
      await pending
      const cw = deps.watch()
      await cw.sync()
      const q = input.competitor?.trim().toLowerCase()
      const names = new Map(((await deps.brandWatch())?.competitors ?? []).map((c) => [c.id, c]))
      const sources = cw
        .sources()
        .filter((s) => s.kind === 'amazon_asin' && s.paused !== true)
        .filter((s) => {
          if (q === undefined || q === '') return true
          const c = names.get(s.competitor_id)
          return (
            s.competitor_id.toLowerCase() === q ||
            s.label.toLowerCase() === q ||
            c?.aliases.some((a) => a.toLowerCase() === q) === true
          )
        })
      if (sources.length === 0)
        return q === undefined || q === ''
          ? { needs_setup: AMAZON_COMPETITOR_TARGET, message: '还没有在盯的 Amazon 对标款' }
          : { message: `没在盯「${input.competitor}」的 Amazon 对标款` }
      const mark = lastSeq()
      const run = await cw.runNow({ trigger: 'manual', source_ids: sources.map((s) => s.id) })
      const ids = new Set(sources.map((s) => s.id))
      const changes = cw
        .changes({ since: run.started_at, source_kind: 'amazon_asin', limit: 200 })
        .filter((c) => ids.has(c.source_id))
      const credits = creditsAfter(mark)
      const parts = run.parts.filter((p) => ids.has(p.source_id))
      const failed = parts.filter((p) => p.status === 'failed').map((p) => p.label)
      const blocked = parts.some((p) => /人机验证/.test(p.message ?? ''))
      const say = [
        blocked
          ? 'Amazon 要人机验证，内置浏览器这一轮没再读、也没绕，改走了工坊云端数据'
          : undefined,
        credits > 0
          ? `这次走工坊云端数据扣了 ${credits} 积分（云端读不到划线价和优惠券，这两格空着）`
          : undefined,
        failed.length > 0 ? `${failed.join('、')} 这次没读到` : undefined,
      ]
        .filter((x): x is string => x !== undefined)
        .join('；')
      return {
        read: parts.map((p) => ({
          label: p.label,
          status: p.status,
          ...(p.via === undefined ? {} : { via: p.via }),
          ...(p.message === undefined ? {} : { note: p.message }),
        })),
        changes: changes.map((c) => ({
          competitor: c.competitor,
          kind: c.kind,
          title: c.title,
          ...(c.url === undefined ? {} : { url: c.url }),
          ...(c.before === undefined ? {} : { before: c.before }),
          ...(c.after === undefined ? {} : { after: c.after }),
          ...(c.pct === undefined ? {} : { pct: c.pct }),
          ...(c.vs_own === undefined
            ? {}
            : {
                vs_own: {
                  own: c.vs_own.own_title ?? c.vs_own.own_key,
                  diff: c.vs_own.diff,
                  ...(c.vs_own.currency === undefined ? {} : { currency: c.vs_own.currency }),
                },
              }),
          important: isImportantAmazonChange(c, plan.rules),
        })),
        ...(credits > 0 ? { credits } : {}),
        ...(say === '' ? {} : { say }),
      }
    },
  }
}

/**
 * WP420（自查 B5）：搜索结果卡片里挑自家候选——标题里带品牌名（不分大小写）、不是广告位，最多 5 款。
 */
export function ownCandidatesFromCards(
  cards: readonly { asin: string; title: string; sponsored: boolean }[],
  brand: string,
  max = 5,
): { asin: string; title: string }[] {
  const b = brand.trim().toLowerCase()
  if (b === '') return []
  const seen = new Set<string>()
  const out: { asin: string; title: string }[] = []
  for (const c of cards) {
    const asin = c.asin.trim().toUpperCase()
    if (c.sponsored || seen.has(asin) || !c.title.toLowerCase().includes(b)) continue
    seen.add(asin)
    out.push({ asin, title: c.title })
    if (out.length >= max) break
  }
  return out
}

/** WP420（自查 U15）：方案卡上一款一行——「短名 · $价格 · ★评分」（搜索卡片里有什么写什么）。 */
export function pickLine(
  asin: string,
  cards: readonly {
    asin: string
    title: string
    price?: number
    currency?: string
    rating?: number
  }[],
): string {
  const c = cards.find((x) => x.asin.toUpperCase() === asin.toUpperCase())
  if (c === undefined) return asin
  const name =
    c.title
      .split(/[,，|–—-]/u)[0]
      ?.trim()
      .slice(0, 32) ?? asin
  const sym = c.currency === undefined || c.currency === 'USD' ? '$' : `${c.currency} `
  return [
    name === '' ? asin : name,
    ...(c.price === undefined ? [] : [`${sym}${c.price}`]),
    ...(c.rating === undefined ? [] : [`★${c.rating}`]),
  ].join(' · ')
}
