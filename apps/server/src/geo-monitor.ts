/**
 * WP321（docs/99 §5 / §7 O2）：SEO / GEO **监测**那一层——「GEO 关注设置」的策略设定、每周一轮
 * （已选 Prompt × 关注的 AI × 市场；关注词排名；品牌词 Search Console 周数据）、写历史、算指标。
 *
 * 判断在 `@agentsws/seo-core`（指标、策略、估算、提示词）与 `@agentsws/search-providers`（提及 / 引用 /
 * 名次 / 引用归类）里，都是纯函数；这里只做接线与存取（`geo.sqlite`，`./geo-store.ts`）。
 *
 * 取数怎么走（决策 461 / 465 / 469 / 534）：
 *
 * | 档 | ChatGPT / Gemini / AI 概览 | Claude | 关注词排名 |
 * |---|---|---|---|
 * | 官方·定时 | 排队档批量任务 `ai_answer_batch.*` | 能力目录 `ai_answer.claude`（即时） | `seo.rank_check`（排队档，前 20） |
 * | 官方·手动 | 即时 `aiAnswers` | 同上 | 同上 |
 * | 自带 key | 即时 `aiAnswers` | 同上（每天第一次前查一次免费模型清单，不过就跳过） | 结果页 `serp`（服务商给几条算几条） |
 *
 * 纪律：计费请求不自动重试；失败 / 空回答记「没查成」、不算「没提到」；一轮里一格只问一次；
 * 决策 650（Luoye 10-14 定）：Claude 默认就问——策略还没定（设定卡没批）之前，定时那一轮也问四家；
 * 手动「现在跑一轮」官方档有 Claude 时先合并确认一次。
 * 本文件不打一跳网络——取数口、模型口都是注入的。
 */
import type {
  AiAnswerDataItem,
  AiAnswerResult,
  AiPlatform,
  BrandAudience,
  BrandCompetitor,
  BrandKeywords,
  BrandWatch,
  BrandWatchAmazonItem,
  BrandWatchCompetitor,
  BrandWatchKeyword,
  Clock,
  DataCallResult,
  DataCapabilityList,
  DataTaskItemsPage,
  DataTaskView,
  GeoAnswerDetail,
  GeoAnswerSide,
  GeoCitationRecord,
  GeoFactsPatch,
  GeoMentionRecord,
  GeoMetricsView,
  GeoOfficialFact,
  GeoProbeRow,
  GeoQuestion,
  GeoRunEstimate,
  GeoWatchPatch,
  GeoWatchStrategy,
  GeoWatchView,
  GscRow,
  Iso8601,
  SearchDataPort,
  SearchDataStatus,
  SeoBrandGscWeek,
  SeoRankCheckItem,
  SeoRankSnapshot,
  SerpResult,
  WatchRun,
} from '@agentsws/contracts'
import {
  BRAND_WATCH_DEFAULT_PLATFORMS,
  DATA_TASK_TERMINAL_STATUSES,
  GEO_PROMPT_CAP_MAX,
  RANK_CHECK_DEPTH,
  WATCH_KEYWORDS_MAX,
} from '@agentsws/contracts'
import {
  analyzeAnswer,
  builtinSiteKind,
  citationsOf,
  domainMatches,
  domainOf,
  matchEntities,
} from '@agentsws/search-providers'
import {
  brandGscWeeks,
  brandShares,
  buildStrategy,
  cellChanges,
  cellHistory,
  citedSources,
  classifyPrompt,
  competitorId,
  defaultWatchKeywords,
  factValuesOf,
  type GeoAlert,
  type GeoUnitPrices,
  generatePromptCandidates,
  geoAlerts,
  geoBriefLine,
  geoGrid,
  geoQualityOf,
  geoRunEstimate,
  geoTrends,
  guessPromptTopic,
  judgeMessages,
  type MetricAnswer,
  marketName,
  mondayOf,
  newPromptCandidates,
  parseClassifyReply,
  parseInsightReply,
  parseJudgeReply,
  parseStrategyReply,
  patchFacts,
  pickDefaultPrompts,
  promptId,
  promptIsBranded,
  type RankPoint,
  rankMetrics,
  sentimentCounts,
  shiftDay,
  stageHint,
  strategyPrompt,
  syncFacts,
} from '@agentsws/seo-core'
import type { BrandWatchSettings, GeoStore, StoredPrompt } from './geo-store.js'
import { answerHash as answerHashOf, defaultWatchSettings } from './geo-store.js'

/** 模型口（这个品牌的模型网关；用量照常进用量账）。 */
/**
 * `system` 可选（WP471）：给了就作系统提示放最前面——同一品牌固定不变的说明放那里，命中缓存。
 */
export type WatchModel = (input: { prompt: string; system?: string }) => Promise<{ text: string }>

/** 数据能力口（`./data-service.ts` 的那一份，按品牌）。 */
export interface WatchDataPort {
  capabilities(): Promise<DataCapabilityList>
  call(capability: string, input: { input: Record<string, unknown> }): Promise<DataCallResult>
  submit(input: {
    capability: string
    input: Record<string, unknown>
    max_items?: number
    idempotency_key?: string
  }): Promise<DataTaskView>
  task(id: string): Promise<DataTaskView>
  items(id: string, cursor?: string): Promise<DataTaskItemsPage>
}

/** 监测要的品牌档案那几格。 */
export interface WatchBrand {
  name: string
  domains: string[]
  language: 'zh' | 'en'
  country: string
  markets?: string[] | undefined
  /** 品牌一句话介绍（品类常在这里）。 */
  one_liner?: string | undefined
  category?: string | undefined
  /** WP346（决策 872）：品牌档案里的目标人群、关键词、竞品（GEO 建议先读它们，读不到再让 AI 猜）。 */
  audience?: BrandAudience | undefined
  keywords?: BrandKeywords | undefined
  competitors?: readonly BrandCompetitor[] | undefined
  /** WP380：官方事实表要的几格（品牌档案第二版；没有不写）。 */
  subcategory?: string | undefined
  price_band?: string | undefined
  positioning?: string | undefined
}

export interface GeoMonitorDeps {
  clock: Clock
  nextId(prefix: string): string
  /** 这个品牌的 `geo.sqlite`（第一次用时搬老数据、迁到新设置）。 */
  store(): Promise<GeoStore>
  brand(): Promise<WatchBrand>
  searchData(): SearchDataPort
  /** 官方数据能力口（批量任务、Claude、排名）；没装 = 这几样走不了，照实说。 */
  data?(): WatchDataPort | undefined
  /** 决策 534：自带 key 那档问 Claude 前查一次免费的模型清单。不给 = 不查（当通过）。 */
  claudeModelCheck?(): Promise<{ ok: boolean; reason?: string }>
  /** 模型口（每次现取；没配回 `undefined`）。 */
  model?(purpose: 'strategy' | 'judge' | 'classify'): WatchModel | undefined
  /** 把一个 Prompt 翻成这个市场的语言（翻过的有缓存；没模型 = 原语言问）。 */
  translate(
    text: string,
    market: string,
  ): Promise<{ asked: string; language: string; untranslated: boolean }>
  /** 一个市场用什么语言查（排名那一跳用；Prompt 的翻译走 `translate`）。 */
  languageOf(market: string): string | Promise<string>
  /** Search Console 连没连（不读数；面板上「品牌词」那一块要不要提示去连）。 */
  gscConnected?(): boolean
  /** Search Console 近 7 天的行（没连 `connected: false`）。 */
  gsc(): Promise<{ connected: boolean; rows: GscRow[] }>
  /** 等排队档任务时睡多久（测试注入）。 */
  sleep?(ms: number): Promise<void>
  /** 一轮里最多等排队档多久（毫秒；没回来的留着，下一次「取回」接着收）。 */
  waitBudgetMs?: number
  /** 一轮最多让模型判几条回答的情感（省钱）。 */
  judgeCap?: number
}

/** 默认最多等排队档 15 分钟（没回来的留到下一次取回）。 */
export const WATCH_WAIT_BUDGET_MS = 15 * 60_000
/** 一轮最多判几条回答的情感。 */
export const WATCH_JUDGE_CAP = 80
/** 设定卡批过（策略定了）的时刻。 */
export const WATCH_SETUP_KEY = 'watch_setup_at'
/** 还在等人的设定卡 id（人说了「不要」记 {@link SETUP_DECLINED}）。 */
export const WATCH_SETUP_CARD_KEY = 'watch_setup_card'
export const SETUP_DECLINED = 'declined'
/** 人在「要加进竞品吗」卡上说过「不要」的品牌（JSON 数组；不再问）。 */
export const DECLINED_RIVALS_KEY = 'declined_competitors'
/** 决策 534：今天查过 Claude 模型清单没有（`YYYY-MM-DD|ok|一句话`）。 */
export const CLAUDE_CHECK_KEY = 'claude_model_check'

export const NOTE_CLAUDE_NOT_CONFIRMED_RUN =
  'Claude 这一轮没问：一格约 3.6 积分，要先确认这一轮的花费（「现在跑一轮」会先给估算）。'
export const NOTE_NO_DATA_SERVICE =
  'Claude 与关注词排名要用 Agents 工坊官方数据接口，这台电脑还没接上，这一轮先跳过。'

