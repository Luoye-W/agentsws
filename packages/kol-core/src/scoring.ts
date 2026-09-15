/**
 * 红人打分（48 §5.2「打分」）：粉丝带 / 互动率 / 类目匹配 / 语言地区 / 活跃度 → 0–100。
 *
 * **每一项都可解释**。这是这个模块唯一的硬要求：找人清单上排第一的那个人，
 * 用户点开必须看得到"为什么是他"——哪一项拿了多少分、为什么。一个光秃秃的
 * 87 分跟掷骰子在用户眼里没有区别，而且它错的时候没人能指出错在哪。
 *
 * 五项的权重写死在 {@link DEFAULT_WEIGHTS} 里，可以按 campaign 覆盖（小众品类找
 * 小号，粉丝带那一项就该轻）。**没有 LLM**：KOLAgents 那边是启发式 + LLM 混合，
 * 本体这一份只做启发式那一半——纯函数、可测、离线也算得出来。
 *
 * 刷粉护栏在 {@link engagementScore} 里：粉丝很多而互动率低得离谱的账号，
 * 互动率那一项直接给 0 并说明白，不是按线性插值给个中间分。
 */
import type { KolChannel, PlatformAccount } from '@agentsws/contracts'

/** 打分的五项。 */
export type ScoreFactorId = 'followers' | 'engagement' | 'category' | 'locale' | 'activity'

export interface ScoreFactor {
  id: ScoreFactorId
  /** 界面上那一行的名字。 */
  label: string
  /** 这一项拿了多少分（0–100，未加权）。 */
  score: number
  /** 这一项占总分的比重（0–1）。 */
  weight: number
  /** 一句人话：为什么是这个分。**必给**——这一格空着，整个模块就白写了。 */
  why: string
}

export interface CreatorScore {
  /** 0–100，四舍五入到整数。 */
  total: number
  factors: ScoreFactor[]
  /**
   * 拦下的理由（有值就是"这个人先别看"）。
   *
   * 与低分**分得开**：60 分是"不太合适"，`blocked` 是"数据本身不可信 / 明显刷粉"。
   * 面板上前者往下排，后者单独一栏。
   */
  blocked?: string
}

export type ScoreWeights = Readonly<Record<ScoreFactorId, number>>

/**
 * 默认权重。互动率比粉丝数重，因为粉丝数是**买得到**的而互动率买起来贵得多；
 * 语言地区那一项压得很轻——它更像一道过滤而不是一个分。
 */
export const DEFAULT_WEIGHTS: ScoreWeights = {
  followers: 0.25,
  engagement: 0.3,
  category: 0.2,
  locale: 0.1,
  activity: 0.15,
}

/** 一次找人的条件（campaign 向导里填的那几格）。 */
export interface ScoreCriteria {
  /** 想要的粉丝带（含两端）。不填就按 {@link DEFAULT_BAND}。 */
  followers_band?: { min: number; max: number }
  /** 目标类目（`PlatformAccount.category` 与它比）。 */
  category?: string
  /** 目标语言（BCP-47 前缀比对：`zh` 命中 `zh-Hans`）。 */
  language?: string
  /** 目标地区（ISO-3166，大小写不敏感）。 */
  region?: string
  /** 权重覆盖（只写想改的那几项）。 */
  weights?: Partial<ScoreWeights>
  /** 算"活跃度"用的现在时刻（注入，本文件没有 `Date.now()`）。 */
  now: string
}

/** 不填粉丝带时的默认区间：一万到五十万（中腰部，DTC 投产比最好的那一段）。 */
export const DEFAULT_BAND = { min: 10_000, max: 500_000 } as const

/**
 * 各渠道"正常"的互动率量级差别很大（一条 X 的帖子与一条 YouTube 视频不是一回事），
 * 所以基准按渠道分。超过基准就满分，低于一半按比例给。
 */
export const ENGAGEMENT_BASELINE: Readonly<Record<KolChannel, number>> = {
  youtube: 0.04,
  facebook: 0.02,
  instagram: 0.03,
  tiktok: 0.06,
  x: 0.015,
}

/**
 * 刷粉护栏那条线：粉丝数在这个量级以上、互动率却低于基准的这个比例，
 * 就不是"表现一般"，是数据不可信。
 */
export const FAKE_FOLLOWER_FLOOR = 50_000
export const FAKE_FOLLOWER_RATIO = 0.1

const clamp = (v: number): number => Math.max(0, Math.min(100, v))
const pct = (v: number): string => `${(v * 100).toFixed(1)}%`

