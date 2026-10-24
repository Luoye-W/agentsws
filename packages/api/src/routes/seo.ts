/**
 * WP154「内容与搜索」的 `/v1/seo/*`（最小一套，三条）。
 *
 * - `GET  /v1/seo/geo-questions`：买家会问的问题清单（自动生成 + 人改过的）；
 * - `PUT  /v1/seo/geo-questions`：在面板里改（关掉、改字、加）——人改过的永远赢；
 * - `POST /v1/seo/run`：现在跑一轮（每日判断 / 周小结），不用等到早上 8 点。
 * - WP159 `GET / PATCH /v1/knowledge/claim-rules`：知识库里那张「违规宣称规则」表（按市场分组、
 *   带出处）；闸走**知识库**那一套（读 = knowledge.read，改 = knowledge.stage，工作区范围），
 *   因为这张表就放在知识库里——实现落在内容与搜索那一层（它管质检）。
 * - `GET / PUT /v1/seo/google-sources`（WP158）：Search Console 选哪个站点、GA4 选哪个媒体资源。
 * - WP310 `GET /v1/seo/geo-history/export`、`POST /v1/seo/geo-history/delete`：GEO / 排名历史
 *   （回答全文、引用、判定、周数据）导出成 JSON / CSV、按品牌或按时间段删（决策 473）。
 * - WP321 `GET / PUT /v1/seo/watch`、`POST /v1/seo/watch/strategy`、`POST /v1/seo/watch/run`、
 *   `GET /v1/seo/watch/metrics`：「GEO 关注设置」读写、AI 按品牌档案给策略（可同时出设定卡）、
 *   现在跑一轮（Claude 单格 ≥ 1 积分先回估算、带 `confirm` 才跑）、看板要的数（O3 画）。
 *
 * 闸：`content` 域（`dtc.seo` / `dtc.content` 的 scopes 里都有 read / stage）。别的职责进不来，
 * 路由里一行 if 都不用写（同 `pr.ts` 文件头第 1 条）。判断与出卡全在服务端的
 * `seo-service.ts`，这里只收发。
 */
import type {
  AssignmentId,
  BacklinkAuditRun,
  BacklinkAuditSettings,
  BacklinkAuditView,
  ClaimMarketGroup,
  ClaimRulesView,
  GeoAnswerDetail,
  GeoConsistencyRun,
  GeoCostEstimate,
  GeoFactsPatch,
  GeoHistoryDeleteInput,
  GeoHistoryDeleteResult,
  GeoHistoryExport,
  GeoMetricsView,
  GeoOfficialFact,
  GeoQuestion,
  GeoRecheck,
  GeoRecheckInput,
  GeoSettings,
  GeoWatchPatch,
  GeoWatchRunResult,
  GeoWatchSuggestion,
  GeoWatchView,
  LlmsTxtView,
  MaybePromise,
  PersonId,
  RepurposeChannel,
  RepurposeResult,
  RoleId,
  SeoCalendarView,
  SeoClusterPlanResult,
  WorkspaceId,
} from '@agentsws/contracts'
import { z } from 'zod'
import { ApiError } from '../errors.js'
import { assignmentOf, body, ok, param, principalOf } from '../helpers.js'
import { type Route, route } from '../route-spec.js'
import type { GatewayDeps } from '../types.js'

const READ_CONTENT = {
  domain: 'content',
  op: 'read',
  range: 'assigned',
  sensitivity: 'internal',
} as const
const STAGE_CONTENT = { ...READ_CONTENT, op: 'stage' } as const

export interface SeoActor {
  workspace_id: WorkspaceId
  person_id: PersonId
  assignment_id: AssignmentId
  role_id: RoleId
}

/** 现在跑一轮的结果（数全是服务端算好的）。 */
export interface SeoRunView {
  what: 'daily' | 'weekly'
  /** 报告卡 id（出了才有）。 */
  approval_item_ids: string[]
  /** 没跑的理由（没人持有这条职责……）。 */
  skipped?: string
  picks?: number
}

/**
 * 面板上那一块：问题清单 + 开关与问几个 + 每周大概花多少（WP155 提醒：探测按
 * 「每个问题 × 每个平台一次」计费，要让人看得到、调得动、关得掉）。
 */
export interface GeoQuestionsView {
  questions: GeoQuestion[]
  settings: GeoSettings
  estimate: GeoCostEstimate
  /**
   * WP166：目标市场（公司档案里的；没写就是默认那一个）与这个市场探不探（面板上能关某个市场的
   * 探测，只关探测、不改档案）。老装配不给。
   */
  markets?: {
    code: string
    probing: boolean
    /** WP169：这个市场用什么语言问（ISO 639-1；问题由模型从品牌语言翻过来）。 */
    language?: string
    /** WP169：要翻译却没配模型——这一周按原语言问（面板注明）。 */
    untranslated?: boolean
  }[]
  markets_from?: 'brand_profile' | 'default'
}

/** WP158：一个 Google 源（Search Console / GA4）在选择器上的样子。 */
export interface GoogleSourceView {
  connected: boolean
  /** 选中的站点（原样的 `siteUrl`）或 GA4 媒体资源 id。 */
  selected?: string
  selected_label?: string
  options: { id: string; label: string }[]
  /** 连上了、还没选（出那张「选一下」的小卡）。 */
  needs_pick: boolean
  /** 上一次没读到的人话。 */
  note?: string
  stale?: boolean
  window?: { start: string; end: string }
}

/** WP158：`GET / PUT /v1/seo/google-sources` 的返回。 */
export interface GoogleSourcesView {
  gsc: GoogleSourceView
  ga4: GoogleSourceView
}

