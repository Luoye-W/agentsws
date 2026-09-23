/**
 * 公共红人库服务（48 §5.3 / 49 §6 WP61）。
 *
 * 计费照 49 M3 / M4 逐条抄 `packages/cloud-entry` 那一套，顺序不能换：
 *
 * 1. 查价目算预扣 → 2. 余额够才放行（不够 402 人话，**只拒这一次不冻结**）
 * → 3. 真做这件事 → 4. 按实际结算并记**一条**计量事件 → 失败整笔释放。
 *
 * WP126（09-19 Luoye 定）把「浏览免费」那一套推翻了：官方数据接口本身就是增值
 * 服务，**浏览 / 搜索 / 类目基准按 `data.kol.lookup` 收，体检报告按
 * `data.kol.audit` 收**——命中缓存与未命中收同样的钱（库本身就是缓存，
 * "命中"不是用户的功劳）；取数失败 / 查无此人 / 搜到 0 条 → 预扣释放不收钱。
 * 口径①②③见 docs/75：一次提交的搜索算一次（10 分钟幂等窗口）；搜到 0 条
 * 不收钱；贡献返额度保留。
 *
 * 计量事件只有八个字段（49 M6）——**红人名字没有地方放**，正文更没有。
 * 这不是靠自觉：`Wallet.settle` 里的 `assertMeteringEvent` 多一个键就抛。
 */
import type {
  AuditReport,
  Benchmark,
  ContributionEvent,
  Dispute,
  FollowersBand,
  Iso8601,
  IssuedPluginToken,
  KolChannel,
  KolObservationSource,
  PluginPairing,
  PublicContentObservation,
  PublicContentSample,
  PublicCreatorCard,
  PublicCreatorObservation,
  RevealedContact,
} from '@agentsws/contracts'
import {
  ANY_CATEGORY,
  CONTACT_REWARD_CREDITS,
  CONTRIBUTION_CREDIT_TTL_DAYS,
  DEFAULT_CREATOR_LIMIT,
  followersBandOf,
  KOL_AUDIT_CAPABILITY,
  KOL_LOOKUP_CAPABILITY,
  KOL_UNIT,
  MAX_CREATOR_LIMIT,
  MAX_DAILY_REWARD_CREDITS,
  MAX_DISPUTE_CLAIM,
  MAX_OBSERVATIONS_PER_BATCH,
  MAX_PLUGIN_OBSERVATIONS_PER_DAY,
  OBSERVATION_DEDUPE_HOURS,
  OBSERVATIONS_PER_CREDIT,
  PLUGIN_TOKEN_PREFIX,
  PLUGIN_TOKEN_TTL_MS,
  SOCIAL_FETCH_CAPABILITY,
  SOURCE_CONFIDENCE,
} from '@agentsws/contracts'
import {
  COST_TABLE,
  type CostTable,
  creditsFor,
  roundCredits,
  type SettleMeta,
  unitCostMicros,
  WalletError,
  type WalletReservation,
} from '@agentsws/metering'
import { buildAudit } from './audit.js'
import { benchmarkNote, benchmarkOf, bucketOf } from './benchmarks.js'
import { dayOf, normalizeEmail, parseContentObservation, parseObservation } from './normalize.js'
import { outcomeOfError } from './sources/index.js'
import {
  type CreatorRow,
  isContentStore,
  type KolContentStore,
  type ObservationRow,
} from './store.js'
import {
  type ContributionSubject,
  KolError,
  type KolPrincipal,
  type KolServiceDeps,
  type SourceOutcome,
  type SourceSnapshot,
} from './types.js'

const DAY_MS = 24 * 60 * 60 * 1000
const HOUR_MS = 60 * 60 * 1000

/** 累计计数落在配额表的这一"天"上（主键是 `(subject, day)`，天然容得下）。 */
export const LIFETIME_DAY = 'lifetime'

/** 0 积分的计量事件（用法看板要用，不是"没发生过"）。 */
export const FREE_CREDITS = 0

/**
 * 搜索幂等窗口（WP126 口径①，Luoye 定、Fable 提出）：**一次提交的搜索算一次**。
 *
 * 同一个工作区、同一个查询串，10 分钟内翻页 / 重排不再扣第二次——翻页不
 * 重新取数，只是把同一份结果换一种摆法。键里**刻意不含 limit**（翻页
 * 就是 limit 在变）。输入过程中的空查询不算搜索，也不进窗口。
 */
export const SEARCH_IDEMPOTENCY_WINDOW_MS = 10 * 60 * 1000

/**
 * 体检报告样本不够时接在 `note` 后面的那句话（WP129）。界面直接显示 `note`，
 * 所以"这次不收"是报告自己说的，不靠每个界面各写一遍。
 */
export const AUDIT_NOT_CHARGED_NOTE = '样本不够，这次不收。'

export interface BrowseResult {
  creators: PublicCreatorCard[]
  /** 这一次扣了多少积分（命中缓存与未命中同价；窗口内重复搜索为 0）。 */
  credits: number
}

export interface RefreshResult {
  /** 有没有真的去外部取一次数。 */
  refreshed: boolean
  used: SourceOutcome['used']
  reason?: SourceOutcome['reason']
  message: string
  credits: number
  card?: PublicCreatorCard
}

export interface BenchmarkResult extends Benchmark {
  note: string
  /** 这一次扣了多少积分（桶不够 k 不收钱 → 0）。 */
  credits: number
}

export interface DisputeResult {
  dispute: Dispute
  message: string
}

/**
 * 卡面的可信度：来源档 × 观察条数带来的把握 × 新鲜度。
 *
 * 三项都是**看得见的事实**，没有一项是模型给的分——这张分会被用来排序，
 * 排序影响谁被联系到，所以它必须能被一句话解释清楚。
 */
