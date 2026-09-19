/**
 * 页内即时体检（WP119 定论 5：**与 KOLAgents 同输入同输出**）。
 *
 * 这是插件里唯一一块「不登录也能用」的判断：两个比值、一条买粉守卫、四档结论。
 * 它**不联网、不问本机服务、不问云**——用户在 YouTube 页面上按一下，
 * 答案就在页面上，这一条是整个插件存在的理由。
 *
 * 三个不能动的地方（动了就不是「同输出」了）：
 *
 * 1. **买粉守卫优先于所有档位**。粉丝 ≥ 10,000 且播放/粉丝 < 2% → 直接
 *    `suspicious`，不再去看它够不够 `excellent`。
 * 2. **粉丝不到 1 万的账号永远不会被判 `suspicious`**。小号播放低是常态，
 *    把它染红等于让这个功能天天喊狼来了。
 * 3. **频道档与单条档的阈值不一样**：频道是 10% / 3%，单条是 100% / 10% / 2%。
 *    单条可以远远超过频道均值（一条爆款打到粉丝数的十倍很常见），
 *    用同一套阈值会把所有爆款都算成"正常"。
 *
 * 另外：**本地档不出总分**。两个从页面上派生的比值不配当一个 0–100 的
 * headline 分——那个数要有历史快照才算得准，而历史快照是云端公共库的事。
 */

import { averageItemViews, type ContentSnapshot, type CreatorSnapshot } from './snapshot.js'

/** 粉丝到了这个数，才开始看「是不是买的」。 */
export const BOUGHT_AUDIENCE_MIN_FOLLOWERS = 10_000

/** 播放/粉丝低于这个数（且粉丝够多）就是可疑。 */
export const BOUGHT_AUDIENCE_RATIO = 0.02

/** 频道档：≥ 这个数是「很好」。 */
export const CREATOR_EXCELLENT_RATIO = 0.1

/** 频道档：≥ 这个数是「正常」。 */
export const CREATOR_NORMAL_RATIO = 0.03

/** 单条档：≥ 1 倍粉丝数是「爆了」。 */
export const CONTENT_VIRAL_RATIO = 1

/** 单条档：≥ 10% 是「不错」。 */
export const CONTENT_GOOD_RATIO = 0.1

/** 单条档：≥ 2% 是「正常」。 */
export const CONTENT_NORMAL_RATIO = 0.02

export type HealthVerdict = 'excellent' | 'normal' | 'weak' | 'suspicious' | 'unknown'

export interface CreatorHealth {
  /** 平均播放 ÷ 粉丝数。算不出来就没有这一格（不是 0）。 */
  views_to_followers?: number | undefined
  /** 平均播放（体检顺手算出来的，导出那一行也用它）。 */
  avg_views?: number | undefined
  bought_audience_suspected: boolean
  verdict: HealthVerdict
}

export type ContentVerdict = 'viral' | 'good' | 'normal' | 'below' | 'unknown'

export interface ContentHealth {
  views_to_followers?: number | undefined
  /** 点赞 ÷ 播放。即使 verdict 是 `unknown` 也照给——它自己就有意义。 */
  engagement_rate?: number | undefined
  verdict: ContentVerdict
}

/**
 * 频道档体检。
 *
 * `avg_views` 由 {@link averageItemViews} 从近期作品里算；调用方也可以直接给
 * （YouTube 的「关于」页有总播放与视频数时更准）。
 */
export function computeCreatorHealth(
  snapshot: Pick<CreatorSnapshot, 'followers' | 'recent_items'> & {
    avg_views?: number | undefined
  },
): CreatorHealth {
  const followers = snapshot.followers
  const avgViews = snapshot.avg_views ?? averageItemViews(snapshot.recent_items)

  if (
    followers === undefined ||
    followers <= 0 ||
    avgViews === undefined ||
    !Number.isFinite(avgViews) ||
    avgViews <= 0
  ) {
    return { avg_views: avgViews, bought_audience_suspected: false, verdict: 'unknown' }
  }

  const ratio = avgViews / followers
  // 顺序是硬的：守卫先答，档位后答。
  const suspected = followers >= BOUGHT_AUDIENCE_MIN_FOLLOWERS && ratio < BOUGHT_AUDIENCE_RATIO

  const verdict: HealthVerdict = suspected
    ? 'suspicious'
    : ratio >= CREATOR_EXCELLENT_RATIO
      ? 'excellent'
      : ratio >= CREATOR_NORMAL_RATIO
        ? 'normal'
        : 'weak'

  return {
    views_to_followers: ratio,
    avg_views: avgViews,
    bought_audience_suspected: suspected,
    verdict,
  }
}

/** 单条内容档体检。 */
export function computeContentHealth(snapshot: ContentSnapshot): ContentHealth {
  const views = snapshot.views
  const followers = snapshot.author.followers
  const engagement =
    snapshot.likes !== undefined && views !== undefined && views > 0
      ? snapshot.likes / views
      : undefined

  if (views === undefined || views <= 0 || followers === undefined || followers <= 0) {
    return { engagement_rate: engagement, verdict: 'unknown' }
  }

  const ratio = views / followers
  const verdict: ContentVerdict =
    ratio >= CONTENT_VIRAL_RATIO
      ? 'viral'
      : ratio >= CONTENT_GOOD_RATIO
        ? 'good'
        : ratio >= CONTENT_NORMAL_RATIO
          ? 'normal'
          : 'below'

  return { views_to_followers: ratio, engagement_rate: engagement, verdict }
}

/** 比值 → `12.3%`。算不出来是 `-`，不是 `0.0%`。 */
export function formatRatioPercent(ratio: number | undefined): string {
  if (ratio === undefined || !Number.isFinite(ratio)) return '-'
  return `${(ratio * 100).toFixed(1)}%`
}

/** 四档结论的人话（卡片上那一行）。 */
export const CREATOR_VERDICT_TEXT: Record<HealthVerdict, string> = {
  excellent: '播放撑得住粉丝数，状态很好',
  normal: '播放与粉丝数对得上，正常',
  weak: '播放明显低于粉丝数，先看看内容对不对路',
  suspicious: '粉丝不少但几乎没人看——这个量级的账号出现这种比例，多半是买的',
  unknown: '这一页上没印够数字，算不了',
}

export const CONTENT_VERDICT_TEXT: Record<ContentVerdict, string> = {
  viral: '播放超过了粉丝总数，这条出圈了',
  good: '播放跑赢了自己的盘子',
  normal: '正常水平',
  below: '播放低于这个账号的常态',
  unknown: '这一页上没印够数字，算不了',
}