export interface SeoPort {
  geoQuestions(actor: SeoActor): MaybePromise<GeoQuestionsView>
  setGeoQuestions(
    actor: SeoActor,
    input: {
      questions?: { id?: string | undefined; text: string; enabled: boolean }[] | undefined
      settings?:
        | {
            enabled?: boolean | undefined
            max_questions?: number | undefined
            /** WP166：关掉哪几个市场的探测（给全量清单；空数组 = 都探）。 */
            markets_off?: string[] | undefined
          }
        | undefined
    },
  ): MaybePromise<GeoQuestionsView>
  run(actor: SeoActor, what: 'daily' | 'weekly'): MaybePromise<SeoRunView>
  /** WP159：违规宣称规则表。没装 = `/v1/knowledge/claim-rules` 回 not_implemented。 */
  claimRules?(actor: SeoActor): MaybePromise<ClaimRulesView>
  setClaimRules?(actor: SeoActor, input: ClaimRulesPatch): MaybePromise<ClaimRulesView>
  /** WP158：Search Console 选哪个站点、GA4 选哪个媒体资源（可选；没装 = 501）。 */
  googleSources?(actor: SeoActor): MaybePromise<GoogleSourcesView>
  /** WP158：选了立刻重读，并重出今天的 5 件事。 */
  setGoogleSources?(
    actor: SeoActor,
    input: { gsc_site?: string | undefined; ga4_property?: string | undefined },
  ): MaybePromise<GoogleSourcesView>
  /** WP310（决策 473）：导出这个品牌的 GEO / 排名历史（没装 = 501）。 */
  geoHistoryExport?(
    actor: SeoActor,
    input: { format: 'json' | 'csv'; from?: string | undefined; to?: string | undefined },
  ): MaybePromise<GeoHistoryExport>
  /** WP310（决策 473）：删历史——按品牌（全部，可连设置）/ 按时间段 `[from, to)`。 */
  geoHistoryDelete?(
    actor: SeoActor,
    input: GeoHistoryDeleteInput,
  ): MaybePromise<GeoHistoryDeleteResult>
  /** WP321：「GEO 关注设置」读视图（没装 = 501）。 */
  watchView?(actor: SeoActor): MaybePromise<GeoWatchView>
  /** WP321：AI 按品牌档案给一份策略（`card: true` 同时出一张设定卡）。 */
  watchSuggest?(actor: SeoActor, input: { card?: boolean }): MaybePromise<GeoWatchSuggestion>
  /** WP321：改关注设置（确认 / 改策略）。 */
  watchApply?(actor: SeoActor, input: GeoWatchPatch): MaybePromise<GeoWatchView>
  /** WP321：现在跑一轮（Claude 单格 ≥ 1 积分：不带 `confirm` 只回估算）。 */
  watchRun?(
    actor: SeoActor,
    input: { confirm?: boolean; kinds?: ('geo' | 'rank')[] },
  ): MaybePromise<GeoWatchRunResult>
  /** WP321：看板要的数（默认近 12 周）。 */
  watchMetrics?(actor: SeoActor, input: { weeks?: number }): MaybePromise<GeoMetricsView>
  /** WP335：「一条回答」——按 id 取全文、编号引用、上一期与时间线（没有 = `undefined` → 404）。 */
  watchAnswer?(actor: SeoActor, id: string): MaybePromise<GeoAnswerDetail | undefined>
  /** WP380：官方事实表（读之前先跟品牌档案同步）。 */
  watchFacts?(actor: SeoActor): MaybePromise<GeoOfficialFact[]>
  /** WP380：人改官方事实（空值 = 退回跟档案走）。 */
  watchSetFacts?(actor: SeoActor, input: GeoFactsPatch): MaybePromise<GeoOfficialFact[]>
  /** WP380：现在对一次对外说法（没人持有内容职责 = `undefined` → 409）。 */
  watchConsistency?(
    actor: SeoActor,
    input: { urls?: string[] },
  ): MaybePromise<GeoConsistencyRun | undefined>
  /** WP380：登记一条复查（改了什么、看哪个数、几天后）。 */
  watchRecheck?(actor: SeoActor, input: GeoRecheckInput): MaybePromise<GeoRecheck>
  /** WP450：第三栏「编辑日历」（下几周写什么、哪篇该回头改、最近发布、出一组的估算）。 */
  calendar?(actor: SeoActor): MaybePromise<SeoCalendarView>
  /** WP450：出一组主题（按搜索结果重叠度分组，出一张 `seo_cluster` 卡）。 */
  planClusters?(actor: SeoActor): MaybePromise<SeoClusterPlanResult>
  /** WP450：外链体检（设置、上一次、一次大概花多少）。 */
  backlinks?(actor: SeoActor): MaybePromise<BacklinkAuditView>
  setBacklinks?(
    actor: SeoActor,
    patch: Partial<BacklinkAuditSettings>,
  ): MaybePromise<BacklinkAuditView>
  /** WP450：现在体检一次外链。 */
  runBacklinks?(actor: SeoActor): MaybePromise<BacklinkAuditRun>
  /** WP450：llms.txt（生成的那份、体检里那一项、怎么放）。 */
  llmsTxt?(actor: SeoActor): MaybePromise<LlmsTxtView>
  /** WP450：生成一份 llms.txt；`handoff` 交建站放上去。 */
  generateLlmsTxt?(actor: SeoActor, input: { handoff?: boolean }): MaybePromise<LlmsTxtView>
  /** WP450：一篇已发布的文章起草社媒稿（只起草），开事项交社媒运营。 */
  repurpose?(
    actor: SeoActor,
    input: {
      change_id?: string | undefined
      title?: string | undefined
      body?: string | undefined
      url?: string | undefined
      channels?: RepurposeChannel[] | undefined
    },
  ): MaybePromise<RepurposeResult>
}