export function confidenceOf(args: {
  source: KolObservationSource
  observations: number
  observed_at: Iso8601
  at: Iso8601
}): number {
  const base = SOURCE_CONFIDENCE[args.source] ?? 0.5
  const depth = 0.7 + Math.min(args.observations / 10, 1) * 0.3
  const ageDays = Math.max(0, (Date.parse(args.at) - Date.parse(args.observed_at)) / DAY_MS)
  const freshness = ageDays <= 30 ? 1 : ageDays <= 90 ? 0.85 : 0.6
  return Math.round(Math.min(0.99, base * depth * freshness) * 100) / 100
}

function mergeCategories(prev: string[] | undefined, next: string[] | undefined): string[] {
  const set = new Set<string>([...(prev ?? []), ...(next ?? [])])
  return [...set].sort()
}

export class KolPublicService {
  private readonly deps: KolServiceDeps
  private readonly nextRequestId: () => string

  constructor(deps: KolServiceDeps) {
    this.deps = deps
    let n = 0
    this.nextRequestId =
      deps.newRequestId ??
      (() => {
        n += 1
        return `kol_${deps.now().replace(/\D/g, '').slice(0, 14)}_${String(n)}`
      })
  }

  // ————————————————————————— 计费 —————————————————————————

  /** 价目表里这条能力多少积分；表里没有就拒，**不猜价**。 */
  private priceOf(capability: string, quantity: number): number {
    const credits = creditsFor(this.deps.pricing, capability, quantity)
    if (credits === undefined)
      throw new KolError(
        'internal',
        `云侧的价目表里没有「${capability}」这一条，这一次没有扣积分。`,
      )
    return credits
  }

  /**
   * 这一次的成本会计那几格（WP115，65 §3）。
   *
   * 非 token 的上游按 **`provider:unit`** 记（`youtube:call` / `apify:call`），
   * 与 AI 那边按 token 记的是两套量纲——合成一套就得给"一次 Apify 抓取等于
   * 多少 token"编一个换算，而那个数字是编的。
   *
   * `internal` 是我们自己库里的读写：成本 0，但**照样记一行**，否则用量看板
   * 会以为公共红人库没人用。
   */
  private meta(
    principal: KolPrincipal,
    provider: string,
    quantity: number,
    charge_status: 'charged' | 'skipped' | 'admin_exempt',
  ): SettleMeta {
    const table: CostTable | null =
      this.deps.costTable === undefined ? COST_TABLE : this.deps.costTable
    const base: SettleMeta = {
      provider,
      account_id: principal.account_id,
      charge_status,
    }
    if (table === null) return base
    const cost = unitCostMicros(`${provider}:${KOL_UNIT}`, quantity, table)
    return { ...base, cost_micros: cost.micros, cost_currency: cost.currency }
  }

  /** 这个账号是不是我们自己人（免计费、不进失败统计）。 */
  private exempt(principal: KolPrincipal): boolean {
    return this.deps.isExemptAccount?.(principal.account_id) === true
  }

  private reserve(
    principal: KolPrincipal,
    capability: string,
    quantity: number,
  ): { reservation: WalletReservation; credits: number } {
    const credits = this.priceOf(capability, quantity)
    try {
      return {
        credits,
        reservation: this.deps.wallet.reserve({
          org_id: principal.org_id,
          workspace_id: principal.workspace_id,
          capability,
          unit: KOL_UNIT,
          quantity,
          credits,
          request_id: this.nextRequestId(),
        }),
      }
    } catch (err) {
      if (err instanceof WalletError && err.code === 'insufficient_credits')
        throw new KolError('insufficient_credits', err.message, { details: err.details })
      if (err instanceof WalletError) throw new KolError('invalid_input', err.message)
      throw err
    }
  }

  /** 预扣 → 做 → 结算；中间抛了就整笔释放（不计花费、不记计量事件）。 */
  private charge<T>(
    principal: KolPrincipal,
    capability: string,
    quantity: number,
    run: () => T,
    provider = 'internal',
  ): { value: T; credits: number } {
    const exempt = this.exempt(principal)
    const { reservation, credits } = this.reserve(principal, capability, exempt ? 0 : quantity)
    try {
      const value = run()
      const charged = exempt ? 0 : credits
      this.deps.wallet.settle(reservation, {
        quantity,
        credits: charged,
        ...this.meta(principal, provider, quantity, exempt ? 'admin_exempt' : 'charged'),
      })
      return { value, credits: charged }
    } catch (err) {
      this.deps.wallet.release(reservation)
      throw err
    }
  }

  /**
   * 免费或"这一次没扣"的动作也记一条计量事件（0 积分）。
   *
   * 为什么不走 `reserve` 再 `settle`：余额短暂为负的时候（结算可能比预扣多，
   * 49 §3 允许）`reserve(0)` 会被拒——**没扣钱的东西不该因为余额而用不了**。
   * 所以这里直接结算一笔 0 积分的记录：扣 0、记一条、不碰余额。
   */
  private meterFree(principal: KolPrincipal, capability: string, quantity: number): void {
    const at = this.deps.now()
    this.deps.wallet.settle(
      {
        id: `free_${this.nextRequestId()}`,
        org_id: principal.org_id,
        workspace_id: principal.workspace_id,
        capability,
        unit: KOL_UNIT,
        quantity,
        credits: FREE_CREDITS,
        request_id: this.nextRequestId(),
        at,
      },
      {
        quantity,
        credits: FREE_CREDITS,
        // `skipped` = 本来就免费，不是"该扣没扣上"。扣费健康那张表靠这一格分开这两件事
        ...this.meta(
          principal,
          'internal',
          quantity,
          this.exempt(principal) ? 'admin_exempt' : 'skipped',
        ),
      },
    )
  }

  // ————————————————————————— 读 —————————————————————————