/** 粉丝带：在带内满分，带外按离带边的距离掉分（数量级尺度，不是线性）。 */
function followersScore(
  followers: number | undefined,
  band: { min: number; max: number },
): { score: number; why: string } {
  if (followers === undefined)
    // 不知道粉丝数不等于零分：那样会把"还没采到数"的人永远压在最下面，
    // 而他可能正是最该看的那个。给中间分并说清楚。
    return { score: 50, why: '还不知道粉丝数（没采到），按中间分算，先别当结论。' }
  if (followers >= band.min && followers <= band.max)
    return { score: 100, why: `${followers.toLocaleString('en-US')} 粉，正好在想要的区间里。` }
  const edge = followers < band.min ? band.min : band.max
  // 差一个数量级扣 60 分：10 万 vs 1 万比 10 万 vs 9 万严重得多
  const decades = Math.abs(Math.log10(Math.max(1, followers) / edge))
  const score = clamp(100 - decades * 60)
  const side = followers < band.min ? '偏小' : '偏大'
  return {
    score,
    why: `${followers.toLocaleString('en-US')} 粉，比想要的区间${side}（区间是 ${band.min.toLocaleString('en-US')}–${band.max.toLocaleString('en-US')}）。`,
  }
}

/** 互动率：按渠道基准折算；刷粉护栏在这里。 */
function engagementScore(
  rate: number | undefined,
  followers: number | undefined,
  channel: KolChannel,
): { score: number; why: string; blocked?: string } {
  const baseline = ENGAGEMENT_BASELINE[channel]
  if (rate === undefined) return { score: 50, why: '还不知道互动率（没采到），按中间分算。' }
  if (
    followers !== undefined &&
    followers >= FAKE_FOLLOWER_FLOOR &&
    rate < baseline * FAKE_FOLLOWER_RATIO
  )
    return {
      score: 0,
      why: `${followers.toLocaleString('en-US')} 粉却只有 ${pct(rate)} 互动率，这个渠道正常是 ${pct(baseline)} 上下。`,
      blocked: `粉丝数与互动率对不上（${followers.toLocaleString('en-US')} 粉 / ${pct(rate)}），先人工看一眼是不是刷的。`,
    }
  const score = clamp((rate / baseline) * 100)
  return {
    score,
    why:
      rate >= baseline
        ? `互动率 ${pct(rate)}，高于这个渠道的基准 ${pct(baseline)}。`
        : `互动率 ${pct(rate)}，低于这个渠道的基准 ${pct(baseline)}。`,
  }
}

/** 类目匹配：完全相同满分，互相包含给 70，都没填给中间分。 */
function categoryScore(
  actual: string | undefined,
  want: string | undefined,
): { score: number; why: string } {
  if (want === undefined) return { score: 50, why: '这次找人没限类目。' }
  if (actual === undefined)
    return { score: 40, why: `还不知道他做什么类目（想要的是「${want}」）。` }
  const a = actual.trim().toLowerCase()
  const w = want.trim().toLowerCase()
  if (a === w) return { score: 100, why: `类目正好是「${actual}」。` }
  if (a.includes(w) || w.includes(a))
    return { score: 70, why: `类目「${actual}」与想要的「${want}」沾边，不完全一样。` }
  return { score: 20, why: `类目是「${actual}」，想要的是「${want}」，对不上。` }
}

/** 语言与地区：两格各占一半；没限制就算满足。 */
function localeScore(
  account: Pick<PlatformAccount, 'language' | 'region'>,
  want: Pick<ScoreCriteria, 'language' | 'region'>,
): { score: number; why: string } {
  const parts: string[] = []
  let got = 0
  let total = 0
  if (want.language !== undefined) {
    total += 1
    const actual = account.language
    // BCP-47 前缀比对：想要 `zh` 时 `zh-Hans` 算命中
    const hit =
      actual !== undefined &&
      (actual.toLowerCase() === want.language.toLowerCase() ||
        actual.toLowerCase().startsWith(`${want.language.toLowerCase()}-`))
    if (hit) got += 1
    parts.push(hit ? `语言是 ${actual}` : `语言 ${actual ?? '未知'}（想要 ${want.language}）`)
  }
  if (want.region !== undefined) {
    total += 1
    const hit = account.region?.toUpperCase() === want.region.toUpperCase()
    if (hit) got += 1
    parts.push(
      hit ? `地区是 ${account.region}` : `地区 ${account.region ?? '未知'}（想要 ${want.region}）`,
    )
  }
  if (total === 0) return { score: 100, why: '这次找人没限语言地区。' }
  return { score: (got / total) * 100, why: `${parts.join('；')}。` }
}

