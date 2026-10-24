/**
 * WP500：红人详情里「体检 / 受众真实性 / 频道估值 / 更新规律 / 粉丝 30 天变化」那几块的数。
 *
 * 新写的只有接线：把本机已有的东西拼回一份 {@link CreatorSnapshot}，交给插件面板那一套算法
 * （`@agentsws/creator-capture` 的 `creatorMetrics`——体检 `computeLocalHealth`、受众真实性
 * `localAuthenticitySignals`、频道估值 `estimateLocalValuation`、更新规律 `assessUploadRegularity`，
 * 都是移植自 KOLAgents 的那几份，本体不改）。于是同一个红人，插件面板上、ego 回执里、工作台详情里
 * 是同一份数。
 *
 * 本机已有的东西 = 「存入红人池」那一刻主页上的资料（WP498 的 `profile`：近期作品带播放 / 点赞 / 评论 /
 * 发布时间）+ 账号上最近一次看到的粉丝数 + 粉丝快照历史。
 *
 * 只出**结构化的数**：插件那几份算法里带的说明文字（`pick()` 按浏览器语言出中 / 英文）不往外送，
 * 界面按自己的语言说——服务端在哪种语言下跑都不该影响界面上那一句。
 */
import type { KolCreatorChecksView } from '@agentsws/api'
import type { Iso8601, PlatformAccount } from '@agentsws/contracts'
import {
  type CapturePlatform,
  type CreatorSnapshot,
  creatorMetrics,
  type RecentItem,
} from '@agentsws/creator-capture'
import { assessUploadRegularity } from '@agentsws/creator-capture/kol/utils/creatorSnapshot'
import type { KolAccountObservation, KolProfileSnapshot } from './kol.js'

/** 粉丝趋势看多少天（与插件报告、云端「30 天内重看不另收费」同一个数）。 */
export const FOLLOWER_TREND_DAYS = 30

/** 插件那套算法认得的平台（Facebook / X 没有主页采集器，估值也没有 CPM 表）。 */
const CAPTURE_PLATFORMS: readonly CapturePlatform[] = ['youtube', 'instagram', 'tiktok']

function capturePlatform(channel: string): CapturePlatform | undefined {
  return CAPTURE_PLATFORMS.find((p) => p === channel)
}

/** 存下来的那一份资料 → 插件的快照形状（只填算法读的那几格）。 */
export function snapshotOf(
  account: PlatformAccount,
  profile: KolProfileSnapshot,
  platform: CapturePlatform,
): CreatorSnapshot {
  const recentItems: RecentItem[] = (profile.recent_items ?? []).map((r) => ({
    title: r.title,
    ...(r.views === undefined ? {} : { views: r.views }),
    ...(r.views_text === undefined ? {} : { viewsText: r.views_text }),
    ...(r.likes === undefined ? {} : { likes: r.likes }),
    ...(r.comments === undefined ? {} : { comments: r.comments }),
    ...(r.published_at === undefined ? {} : { publishedAt: r.published_at }),
    ...(r.published_text === undefined ? {} : { publishedText: r.published_text }),
  }))
  return {
    platform,
    externalId: account.external_id ?? account.handle,
    name: account.handle,
    handle: account.handle,
    ...(account.followers === undefined ? {} : { followers: account.followers }),
    ...(profile.video_count === undefined ? {} : { videoCount: profile.video_count }),
    ...(profile.avg_views === undefined ? {} : { avgViews: profile.avg_views }),
    links: [],
    recentItems,
    regularity: assessUploadRegularity(recentItems),
    pageUrl: account.url,
  }
}

/** 点赞率中位数（与 `localAuthenticitySignals` 里那一条同一个口径：有播放、有点赞的作品）。 */
function likeRateMedian(
  items: readonly RecentItem[],
): { median: number; items: number } | undefined {
  const rates = items
    .filter((i) => Number.isFinite(i.views) && (i.views as number) > 0 && Number.isFinite(i.likes))
    .map((i) => (i.likes as number) / (i.views as number))
    .sort((a, b) => a - b)
  if (rates.length === 0) return undefined
  const mid = Math.floor(rates.length / 2)
  const median =
    rates.length % 2 === 1
      ? (rates[mid] as number)
      : ((rates[mid - 1] as number) + (rates[mid] as number)) / 2
  return { median, items: rates.length }
}