  /**
   * 搜索幂等窗口的键（口径①）。键里**不含 limit**（翻页就是 limit 在变），
   * 含 subject（哪个工作区）、渠道、关键词、粉丝下限与类目。
   * 空查询不算一次搜索——输入过程中不该扣钱。
   */
  private searchWindowKey(
    principal: KolPrincipal,
    query: {
      channel?: KolChannel | undefined
      q?: string | undefined
      min_followers?: number | undefined
      category?: string | undefined
    },
  ): string | undefined {
    const q = query.q?.trim() ?? ''
    if (q === '') return undefined
    const parts = [
      principal.workspace_id,
      query.channel ?? '*',
      q.toLowerCase(),
      query.min_followers === undefined ? '*' : String(query.min_followers),
      query.category?.trim().toLowerCase() || '*',
    ]
    return `srch:${this.deps.secrets.sha256(parts.join('|'))}`
  }

  /**
   * 共享库浏览 / 搜索：按 `data.kol.lookup` 收（0.2 积分 / 次，价目表说了算）。
   *
   * 三条口径在这里落地：
   * - **搜到 0 条不收钱**（口径②）：一个空列表不值得钱，一次都不预扣；
   * - **一次提交的搜索算一次**（口径①）：同一个 (subject, 查询串) 10 分钟内
   *     翻页 / 重排不重复收——窗口内记一条 0 积分的计量事件（用法照常可见），
   * - **命中缓存与未命中同价**：库本身就是缓存，没有"命中免费"这一说。
   */
  browse(
    principal: KolPrincipal,
    query: {
      channel?: KolChannel | undefined
      q?: string | undefined
      min_followers?: number | undefined
      category?: string | undefined
      limit?: number | undefined
    },
  ): BrowseResult {
    const limit = Math.min(Math.max(1, query.limit ?? DEFAULT_CREATOR_LIMIT), MAX_CREATOR_LIMIT)
    const creators = this.deps.store.listCreators({
      channel: query.channel,
      q: query.q,
      min_followers: query.min_followers,
      category: query.category?.toLowerCase(),
      limit,
    })
    if (creators.length === 0) return { creators, credits: FREE_CREDITS }
    const key = this.searchWindowKey(principal, query)
    const last = key === undefined ? undefined : this.deps.store.searchChargeAt(key)
    if (
      last !== undefined &&
      Date.parse(this.deps.now()) - Date.parse(last) < SEARCH_IDEMPOTENCY_WINDOW_MS
    ) {
      this.meterFree(principal, KOL_LOOKUP_CAPABILITY, 1)
      return { creators, credits: FREE_CREDITS }
    }
    const { credits } = this.charge(principal, KOL_LOOKUP_CAPABILITY, 1, () => creators)
    if (key !== undefined) this.deps.store.putSearchCharge(key, this.deps.now())
    return { creators, credits }
  }

  private cardOrThrow(channel: KolChannel, handle: string): CreatorRow {
    const card = this.deps.store.creator(channel, handle)
    if (card === undefined)
      throw new KolError(
        'not_found',
        '公共库里还没有这个人。可以先用插件采集或者手动报一条观察，之后所有人都能看到。',
      )
    return card
  }

  private benchmarkFor(card: CreatorRow, at: Iso8601, category?: string): Benchmark {
    return benchmarkOf(
      this.deps.store,
      bucketOf({
        channel: card.channel,
        followers_band: followersBandOf(card.followers),
        ...(category === undefined ? {} : { category }),
      }),
      at,
    )
  }

  /**
   * 体检报告（WP126 起**付费**，`data.kol.audit`，3 积分 / 次）。
   *
   * 两种情况不收钱（预扣释放；Workers 形态下入口那一笔由 `apply` 兜底释放）：
   * - 查无此人（`cardOrThrow` 抛）；
   * - **样本不够、只能给部分结论**（WP129，与「0 条不收钱」同一口径）：报告照出，
   *   里面明说样本不够，`credits` 为 0，`note` 末尾写「样本不够，这次不收。」。
   *   收钱换来的应该是一份完整的体检；只剩"最近一次看到的资料本身"那一份，
   *   说不过去。
   *
   * 基准桶不够 k（分位那一格缺）**不算**这一档：粉丝真实度是这个人自己的样本
   * 算出来的完整结论，缺的是"和别人比"——报告里已经说清楚了。
   */
  audit(principal: KolPrincipal, key: { channel: KolChannel; handle: string }): AuditReport {
    return this.chargedAudit(principal, key, 'basic')
  }

  /**
   * 付费深度体检（`data.kol.audit`，与 basic 同价——WP126 之后只有这一档价，
   * `depth` 标 `deep` 但里面的判断与 basic 同源。真的深度分析（评论真实性抽样、
   * 受众画像、跨渠道对照）留给后续 WP —— 收了钱就要说清楚现在买到的是什么，
   * 报告里的 `note` 会写明。样本不够同样不收（见 {@link audit}）。
   */
  deepAudit(principal: KolPrincipal, key: { channel: KolChannel; handle: string }): AuditReport {
    return this.chargedAudit(principal, key, 'deep')
  }

  /** 两档体检共用：先出报告（库内计算，不碰外部源），够格才收钱。 */
  private chargedAudit(
    principal: KolPrincipal,
    key: { channel: KolChannel; handle: string },
    depth: 'basic' | 'deep',
  ): AuditReport {
    const at = this.deps.now()
    const card = this.cardOrThrow(key.channel, key.handle)
    const report = buildAudit({
      card,
      observations: this.deps.store.observationsOf(card.channel, card.handle),
      benchmark: this.benchmarkFor(card, at),
      at,
      depth,
    })
    if (report.insufficient_samples)
      return { ...report, note: `${report.note}${AUDIT_NOT_CHARGED_NOTE}`, credits: FREE_CREDITS }
    const { credits } = this.charge(principal, KOL_AUDIT_CAPABILITY, 1, () => report)
    return { ...report, credits }
  }