/** 一天的毫秒数。 */
const DAY = 86_400_000
/** 观测超过这么多天就当"不知道现在什么样"。 */
export const STALE_DAYS = 90

/** 活跃度：按 `observed_at` 有多旧算。新鲜满分，越旧越低，超过 {@link STALE_DAYS} 见底。 */
function activityScore(observed_at: string, now: string): { score: number; why: string } {
  const at = Date.parse(observed_at)
  const t = Date.parse(now)
  if (Number.isNaN(at) || Number.isNaN(t))
    return { score: 0, why: '这份数据没有可信的观测时间，当成不知道。' }
  const days = Math.max(0, Math.floor((t - at) / DAY))
  if (days <= 7) return { score: 100, why: `${days} 天前看到的数据，还新鲜。` }
  const score = clamp(100 - ((days - 7) / (STALE_DAYS - 7)) * 100)
  return {
    score,
    why:
      days >= STALE_DAYS
        ? `${days} 天前看到的数据，太旧了——现在什么样其实不知道。`
        : `${days} 天前看到的数据。`,
  }
}

const LABELS: Readonly<Record<ScoreFactorId, string>> = {
  followers: '粉丝带',
  engagement: '互动率',
  category: '类目匹配',
  locale: '语言地区',
  activity: '数据新鲜度',
}

/**
 * 打分看得见的那几格（`PlatformAccount` 的子集）。
 *
 * 单独起个名字是为了让 `campaign.ts` 那边的泛型写得下去——
 * 在类型参数上写 `Parameters<typeof scoreCreator>[0]` 读起来像谜语。
 */
export type ScorableAccount = Pick<
  PlatformAccount,
  'channel' | 'followers' | 'engagement_rate' | 'category' | 'language' | 'region' | 'observed_at'
>

/**
 * 给一个账号打分。
 *
 * 总分 = 五项加权平均（权重会被归一，所以覆盖时不用凑够 1）。
 * 命中刷粉护栏时 `blocked` 有值，**总分照算**——面板上要能同时说
 * "他 72 分"和"但这个数不可信"。
 */
export function scoreCreator(account: ScorableAccount, criteria: ScoreCriteria): CreatorScore {
  const weights: ScoreWeights = { ...DEFAULT_WEIGHTS, ...criteria.weights }
  const band = criteria.followers_band ?? DEFAULT_BAND
  const f = followersScore(account.followers, band)
  const e = engagementScore(account.engagement_rate, account.followers, account.channel)
  const c = categoryScore(account.category, criteria.category)
  const l = localeScore(account, criteria)
  const a = activityScore(account.observed_at, criteria.now)

  const raw: { id: ScoreFactorId; score: number; why: string }[] = [
    { id: 'followers', ...f },
    { id: 'engagement', score: e.score, why: e.why },
    { id: 'category', ...c },
    { id: 'locale', ...l },
    { id: 'activity', ...a },
  ]
  const sum = raw.reduce((acc, r) => acc + weights[r.id], 0)
  const factors: ScoreFactor[] = raw.map((r) => ({
    id: r.id,
    label: LABELS[r.id],
    score: Math.round(r.score),
    weight: sum === 0 ? 0 : weights[r.id] / sum,
    why: r.why,
  }))
  const total = Math.round(factors.reduce((acc, x) => acc + x.score * x.weight, 0))
  return { total, factors, ...(e.blocked === undefined ? {} : { blocked: e.blocked }) }
}

/**
 * 找人清单：一批账号按分排序。
 *
 * 命中刷粉护栏的**排在后面**（不是剔掉）：把人从清单上悄悄拿掉，用户会以为
 * 我们没搜到他；排在后面并写明理由，用户自己判断。
 */
export function rankCreators<T extends ScorableAccount>(
  accounts: readonly T[],
  criteria: ScoreCriteria,
): { account: T; score: CreatorScore }[] {
  return accounts
    .map((account) => ({ account, score: scoreCreator(account, criteria) }))
    .sort((x, y) => {
      const bx = x.score.blocked === undefined ? 0 : 1
      const by = y.score.blocked === undefined ? 0 : 1
      if (bx !== by) return bx - by
      return y.score.total - x.score.total
    })
}