/** WP450：没装就 501。 */
function planPortOf<
  K extends
    | 'calendar'
    | 'planClusters'
    | 'backlinks'
    | 'setBacklinks'
    | 'runBacklinks'
    | 'llmsTxt'
    | 'generateLlmsTxt'
    | 'repurpose',
>(deps: GatewayDeps, key: K): NonNullable<SeoPort[K]> {
  const p = portOf(deps)
  const f = p[key]
  if (f === undefined)
    throw new ApiError(
      'not_implemented',
      '这个服务进程没有装配主题簇 / 外链体检 / llms.txt 那一层。',
    )
  return (f as (...args: never[]) => unknown).bind(p) as NonNullable<SeoPort[K]>
}

const BacklinkSettingsBody = z.object({
  enabled: z.boolean().optional(),
  every_days: z.number().int().min(7).max(90).optional(),
  competitors: z.array(z.string().min(1).max(200)).max(3).optional(),
})
const LlmsBody = z.object({ handoff: z.boolean().optional() })
const RepurposeBody = z
  .object({
    change_id: z.string().min(1).max(200).optional(),
    title: z.string().min(1).max(300).optional(),
    body: z.string().max(200_000).optional(),
    url: z.string().max(2000).optional(),
    channels: z
      .array(z.enum(['x', 'linkedin', 'reddit', 'short_video']))
      .min(1)
      .max(4)
      .optional(),
  })
  .refine((b) => b.change_id !== undefined || (b.title !== undefined && b.body !== undefined), {
    message: '给 change_id，或者给 title + body',
  })

/** WP159：改规则表（三件事一次给一件就行）。 */
export interface ClaimRulesPatch {
  group?: { id: ClaimMarketGroup; enabled: boolean } | undefined
  rule?:
    | {
        id: string
        enabled?: boolean | undefined
        pattern?: string | undefined
        reason?: string | undefined
      }
    | undefined
  add?: { pattern: string; reason: string; market?: ClaimMarketGroup | undefined } | undefined
}

const READ_KNOWLEDGE = {
  domain: 'knowledge',
  op: 'read',
  range: 'workspace',
  sensitivity: 'internal',
} as const
const WRITE_KNOWLEDGE = { ...READ_KNOWLEDGE, op: 'stage' } as const

const Group = z.enum(['global', 'us', 'eu_uk', 'ca', 'au'])
const ClaimRulesBody = z
  .object({
    group: z.object({ id: Group, enabled: z.boolean() }).optional(),
    rule: z
      .object({
        id: z.string().min(1).max(120),
        enabled: z.boolean().optional(),
        pattern: z.string().max(200).optional(),
        reason: z.string().max(300).optional(),
      })
      .optional(),
    add: z
      .object({
        pattern: z.string().min(1).max(200),
        reason: z.string().max(300),
        market: Group.optional(),
      })
      .optional(),
  })
  .refine((b) => b.group !== undefined || b.rule !== undefined || b.add !== undefined, {
    message: 'group / rule / add 至少给一个',
  })

function claimPortOf(deps: GatewayDeps): Required<Pick<SeoPort, 'claimRules' | 'setClaimRules'>> {
  const p = portOf(deps)
  if (p.claimRules === undefined || p.setClaimRules === undefined)
    throw new ApiError('not_implemented', '这个服务进程没有装配违规宣称规则表。')
  return { claimRules: p.claimRules.bind(p), setClaimRules: p.setClaimRules.bind(p) }
}

function portOf(deps: GatewayDeps): SeoPort {
  const p = deps.seo
  if (p === undefined)
    throw new ApiError(
      'not_implemented',
      '这个服务进程没有装配 SEO 与 GEO 那一层（GatewayDeps.seo）。',
    )
  return p
}

function actorOf(c: Parameters<typeof principalOf>[0]): SeoActor {
  const p = principalOf(c)
  const a = assignmentOf(c)
  return {
    workspace_id: p.workspace_id,
    person_id: p.person_id,
    assignment_id: a.id,
    role_id: a.role_id,
  }
}

const QuestionsBody = z.object({
  questions: z
    .array(
      z.object({
        id: z.string().min(1).max(80).optional(),
        text: z.string().max(300),
        enabled: z.boolean(),
      }),
    )
    .max(30)
    .optional(),
  settings: z
    .object({
      enabled: z.boolean().optional(),
      max_questions: z.number().int().min(1).max(10).optional(),
      // WP166：关掉哪几个市场的探测（只关探测，不改公司档案）
      markets_off: z
        .array(z.string().regex(/^[A-Za-z]{2}$/))
        .max(60)
        .optional(),
    })
    .optional(),
})

const RunBody = z.object({ what: z.enum(['daily', 'weekly']) })

const IsoTime = z.string().datetime({ offset: true })
const GeoHistoryDeleteBody = z
  .object({
    scope: z.enum(['brand', 'range']),
    from: IsoTime.optional(),
    to: IsoTime.optional(),
    include_settings: z.boolean().optional(),
  })
  .refine((b) => b.scope === 'brand' || b.from !== undefined || b.to !== undefined, {
    message: '按时间段删要给 from 或 to',
  })