  /** 付费 reveal 邮箱（`data.kol.lookup`）。库里没有联系方式**不扣积分**。 */
  reveal(principal: KolPrincipal, key: { channel: KolChannel; handle: string }): RevealedContact {
    const at = this.deps.now()
    const card = this.cardOrThrow(key.channel, key.handle)
    const contact = this.deps.store.contactOf(card.channel, card.handle)
    if (contact === undefined)
      throw new KolError(
        'not_found',
        '库里还没有这个人的联系方式。没有取到就不收钱——这一次没有扣积分。',
      )
    if (!this.deps.secrets.available)
      throw new KolError('internal', '云侧没有配邮箱密钥，这一次没有扣积分。')

    const { value, credits } = this.charge(principal, KOL_LOOKUP_CAPABILITY, 1, () => {
      const email = this.deps.secrets.decrypt(contact.email_cipher)
      if (email === undefined)
        throw new KolError('internal', '这条联系方式解不开，这一次没有扣积分。')
      return email
    })
    return {
      channel: card.channel,
      handle: card.handle,
      email: value,
      source: contact.source,
      at,
      credits,
    }
  }

  /**
   * 去外部源刷新一次这个人的公开资料（`social.fetch`）。
   *
   * 三条纪律：**驻留先判**（`cn` 只查库）、**配额耗尽自动降级**、
   * **没真取到就不收钱**（预扣整笔释放）。
   */
  async refresh(
    principal: KolPrincipal,
    key: { channel: KolChannel; handle: string },
  ): Promise<RefreshResult> {
    const at = this.deps.now()
    const sources = this.deps.sources
    if (sources === undefined)
      return {
        refreshed: false,
        used: 'none',
        reason: 'no_source',
        message: '云侧现在没有配任何外部采集源，这一次只查了库里已有的资料。',
        credits: FREE_CREDITS,
        ...(this.deps.store.creator(key.channel, key.handle) === undefined
          ? {}
          : { card: this.cardOrThrow(key.channel, key.handle) }),
      }

    const { reservation, credits } = this.reserve(principal, SOCIAL_FETCH_CAPABILITY, 1)
    let outcome: SourceOutcome
    try {
      outcome = await sources.fetch(key, { region: principal.region, at })
    } catch (err) {
      this.deps.wallet.release(reservation)
      outcome = outcomeOfError(err)
      return {
        refreshed: false,
        used: outcome.used,
        ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
        message: outcome.message,
        credits: FREE_CREDITS,
      }
    }

    const snapshot = outcome.snapshot
    if (snapshot === undefined) {
      // 没走成外部源（驻留挡住 / 配额用完 / 没找到）：整笔释放，一分不扣
      this.deps.wallet.release(reservation)
      const existing = this.deps.store.creator(key.channel, key.handle)
      return {
        refreshed: false,
        used: outcome.used,
        ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
        message: outcome.message,
        credits: FREE_CREDITS,
        ...(existing === undefined ? {} : { card: existing }),
      }
    }

    const source: KolObservationSource = outcome.used === 'apify' ? 'apify' : 'official_api'
    const card = this.ingestOne(
      { ...snapshot },
      {
        id: `source:${outcome.used}`,
        workspace_id: principal.workspace_id,
        org_id: principal.org_id,
        kind: 'workspace',
      },
      source,
      at,
      false,
    )
    // 顺手抓到的邮箱：进库就变成哈希 + 密文（明文不落库、不进日志）
    if (snapshot.email !== undefined)
      this.storeContact(card, snapshot.email, source, principal.workspace_id, at)
    /*
     * 这一次真去外面取了数：供应商就是实际用上的那一家（`youtube` / `apify`），
     * 不是 `internal`。成本按 `provider:call` 那张表算——两家的单价差着一个
     * 数量级，记成同一个供应商会让"按供应商"那张表完全失去意义。
     */
    this.deps.wallet.settle(reservation, {
      quantity: 1,
      credits,
      ...this.meta(principal, source === 'apify' ? 'apify' : 'youtube', 1, 'charged'),
    })
    return {
      refreshed: true,
      used: outcome.used,
      message: outcome.message,
      credits,
      card: this.cardOrThrow(card.channel, card.handle),
    }
  }

  /**
   * k-匿名基准：桶不到 20 条不出数，只回分位数不回个体。
   *
   * WP126 起按 `data.kol.lookup` 收（0.2 积分 / 次）。**桶不够 k 不收钱**：
   * 口径②的同一条——收了钱却交不出一个数，说不过去。先算桶再收钱
   * （这一步是库内计算，不碰外部源，不存在"先扣后干"的成本风险）。
   */
  benchmark(
    principal: KolPrincipal,
    query: { channel: KolChannel; category?: string | undefined; followers_band: FollowersBand },
  ): BenchmarkResult {
    const at = this.deps.now()
    const benchmark = benchmarkOf(this.deps.store, bucketOf(query), at)
    if (benchmark.insufficient_samples)
      return { ...benchmark, credits: FREE_CREDITS, note: benchmarkNote(benchmark) }
    const { credits } = this.charge(principal, KOL_LOOKUP_CAPABILITY, 1, () => benchmark)
    return { ...benchmark, credits, note: benchmarkNote(benchmark) }
  }

  // ————————————————————————— 插件配对 —————————————————————————

  /**
   * 用工作区服务令牌换一把插件令牌。
   *
   * 明文只在返回值里出现一次，库里只有 sha256；30 天到期、可撤。
   * 插件拿到的这把**只能报观察**——它既不能查库、也不能花积分。
   */
  pairPlugin(principal: KolPrincipal, label: string): IssuedPluginToken {
    const at = this.deps.now()
    const token = this.deps.secrets.newPluginToken()
    const pairing: PluginPairing = {
      id: this.deps.newId('plp'),
      workspace_id: principal.workspace_id,
      org_id: principal.org_id,
      account_id: principal.account_id,
      label: label.trim() === '' ? '浏览器采集插件' : label.trim().slice(0, 200),
      token_sha256: this.deps.secrets.sha256(token),
      issued_at: at,
      expires_at: new Date(Date.parse(at) + PLUGIN_TOKEN_TTL_MS).toISOString(),
      valid_observations: 0,
      granted_credits: 0,
    }
    this.deps.store.putPairing(pairing)
    return { pairing, token, expires_at: pairing.expires_at }
  }