const BATCHABLE: readonly AiPlatform[] = ['chatgpt', 'gemini', 'google_ai_overview']

/** 一条原样的回答（两种来路统一成一个样子）。 */
export interface RawAnswer {
  platform: AiPlatform
  text: string
  citations?: AiAnswerDataItem['citations']
  cited_urls: string[]
  model?: string | undefined
  via?: AiAnswerDataItem['via'] | undefined
  credits: number
}

export function rawOfResult(r: AiAnswerResult): RawAnswer {
  return {
    platform: r.platform,
    text: r.answer_markdown ?? r.answer_excerpt,
    ...(r.citations === undefined ? {} : { citations: r.citations }),
    cited_urls: r.cited_urls,
    model: r.model,
    via: r.via,
    credits: r.credits ?? 0,
  }
}

export function rawOfItem(r: AiAnswerDataItem, credits: number): RawAnswer {
  return {
    platform: r.platform,
    text: r.answer_markdown ?? r.text,
    ...(r.citations === undefined ? {} : { citations: r.citations }),
    cited_urls: r.cited_urls,
    model: r.model,
    via: r.via,
    credits,
  }
}

/** 一轮里的一格：Prompt × 市场（× AI 在外层）。 */
export interface WatchCell {
  prompt: GeoQuestion
  market: string
  language: string
  asked: string
}

export const periodOf = (now: Iso8601): string => mondayOf(now)
const today = (now: Iso8601): string => now.slice(0, 10)

/** 探测的市场 = 设置里的市场 − 关掉的。 */
export function probingMarkets(w: Pick<BrandWatch, 'markets' | 'markets_off'>): string[] {
  const off = new Set((w.markets_off ?? []).map((m) => m.toUpperCase()))
  return w.markets.filter((m) => !off.has(m.toUpperCase()))
}

/** 设备：`both` = 两份。 */
export const devicesOf = (d: BrandWatch['rank_device']): ('mobile' | 'desktop')[] =>
  d === 'both' ? ['mobile', 'desktop'] : [d]

/**
 * 一个关注词一次结果页 → 我们排第几（只数自然结果，子域名也算我们）+ AI 概览里提没提 / 引没引我们。
 */
export function rankSnapshotOf(
  item: SeoRankCheckItem,
  ctx: {
    run_id: string
    market: string
    device: 'mobile' | 'desktop'
    watch: Pick<BrandWatch, 'brand'>
  },
): SeoRankSnapshot {
  const ours = ctx.watch.brand.domains
  const hit = item.organic.find((o) =>
    ours.some((d) => domainMatches(o.domain === '' ? domainOf(o.url) : o.domain, d)),
  )
  const aio = item.ai_overview
  const match =
    aio === undefined
      ? undefined
      : matchEntities(aio.text, aio.citations, [
          {
            entity: 'ours',
            name: ctx.watch.brand.name,
            aliases: ctx.watch.brand.aliases,
            domains: ours,
          },
        ])[0]
  return {
    run_id: ctx.run_id,
    keyword: item.keyword,
    market: ctx.market,
    device: ctx.device,
    ...(hit === undefined ? {} : { rank: hit.rank, url: hit.url }),
    serp_features: item.features,
    aio_mentions_us: match?.mentioned === true,
    aio_cites_us: (aio?.citations ?? []).some((c) => ours.some((d) => domainMatches(c.domain, d))),
    fetched_at: item.fetched_at,
  }
}

/** 自带 key 那档：一次结果页 → 排名那一条的样子（服务商给几条算几条）。 */
export function rankItemOfSerp(serp: SerpResult, device: 'mobile' | 'desktop'): SeoRankCheckItem {
  const organic = serp.items
    .filter((i) => i.type === 'organic')
    .slice(0, RANK_CHECK_DEPTH)
    .map((i, n) => ({ rank: n + 1, url: i.url, domain: i.domain, title: i.title }))
  return {
    keyword: serp.query.query,
    country: serp.query.country,
    language: serp.query.language,
    device,
    organic,
    features: {
      ai_overview: serp.ai_overview !== undefined,
      people_also_ask: (serp.people_also_ask ?? []).length > 0,
      shopping: serp.items.some((i) => i.type === 'shopping'),
      video: serp.items.some((i) => i.type === 'video'),
    },
    ...(serp.ai_overview === undefined
      ? {}
      : {
          ai_overview: {
            text: serp.ai_overview.text,
            citations: citationsOf({ cited_urls: serp.ai_overview.cited_urls }),
          },
        }),
    ...(serp.people_also_ask === undefined ? {} : { people_also_ask: serp.people_also_ask }),
    fetched_at: serp.fetched_at,
  }
}

/** 一格（Prompt × AI × 市场）的结果：拿到的回答，或没查成。 */
export interface CellResult {
  cell: WatchCell
  platform: AiPlatform
  raw?: RawAnswer | undefined
}

/** 一轮 GEO 的结果。 */
export interface GeoRoundOutcome {
  run?: WatchRun
  skipped?: string
  notes: string[]
  pending_tasks: number
  estimate: GeoRunEstimate
}

const asQuestion = (p: StoredPrompt): GeoQuestion => {
  const { created_at: _c, replaces: _r, ...q } = p
  return q
}

const errText = (err: unknown): string =>
  (err instanceof Error ? err.message : String(err)).slice(0, 80)
const codeOf = (err: unknown): string | undefined => {
  const c = (err as { code?: unknown }).code
  return typeof c === 'string' ? c : undefined
}

export type GeoMonitor = ReturnType<typeof createGeoMonitor>