function geoHistoryPortOf(
  deps: GatewayDeps,
): Required<Pick<SeoPort, 'geoHistoryExport' | 'geoHistoryDelete'>> {
  const p = portOf(deps)
  if (p.geoHistoryExport === undefined || p.geoHistoryDelete === undefined)
    throw new ApiError(
      'not_implemented',
      '这个服务进程没有装配 GEO 历史那一层（SeoPort.geoHistory*）。',
    )
  return {
    geoHistoryExport: p.geoHistoryExport.bind(p),
    geoHistoryDelete: p.geoHistoryDelete.bind(p),
  }
}

/** 查询串里的时刻（不合法就 400）。 */
function isoParam(c: Parameters<typeof principalOf>[0], name: string): string | undefined {
  const v = c.req.query(name)
  if (v === undefined || v === '') return undefined
  if (!IsoTime.safeParse(v).success)
    throw new ApiError('invalid_input', `${name} 要是带时区的 ISO 时刻（如 2026-10-01T00:00:00Z）`)
  return v
}

/* ── WP321：GEO 关注设置 ─────────────────────────────────────────────── */

const Topic = z.enum([
  'category',
  'buying_guide',
  'comparison',
  'use_case',
  'price_value',
  'reviews',
  'branded',
  'other',
])
const WatchPlatform = z.enum(['chatgpt', 'gemini', 'claude', 'google_ai_overview'])
const PromptBody = z.object({
  id: z.string().min(1).max(80),
  text: z.string().min(1).max(300),
  origin: z.enum(['brand', 'top_query', 'human', 'ai_suggest']),
  enabled: z.boolean(),
  topic: Topic.optional(),
  branded: z.boolean().optional(),
  selected: z.boolean().optional(),
})
/** WP392：Amazon 上一款（竞品对标款 / 自家的那一款）。 */
const AmazonItemBody = z.object({
  marketplace: z.string().min(2).max(4),
  asin: z.string().min(1).max(20),
  label: z.string().max(120).optional(),
  vs_own: z.string().max(120).optional(),
})
const CompetitorBody = z.object({
  id: z.string().max(80),
  name: z.string().min(1).max(80),
  aliases: z.array(z.string().max(80)).max(10),
  domains: z.array(z.string().max(120)).max(5),
  // WP392（docs/104 C3）：竞品监控加的两格
  store: z
    .object({
      url: z.string().min(1).max(300),
      platform: z.enum(['shopify', 'woocommerce', 'other', 'unknown']),
      checked_at: z.string().max(40).optional(),
    })
    .optional(),
  amazon: z.array(AmazonItemBody).max(100).optional(),
})
const KeywordBody = z.object({
  keyword: z.string().min(1).max(120),
  branded: z.boolean(),
  enabled: z.boolean(),
})
const StrategyBody = z.object({
  by: z.enum(['ai', 'rules']),
  category: z.string().max(80).optional(),
  stage: z.enum(['new', 'growing', 'established']).optional(),
  prompt_limit: z.number().int().min(1).max(50),
  branded: z.number().int().min(0).max(50),
  topic_mix: z.array(z.object({ topic: Topic, count: z.number().int().min(0).max(50) })).max(10),
  prompts: z.array(PromptBody).max(50),
  candidates: z.array(PromptBody).max(100),
  competitors: z.array(CompetitorBody).max(10),
  keywords: z.array(KeywordBody).max(100),
  platforms: z.array(WatchPlatform).max(4),
  why: z.array(z.string().max(300)).max(5),
  created_at: z.string().max(40),
})
const WatchPatchBody = z.object({
  strategy: StrategyBody.optional(),
  brand_aliases: z.array(z.string().max(80)).max(10).optional(),
  brand_amazon: z.array(AmazonItemBody).max(100).optional(),
  competitors: z.array(CompetitorBody).max(10).optional(),
  keywords: z.array(KeywordBody).max(100).optional(),
  platforms: z.array(WatchPlatform).max(4).optional(),
  markets_off: z
    .array(z.string().regex(/^[A-Za-z]{2}$/))
    .max(60)
    .optional(),
  frequency: z.enum(['weekly', 'biweekly', 'monthly', 'manual']).optional(),
  rank_device: z.enum(['mobile', 'desktop', 'both']).optional(),
  enabled: z.boolean().optional(),
  prompt_limit: z.number().int().min(1).max(50).optional(),
  select: z.array(z.string().min(1).max(80)).max(50).optional(),
  add_prompts: z
    .array(
      z.object({
        id: z.string().min(1).max(80).optional(),
        text: z.string().min(1).max(300),
        topic: Topic.optional(),
        selected: z.boolean().optional(),
      }),
    )
    .max(30)
    .optional(),
  edit_prompts: z
    .array(z.object({ id: z.string().min(1).max(80), text: z.string().min(1).max(300) }))
    .max(30)
    .optional(),
  archive_prompts: z.array(z.string().min(1).max(80)).max(100).optional(),
})
const WatchSuggestBody = z.object({ card: z.boolean().optional() })
const FACT_KEY = z.enum(['name', 'category', 'price', 'selling_points', 'markets'])
const WatchFactsBody = z.object({
  facts: z
    .array(z.object({ key: FACT_KEY, value: z.string().max(300) }))
    .min(1)
    .max(5),
})
const WatchConsistencyBody = z.object({
  urls: z.array(z.string().url().max(500)).max(10).optional(),
})
const WatchRecheckBody = z.object({
  change: z.string().min(1).max(200),
  metric: z.enum(['mention_rate', 'citation_rate', 'win_rate', 'accuracy']),
  prompt_ids: z.array(z.string().min(1).max(200)).min(1).max(50),
  due_days: z.number().int().min(1).max(90).optional(),
  matter_id: z.string().min(1).max(200).optional(),
  owner: z.enum(['site', 'web-ops', 'pr', 'content']).optional(),
})
const WatchRunBody = z.object({
  confirm: z.boolean().optional(),
  kinds: z
    .array(z.enum(['geo', 'rank']))
    .min(1)
    .max(2)
    .optional(),
})