  /** 验一把插件令牌。撤销 / 过期 / 不存在一律回 `undefined`——**不区分**。 */
  verifyPluginToken(token: string): ContributionSubject | undefined {
    if (!token.startsWith(PLUGIN_TOKEN_PREFIX)) return undefined
    const sha = this.deps.secrets.sha256(token)
    const pairing = this.deps.store.pairingBySha(sha)
    if (pairing === undefined) return undefined
    const at = this.deps.now()
    if (pairing.revoked_at !== undefined || pairing.expires_at <= at) return undefined
    return {
      id: `plg:${sha.slice(0, 16)}`,
      pairing_sha256: sha,
      workspace_id: pairing.workspace_id,
      org_id: pairing.org_id,
      kind: 'plugin',
    }
  }

  /** 撤一把（本机"解除插件"走这条）。不删行，只写 `revoked_at`。 */
  revokePlugin(principal: KolPrincipal, token_sha256: string): boolean {
    const pairing = this.deps.store.pairingBySha(token_sha256)
    if (pairing === undefined || pairing.workspace_id !== principal.workspace_id) return false
    if (pairing.revoked_at !== undefined) return true
    this.deps.store.putPairing({ ...pairing, revoked_at: this.deps.now() })
    return true
  }

  // ————————————————————————— 写与贡献 —————————————————————————

  /** 一条观察落库 + 更新卡面。回更新后的卡。 */
  private ingestOne(
    observation: PublicCreatorObservation,
    subject: ContributionSubject,
    source: KolObservationSource,
    at: Iso8601,
    counted: boolean,
  ): CreatorRow {
    const prev = this.deps.store.creator(observation.channel, observation.handle)
    const fresher = prev === undefined || observation.observed_at >= prev.observed_at
    const observations = (prev?.observations ?? 0) + 1
    const row: ObservationRow = {
      ...observation,
      id: this.deps.newId('kob'),
      subject: subject.id,
      source,
      at,
      followers_band: followersBandOf(observation.followers),
      counted,
    }
    this.deps.store.appendObservation(row)

    const language = fresher ? (observation.language ?? prev?.language) : prev?.language
    const region = fresher ? (observation.region ?? prev?.region) : prev?.region
    const card: CreatorRow = {
      channel: observation.channel,
      handle: observation.handle,
      followers: fresher ? observation.followers : (prev?.followers ?? observation.followers),
      posts_30d: fresher ? observation.posts_30d : (prev?.posts_30d ?? observation.posts_30d),
      engagement_rate: fresher
        ? observation.engagement_rate
        : (prev?.engagement_rate ?? observation.engagement_rate),
      ...(language === undefined ? {} : { language }),
      ...(region === undefined ? {} : { region }),
      categories: mergeCategories(prev?.categories, observation.categories),
      observed_at: fresher
        ? observation.observed_at
        : (prev?.observed_at ?? observation.observed_at),
      source: fresher ? source : (prev?.source ?? source),
      observations,
      confidence: confidenceOf({
        source: fresher ? source : (prev?.source ?? source),
        observations,
        observed_at: fresher
          ? observation.observed_at
          : (prev?.observed_at ?? observation.observed_at),
        at,
      }),
      has_contact: prev?.has_contact ?? false,
      updated_at: at,
    }
    this.deps.store.putCreator(card)
    return card
  }

