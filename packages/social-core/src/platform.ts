/**
 * WP191（docs/86 §1.4 / §3）：**各平台的硬限制，一张表**。
 *
 * 学的是 Mixpost（MIT）与 Postiz（AGPL-3.0，只学思路、一行代码没搬）的建模方式：
 * 平台限制写成一张声明式表，而不是散在各个适配器里——起草那一跳先量一遍、
 * 日历按渠道取每日上限、适配器发之前再拦一次，三处读的是同一份数。
 *
 * 数字的出处都在 docs/86 §1.3（2026-09-29 核过的官方页），每一格的注释写来源；
 * 官方页上没核到的那一格**不填**——宁可不拦，也不拿一个编的数去拦人。
 *
 * `max_posts_per_day` 与职责 yml 上 `stage_post` 的 `max_posts_per_day` 是
 * **同一个数的两个位置**（同 `calendar.ts` 的 `SCHEDULE_RULES`）：这边排的时候
 * 提前说，那边提交的时候真拦。`packages/roles` 的测试钉住两边一致。
 */

import type { SocialChannel } from '@agentsws/contracts'
import { SCHEDULE_RULES, type ScheduleRules } from './calendar.js'

export interface PlatformLimits {
  /** 正文最多多少字（按 JS 字符串长度量；平台按字节量的在注释里说）。 */
  max_chars?: number
  /** 话题标签（`#xxx`）最多几个。 */
  max_hashtags?: number
  /** `@` 最多几个。 */
  max_mentions?: number
  /** 链接最多几个。 */
  max_links?: number
  /** 轮播最多几张。 */
  max_carousel_items?: number
  /**
   * 一个号一天最多排几条（**我们的**上限，不是平台的：平台的硬上限远高于它，
   * 这条线是"别把关注的人刷走"，docs/86 §2 规律 1）。
   */
  max_posts_per_day: number
}

/**
 * 内容账号组各渠道的限制（社群组不在这里：群发与私信的额度在职责 yml 与
 * `broadcast.ts` 里，那是另一件事）。没列的渠道按 {@link SCHEDULE_RULES} 的默认。
 */
export const PLATFORM_LIMITS: Readonly<Partial<Record<SocialChannel, PlatformLimits>>> = {
  // 老渠道（已拆成 FB + IG，docs/86 §6）：迁移前的老帖子仍按原来那条线排
  meta: { max_posts_per_day: 3 },
  // TikTok Content Posting API：标题最多 2,200 个 UTF-16 字符（接口文档 `post_info.title`）
  tiktok: { max_chars: 2200, max_posts_per_day: 3 },
  // X：一条 280 字（Premium 长帖不能排期，所以我们只按 280 排，docs/86 §3.2）
  x: { max_chars: 280, max_posts_per_day: 5 },
  // YouTube：标题 100 字、描述 5,000 字；这里量的是描述（标题在卡面上单列）
  youtube: { max_chars: 5000, max_posts_per_day: 2 },
  // Facebook 主页：官方页没给出正文上限（Postiz 取 63,206、Mixpost 取 5,000，都未经官方核实）→ 不填
  facebook: { max_posts_per_day: 2 },
  // Instagram：配文 2,200 字、30 个话题标签、20 个 @；API 轮播最多 10 张
  instagram: {
    max_chars: 2200,
    max_hashtags: 30,
    max_mentions: 20,
    max_carousel_items: 10,
    max_posts_per_day: 3,
  },
  // Threads：正文 500 字（按 UTF-8 字节量 emoji）、最多 5 个链接、一个话题标签、轮播 2–20 张
  threads: {
    max_chars: 500,
    max_links: 5,
    max_hashtags: 1,
    max_carousel_items: 20,
    max_posts_per_day: 3,
  },
  // LinkedIn：正文 3,000 字（LinkedIn 帮助中心口径；Postiz 同值）
  linkedin: { max_chars: 3000, max_posts_per_day: 1 },
}

/** 这条渠道的排期规则（日历撞车判据按渠道取每日上限）。 */
export function scheduleRulesFor(channel: SocialChannel | string): ScheduleRules {
  const limits = PLATFORM_LIMITS[channel as SocialChannel]
  return limits === undefined
    ? SCHEDULE_RULES
    : { ...SCHEDULE_RULES, max_per_day: limits.max_posts_per_day }
}

/** 一处超限（`message` 是给人看的一句话，原样上卡）。 */
export interface PostTextProblem {
  kind: 'too_long' | 'too_many_hashtags' | 'too_many_mentions' | 'too_many_links'
  limit: number
  actual: number
  message: string
}

const count = (text: string, re: RegExp): number => (text.match(re) ?? []).length

/**
 * 发之前量一遍正文。**只量，不改**：删哪几个标签、从哪儿截断是人的决定。
 *
 * 没列限制的渠道回空数组（不是"通过"——是"我们不知道它的上限"，所以不拦）。
 */
export function checkPostText(channel: SocialChannel | string, text: string): PostTextProblem[] {
  const limits = PLATFORM_LIMITS[channel as SocialChannel]
  if (limits === undefined) return []
  const out: PostTextProblem[] = []
  const chars = [...text].length
  if (limits.max_chars !== undefined && chars > limits.max_chars)
    out.push({
      kind: 'too_long',
      limit: limits.max_chars,
      actual: chars,
      message: `这条有 ${chars} 个字，这个平台一条最多 ${limits.max_chars} 个字——要删一点或拆成两条。`,
    })
  const tags = count(text, /(^|\s)#[^\s#]+/gu)
  if (limits.max_hashtags !== undefined && tags > limits.max_hashtags)
    out.push({
      kind: 'too_many_hashtags',
      limit: limits.max_hashtags,
      actual: tags,
      message: `话题标签有 ${tags} 个，这个平台最多 ${limits.max_hashtags} 个。`,
    })
  const mentions = count(text, /(^|\s)@[\w.]+/gu)
  if (limits.max_mentions !== undefined && mentions > limits.max_mentions)
    out.push({
      kind: 'too_many_mentions',
      limit: limits.max_mentions,
      actual: mentions,
      message: `@ 了 ${mentions} 个人，这个平台最多 ${limits.max_mentions} 个。`,
    })
  const links = count(text, /https?:\/\/\S+/gu)
  if (limits.max_links !== undefined && links > limits.max_links)
    out.push({
      kind: 'too_many_links',
      limit: limits.max_links,
      actual: links,
      message: `放了 ${links} 个链接，这个平台一条最多 ${limits.max_links} 个。`,
    })
  return out
}