export function createGeoMonitor(deps: GeoMonitorDeps) {
  const now = (): Iso8601 => deps.clock.now()
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const budget = deps.waitBudgetMs ?? WATCH_WAIT_BUDGET_MS

  const brandMarkets = (b: WatchBrand): string[] => {
    const listed = [
      ...new Set((b.markets ?? []).map((m) => m.trim().toUpperCase()).filter((m) => m !== '')),
    ]
    return listed.length > 0 ? listed : [b.country.toUpperCase()]
  }
  const settingsOf = (w: BrandWatch): BrandWatchSettings => {
    const { prompt_candidates: _c, prompts: _p, ...rest } = w
    return rest
  }
  const isBrandQuery =
    (w: Pick<BrandWatch, 'brand'>) =>
    (q: string): boolean =>
      promptIsBranded(q, w.brand) ||
      w.brand.domains.some((d) => {
        const stem = d.split('.')[0] ?? ''
        return stem.length >= 3 && q.toLowerCase().includes(stem.toLowerCase())
      })

  /**
   * 这个品牌的关注设置（没有就按默认建一份，并按品牌档案套出候选、先选兜底那几条）。品牌名、域名、
   * 市场**跟着品牌档案走**（档案是唯一来源）；别名、竞品、关掉的市场是人在设置里改的，不动。
   */
  async function ensureWatch(): Promise<{ store: GeoStore; watch: BrandWatch; brand: WatchBrand }> {
    const store = await deps.store()
    const brand = await deps.brand()
    const markets = brandMarkets(brand)
    const cur = store.watch()
    if (cur === undefined)
      store.saveSettings(
        defaultWatchSettings({
          brand: { name: brand.name, domains: brand.domains },
          markets,
          at: now(),
        }),
      )
    else if (
      cur.brand.name !== brand.name ||
      (brand.domains.length > 0 && cur.brand.domains.join('|') !== brand.domains.join('|')) ||
      cur.markets.join('|') !== markets.join('|')
    )
      store.saveSettings({
        ...settingsOf(cur),
        brand: {
          ...cur.brand,
          name: brand.name,
          domains: brand.domains.length > 0 ? brand.domains : cur.brand.domains,
        },
        markets,
        updated_at: now(),
      })
    if (store.prompts({ archived: true }).length === 0) {
      const watch = store.watch() as BrandWatch
      const { rows } = await deps.gsc().catch(() => ({ connected: false, rows: [] as GscRow[] }))
      const top = [...rows]
        .sort((a, b) => b.impressions - a.impressions)
        .slice(0, 30)
        .map((r) => r.query)
      const candidates = generatePromptCandidates({
        brand: { name: brand.name, aliases: watch.brand.aliases },
        category: brand.category,
        language: brand.language,
        top_queries: top,
      })
      for (const c of candidates) store.addPrompt({ ...c, created_at: now() })
      // 兜底先选几条（决策 531：带品牌名几条不预设——不带品牌名的不够就用带的补满）
      const picked = pickDefaultPrompts(candidates, watch.prompt_limit)
      for (const c of candidates)
        if (picked.length < watch.prompt_limit && !picked.includes(c.id)) picked.push(c.id)
      store.selectPrompts(picked)
    }
    return { store, watch: store.watch() as BrandWatch, brand }
  }

  const setupDone = (store: GeoStore): boolean => store.meta(WATCH_SETUP_KEY) !== undefined

  /** 能力目录（价与能不能用）；取不到回 `undefined`（照实说，不编）。 */
  async function capabilities(): Promise<DataCapabilityList | undefined> {
    const data = deps.data?.()
    if (data === undefined) return undefined
    try {
      return await data.capabilities()
    } catch {
      return undefined
    }
  }
  const capOf = (caps: DataCapabilityList | undefined, id: string) =>
    caps?.capabilities.find((c) => c.id === id)

  /** 单价：三家按搜索数据口给的；Claude 与排名按能力目录。 */
  function pricesOf(status: SearchDataStatus, caps: DataCapabilityList | undefined): GeoUnitPrices {
    return {
      ai_answer: status.prices?.ai_answer,
      claude: capOf(caps, 'ai_answer.claude')?.credits_per_unit,
      rank_check: capOf(caps, 'seo.rank_check')?.credits_per_unit,
    }
  }

  /** 这条路能问的 AI（与关注的取交集；Claude 另看）。 */
  function askable(
    watch: BrandWatch,
    status: SearchDataStatus,
    caps: DataCapabilityList | undefined,
  ): AiPlatform[] {
    if (!status.configured) return []
    const can = status.platforms
    const base = watch.platforms.filter(
      (p) => p !== 'claude' && (can === undefined ? BATCHABLE.includes(p) : can.includes(p)),
    )
    const claude =
      watch.platforms.includes('claude') &&
      (status.route === 'byo'
        ? can?.includes('claude') === true
        : capOf(caps, 'ai_answer.claude')?.available === true)
    return claude ? [...base, 'claude'] : base
  }

  /** 按现在的设置，一轮大概花多少。 */
  async function estimate(
    watch: BrandWatch,
    status: SearchDataStatus,
    caps?: DataCapabilityList,
  ): Promise<GeoRunEstimate> {
    const c = caps ?? (status.route === 'official' ? await capabilities() : undefined)
    const prompts = Math.min(watch.prompts.filter((p) => p.enabled).length, watch.prompt_limit)
    const keywords = watch.keywords.filter((k) => k.enabled).length
    return geoRunEstimate({
      route: status.configured ? status.route : 'none',
      prompts: watch.enabled ? prompts : 0,
      markets: probingMarkets(watch).length,
      platforms: status.configured ? askable(watch, status, c) : watch.platforms,
      keywords: watch.enabled ? keywords : 0,
      devices: devicesOf(watch.rank_device).length,
      prices: pricesOf(status, c),
      frequency: watch.frequency,
    })
  }

  /* ── 存一批回答：先给认不出的站分类（模型一次 + 缓存）→ 规则判 → 情感（模型，附原话） ─── */

  async function classifyDomains(
    store: GeoStore,
    watch: BrandWatch,
    raws: readonly RawAnswer[],
  ): Promise<void> {
    const model = deps.model?.('classify')
    if (model === undefined) return
    const known = new Set([...watch.brand.domains, ...watch.competitors.flatMap((c) => c.domains)])
    const unknown = new Set<string>()
    for (const r of raws)
      for (const c of citationsOf({ citations: r.citations, cited_urls: r.cited_urls })) {
        if (c.domain === '' || [...known].some((d) => domainMatches(c.domain, d))) continue
        if (builtinSiteKind(c.domain) !== undefined || store.domainKind(c.domain) !== undefined)
          continue
        unknown.add(c.domain)
      }
    if (unknown.size === 0) return
    const list = [...unknown].slice(0, 60)
    let got: ReturnType<typeof parseClassifyReply>
    try {
      got = parseClassifyReply((await model({ prompt: classifyPrompt(list) })).text, list)
    } catch {
      return
    }
    // 问过的都记下（认不出的记 other）：同一个站不再问第二次；人改过的不让模型盖
    for (const d of list) store.setDomainKind(d, got.get(d) ?? 'other', 'model', now())
  }

  const answerIdOf = (run_id: string, r: CellResult): string =>
    `ga_${run_id}_${r.platform}_${r.cell.market}_${r.cell.prompt.id}`

  /** 存一批格；回这批里拿到回答的几格、花了多少。 */
  async function recordCells(
    store: GeoStore,
    watch: BrandWatch,
    run: WatchRun,
    results: readonly CellResult[],
    judged: { n: number },
  ): Promise<{ answered: number; credits: number }> {
    await classifyDomains(
      store,
      watch,
      results.flatMap((r) => (r.raw === undefined ? [] : [r.raw])),
    )
    const entities = { brand: watch.brand, competitors: watch.competitors }
    const judge = deps.model?.('judge')
    const cap = deps.judgeCap ?? WATCH_JUDGE_CAP
    const facts = judge === undefined ? [] : await officialFacts(store)
    let answered = 0
    let credits = 0
    for (const r of results) {
      const id = answerIdOf(run.id, r)
      const text = r.raw?.text ?? ''
      const status = r.raw === undefined ? 'failed' : text.trim() === '' ? 'empty' : 'ok'
      const analysis =
        status === 'ok'
          ? analyzeAnswer(
              entities,
              { text, citations: r.raw?.citations, cited_urls: r.raw?.cited_urls ?? [] },
              (h) => store.domainKind(h),
            )
          : undefined
      const citations: GeoCitationRecord[] = (analysis?.citations ?? []).map((c) => ({
        answer_id: id,
        position: c.position,
        url: c.url,
        url_norm: c.url_norm,
        domain: c.domain,
        ...(c.title === undefined ? {} : { title: c.title }),
        ...(c.snippet === undefined ? {} : { snippet: c.snippet }),
        where: c.where,
        site_kind: c.site_kind,
      }))
      const mentions: GeoMentionRecord[] = (analysis?.mentions ?? []).map((m) => ({
        answer_id: id,
        ...m,
        rules_version: analysis?.rules_version ?? 1,
      }))
      const spent = r.raw?.credits ?? 0
      store.recordAnswer(
        {
          id,
          run_id: run.id,
          prompt_id: r.cell.prompt.id,
          prompt_text: r.cell.prompt.text,
          asked_text: r.cell.asked,
          platform: r.platform,
          model: r.raw?.model ?? 'web',
          via:
            r.raw?.via ??
            (r.platform === 'claude'
              ? 'model_api'
              : r.platform === 'google_ai_overview'
                ? 'serp'
                : 'web_ui'),
          market: r.cell.market,
          language: r.cell.language,
          status,
          answer_md: text,
          answer_hash: answerHashOf(text),
          fetched_at: now(),
          credits: spent,
        },
        citations,
        mentions,
      )
      credits += spent
      if (status !== 'ok') continue
      answered += 1
      // 决策 470：情感交模型判、必须附原话；顺带认出其他品牌（只用来建议加竞品）
      if (judge === undefined || judged.n >= cap) continue
      judged.n += 1
      const ours = mentions.find((m) => m.entity === 'ours')
      // WP380：提到我们的回答顺带判「和竞品比更推荐谁」与「说得对不对」（同一次调用）
      const rivals = mentions
        .filter((m) => m.entity !== 'ours' && m.mentioned)
        .map((m) => watch.competitors.find((c) => c.id === m.entity)?.name ?? m.name_snapshot)
      try {
        // WP471（决策 1549）：两段——固定说明（含品牌名、竞品名单）进系统提示，这条回答在用户消息
        const asked = judgeMessages({
          brand: watch.brand,
          competitors: watch.competitors.map((c) => c.name),
          answer: text,
          mentioned: ours?.mentioned === true,
          facts,
          rivals,
        })
        const reply = await judge({ system: asked.system, prompt: asked.user })
        const j = parseJudgeReply(reply.text, text, ours?.mentioned === true)
        if (ours?.mentioned === true) {
          const got = parseInsightReply(reply.text, text, {
            mentioned: true,
            facts,
            rivals,
          })
          const asOf = facts
            .map((f) => f.as_of)
            .sort()
            .at(-1)
          if (got.compare !== undefined || got.claims.length > 0)
            store.setInsight({
              answer_id: id,
              ...got,
              ...(asOf === undefined ? {} : { facts_as_of: asOf }),
              judged_at: now(),
            })
        }
        const mood = j.sentiment
        if (mood !== undefined && ours !== undefined)
          store.replaceMentions(
            id,
            mentions.map((m) =>
              m.entity === 'ours'
                ? {
                    ...m,
                    sentiment: mood,
                    ...(j.quote === undefined ? {} : { sentiment_quote: j.quote }),
                  }
                : m,
            ),
          )
        const knownNames = [watch.brand, ...watch.competitors]
        const others = j.brands.filter(
          (b) =>
            !knownNames.some((k) => promptIsBranded(b, k) || promptIsBranded(k.name, { name: b })),
        )
        if (others.length > 0) store.setOtherBrands(id, others)
      } catch {
        // 模型这次没答上来：不判（规则那几格照常）
      }
    }
    return { answered, credits }
  }

  /** 一轮的格数与花费累加到轮次上。 */
  function addToRun(
    store: GeoStore,
    run_id: string,
    got: { answered: number; credits: number },
  ): void {
    const cur = store.runs().find((r) => r.id === run_id)
    if (cur === undefined) return
    store.finishRun(run_id, {
      answered: cur.answered + got.answered,
      credits: Math.round((cur.credits + got.credits) * 1000) / 1000,
    })
  }

  /* ── 排队档任务：提交、等、取回 ─────────────────────────────────────── */

  /** 等这几个任务走到头（间隔递增，最多等 `budget`；没走到头的留着下次取回）。 */
  async function waitTasks(data: WatchDataPort, ids: readonly string[]): Promise<void> {
    let waited = 0
    let delay = 2_000
    for (;;) {
      let open = 0
      for (const id of ids) {
        try {
          const t = await data.task(id)
          if (!DATA_TASK_TERMINAL_STATUSES.includes(t.status)) open += 1
        } catch {
          // 查不到状态：当还没好，下次再看
          open += 1
        }
      }
      if (open === 0 || waited + delay > budget) return
      await sleep(delay)
      waited += delay
      delay = Math.min(delay * 2, 60_000)
    }
  }

  async function itemsOf(data: WatchDataPort, id: string): Promise<Record<string, unknown>[]> {
    const out: Record<string, unknown>[] = []
    let cursor: string | undefined
    for (let page = 0; page < 20; page += 1) {
      const got = await data.items(id, cursor)
      out.push(...(got.items as Record<string, unknown>[]))
      if (got.next_cursor === undefined) break
      cursor = got.next_cursor
    }
    return out
  }

  /**
   * 取回排队档任务（走到头的才取；没走到头的留着）。geo 的按问的那句对回 Prompt，没回来的那几格
   * 记「没查成」；rank 的按关键词记排名快照。一轮的任务都取回了就把这一轮记完。回记完的那几轮。
   */
  async function collect(): Promise<WatchRun[]> {
    const data = deps.data?.()
    const store = await deps.store()
    const pending = store.tasks({ status: 'pending' })
    if (data === undefined || pending.length === 0) return []
    const { watch } = await ensureWatch()
    const touched = new Set<string>()
    const judged = { n: 0 }
    for (const t of pending) {
      let view: DataTaskView
      try {
        view = await data.task(t.task_id)
      } catch {
        continue
      }
      if (!DATA_TASK_TERMINAL_STATUSES.includes(view.status)) continue
      touched.add(t.run_id)
      const run = store.runs().find((r) => r.id === t.run_id)
      let items: Record<string, unknown>[] = []
      if (view.status === 'succeeded')
        try {
          items = await itemsOf(data, t.task_id)
        } catch {
          continue
        }
      if (run === undefined) {
        store.finishTask(t.task_id, 'failed', now())
        continue
      }
      if (t.kind === 'geo') {
        const each = items.length === 0 ? 0 : view.credits / items.length
        const byQ = new Map(
          items.map((i) => [
            String((i as { question?: unknown }).question ?? ''),
            i as unknown as AiAnswerDataItem,
          ]),
        )
        const results: CellResult[] = t.items.map((it) => {
          const hit = byQ.get(it.asked ?? '')
          return {
            cell: {
              prompt: {
                id: it.prompt_id ?? '',
                text: it.prompt_text ?? '',
                origin: 'human',
                enabled: true,
              },
              market: t.market,
              language: t.language,
              asked: it.asked ?? it.prompt_text ?? '',
            },
            platform: t.platform ?? 'chatgpt',
            raw:
              hit === undefined
                ? undefined
                : rawOfItem({ ...hit, platform: t.platform ?? hit.platform }, each),
          }
        })
        addToRun(store, run.id, await recordCells(store, watch, run, results, judged))
      } else {
        let n = 0
        for (const i of items as unknown as SeoRankCheckItem[]) {
          if (typeof i.keyword !== 'string' || !Array.isArray(i.organic)) continue
          store.recordRank(
            rankSnapshotOf(
              {
                ...i,
                features: i.features ?? {
                  ai_overview: false,
                  people_also_ask: false,
                  shopping: false,
                  video: false,
                },
                fetched_at: i.fetched_at ?? now(),
              },
              { run_id: run.id, market: t.market, device: t.device ?? 'mobile', watch },
            ),
          )
          n += 1
        }
        addToRun(store, run.id, { answered: n, credits: view.credits })
      }
      store.finishTask(t.task_id, view.status === 'succeeded' ? 'collected' : 'failed', now())
    }
    const done: WatchRun[] = []
    for (const run_id of touched) {
      if (store.tasks({ status: 'pending', run_id }).length > 0) continue
      store.finishRun(run_id, { status: 'done', finished_at: now() })
      const run = store.runs().find((r) => r.id === run_id)
      if (run !== undefined) done.push(run)
    }
    return done
  }

  /* ── 一轮 GEO ───────────────────────────────────────────────────────── */

  /** 决策 534：自带 key 那档问 Claude 前，每天第一次查一次免费的模型清单（结果当天记着）。 */
  async function claudeCheck(store: GeoStore): Promise<{ ok: boolean; reason?: string }> {
    const day = today(now())
    const cached = store.meta(CLAUDE_CHECK_KEY)
    if (cached?.startsWith(`${day}|`)) {
      const [, ok, reason] = cached.split('|')
      return ok === '1' ? { ok: true } : { ok: false, ...(reason ? { reason } : {}) }
    }
    if (deps.claudeModelCheck === undefined) return { ok: true }
    let got: { ok: boolean; reason?: string }
    try {
      got = await deps.claudeModelCheck()
    } catch (err) {
      got = { ok: false, reason: errText(err) }
    }
    store.setMeta(
      CLAUDE_CHECK_KEY,
      `${day}|${got.ok ? '1' : '0'}|${(got.reason ?? '').replace(/\|/g, ' ')}`,
    )
    return got
  }

  async function runGeo(
    trigger: 'scheduled' | 'manual',
    opts: {
      confirmed?: boolean
      /**
       * WP380 复查：只问这几条（即时问、不走排队档；官方那条路不问 Claude——单格贵、这一轮没人确认过）。
       * 这一轮记在复查表上，不进每周指标。
       */
      recheck?: { prompt_ids: readonly string[]; markets?: readonly string[] | undefined }
    } = {},
  ): Promise<GeoRoundOutcome> {
    const { store, watch } = await ensureWatch()
    const search = deps.searchData()
    const status = await search.status()
    const caps = status.route === 'official' ? await capabilities() : undefined
    const est = await estimate(watch, status, caps)
    const skip = (why: string): GeoRoundOutcome => ({
      skipped: why,
      notes: [why],
      pending_tasks: 0,
      estimate: est,
    })
    if (!watch.enabled) return skip('AI 回答监测在设置里关掉了，这一轮没有问。')
    if (!status.configured) return skip(status.reason ?? '搜索数据接口还没接，这一轮没有问各 AI。')
    const only = opts.recheck
    const markets = probingMarkets(watch).filter(
      (m) => only?.markets === undefined || only.markets.length === 0 || only.markets.includes(m),
    )
    if (markets.length === 0) return skip('每个市场的监测都关掉了，这一轮没有问。')
    const prompts =
      only === undefined
        ? watch.prompts.filter((p) => p.enabled).slice(0, watch.prompt_limit)
        : store
            .prompts({ archived: true })
            .filter((p) => only.prompt_ids.includes(p.id))
            .map(asQuestion)
    if (prompts.length === 0) return skip('还没选要追的 Prompt，这一轮没有问。')
    const notes: string[] = []
    let platforms = askable(watch, status, caps)
    if (watch.platforms.includes('claude') && !platforms.includes('claude'))
      notes.push(
        status.route === 'official' && deps.data?.() === undefined
          ? NOTE_NO_DATA_SERVICE
          : 'Claude 这一轮问不了（这条取数的路暂时没开 Claude），先跳过。',
      )
    // 定时：策略定了才问 Claude；手动：官方那条路这一轮合并确认过才问（单格 ≥ 1 积分，docs/75）；
    // 自带 key 不扣积分，手动照问
    // 决策 650（Luoye 10-14 定）：Claude 默认就问——定时那一轮不等策略定了（关注的 AI 里关掉才不问）；
    // 手动「现在跑一轮」官方那条路仍要这一轮合并确认过才问（单格 ≥ 1 积分，docs/75），自带 key 照问
    const claudeOk =
      (trigger === 'scheduled' && only === undefined) ||
      opts.confirmed === true ||
      status.route !== 'official'
    if (platforms.includes('claude') && !claudeOk) {
      platforms = platforms.filter((p) => p !== 'claude')
      notes.push(NOTE_CLAUDE_NOT_CONFIRMED_RUN)
    }
    if (platforms.includes('claude') && status.route === 'byo') {
      const ok = await claudeCheck(store)
      if (!ok.ok) {
        platforms = platforms.filter((p) => p !== 'claude')
        notes.push(
          `Claude 这一轮没问（没花钱）：你自带的搜索数据 key 那边查模型清单没通过${ok.reason ? `——${ok.reason}` : ''}。`,
        )
      }
    }
    if (platforms.length === 0)
      return { ...skip(notes[0] ?? '这条取数的路问不了关注的这几个 AI。'), notes }
    // 每个市场用它的语言问（Prompt 由模型翻；没模型就原语言问、注明）
    const cells: WatchCell[] = []
    const untranslated = new Set<string>()
    for (const market of markets)
      for (const prompt of prompts) {
        const t = await deps.translate(prompt.text, market)
        if (t.untranslated) untranslated.add(market)
        cells.push({ prompt, market, language: t.language, asked: t.asked })
      }
    if (untranslated.size > 0)
      notes.push(
        `还没配模型，${[...untranslated].map((m) => marketName(m)).join('、')}先按原语言问的（配好模型后按当地语言问）。`,
      )
    const run: WatchRun = {
      id: deps.nextId('wr'),
      kind: 'geo',
      trigger,
      period: periodOf(now()),
      status: 'running',
      planned: cells.length * platforms.length,
      answered: 0,
      credits: 0,
      started_at: now(),
    }
    store.startRun(run)
    const judged = { n: 0 }
    const data = deps.data?.()
    const submitted: string[] = []
    // ① 定时 + 官方：ChatGPT / Gemini / AI 概览走排队档批量任务（决策 469）
    const batch =
      trigger === 'scheduled' &&
      only === undefined &&
      status.route === 'official' &&
      data !== undefined
        ? platforms.filter(
            (p) => BATCHABLE.includes(p) && capOf(caps, `ai_answer_batch.${p}`)?.available === true,
          )
        : []
    const failed: CellResult[] = []
    for (const p of batch) {
      const groups = new Map<string, WatchCell[]>()
      for (const c of cells)
        groups.set(`${c.market}|${c.language}`, [
          ...(groups.get(`${c.market}|${c.language}`) ?? []),
          c,
        ])
      for (const [key, group] of groups) {
        const [market = '', language = ''] = key.split('|')
        const questions = [...new Set(group.map((c) => c.asked))]
        try {
          const view = await (data as WatchDataPort).submit({
            capability: `ai_answer_batch.${p}`,
            input: { questions, country: market.toLowerCase(), language },
            max_items: questions.length,
            idempotency_key: `geo|${run.id}|${p}|${market}|${language}`,
          })
          store.addTask({
            task_id: view.id,
            run_id: run.id,
            kind: 'geo',
            capability: `ai_answer_batch.${p}`,
            platform: p,
            market,
            language,
            items: group.map((c) => ({
              prompt_id: c.prompt.id,
              prompt_text: c.prompt.text,
              asked: c.asked,
            })),
            status: 'pending',
            submitted_at: now(),
          })
          submitted.push(view.id)
        } catch (err) {
          notes.push(
            `${p} 在 ${market} 这一批没交上去（${errText(err)}），这几格这周记「没查成」。`,
          )
          for (const c of group) failed.push({ cell: c, platform: p })
        }
      }
    }
    // ② 其余三家：即时问（手动、自带 key、或批量口没开）
    const live = platforms.filter((p) => p !== 'claude' && !batch.includes(p))
    const results: CellResult[] = [...failed]
    // 积分不够了：剩下的格不再问，记「没查成」（覆盖照实算）
    let broke = false
    if (live.length > 0)
      for (const c of cells) {
        if (broke) {
          for (const p of live) results.push({ cell: c, platform: p })
          continue
        }
        try {
          const got = await search.aiAnswers({
            question: c.asked,
            platforms: live,
            country: c.market.toLowerCase(),
            language: c.language,
            brand: {
              name: watch.brand.name,
              domains: watch.brand.domains,
              aliases: watch.brand.aliases,
            },
            competitors: watch.competitors.map((x) => ({
              name: x.name,
              domains: x.domains,
              aliases: x.aliases,
            })),
          })
          for (const p of live) {
            const hit = got.find((r) => r.platform === p)
            results.push({
              cell: c,
              platform: p,
              raw: hit === undefined ? undefined : rawOfResult(hit),
            })
          }
        } catch (err) {
          if (codeOf(err) === 'insufficient_credits' || codeOf(err) === 'budget_exhausted') {
            notes.push(`积分不够了，这一轮剩下的没问（${errText(err)}）。`)
            broke = true
          } else notes.push(`「${c.prompt.text}」在 ${c.market} 这一问没查到（${errText(err)}）。`)
          for (const p of live) results.push({ cell: c, platform: p })
        }
      }
    // ③ Claude：官方走能力目录（单独定价）；自带 key 走自己的服务商
    if (platforms.includes('claude'))
      for (const c of cells) {
        if (broke) {
          results.push({ cell: c, platform: 'claude' })
          continue
        }
        try {
          if (status.route === 'byo') {
            const got = await search.aiAnswers({
              question: c.asked,
              platforms: ['claude'],
              country: c.market.toLowerCase(),
              language: c.language,
              brand: {
                name: watch.brand.name,
                domains: watch.brand.domains,
                aliases: watch.brand.aliases,
              },
            })
            const hit = got.find((r) => r.platform === 'claude')
            results.push({
              cell: c,
              platform: 'claude',
              raw: hit === undefined ? undefined : rawOfResult(hit),
            })
          } else {
            const got = await (data as WatchDataPort).call('ai_answer.claude', {
              input: { question: c.asked, country: c.market.toLowerCase(), language: c.language },
            })
            const item = got.items[0] as AiAnswerDataItem | undefined
            results.push({
              cell: c,
              platform: 'claude',
              raw:
                item === undefined
                  ? { platform: 'claude', text: '', cited_urls: [], credits: got.credits }
                  : rawOfItem({ ...item, platform: 'claude' }, got.credits),
            })
          }
        } catch (err) {
          if (codeOf(err) === 'insufficient_credits' || codeOf(err) === 'budget_exhausted') {
            notes.push(`积分不够了，Claude 剩下的这几格没问（${errText(err)}）。`)
            broke = true
          }
          results.push({ cell: c, platform: 'claude' })
        }
      }
    addToRun(store, run.id, await recordCells(store, watch, run, results, judged))
    if (submitted.length > 0 && data !== undefined) {
      await waitTasks(data, submitted)
      await collect()
    }
    const left = store.tasks({ status: 'pending', run_id: run.id }).length
    if (left === 0) store.finishRun(run.id, { status: 'done', finished_at: now(), notes })
    else store.finishRun(run.id, { notes })
    return {
      run: store.runs().find((r) => r.id === run.id) as WatchRun,
      notes,
      pending_tasks: left,
      estimate: est,
    }
  }

  /* ── 关注词排名、品牌词 Search Console 周数据 ───────────────────────── */

  async function runRank(
    trigger: 'scheduled' | 'manual',
  ): Promise<{ run?: WatchRun; notes: string[]; skipped?: string }> {
    const { store, watch } = await ensureWatch()
    const keywords = watch.keywords.filter((k) => k.enabled).map((k) => k.keyword)
    if (!watch.enabled || keywords.length === 0)
      return { notes: [], skipped: keywords.length === 0 ? '还没设关注的关键词。' : '监测关掉了。' }
    const search = deps.searchData()
    const status = await search.status()
    if (!status.configured) return { notes: [], skipped: status.reason ?? '搜索数据接口还没接。' }
    const markets = probingMarkets(watch)
    const devices = devicesOf(watch.rank_device)
    const data = deps.data?.()
    const caps = status.route === 'official' ? await capabilities() : undefined
    if (
      status.route === 'official' &&
      (data === undefined || capOf(caps, 'seo.rank_check')?.available !== true)
    )
      return { notes: [NOTE_NO_DATA_SERVICE], skipped: NOTE_NO_DATA_SERVICE }
    const notes: string[] = []
    const run: WatchRun = {
      id: deps.nextId('wr'),
      kind: 'rank',
      trigger,
      period: periodOf(now()),
      status: 'running',
      planned: keywords.length * markets.length * devices.length,
      answered: 0,
      credits: 0,
      started_at: now(),
    }
    store.startRun(run)
    const submitted: string[] = []
    for (const market of markets)
      for (const device of devices) {
        const language = await deps.languageOf(market)
        if (status.route === 'byo') {
          let n = 0
          for (const keyword of keywords)
            try {
              const serp = await search.serp({
                query: keyword,
                engine: 'google',
                country: market.toLowerCase(),
                language,
                device,
              })
              store.recordRank(
                rankSnapshotOf(rankItemOfSerp(serp, device), {
                  run_id: run.id,
                  market,
                  device,
                  watch,
                }),
              )
              n += 1
            } catch (err) {
              notes.push(`「${keyword}」在 ${market} 没查到排名（${errText(err)}）。`)
            }
          addToRun(store, run.id, { answered: n, credits: 0 })
          continue
        }
        for (let i = 0; i < keywords.length; i += 100) {
          const chunk = keywords.slice(i, i + 100)
          try {
            const view = await (data as WatchDataPort).submit({
              capability: 'seo.rank_check',
              input: {
                keywords: chunk,
                country: market.toLowerCase(),
                language,
                device,
                depth: RANK_CHECK_DEPTH,
              },
              max_items: chunk.length,
              idempotency_key: `rank|${run.id}|${market}|${device}|${i}`,
            })
            store.addTask({
              task_id: view.id,
              run_id: run.id,
              kind: 'rank',
              capability: 'seo.rank_check',
              market,
              language,
              device,
              items: chunk.map((keyword) => ({ keyword })),
              status: 'pending',
              submitted_at: now(),
            })
            submitted.push(view.id)
          } catch (err) {
            notes.push(`${market} 的关注词排名这一批没交上去（${errText(err)}）。`)
          }
        }
      }
    if (submitted.length > 0 && data !== undefined) {
      await waitTasks(data, submitted)
      await collect()
    }
    const left = store.tasks({ status: 'pending', run_id: run.id }).length
    store.finishRun(run.id, left === 0 ? { status: 'done', finished_at: now(), notes } : { notes })
    return { run: store.runs().find((r) => r.id === run.id) as WatchRun, notes }
  }

  /** 决策 468：品牌词在 Search Console 里这一周的曝光 / 点击 / 平均排名（没连就不取、说一句）。 */
  async function brandGsc(): Promise<{ rows: number; note?: string }> {
    const { store, watch } = await ensureWatch()
    const g = await deps.gsc().catch(() => ({ connected: false, rows: [] as GscRow[] }))
    if (!g.connected)
      return { rows: 0, note: '没连 Search Console，品牌词那一块先不显示（去连接页连上就有）。' }
    const isBrand = isBrandQuery(watch)
    const by = new Map<string, { i: number; c: number; w: number }>()
    for (const r of g.rows) {
      if (!isBrand(r.query)) continue
      const k = r.query.trim().toLowerCase()
      const cur = by.get(k) ?? { i: 0, c: 0, w: 0 }
      by.set(k, {
        i: cur.i + r.impressions,
        c: cur.c + r.clicks,
        w: cur.w + r.position * r.impressions,
      })
    }
    const week = periodOf(now())
    const rows: SeoBrandGscWeek[] = [...by.entries()].map(([query, v]) => ({
      week,
      query,
      impressions: v.i,
      clicks: v.c,
      position: v.i === 0 ? 0 : Math.round((v.w / v.i) * 10) / 10,
      fetched_at: now(),
    }))
    store.recordBrandGscWeeks(rows)
    const id = deps.nextId('wr')
    store.startRun({
      id,
      kind: 'brand_gsc',
      trigger: 'scheduled',
      period: week,
      status: 'done',
      planned: rows.length,
      answered: rows.length,
      credits: 0,
      started_at: now(),
      finished_at: now(),
    })
    return { rows: rows.length }
  }

  /* ── 指标（规则算，从历史原文来） ─────────────────────────────────────── */

  /** `from` 那一周起的 GEO 回答（带判定、引用、那一轮的周、Prompt 带不带品牌名）。 */
  function history(
    store: GeoStore,
    fromWeek: string,
    opts: { rechecks?: 'exclude' | 'only' } = {},
  ): MetricAnswer[] {
    // WP380：复查那几轮只问了一小组，不进每周指标（复查自己比前后）
    const recheckRuns = new Set(
      store.rechecks().flatMap((r) => (r.run_id === undefined ? [] : [r.run_id])),
    )
    const keep = (id: string) =>
      opts.rechecks === 'only' ? recheckRuns.has(id) : !recheckRuns.has(id)
    const runs = new Map(
      store
        .runs({ kind: 'geo' })
        .filter((r) => keep(r.id))
        .map((r) => [r.id, r]),
    )
    const branded = new Map(store.prompts({ archived: true }).map((p) => [p.id, p.branded]))
    const answers = store
      .answers({ range: { from: `${fromWeek}T00:00:00Z` } })
      .filter((a) => runs.has(a.run_id))
    const insights = new Map(
      store.insights(answers.map((a) => a.id)).map((i) => [i.answer_id, i] as const),
    )
    return answers.map((a) => ({
      answer: a,
      week: runs.get(a.run_id)?.period ?? mondayOf(a.fetched_at),
      mentions: store.mentions(a.id),
      citations: store.citations(a.id),
      branded: branded.get(a.prompt_id),
      insight: insights.get(a.id),
    }))
  }

  /* ── WP380：官方事实表 ─────────────────────────────────────────────── */

  /** 官方事实表：先跟品牌档案同步（档案改了旧说法进 previous；人改的不动），再读。 */
  async function officialFacts(store?: GeoStore): Promise<GeoOfficialFact[]> {
    const s = store ?? (await deps.store())
    const b = await deps.brand()
    const cur = s.facts()
    const next = syncFacts(
      cur,
      factValuesOf({
        name: b.name,
        category: b.category,
        subcategory: b.subcategory,
        price_band: b.price_band,
        positioning: b.positioning,
        one_liner: b.one_liner,
        markets: b.markets,
      }),
      today(now()),
    )
    if (JSON.stringify(next) !== JSON.stringify(cur)) s.saveFacts(next)
    return next
  }

  /** 人改官方事实（空值 = 退回跟档案走）。 */
  async function setFacts(patch: GeoFactsPatch): Promise<GeoOfficialFact[]> {
    const store = await deps.store()
    const cur = await officialFacts(store)
    store.saveFacts(patchFacts(cur, patch, today(now())))
    return officialFacts(store)
  }

  function rankHistory(store: GeoStore, fromWeek: string): RankPoint[] {
    const runs = new Map(store.runs({ kind: 'rank' }).map((r) => [r.id, r.period]))
    return store
      .ranks({ range: { from: `${fromWeek}T00:00:00Z` } })
      .map((s) => ({ ...s, week: runs.get(s.run_id) ?? mondayOf(s.fetched_at) }))
  }

  const namesOf = (watch: BrandWatch): Map<string, string> =>
    new Map([
      ['ours', watch.brand.name],
      ...watch.competitors.map((c) => [c.id, c.name] as [string, string]),
    ])

  /** 看板要的全部数（默认近 12 周；被引用最多的站按近 4 周）。 */
  async function metrics(opts: { weeks?: number } = {}): Promise<GeoMetricsView> {
    const { store, watch } = await ensureWatch()
    const weeks = Math.max(1, Math.min(52, opts.weeks ?? 12))
    const thisWeek = periodOf(now())
    // 多取 4 周：近 4 周滚动与「和上一段比」要它
    const rows = history(store, shiftDay(thisWeek, -7 * (weeks + 4)))
    const week = [...new Set(rows.map((r) => r.week))].sort().at(-1)
    const g = await deps.gsc().catch(() => ({ connected: false, rows: [] as GscRow[] }))
    const gscPos = (k: string): number | undefined => {
      const hits = g.rows.filter((r) => r.query.trim().toLowerCase() === k.trim().toLowerCase())
      const imp = hits.reduce((a, r) => a + r.impressions, 0)
      return imp === 0
        ? undefined
        : Math.round((hits.reduce((a, r) => a + r.position * r.impressions, 0) / imp) * 10) / 10
    }
    const rank = rankMetrics(rankHistory(store, shiftDay(thisWeek, -7 * (weeks + 4))), gscPos)
    const from = shiftDay(thisWeek, -7 * weeks)
    const trends = geoTrends(rows).map((l) => ({
      ...l,
      points: l.points.filter((p) => p.week >= from),
    }))
    const range = week === undefined ? undefined : { from: shiftDay(week, -21), to: week }
    const pages = range === undefined ? [] : citedSources(rows, range, 'page')
    const notes: string[] = []
    if (rows.length === 0) notes.push('还没有监测历史：跑过第一轮就有。')
    // WP335：方格（最新一周）与简报那一行（这一周没拿到回答就不出）
    const grid = week === undefined ? undefined : geoGrid(rows, week)
    const allLine = trends.find((l) => l.kind === 'all')
    const brief = geoBriefLine(
      allLine?.points.find((p) => p.week === week),
      rank.week === week ? rank : undefined,
    )
    // WP380：说得对不对、比得过谁（AI 判断那一步附原话；这里只数）+ 官方事实、一致性、复查
    const facts = await officialFacts(store)
    const consistency = store.consistencyRuns(1)[0]
    const rechecks = [
      ...store.rechecks({ status: 'waiting' }),
      ...store
        .rechecks({ status: 'done' })
        .sort((a, b) => b.due.localeCompare(a.due))
        .slice(0, 5),
    ].slice(0, 10)
    const quality = {
      ...geoQualityOf(rows, week, facts),
      facts,
      ...(consistency === undefined ? {} : { consistency }),
      rechecks,
    }
    return {
      quality,
      ...(week === undefined ? {} : { week }),
      ...(grid === undefined ? {} : { grid }),
      ...(brief === undefined ? {} : { brief }),
      trends,
      brands: week === undefined ? [] : brandShares(rows, week, namesOf(watch)),
      sentiment:
        week === undefined
          ? { positive: 0, neutral: 0, negative: 0, by: 'ai' }
          : sentimentCounts(rows, week),
      top_domains: range === undefined ? [] : citedSources(rows, range, 'domain').slice(0, 10),
      top_pages: pages.slice(0, 10),
      our_pages: pages.filter((p) => p.group === 'ours').slice(0, 10),
      competitor_pages: pages.filter((p) => p.group === 'competitor').slice(0, 10),
      changes: week === undefined ? [] : cellChanges(rows, week),
      rank,
      brand_gsc: {
        connected: g.connected,
        weeks: g.connected ? brandGscWeeks(store.brandGscWeeks({ range: { from } })) : [],
      },
      notes,
    }
  }

  /**
   * WP335：「一条回答」——全文、编号引用、各品牌判定、同一格上一期（「和上周比」）、
   * 这一格近 12 周的时间线、高亮用的名字。没有这条 → `undefined`（路由回 404）。
   */
  async function answer(id: string): Promise<GeoAnswerDetail | undefined> {
    const { store, watch } = await ensureWatch()
    const a = store.answer(id)
    if (a === undefined) return undefined
    const runs = new Map(store.runs({ kind: 'geo' }).map((r) => [r.id, r.period]))
    const weekOf = (x: { run_id: string; fetched_at: string }): string =>
      runs.get(x.run_id) ?? mondayOf(x.fetched_at)
    const sideOf = (x: typeof a): GeoAnswerSide => ({
      week: weekOf(x),
      answer: x,
      citations: [...store.citations(x.id)].sort((p, q) => p.position - q.position),
      mentions: store.mentions(x.id),
    })
    const branded = store.prompts({ archived: true }).find((p) => p.id === a.prompt_id)?.branded
    const same: MetricAnswer[] = store
      .answers({ prompt_id: a.prompt_id, platform: a.platform, market: a.market })
      .map((x) => ({
        answer: x,
        week: weekOf(x),
        mentions: store.mentions(x.id),
        citations: [],
        branded,
      }))
    const week = weekOf(a)
    const history = cellHistory(
      same.filter((r) => r.week <= week),
      { prompt_id: a.prompt_id, platform: a.platform, market: a.market },
      12,
    )
    // 上一期 = 比这一周早、拿到了回答的最近一周（同一周取最新那条）
    const prevPoint = history.filter((h) => h.week < week && h.state !== 'failed').at(-1)
    const prev = prevPoint === undefined ? undefined : store.answer(prevPoint.answer_id)
    return {
      ...sideOf(a),
      ...(prev === undefined ? {} : { previous: sideOf(prev) }),
      history,
      names: [
        {
          entity: 'ours',
          name: watch.brand.name,
          terms: [watch.brand.name, ...watch.brand.aliases, ...watch.brand.domains],
        },
        ...watch.competitors.map((c) => ({
          entity: c.id,
          name: c.name,
          terms: [c.name, ...c.aliases, ...c.domains],
        })),
      ],
    }
  }

  /** 这一周变化大的那几件（「变化大才出卡」；其余只是数字波动）。 */
  async function alerts(week: string): Promise<GeoAlert[]> {
    const { store, watch } = await ensureWatch()
    const rows = history(store, shiftDay(week, -28))
    const ids = rows
      .filter((r) => r.week === week && r.answer.status === 'ok')
      .map((r) => r.answer.id)
    const counts = new Map<string, { name: string; n: Set<string> }>()
    for (const o of store.otherBrands(ids)) {
      const k = o.name.trim().toLowerCase()
      const cur = counts.get(k) ?? { name: o.name, n: new Set<string>() }
      cur.n.add(o.answer_id)
      counts.set(k, cur)
    }
    const others = new Map([...counts.values()].map((v) => [v.name, v.n.size]))
    const ranks = rankMetrics(rankHistory(store, shiftDay(week, -28)).filter((p) => p.week <= week))
    return geoAlerts({
      rows,
      week,
      ranks: ranks.week === week ? ranks : undefined,
      others,
      names: namesOf(watch),
    })
  }

  /** 一轮的回答 → 老报告卡上的行（兼容 `seo.geo_visibility` 等老读法）。 */
  async function probeRowsOf(run_id: string): Promise<GeoProbeRow[]> {
    const { store, watch } = await ensureWatch()
    const names = namesOf(watch)
    return store
      .answers({ run_id })
      .filter((a) => a.status === 'ok')
      .map((a) => {
        const ms = store.mentions(a.id)
        const cs = store.citations(a.id)
        const ours = ms.find((m) => m.entity === 'ours')
        return {
          question: a.prompt_text,
          platform: a.platform,
          market: a.market,
          language: a.language,
          ...(a.asked_text === a.prompt_text ? {} : { asked: a.asked_text }),
          brand_mentioned: ours?.mentioned === true,
          our_domain_cited: cs.some((c) => c.site_kind === 'ours'),
          cited_domains: [
            ...new Set(cs.filter((c) => c.where !== 'searched').map((c) => c.domain)),
          ],
          competitors_mentioned: ms
            .filter((m) => m.entity !== 'ours' && m.mentioned)
            .map((m) => names.get(m.entity) ?? m.name_snapshot),
        }
      })
  }

  /* ── 策略设定与改设置 ─────────────────────────────────────────────── */

  /** AI 按品牌档案（品类、阶段、市场）给一份策略；没模型 / 模型没答好就是兜底（追 5 条）。 */
  async function suggest(): Promise<GeoWatchStrategy> {
    const { store, watch, brand } = await ensureWatch()
    const g = await deps.gsc().catch(() => ({ connected: false, rows: [] as GscRow[] }))
    const isBrand = isBrandQuery(watch)
    const byQuery = new Map<string, number>()
    for (const r of g.rows) byQuery.set(r.query, (byQuery.get(r.query) ?? 0) + r.impressions)
    const top = [...byQuery.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 30)
      .map(([q]) => q)
    // WP346（决策 872）：竞品与关注词先读品牌档案（关注设置里还没有的时候），读不到再让 AI 建议
    const profileCompetitors: BrandWatchCompetitor[] =
      watch.competitors.length > 0
        ? watch.competitors
        : (brand.competitors ?? []).slice(0, 10).map((c) => ({
            id: competitorId(c.name),
            name: c.name,
            aliases: [],
            domains: (() => {
              try {
                return c.url === undefined ? [] : [new URL(c.url).hostname.replace(/^www\./, '')]
              } catch {
                return []
              }
            })(),
          }))
    const profileKeywords: BrandWatchKeyword[] =
      watch.keywords.length > 0 || brand.keywords === undefined
        ? []
        : [
            ...brand.keywords.brand.map((k) => ({ keyword: k, branded: true, enabled: true })),
            ...brand.keywords.category.map((k) => ({ keyword: k, branded: false, enabled: true })),
            ...brand.keywords.scenario.map((k) => ({ keyword: k, branded: false, enabled: true })),
          ]
    const audience =
      brand.audience === undefined
        ? undefined
        : [brand.audience.buyers, ...(brand.audience.concerns ?? [])].join('；')
    const profile = {
      brand: { name: watch.brand.name, aliases: watch.brand.aliases, domains: watch.brand.domains },
      one_liner: brand.one_liner,
      category: brand.category,
      ...(audience === undefined ? {} : { audience }),
      ...(profileKeywords.length === 0 ? {} : { profile_keywords: profileKeywords }),
      markets: probingMarkets(watch),
      language: brand.language,
      stage_hint: stageHint(
        g.connected
          ? [...byQuery.entries()].map(([query, impressions]) => ({ query, impressions }))
          : undefined,
        isBrand,
      ),
      top_queries: top,
      competitors: profileCompetitors,
    }
    const model = deps.model?.('strategy')
    let reply: ReturnType<typeof parseStrategyReply>
    if (model !== undefined)
      try {
        reply = parseStrategyReply((await model({ prompt: strategyPrompt(profile) })).text)
      } catch {
        reply = undefined
      }
    const keywords =
      watch.keywords.length > 0
        ? watch.keywords
        : defaultWatchKeywords({
            brand: watch.brand,
            category: brand.category ?? reply?.category,
            language: brand.language,
            top_queries: top,
            isBrand,
          })
    return buildStrategy({
      profile,
      reply,
      existing: store.prompts({ archived: true }).map(asQuestion),
      platforms: watch.platforms,
      keywords,
      at: now(),
    })
  }

  const PLATFORM_OK = new Set<AiPlatform>(BRAND_WATCH_DEFAULT_PLATFORMS)
  /** WP392：Amazon 商品清一下（站点大写、ASIN 大写去空、同站点同 ASIN 只留一条；C6 只设技术上限 100）。 */
  const cleanAmazon = (items: readonly BrandWatchAmazonItem[]): BrandWatchAmazonItem[] => {
    const seen = new Set<string>()
    const out: BrandWatchAmazonItem[] = []
    for (const it of items) {
      const marketplace = it.marketplace.trim().toUpperCase()
      const asin = it.asin.trim().toUpperCase()
      if (marketplace === '' || asin === '' || seen.has(`${marketplace}|${asin}`)) continue
      seen.add(`${marketplace}|${asin}`)
      out.push({
        marketplace,
        asin,
        ...(it.label === undefined || it.label.trim() === '' ? {} : { label: it.label.trim() }),
        ...(it.vs_own === undefined || it.vs_own.trim() === '' ? {} : { vs_own: it.vs_own.trim() }),
      })
    }
    return out.slice(0, 100)
  }
  const cleanCompetitors = (cs: readonly BrandWatchCompetitor[]): BrandWatchCompetitor[] =>
    cs
      .filter((c) => c.name.trim() !== '')
      .slice(0, 10)
      .map((c) => ({
        id: c.id.trim() === '' ? `c_${promptId(c.name).slice(3)}` : c.id,
        name: c.name.trim().slice(0, 80),
        aliases: c.aliases
          .map((a) => a.trim())
          .filter((a) => a !== '')
          .slice(0, 10),
        domains: c.domains
          .map((d) =>
            d
              .trim()
              .toLowerCase()
              .replace(/^https?:\/\//, '')
              .replace(/^www\./, '')
              .replace(/\/.*$/, ''),
          )
          .filter((d) => d.includes('.'))
          .slice(0, 5),
        // WP392（docs/104 C3）：竞品监控加的两格（独立站、Amazon 对标款）原样留着，只清一下空的
        ...(c.store === undefined || c.store.url.trim() === ''
          ? {}
          : { store: { ...c.store, url: c.store.url.trim() } }),
        ...(c.amazon === undefined ? {} : { amazon: cleanAmazon(c.amazon) }),
      }))

  /**
   * 改关注设置（用户确认 / 改策略都走这里；人改过就算「定了」，设定卡不再自动出）。
   * Prompt 原句不可改：改字 = 归档旧的 + 新建一条；归档过的同一句不以「新的」身份回来。
   */
  async function apply(
    patch: GeoWatchPatch,
    opts: { markSetup?: boolean } = {},
  ): Promise<BrandWatch> {
    const { store, watch } = await ensureWatch()
    store.tx(() => {
      let s: BrandWatchSettings = { ...settingsOf(watch), updated_at: now() }
      const all = () => store.prompts({ archived: true })
      let select: string[] | undefined
      if (patch.strategy !== undefined) {
        const st = patch.strategy
        const have = new Map(all().map((p) => [p.id, p]))
        for (const p of [...st.prompts, ...st.candidates])
          if (!have.has(p.id) && newPromptCandidates(all(), [p]).length > 0)
            store.addPrompt({ ...p, selected: false, created_at: now() })
        select = st.prompts.map((p) => p.id)
        s = {
          ...s,
          prompt_limit: Math.max(1, Math.min(st.prompt_limit, s.prompt_cap)),
          competitors: cleanCompetitors(st.competitors),
          keywords: st.keywords.slice(0, WATCH_KEYWORDS_MAX),
          platforms: st.platforms.filter((p) => PLATFORM_OK.has(p)),
        }
      }
      if (patch.brand_aliases !== undefined)
        s = {
          ...s,
          brand: {
            ...s.brand,
            aliases: patch.brand_aliases
              .map((a) => a.trim())
              .filter((a) => a !== '')
              .slice(0, 10),
          },
        }
      if (patch.competitors !== undefined)
        s = { ...s, competitors: cleanCompetitors(patch.competitors) }
      // WP392（docs/104 C8）：自家的 Amazon 商品（竞品对标款比价用）
      if (patch.brand_amazon !== undefined) {
        const { amazon: _old, ...brand } = s.brand
        const amazon = cleanAmazon(patch.brand_amazon)
        s = { ...s, brand: amazon.length === 0 ? brand : { ...brand, amazon } }
      }
      if (patch.keywords !== undefined)
        s = {
          ...s,
          keywords: patch.keywords
            .filter((k) => k.keyword.trim() !== '')
            .slice(0, WATCH_KEYWORDS_MAX),
        }
      if (patch.platforms !== undefined)
        s = { ...s, platforms: patch.platforms.filter((p) => PLATFORM_OK.has(p)) }
      if (patch.markets_off !== undefined) {
        const off = [
          ...new Set(
            patch.markets_off
              .map((m) => m.trim().toUpperCase())
              .filter((m) => /^[A-Z]{2}$/.test(m)),
          ),
        ]
        const { markets_off: _o, ...rest } = s
        s = off.length === 0 ? rest : { ...rest, markets_off: off }
      }
      if (patch.frequency !== undefined) s = { ...s, frequency: patch.frequency }
      if (patch.rank_device !== undefined) s = { ...s, rank_device: patch.rank_device }
      if (patch.enabled !== undefined) s = { ...s, enabled: patch.enabled }
      if (patch.prompt_limit !== undefined)
        s = {
          ...s,
          prompt_limit: Math.max(
            1,
            Math.min(Math.round(patch.prompt_limit), s.prompt_cap, GEO_PROMPT_CAP_MAX),
          ),
        }
      for (const t of patch.add_prompts ?? []) {
        const text = t.text.trim().slice(0, 300)
        if (text === '') continue
        const id = t.id ?? promptId(text)
        const cur = store.prompt(id)
        if (cur !== undefined) {
          if (cur.archived_at === undefined && t.selected !== undefined)
            store.updatePrompt(id, { selected: t.selected })
          continue
        }
        const branded = promptIsBranded(text, s.brand)
        store.addPrompt({
          id,
          text,
          origin: 'human',
          enabled: true,
          topic: branded ? 'branded' : (t.topic ?? guessPromptTopic(text, s.brand)),
          branded,
          selected: t.selected === true,
          created_at: now(),
        })
      }
      for (const e of patch.edit_prompts ?? []) {
        const text = e.text.trim().slice(0, 300)
        if (text === '' || store.prompt(e.id) === undefined) continue
        const id = store.prompt(promptId(text)) === undefined ? promptId(text) : deps.nextId('gp')
        store.editPromptText(e.id, { id, text, at: now() })
      }
      for (const id of patch.archive_prompts ?? []) store.archivePrompt(id, now())
      store.saveSettings(s)
      // 已选：给了就照给的；没给就按上限收 / 补（人选过的优先）
      const live = store.prompts().map(asQuestion)
      const ids = patch.select ?? select ?? live.filter((p) => p.selected === true).map((p) => p.id)
      const kept = ids.filter((id) => live.some((p) => p.id === id)).slice(0, s.prompt_limit)
      store.selectPrompts(
        kept.length >= s.prompt_limit || patch.select !== undefined
          ? kept
          : pickDefaultPrompts(
              live.map((p) => ({ ...p, selected: kept.includes(p.id) })),
              s.prompt_limit,
            ),
      )
      if (opts.markSetup !== false) store.setMeta(WATCH_SETUP_KEY, now())
    })
    return store.watch() as BrandWatch
  }

  async function view(): Promise<GeoWatchView> {
    const { store, watch } = await ensureWatch()
    const status = await deps.searchData().status()
    const est = await estimate(watch, status)
    const runs = store.runs()
    const last = (['geo', 'rank', 'brand_gsc'] as const).flatMap((k) =>
      runs
        .filter((r) => r.kind === k)
        .slice(-3)
        .reverse(),
    )
    const gscConnected =
      deps.gscConnected?.() ??
      (await deps.gsc().catch(() => ({ connected: false, rows: [] as GscRow[] }))).connected
    const notes: string[] = []
    const check = store.meta(CLAUDE_CHECK_KEY)
    if (status.route === 'byo' && check?.startsWith(`${today(now())}|0`))
      notes.push(
        `Claude 今天没问：你自带的搜索数据 key 那边查模型清单没通过${check.split('|')[2] ? `——${check.split('|')[2]}` : ''}。`,
      )
    const raw = store.meta(WATCH_SETUP_CARD_KEY)
    // `declined` = 人在设定卡上说了「不要」：不再自动出卡，面板上照样显示「还没定」
    const card = raw === undefined || raw === '' || raw === SETUP_DECLINED ? undefined : raw
    return {
      watch,
      estimate: est,
      setup: setupDone(store) ? 'done' : card !== undefined ? 'pending_card' : 'needed',
      ...(card === undefined || setupDone(store) ? {} : { setup_card_id: card }),
      last_runs: last,
      pending_tasks: store.tasks({ status: 'pending' }).length,
      search_data: status.configured ? 'configured' : 'not_configured',
      gsc_connected: gscConnected,
      notes,
    }
  }

  return {
    ensureWatch,
    estimate: async () => {
      const { watch } = await ensureWatch()
      return estimate(watch, await deps.searchData().status())
    },
    /** 按一份策略（还没落成设置）估一轮 / 每月花多少（设定卡上写清）。 */
    estimateFor: async (st: GeoWatchStrategy) => {
      const { watch } = await ensureWatch()
      return estimate(
        {
          ...watch,
          prompts: st.prompts,
          prompt_limit: st.prompt_limit,
          platforms: st.platforms,
          keywords: st.keywords,
        },
        await deps.searchData().status(),
      )
    },
    view,
    suggest,
    apply,
    runGeo,
    /** WP380：官方事实表（读之前先跟档案同步）/ 人改。 */
    officialFacts: () => officialFacts(),
    setFacts,
    /** WP380：指标要的回答行（复查那几轮默认不算；`only` = 只要复查那几轮）。 */
    historyRows: async (fromWeek: string, opts: { rechecks?: 'exclude' | 'only' } = {}) =>
      history(await deps.store(), fromWeek, opts),
    runRank,
    brandGsc,
    collect,
    metrics,
    answer,
    alerts,
    probeRowsOf,
    setupDone: async () => setupDone(await deps.store()),
    /** 设定卡出了 / 决定了：记下（决定了就清掉）。 */
    setSetupCard: async (id: string | undefined) => {
      const store = await deps.store()
      store.setMeta(WATCH_SETUP_CARD_KEY, id ?? '')
    },
    setupCard: async (): Promise<string | undefined> => {
      const v = (await deps.store()).meta(WATCH_SETUP_CARD_KEY)
      return v === undefined || v === '' ? undefined : v
    },
  }
}