  /**
   * 插件（或登录态工作区）上报一批观察。
   *
   * 四道闸，顺序就是下面的顺序：
   *
   * 1. **日配额**：每天每贡献者 `MAX_PLUGIN_OBSERVATIONS_PER_DAY` 条，超了 429 人话；
   * 2. **白名单与范围校验**：任意一条不合格 → 整批拒（400）。为什么不是"丢掉那一条
   *    收下其余的"：一条带正文的观察是一个**信号**（插件写错了，或者有人在试探），
   *    悄悄丢掉它等于把信号也丢了；
   * 3. **去重**：同一个贡献者 24 小时内报过同一个 handle 的，落库但**不算奖励**；
   * 4. **奖励**：每 `OBSERVATIONS_PER_CREDIT` 条有效观察 1 积分（`granted` 类、
   *    `CONTRIBUTION_CREDIT_TTL_DAYS` 天过期），单个贡献者每天封顶
   *    `MAX_DAILY_REWARD_CREDITS` 积分。**封顶之外的不作废**：累计数只按真发出去的
   *    那部分前进，明天接着拿。
   */
  contribute(
    subject: ContributionSubject,
    rawObservations: unknown,
    source: KolObservationSource,
  ): ContributionEvent {
    const at = this.deps.now()
    const day = dayOf(at)
    const batch = Array.isArray(rawObservations) ? rawObservations : undefined
    if (batch === undefined) throw new KolError('invalid_input', 'observations 要是一个数组。')
    if (batch.length === 0) throw new KolError('invalid_input', 'observations 是空的。')
    if (batch.length > MAX_OBSERVATIONS_PER_BATCH)
      throw new KolError(
        'invalid_input',
        `一次最多报 ${MAX_OBSERVATIONS_PER_BATCH} 条，这一批有 ${batch.length} 条。`,
      )

    const quota = this.deps.store.quota(subject.id, day)
    const remaining = MAX_PLUGIN_OBSERVATIONS_PER_DAY - quota.observations
    if (remaining <= 0 || batch.length > remaining)
      throw new KolError(
        'rate_limited',
        `今天这把令牌还能报 ${Math.max(0, remaining)} 条（每天上限 ${MAX_PLUGIN_OBSERVATIONS_PER_DAY} 条），这一批有 ${batch.length} 条。明天零点（UTC）重置。`,
        { details: { remaining: Math.max(0, remaining), limit: MAX_PLUGIN_OBSERVATIONS_PER_DAY } },
      )

    const parsed = batch.map((one, index) => {
      try {
        return parseObservation(one, at)
      } catch (err) {
        if (err instanceof KolError)
          throw new KolError(err.code, `第 ${index + 1} 条不合格：${err.message}`, {
            ...(err.details === undefined ? {} : { details: err.details }),
          })
        throw err
      }
    })

    let counted = 0
    let duplicates = 0
    for (const observation of parsed) {
      const last = this.deps.store.lastObservationAt(
        subject.id,
        observation.channel,
        observation.handle,
      )
      const fresh =
        last === undefined ||
        Date.parse(at) - Date.parse(last) >= OBSERVATION_DEDUPE_HOURS * HOUR_MS
      if (fresh) counted += 1
      else duplicates += 1
      this.ingestOne(observation, subject, source, at, fresh)
    }

    const granted = this.grantContribution(subject, counted, day, at)
    this.deps.store.putQuota({
      ...this.deps.store.quota(subject.id, day),
      observations: quota.observations + parsed.length,
    })
    this.bumpPairing(subject, counted, granted.credits)

    const rejected: { reason: string; count: number }[] = []
    if (duplicates > 0)
      rejected.push({
        reason: `${OBSERVATION_DEDUPE_HOURS} 小时内报过同一个人，这些照样进库，但不算奖励`,
        count: duplicates,
      })
    if (granted.capped > 0)
      rejected.push({
        reason: `今天的奖励到顶了（每天 ${MAX_DAILY_REWARD_CREDITS} 积分），剩下的明天接着拿`,
        count: granted.capped,
      })

    return {
      kind: 'observation',
      received: parsed.length,
      accepted: counted,
      credits_granted: granted.credits,
      daily_reward_remaining: granted.dailyRemaining,
      daily_quota_remaining: Math.max(
        0,
        MAX_PLUGIN_OBSERVATIONS_PER_DAY - (quota.observations + parsed.length),
      ),
      rejected,
      at,
    }
  }

  /**
   * WP129：插件（经本机服务转发，或插件令牌直报）上报一批**内容观测**。
   *
   * 口径与 {@link contribute} 逐条对齐——同一个日配额、同一套奖励累计（每
   * `OBSERVATIONS_PER_CREDIT` 条有效 1 积分、日封顶、`granted` 类 90 天到期）、
   * 同样"任意一条不合格整批拒"。两处不同，都写在这里：
   *
   * 1. **幂等键是 渠道 + external_id + observed_at 的 UTC 日**（不是"这个贡献者 24 小时"）：
   *    同一条内容同一天不管谁报、报几次，都只记一行指标；桶内重复报只刷新卡上的数，
   *    **不算奖励**——一条事实只奖一次，否则同一条视频刷新十遍就能刷积分；
   * 2. **窄行**：白名单里没有评论、没有页面 / 封面地址、没有任何用户自己的备注。
   *
   * 库没有内容写路（老的装配）就明说 501，不假装收下了。
   */
  contributeContent(
    subject: ContributionSubject,
    rawObservations: unknown,
    source: KolObservationSource,
  ): ContributionEvent {
    const store = this.deps.store
    if (!isContentStore(store))
      throw new KolError('not_implemented', '这个云侧的库还没开内容这一格，内容观测暂时收不了。')
    const at = this.deps.now()
    const day = dayOf(at)
    const batch = Array.isArray(rawObservations) ? rawObservations : undefined
    if (batch === undefined) throw new KolError('invalid_input', 'observations 要是一个数组。')
    if (batch.length === 0) throw new KolError('invalid_input', 'observations 是空的。')
    if (batch.length > MAX_OBSERVATIONS_PER_BATCH)
      throw new KolError(
        'invalid_input',
        `一次最多报 ${MAX_OBSERVATIONS_PER_BATCH} 条，这一批有 ${batch.length} 条。`,
      )

    const quota = store.quota(subject.id, day)
    const remaining = MAX_PLUGIN_OBSERVATIONS_PER_DAY - quota.observations
    if (remaining <= 0 || batch.length > remaining)
      throw new KolError(
        'rate_limited',
        `今天这把令牌还能报 ${Math.max(0, remaining)} 条（每天上限 ${MAX_PLUGIN_OBSERVATIONS_PER_DAY} 条，红人与内容合算），这一批有 ${batch.length} 条。明天零点（UTC）重置。`,
        { details: { remaining: Math.max(0, remaining), limit: MAX_PLUGIN_OBSERVATIONS_PER_DAY } },
      )

    const parsed = batch.map((one, index) => {
      try {
        return parseContentObservation(one, at)
      } catch (err) {
        if (err instanceof KolError)
          throw new KolError(err.code, `第 ${index + 1} 条不合格：${err.message}`, {
            ...(err.details === undefined ? {} : { details: err.details }),
          })
        throw err
      }
    })

    let counted = 0
    let duplicates = 0
    let optedOut = 0
    for (const observation of parsed) {
      if (store.optedOut(observation.channel, observation.handle)) {
        optedOut += 1
        continue
      }
      const bucket = dayOf(observation.observed_at)
      const fresh = !store.contentMetricOnDay(observation.channel, observation.external_id, bucket)
      if (fresh) counted += 1
      else duplicates += 1
      this.ingestContent(store, observation, source, at, fresh)
    }

    const granted = this.grantContribution(subject, counted, day, at)
    this.deps.store.putQuota({
      ...this.deps.store.quota(subject.id, day),
      observations: quota.observations + parsed.length,
    })
    this.bumpPairing(subject, counted, granted.credits)

    const rejected: { reason: string; count: number }[] = []
    if (duplicates > 0)
      rejected.push({
        reason: '同一条内容今天（UTC）已经有人报过，这些只刷新了数字，不算奖励',
        count: duplicates,
      })
    if (optedOut > 0)
      rejected.push({ reason: '作者要求过从公共库移除，这些没有收', count: optedOut })
    if (granted.capped > 0)
      rejected.push({
        reason: `今天的奖励到顶了（每天 ${MAX_DAILY_REWARD_CREDITS} 积分），剩下的明天接着拿`,
        count: granted.capped,
      })

    return {
      kind: 'content',
      received: parsed.length,
      accepted: counted,
      credits_granted: granted.credits,
      daily_reward_remaining: granted.dailyRemaining,
      daily_quota_remaining: Math.max(
        0,
        MAX_PLUGIN_OBSERVATIONS_PER_DAY - (quota.observations + parsed.length),
      ),
      rejected,
      at,
    }
  }