/** zod 的可选格出来是 `T | undefined`；契约是「不写」——过一遍 JSON 把 `undefined` 拿掉。 */
const plain = <T>(v: unknown): T => JSON.parse(JSON.stringify(v)) as T

function watchPortOf(
  deps: GatewayDeps,
): Required<
  Pick<SeoPort, 'watchView' | 'watchSuggest' | 'watchApply' | 'watchRun' | 'watchMetrics'>
> {
  const p = portOf(deps)
  if (
    p.watchView === undefined ||
    p.watchSuggest === undefined ||
    p.watchApply === undefined ||
    p.watchRun === undefined ||
    p.watchMetrics === undefined
  )
    throw new ApiError(
      'not_implemented',
      '这个服务进程没有装配 AI 回答监测那一层（SeoPort.watch*）。',
    )
  return {
    watchView: p.watchView.bind(p),
    watchSuggest: p.watchSuggest.bind(p),
    watchApply: p.watchApply.bind(p),
    watchRun: p.watchRun.bind(p),
    watchMetrics: p.watchMetrics.bind(p),
  }
}

/** WP380：可选的几个口（没装 = 501）。 */
function need<K extends 'watchFacts' | 'watchSetFacts' | 'watchConsistency' | 'watchRecheck'>(
  deps: GatewayDeps,
  key: K,
): NonNullable<SeoPort[K]> {
  const p = portOf(deps)
  const fn = p[key]
  if (fn === undefined)
    throw new ApiError(
      'not_implemented',
      `这个服务进程没有装配 AI 回答监测那一层（SeoPort.${key}）。`,
    )
  return (fn as (...args: unknown[]) => unknown).bind(p) as NonNullable<SeoPort[K]>
}

const GoogleSourcesBody = z.object({
  gsc_site: z.string().min(1).max(300).optional(),
  ga4_property: z.string().min(1).max(40).optional(),
})

function googlePortOf(
  deps: GatewayDeps,
): Required<Pick<SeoPort, 'googleSources' | 'setGoogleSources'>> {
  const p = portOf(deps)
  if (p.googleSources === undefined || p.setGoogleSources === undefined)
    throw new ApiError(
      'not_implemented',
      '这个服务进程没有装配 Search Console / GA4 读数那一层（SeoPort.googleSources）。',
    )
  return { googleSources: p.googleSources, setGoogleSources: p.setGoogleSources }
}

