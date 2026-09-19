/**
 * 插件在页面上看到的那一份快照（WP119 / 68）。
 *
 * 这是**整个插件唯一的数据形状**：解析器往里填，体检 / 导出 / 上报从里面读。
 * 三条纪律写在类型里，不写在注释里：
 *
 * 1. **没有正文**。没有 `description`、没有 `comments`、没有 `transcript`——
 *    插件收的是"这个账号公开印在页面上的数字与身份"，不是内容。
 *    公共红人库那一侧的白名单（`PUBLIC_OBSERVATION_FIELDS`）比这里还窄，
 *    所以这里多出来的几格（`bio` / `links`）只留在本机。
 * 2. **数字可以是 `undefined`，但不能是 0 充数**。页面上没印订阅数
 *    （视频 byline 本来就没有）跟"这个人有 0 个订阅"是两件事，
 *    混起来会让阈值筛选把最该发现的人滤掉。
 * 3. **原始文本与解析结果并存**。`followers_text` 是页面上那串
 *    （`1.2万位订阅者`），`followers` 是本机解析出来的数。上报到公共库时
 *    带的是**文本**，解析错了不会污染共享库。
 */

/** 这一版插件认的三个平台。加第四个要同时改 manifest 的 host_permissions。 */
export type Platform = 'youtube' | 'instagram' | 'tiktok'

export const PLATFORM_NAMES: Record<Platform, string> = {
  youtube: 'YouTube',
  instagram: 'Instagram',
  tiktok: 'TikTok',
}

/** 近期作品里的一条。`views` 缺席 = 页面没印，不是 0。 */
export interface RecentItem {
  content_id: string
  title?: string | undefined
  url?: string | undefined
  views?: number | undefined
  likes?: number | undefined
  comments?: number | undefined
  published_at?: string | undefined
  published_text?: string | undefined
}

/** 频道 / 主页上抓到的一份。 */
export interface CreatorSnapshot {
  platform: Platform
  /** 平台自己的 id（YouTube 的 `UC…`、IG 的数字 id、TikTok 的 handle）。 */
  external_id: string
  /** 带 `@` 的 handle（YouTube 保留前导 `@`）。 */
  handle?: string | undefined
  name: string
  avatar_url?: string | undefined
  page_url: string
  followers?: number | undefined
  /** 页面上原样那串。上报公共库带的是它。 */
  followers_text?: string | undefined
  video_count?: number | undefined
  total_views?: number | undefined
  country?: string | undefined
  joined_date?: string | undefined
  bio?: string | undefined
  /** 「关于」页上**用户点开之后**才读得到的那个邮箱。不点不读。 */
  business_email?: string | undefined
  /** 外链（其它平台主页、官网）。只留 href，不留锚文本。 */
  links: string[]
  recent_items: RecentItem[]
  observed_at: string
}

/** 单条内容页（视频 / 帖子）上抓到的一份。 */
export interface ContentSnapshot {
  platform: Platform
  content_id: string
  title?: string | undefined
  url: string
  thumbnail_url?: string | undefined
  published_at?: string | undefined
  published_text?: string | undefined
  views?: number | undefined
  likes?: number | undefined
  comments?: number | undefined
  shares?: number | undefined
  duration_seconds?: number | undefined
  orientation?: 'portrait' | 'landscape' | undefined
  author: {
    external_id?: string | undefined
    handle?: string | undefined
    name?: string | undefined
    followers?: number | undefined
    url?: string | undefined
  }
  observed_at: string
}

/**
 * 近期作品的平均播放。
 *
 * 只数**页面上真印了播放数**的那几条（`undefined` 不当 0），一条都没有就回
 * `undefined`——"算不出来"与"平均 0 次播放"必须长得不一样。
 */
export function averageItemViews(items: readonly RecentItem[]): number | undefined {
  const views = items
    .map((i) => i.views)
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
  if (views.length === 0) return undefined
  return Math.round(views.reduce((a, b) => a + b, 0) / views.length)
}