  /** 登录态工作区那条路（本机服务转发走它）。 */
  contributeContentAs(principal: KolPrincipal, rawObservations: unknown): ContributionEvent {
    return this.contributeContent(workspaceSubject(principal), rawObservations, 'plugin')
  }

  /**
   * 一条内容观测落库：新桶记一行指标；卡（`kol_contents`）只在这一条**不比库里旧**时
   * 才刷新数字（离线队列补传的旧观测不该把新数盖回去），但旧观测里有、库里没有的
   * 格子照样补上。
   */
  private ingestContent(
    store: KolContentStore,
    observation: PublicContentObservation,
    source: KolObservationSource,
    at: Iso8601,
    fresh: boolean,
  ): void {
    const prev = store.content(observation.channel, observation.external_id)
    const newer = prev === undefined || observation.observed_at >= prev.observed_at
    const incoming: PublicContentSample = {
      channel: observation.channel,
      handle: observation.handle,
      external_id: observation.external_id,
      content_type: observation.content_type,
      ...(observation.title === undefined ? {} : { title: observation.title }),
      ...(observation.published_at === undefined ? {} : { published_at: observation.published_at }),
      ...(observation.duration_seconds === undefined
        ? {}
        : { duration_seconds: observation.duration_seconds }),
      ...(observation.orientation === undefined ? {} : { orientation: observation.orientation }),
      ...(observation.views === undefined ? {} : { views: observation.views }),
      ...(observation.likes === undefined ? {} : { likes: observation.likes }),
      ...(observation.comments === undefined ? {} : { comments: observation.comments }),
      ...(observation.shares === undefined ? {} : { shares: observation.shares }),
      ...(observation.paid_promotion === undefined
        ? {}
        : { paid_promotion: observation.paid_promotion }),
      ...(observation.shoppable === undefined ? {} : { shoppable: observation.shoppable }),
      observed_at: observation.observed_at,
      source,
      updated_at: at,
    }
    // 新的盖旧的；旧的只补空格。两种情况都是"整行写回"，库那一侧的 COALESCE 只是第二道保险
    const merged: PublicContentSample =
      prev === undefined
        ? incoming
        : newer
          ? { ...prev, ...incoming }
          : { ...incoming, ...prev, updated_at: at }
    store.putContent(merged)
    if (!fresh) return
    store.putContentMetric({
      channel: observation.channel,
      handle: observation.handle,
      content_external_id: observation.external_id,
      ...(observation.views === undefined ? {} : { views: observation.views }),
      ...(observation.likes === undefined ? {} : { likes: observation.likes }),
      ...(observation.comments === undefined ? {} : { comments: observation.comments }),
      ...(observation.shares === undefined ? {} : { shares: observation.shares }),
      observed_at: observation.observed_at,
      source,
      at,
    })
  }

  /** 累计满 100 条发 1 积分；日封顶之外的留到明天（累计数只按真发的前进）。 */
  private grantContribution(
    subject: ContributionSubject,
    counted: number,
    day: string,
    at: Iso8601,
  ): { credits: number; dailyRemaining: number; capped: number } {
    const life = this.deps.store.quota(subject.id, LIFETIME_DAY)
    const total = life.observations + counted
    const earned = Math.floor(total / OBSERVATIONS_PER_CREDIT) - life.reward_credits
    const today = this.deps.store.quota(subject.id, day)
    const dailyRemaining = Math.max(0, MAX_DAILY_REWARD_CREDITS - today.reward_credits)
    const credits = Math.max(0, Math.min(earned, dailyRemaining))
    this.deps.store.putQuota({
      ...life,
      observations: total,
      reward_credits: life.reward_credits + credits,
    })
    if (credits > 0) {
      this.deps.store.putQuota({ ...today, reward_credits: today.reward_credits + credits })
      this.topupGranted(subject.org_id, credits, at)
    }
    return {
      credits,
      dailyRemaining: Math.max(0, dailyRemaining - credits),
      capped: Math.max(0, earned - credits),
    }
  }

  /** 奖励是"送的"那一类积分：90 天到期清零（49 §3 两类积分）。 */
  private topupGranted(org_id: string, credits: number, at: Iso8601): void {
    this.deps.wallet.topup({
      org_id,
      credits: roundCredits(credits),
      kind: 'granted',
      expires_at: new Date(Date.parse(at) + CONTRIBUTION_CREDIT_TTL_DAYS * DAY_MS).toISOString(),
    })
  }

  /**
   * 配对行上那两个累计数（"这把插件贡献了多少"那个面板看它）。
   *
   * 只有插件那一路有配对行；登录态工作区的累计数在配额表的 `lifetime` 那一行上。
   * 两处记的是同一件事，但**配对行是给人看的**，配额表那行是算奖励用的。
   */
  private bumpPairing(subject: ContributionSubject, counted: number, credits: number): void {
    const sha = subject.pairing_sha256
    if (sha === undefined) return
    const pairing = this.deps.store.pairingBySha(sha)
    if (pairing === undefined) return
    this.deps.store.putPairing({
      ...pairing,
      valid_observations: pairing.valid_observations + counted,
      granted_credits: roundCredits(pairing.granted_credits + credits),
    })
  }