/**
 * 粉丝 30 天变化：窗口里最早与最近两个快照的差（同插件报告 `follower_trend` 那一格的算法）。
 * 快照不足两个 = `undefined`（不是 0）。
 */
export function followerTrendOf(
  observations: readonly KolAccountObservation[],
  now: Iso8601,
): KolCreatorChecksView['follower_trend'] {
  const since = Date.parse(now) - FOLLOWER_TREND_DAYS * 86_400_000
  const window = observations
    .filter(
      (o): o is KolAccountObservation & { followers: number } =>
        o.followers !== undefined && Date.parse(o.observed_at) >= since,
    )
    .sort((a, b) => Date.parse(a.observed_at) - Date.parse(b.observed_at))
  const first = window[0]
  const last = window.at(-1)
  if (first === undefined || last === undefined || first.id === last.id) return undefined
  const days = Math.max(
    1,
    Math.round((Date.parse(last.observed_at) - Date.parse(first.observed_at)) / 86_400_000),
  )
  const delta = last.followers - first.followers
  const percent = first.followers > 0 ? Math.round((delta / first.followers) * 1000) / 10 : 0
  return { days, delta, percent }
}

/** 一个账号的几项估算；一项都算不出来回 `undefined`（详情里就不带这个账号）。 */
export function creatorChecksOf(
  account: PlatformAccount,
  profile: KolProfileSnapshot | undefined,
  observations: readonly KolAccountObservation[],
  now: Iso8601,
): KolCreatorChecksView | undefined {
  const out: KolCreatorChecksView = {}
  const trend = followerTrendOf(observations, now)
  if (trend !== undefined) out.follower_trend = trend
  const platform = capturePlatform(account.channel)
  if (profile !== undefined && platform !== undefined) {
    const snapshot = snapshotOf(account, profile, platform)
    const m = creatorMetrics(snapshot)
    if (m.health.verdict !== 'unknown' && m.health.viewsToSubsRatio !== undefined)
      out.health = {
        verdict: m.health.verdict,
        views_to_followers: m.health.viewsToSubsRatio,
        bought_audience_suspected: m.health.boughtAudienceSuspected,
      }
    const likeSignal = m.authenticity_signals.find((s) => s.key === 'likeRate')
    const like = likeRateMedian(snapshot.recentItems)
    if (like !== undefined && likeSignal !== undefined && likeSignal.level !== 'unknown')
      out.like_rate = { ...like, level: likeSignal.level }
    // 一条作品都没有时不报「作品不够」：那是没存过资料，不是资料不够
    if (snapshot.recentItems.length > 0 || m.valuation.kind === 'estimated')
      out.valuation =
        m.valuation.kind === 'estimated'
          ? {
              kind: 'estimated',
              currency: 'USD',
              low_cents: m.valuation.lowCents,
              mid_cents: m.valuation.midCents,
              high_cents: m.valuation.highCents,
              median_views: m.valuation.basis.medianViews,
              items_used: m.valuation.basis.itemsUsed,
              cap_applied: m.valuation.basis.capApplied,
            }
          : {
              kind: 'insufficient',
              reason: m.valuation.reason,
              ...(m.valuation.itemsUsed === undefined ? {} : { items_used: m.valuation.itemsUsed }),
            }
    const reg = m.regularity
    if (reg !== undefined && reg.status !== 'unknown')
      out.regularity = {
        status: reg.status,
        ...(reg.avgIntervalDays === undefined
          ? {}
          : { avg_interval_days: Math.round(reg.avgIntervalDays * 10) / 10 }),
      }
  }
  return Object.keys(out).length === 0 ? undefined : out
}