export function seoRoutes(): Route[] {
  return [
    route(
      {
        method: 'get',
        path: '/v1/seo/geo-questions',
        operationId: 'listGeoQuestions',
        summary: '买家会问的问题（从品牌档案与排名前列的查询自动生成；人改过的永远赢）',
        tag: 'seo',
        auth: 'bearer',
        assignment: true,
        authz: READ_CONTENT,
        returns: 'GeoQuestionsView',
      },
      async (c, deps) => ok(c, await portOf(deps).geoQuestions(actorOf(c))),
    ),
    route(
      {
        method: 'put',
        path: '/v1/seo/geo-questions',
        operationId: 'setGeoQuestions',
        summary: '改问题清单（关掉、改字、加；空字的那一行当删掉）与每周探测的开关、问几个',
        tag: 'seo',
        auth: 'bearer',
        assignment: true,
        authz: STAGE_CONTENT,
        body: QuestionsBody,
        returns: 'GeoQuestionsView',
      },
      async (c, deps) =>
        ok(c, await portOf(deps).setGeoQuestions(actorOf(c), await body(c, QuestionsBody))),
    ),
    route(
      {
        method: 'post',
        path: '/v1/seo/run',
        operationId: 'runSeo',
        summary:
          '现在跑一轮：daily = 读 Search Console 出「今天值得动的 5 件事」；weekly = 收入与 AI 可见度小结',
        tag: 'seo',
        auth: 'bearer',
        assignment: true,
        authz: STAGE_CONTENT,
        body: RunBody,
        returns: 'SeoRunView',
      },
      async (c, deps) => ok(c, await portOf(deps).run(actorOf(c), (await body(c, RunBody)).what)),
    ),
    route(
      {
        method: 'get',
        path: '/v1/seo/geo-history/export',
        operationId: 'exportGeoHistory',
        summary:
          'WP310：导出这个品牌的 AI 回答监测与排名历史（回答全文、引用、判定、排名、品牌词周数据）——JSON 一份或 CSV 每张表一份',
        tag: 'seo',
        auth: 'bearer',
        assignment: true,
        authz: READ_CONTENT,
        params: [
          { name: 'format', in: 'query', description: 'json | csv，默认 json' },
          { name: 'from', in: 'query', description: '从这个时刻起（含），ISO 时刻' },
          { name: 'to', in: 'query', description: '到这个时刻止（不含），ISO 时刻' },
        ],
        returns: 'GeoHistoryExport',
      },
      async (c, deps) => {
        const format = c.req.query('format') ?? 'json'
        if (format !== 'json' && format !== 'csv')
          throw new ApiError('invalid_input', 'format 只能是 json / csv')
        const from = isoParam(c, 'from')
        const to = isoParam(c, 'to')
        return ok(
          c,
          await geoHistoryPortOf(deps).geoHistoryExport(actorOf(c), {
            format,
            ...(from === undefined ? {} : { from }),
            ...(to === undefined ? {} : { to }),
          }),
        )
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/seo/geo-history/delete',
        operationId: 'deleteGeoHistory',
        summary:
          'WP310：删这个品牌的 AI 回答监测与排名历史——按品牌（全部，可连关注设置一起）或按时间段 [from, to)',
        tag: 'seo',
        auth: 'bearer',
        assignment: true,
        authz: STAGE_CONTENT,
        body: GeoHistoryDeleteBody,
        returns: 'GeoHistoryDeleteResult',
      },
      async (c, deps) => {
        const input = await body(c, GeoHistoryDeleteBody)
        return ok(
          c,
          await geoHistoryPortOf(deps).geoHistoryDelete(actorOf(c), {
            scope: input.scope,
            ...(input.from === undefined ? {} : { from: input.from }),
            ...(input.to === undefined ? {} : { to: input.to }),
            ...(input.include_settings === undefined
              ? {}
              : { include_settings: input.include_settings }),
          }),
        )
      },
    ),
    route(
      {
        method: 'get',
        path: '/v1/seo/watch',
        operationId: 'getGeoWatch',
        summary:
          'WP321：AI 回答监测的关注设置（品牌 / 竞品 / 已选与候选 Prompt / 关注词 / 关注的 AI / 频率）+ 一轮与每月大概多少积分 + 策略定没定 + 最近几轮',
        tag: 'seo',
        auth: 'bearer',
        assignment: true,
        authz: READ_CONTENT,
        returns: 'GeoWatchView',
      },
      async (c, deps) => ok(c, await watchPortOf(deps).watchView(actorOf(c))),
    ),
    route(
      {
        method: 'put',
        path: '/v1/seo/watch',
        operationId: 'setGeoWatch',
        summary:
          'WP321：改关注设置——整份采用一份策略，或单改竞品 / 关注词 / 关注的 AI / 频率 / 已选几条；Prompt 改字 = 归档旧的 + 新建一条',
        tag: 'seo',
        auth: 'bearer',
        assignment: true,
        authz: STAGE_CONTENT,
        body: WatchPatchBody,
        returns: 'GeoWatchView',
      },
      async (c, deps) =>
        ok(
          c,
          await watchPortOf(deps).watchApply(
            actorOf(c),
            plain<GeoWatchPatch>(await body(c, WatchPatchBody)),
          ),
        ),
    ),
    route(
      {
        method: 'post',
        path: '/v1/seo/watch/strategy',
        operationId: 'suggestGeoWatch',
        summary:
          'WP321：AI 按品牌档案（品类、阶段、市场）给一份策略——追几条、各方向占多少、带品牌名几条、候选 Prompt、竞品、关注词；card=true 时同时出一张设定卡',
        tag: 'seo',
        auth: 'bearer',
        assignment: true,
        authz: STAGE_CONTENT,
        body: WatchSuggestBody,
        returns: 'GeoWatchSuggestion',
      },
      async (c, deps) =>
        ok(
          c,
          await watchPortOf(deps).watchSuggest(
            actorOf(c),
            plain<{ card?: boolean }>(await body(c, WatchSuggestBody)),
          ),
        ),
    ),
    route(
      {
        method: 'post',
        path: '/v1/seo/watch/run',
        operationId: 'runGeoWatch',
        summary:
          'WP321：现在跑一轮（即时）——Claude 单格约 3.6 积分：不带 confirm 只回这一轮的估算（needs_confirm），带 confirm=true 才跑',
        tag: 'seo',
        auth: 'bearer',
        assignment: true,
        authz: STAGE_CONTENT,
        body: WatchRunBody,
        returns: 'GeoWatchRunResult',
      },
      async (c, deps) =>
        ok(
          c,
          await watchPortOf(deps).watchRun(
            actorOf(c),
            plain<{ confirm?: boolean; kinds?: ('geo' | 'rank')[] }>(await body(c, WatchRunBody)),
          ),
        ),
    ),
    route(
      {
        method: 'get',
        path: '/v1/seo/watch/metrics',
        operationId: 'getGeoWatchMetrics',
        summary:
          'WP321：看板要的数——提及率 / 引用率 / 平均名次 / 声量份额（按 AI、按市场、带不带品牌名，4 周滚动、覆盖 < 90% 不出变化）、被引用最多的站与页、前后对比、关注词排名、品牌词周数据',
        tag: 'seo',
        auth: 'bearer',
        assignment: true,
        authz: READ_CONTENT,
        params: [{ name: 'weeks', in: 'query', description: '看近几周（1–52，默认 12）' }],
        returns: 'GeoMetricsView',
      },
      async (c, deps) => {
        const raw = c.req.query('weeks')
        const weeks = raw === undefined || raw === '' ? undefined : Number(raw)
        if (weeks !== undefined && (!Number.isInteger(weeks) || weeks < 1 || weeks > 52))
          throw new ApiError('invalid_input', 'weeks 要是 1–52 的整数')
        return ok(
          c,
          await watchPortOf(deps).watchMetrics(actorOf(c), weeks === undefined ? {} : { weeks }),
        )
      },
    ),
    route(
      {
        method: 'get',
        path: '/v1/seo/watch/answers/:id',
        operationId: 'getGeoWatchAnswer',
        summary:
          'WP335：一条 AI 回答——全文、编号引用（我们 / 竞品 / 站外）、各品牌判定、同一格上一期（和上周比）、这一格近 12 周的时间线、高亮用的名字',
        tag: 'seo',
        auth: 'bearer',
        assignment: true,
        authz: READ_CONTENT,
        params: [
          { name: 'id', in: 'path', required: true, description: '回答 id（方格里那一格）' },
        ],
        returns: 'GeoAnswerDetail',
      },
      async (c, deps) => {
        const p = portOf(deps)
        if (p.watchAnswer === undefined)
          throw new ApiError(
            'not_implemented',
            '这个服务进程没有装配 AI 回答监测那一层（SeoPort.watchAnswer）。',
          )
        const detail = await p.watchAnswer(actorOf(c), param(c, 'id'))
        if (detail === undefined) throw new ApiError('not_found', '没有这条回答')
        return ok(c, detail)
      },
    ),
    route(
      {
        method: 'get',
        path: '/v1/seo/watch/facts',
        operationId: 'getGeoWatchFacts',
        summary:
          'WP380：官方事实表（名称 / 品类 / 价格 / 卖点 / 市场，带日期与以前的说法）——描述准确度与对外说法一致性都拿它对',
        tag: 'seo',
        auth: 'bearer',
        assignment: true,
        authz: READ_CONTENT,
        returns: 'GeoOfficialFact[]',
      },
      async (c, deps) => ok(c, await need(deps, 'watchFacts')(actorOf(c))),
    ),
    route(
      {
        method: 'put',
        path: '/v1/seo/watch/facts',
        operationId: 'setGeoWatchFacts',
        summary: 'WP380：人改官方事实（改了旧说法记进 previous；空值 = 退回跟品牌档案走）',
        tag: 'seo',
        auth: 'bearer',
        assignment: true,
        authz: STAGE_CONTENT,
        body: WatchFactsBody,
        returns: 'GeoOfficialFact[]',
      },
      async (c, deps) =>
        ok(
          c,
          await need(deps, 'watchSetFacts')(
            actorOf(c),
            plain<GeoFactsPatch>(await body(c, WatchFactsBody)),
          ),
        ),
    ),
    route(
      {
        method: 'post',
        path: '/v1/seo/watch/consistency',
        operationId: 'runGeoConsistency',
        summary:
          'WP380：现在对一次对外说法——官方事实对官网 / 商品页 / 结构化数据 / 上架页 / 评测页，过时或说法不一的按岗位分好出一张卡',
        tag: 'seo',
        auth: 'bearer',
        assignment: true,
        authz: STAGE_CONTENT,
        body: WatchConsistencyBody,
        returns: 'GeoConsistencyRun',
      },
      async (c, deps) => {
        const run = await need(deps, 'watchConsistency')(
          actorOf(c),
          plain<{ urls?: string[] }>(await body(c, WatchConsistencyBody)),
        )
        if (run === undefined) throw new ApiError('conflict', '没人持有「SEO 与 GEO」这条职责')
        return ok(c, run)
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/seo/watch/rechecks',
        operationId: 'addGeoRecheck',
        summary:
          'WP380：登记一条复查——改了什么、期望哪个数动（提及率 / 引用率 / 比较胜率 / 描述准确度）、几天后重问那组问题',
        tag: 'seo',
        auth: 'bearer',
        assignment: true,
        authz: STAGE_CONTENT,
        body: WatchRecheckBody,
        returns: 'GeoRecheck',
      },
      async (c, deps) =>
        ok(
          c,
          await need(deps, 'watchRecheck')(
            actorOf(c),
            plain<GeoRecheckInput>(await body(c, WatchRecheckBody)),
          ),
        ),
    ),
    route(
      {
        method: 'get',
        path: '/v1/knowledge/claim-rules',
        operationId: 'listClaimRules',
        summary:
          '违规宣称规则表（WP159）：按市场分组（通用 / 美国 / 欧盟英国 / 加拿大 / 澳大利亚），每条带官方出处与一句人话；按品牌目标市场开组',
        tag: 'knowledge',
        auth: 'bearer',
        assignment: true,
        authz: READ_KNOWLEDGE,
        returns: 'ClaimRulesView',
      },
      async (c, deps) => ok(c, await claimPortOf(deps).claimRules(actorOf(c))),
    ),
    route(
      {
        method: 'patch',
        path: '/v1/knowledge/claim-rules',
        operationId: 'setClaimRules',
        summary: '改违规宣称规则表：拨市场组开关 / 改或关一条（记成知识库里的卡）/ 加一条自己的',
        tag: 'knowledge',
        auth: 'bearer',
        assignment: true,
        authz: WRITE_KNOWLEDGE,
        body: ClaimRulesBody,
        returns: 'ClaimRulesView',
      },
      async (c, deps) =>
        ok(c, await claimPortOf(deps).setClaimRules(actorOf(c), await body(c, ClaimRulesBody))),
    ),
    route(
      {
        method: 'get',
        path: '/v1/seo/google-sources',
        operationId: 'getGoogleSources',
        summary: 'Search Console 选了哪个站点、GA4 选了哪个媒体资源（连上没选时出「选一下」）',
        tag: 'seo',
        auth: 'bearer',
        assignment: true,
        authz: READ_CONTENT,
        returns: 'GoogleSourcesView',
      },
      async (c, deps) => ok(c, await googlePortOf(deps).googleSources(actorOf(c))),
    ),
    route(
      {
        method: 'put',
        path: '/v1/seo/google-sources',
        operationId: 'setGoogleSources',
        summary: '选站点 / 媒体资源：选了立刻重读，并重出今天的 5 件事',
        tag: 'seo',
        auth: 'bearer',
        assignment: true,
        authz: STAGE_CONTENT,
        body: GoogleSourcesBody,
        returns: 'GoogleSourcesView',
      },
      async (c, deps) =>
        ok(
          c,
          await googlePortOf(deps).setGoogleSources(actorOf(c), await body(c, GoogleSourcesBody)),
        ),
    ),
    // ── WP450：主题簇与编辑日历、外链体检、llms.txt、改写成社媒稿 ──
    route(
      {
        method: 'get',
        path: '/v1/seo/calendar',
        operationId: 'getSeoCalendar',
        summary:
          'WP450：编辑日历（下几周写什么、哪篇该回头改、最近发布的文章、出一组主题大概花多少）——第三栏那一块',
        tag: 'seo',
        auth: 'bearer',
        assignment: true,
        authz: READ_CONTENT,
        returns: 'SeoCalendarView',
      },
      async (c, deps) => ok(c, await planPortOf(deps, 'calendar')(actorOf(c))),
    ),
    route(
      {
        method: 'post',
        path: '/v1/seo/clusters/plan',
        operationId: 'planSeoClusters',
        summary:
          'WP450：出一组主题——按搜索结果重叠度把词分组（规则算），出一张「一组主题」卡批整组（查搜索结果要花积分）',
        tag: 'seo',
        auth: 'bearer',
        assignment: true,
        authz: STAGE_CONTENT,
        returns: 'SeoClusterPlanResult',
      },
      async (c, deps) => ok(c, await planPortOf(deps, 'planClusters')(actorOf(c))),
    ),
    route(
      {
        method: 'get',
        path: '/v1/seo/backlinks',
        operationId: 'getBacklinkAudit',
        summary: 'WP450：外链体检——设置（每月一次、可关）、上一次的结论、一次大概花多少积分',
        tag: 'seo',
        auth: 'bearer',
        assignment: true,
        authz: READ_CONTENT,
        returns: 'BacklinkAuditView',
      },
      async (c, deps) => ok(c, await planPortOf(deps, 'backlinks')(actorOf(c))),
    ),
    route(
      {
        method: 'put',
        path: '/v1/seo/backlinks',
        operationId: 'setBacklinkAudit',
        summary: 'WP450：改外链体检的设置（开关、几天一次、比哪几家竞品）',
        tag: 'seo',
        auth: 'bearer',
        assignment: true,
        authz: STAGE_CONTENT,
        body: BacklinkSettingsBody,
        returns: 'BacklinkAuditView',
      },
      async (c, deps) => {
        const b = await body(c, BacklinkSettingsBody)
        return ok(
          c,
          await planPortOf(deps, 'setBacklinks')(actorOf(c), {
            ...(b.enabled === undefined ? {} : { enabled: b.enabled }),
            ...(b.every_days === undefined ? {} : { every_days: b.every_days }),
            ...(b.competitors === undefined ? {} : { competitors: b.competitors }),
          }),
        )
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/seo/backlinks/run',
        operationId: 'runBacklinkAudit',
        summary: 'WP450：现在体检一次外链（照官方数据接口的价目扣积分；竞品差距交公关）',
        tag: 'seo',
        auth: 'bearer',
        assignment: true,
        authz: STAGE_CONTENT,
        returns: 'BacklinkAuditRun',
      },
      async (c, deps) => ok(c, await planPortOf(deps, 'runBacklinks')(actorOf(c))),
    ),
    route(
      {
        method: 'get',
        path: '/v1/seo/llms-txt',
        operationId: 'getLlmsTxt',
        summary: 'WP450：llms.txt——生成的那份、体检里「有没有、过不过时」、在 Shopify 上怎么放',
        tag: 'seo',
        auth: 'bearer',
        assignment: true,
        authz: READ_CONTENT,
        returns: 'LlmsTxtView',
      },
      async (c, deps) => ok(c, await planPortOf(deps, 'llmsTxt')(actorOf(c))),
    ),
    route(
      {
        method: 'post',
        path: '/v1/seo/llms-txt',
        operationId: 'generateLlmsTxt',
        summary: 'WP450：按店铺结构与政策页生成一份 llms.txt；`handoff: true` 开一件事交建站放上去',
        tag: 'seo',
        auth: 'bearer',
        assignment: true,
        authz: STAGE_CONTENT,
        body: LlmsBody,
        returns: 'LlmsTxtView',
      },
      async (c, deps) => {
        const b = await body(c, LlmsBody)
        return ok(
          c,
          await planPortOf(deps, 'generateLlmsTxt')(
            actorOf(c),
            b.handoff === undefined ? {} : { handoff: b.handoff },
          ),
        )
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/seo/repurpose',
        operationId: 'repurposePost',
        summary:
          'WP450：一篇已发布的文章起草 X / LinkedIn / Reddit / 短视频脚本（只起草、不编经历与数字），每个渠道开一件事项交社媒运营',
        tag: 'seo',
        auth: 'bearer',
        assignment: true,
        authz: STAGE_CONTENT,
        body: RepurposeBody,
        returns: 'RepurposeResult',
      },
      async (c, deps) => {
        const b = await body(c, RepurposeBody)
        return ok(
          c,
          await planPortOf(deps, 'repurpose')(actorOf(c), {
            ...(b.change_id === undefined ? {} : { change_id: b.change_id }),
            ...(b.title === undefined ? {} : { title: b.title }),
            ...(b.body === undefined ? {} : { body: b.body }),
            ...(b.url === undefined ? {} : { url: b.url }),
            ...(b.channels === undefined ? {} : { channels: b.channels }),
          }),
        )
      },
    ),
  ]
}