  /**
   * 联系方式回填：邮箱进哈希 + 密文，回填者得奖励。
   *
   * **没有密钥就不收**（501 人话）——存不了密文就一个字节都不存，
   * 绝不"先存明文回头再加密"。
   */
  saveContact(
    subject: ContributionSubject,
    key: { channel: KolChannel; handle: string },
    body: { email?: unknown; source?: unknown },
  ): ContributionEvent {
    const at = this.deps.now()
    const day = dayOf(at)
    const card = this.cardOrThrow(key.channel, key.handle)
    if (!this.deps.secrets.available)
      throw new KolError(
        'not_implemented',
        '云侧还没配邮箱密钥，联系方式暂时收不了——收下却存不成密文，比不收更糟。',
      )
    const email = normalizeEmail(body.email)
    const source: KolObservationSource = body.source === 'plugin' ? 'plugin' : 'manual'
    const sha = this.deps.secrets.sha256(email)
    const existing = this.deps.store.contactBySha(card.channel, card.handle, sha)
    if (existing !== undefined) {
      return {
        kind: 'contact',
        received: 1,
        accepted: 0,
        credits_granted: 0,
        daily_reward_remaining: Math.max(
          0,
          MAX_DAILY_REWARD_CREDITS - this.deps.store.quota(subject.id, day).reward_credits,
        ),
        daily_quota_remaining: Math.max(
          0,
          MAX_PLUGIN_OBSERVATIONS_PER_DAY - this.deps.store.quota(subject.id, day).observations,
        ),
        rejected: [{ reason: '这条联系方式库里已经有了', count: 1 }],
        at,
      }
    }

    this.storeContact(card, email, source, subject.workspace_id, at)

    const today = this.deps.store.quota(subject.id, day)
    const dailyRemaining = Math.max(0, MAX_DAILY_REWARD_CREDITS - today.reward_credits)
    const credits = Math.min(CONTACT_REWARD_CREDITS, dailyRemaining)
    if (credits > 0) {
      this.deps.store.putQuota({ ...today, reward_credits: today.reward_credits + credits })
      this.topupGranted(subject.org_id, credits, at)
    }
    return {
      kind: 'contact',
      received: 1,
      accepted: 1,
      credits_granted: credits,
      daily_reward_remaining: Math.max(0, dailyRemaining - credits),
      daily_quota_remaining: Math.max(0, MAX_PLUGIN_OBSERVATIONS_PER_DAY - today.observations),
      rejected:
        credits === 0
          ? [{ reason: `今天的奖励到顶了（每天 ${MAX_DAILY_REWARD_CREDITS} 积分）`, count: 1 }]
          : [],
      at,
    }
  }

  /** 明文在这个函数里活过三行：算哈希、加密、然后就没了。 */
  private storeContact(
    card: CreatorRow,
    email: string,
    source: KolObservationSource,
    contributed_by: string,
    at: Iso8601,
  ): void {
    const normalized = normalizeEmail(email)
    const cipher = this.deps.secrets.encrypt(normalized)
    if (cipher === undefined)
      throw new KolError('not_implemented', '云侧还没配邮箱密钥，联系方式暂时收不了。')
    this.deps.store.putContact({
      channel: card.channel,
      handle: card.handle,
      email_sha256: this.deps.secrets.sha256(normalized),
      email_cipher: cipher,
      source,
      contributed_by,
      at,
    })
    this.deps.store.putCreator({ ...card, has_contact: true, updated_at: at })
  }

  /** 争议：**只记不裁**。系统不会因为一条争议就改数据，owner 后台看。 */
  dispute(
    principal: KolPrincipal,
    key: { channel: KolChannel; handle: string },
    body: { field?: unknown; claim?: unknown },
  ): DisputeResult {
    const at = this.deps.now()
    const card = this.cardOrThrow(key.channel, key.handle)
    const field = typeof body.field === 'string' ? body.field.trim() : ''
    const claim = typeof body.claim === 'string' ? body.claim.trim() : ''
    if (field === '' || field.length > 60)
      throw new KolError('invalid_input', 'field 要说清楚是哪一格不对（比如 followers / region）。')
    if (claim === '' || claim.length > MAX_DISPUTE_CLAIM)
      throw new KolError(
        'invalid_input',
        `claim 要有内容且不超过 ${MAX_DISPUTE_CLAIM} 个字——这里只收一句说明，不收正文。`,
      )
    const dispute: Dispute = {
      id: this.deps.newId('kdp'),
      channel: card.channel,
      handle: card.handle,
      field,
      claim,
      reported_by: principal.workspace_id,
      org_id: principal.org_id,
      status: 'open',
      at,
    }
    this.deps.store.putDispute(dispute)
    return {
      dispute,
      message: '记下了。公共库不会因为一条争议自动改数据——有人看过之后才改。',
    }
  }

  /** 手动加一条观察（登录态工作区那条路）。 */
  contributeAs(principal: KolPrincipal, rawObservations: unknown): ContributionEvent {
    return this.contribute(
      {
        id: `ws:${principal.workspace_id}`,
        workspace_id: principal.workspace_id,
        org_id: principal.org_id,
        kind: 'workspace',
      },
      rawObservations,
      'manual',
    )
  }
}

/** 默认类目（基准不按类目筛时用它）。 */
export const DEFAULT_CATEGORY = ANY_CATEGORY

/** 导出给测试与装配：一个 subject 的 id 长什么样。 */
export const workspaceSubject = (principal: KolPrincipal): ContributionSubject => ({
  id: `ws:${principal.workspace_id}`,
  workspace_id: principal.workspace_id,
  org_id: principal.org_id,
  kind: 'workspace',
})

export type { SourceSnapshot }
