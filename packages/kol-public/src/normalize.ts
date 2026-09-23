/**
 * 入口处的那一道闸：**字段白名单 + 范围校验**。
 *
 * 一条观察进库之前要过三关，三关都是"拒"而不是"改"——
 * 悄悄纠正一条报错的数据，等于把一条错数据洗成一条看起来对的数据：
 *
 * 1. **键在不在白名单里**（`PUBLIC_OBSERVATION_FIELDS`）：多一个键就拒。
 *    正文、评论、私信、视频文案没有一个键能落进来（48 §1.3 第 4 条）；
 * 2. **类型与范围**：粉丝数是非负整数且有上限，互动率是 0–1 的小数，
 *    `observed_at` 是一个真的时间戳且不在未来；
 * 3. **渠道与 handle 的形状**：渠道只有五个，handle 去掉 `@`、小写、长度有上限。
 */
import type {
  KolChannel,
  PublicContentObservation,
  PublicCreatorObservation,
} from '@agentsws/contracts'
import {
  KOL_CHANNEL_IDS,
  MAX_CATEGORIES,
  PUBLIC_CONTENT_OBSERVATION_FIELDS,
  PUBLIC_OBSERVATION_FIELDS,
} from '@agentsws/contracts'
import { KolError } from './types.js'

/** handle 的形状：字母、数字、`.`、`_`、`-`。 */
export const HANDLE_RE = /^[a-z0-9][a-z0-9._-]{0,99}$/

/** 粉丝数的上限（地球上没有 100 亿粉的账号——超过它就是报错了）。 */
export const MAX_FOLLOWERS = 10_000_000_000

/** 近 30 天发布数的上限。 */
export const MAX_POSTS_30D = 10_000

/** 一个类目词最长多少个字。 */
export const MAX_CATEGORY_LENGTH = 40

export function assertChannel(raw: unknown): KolChannel {
  if (typeof raw === 'string' && (KOL_CHANNEL_IDS as readonly string[]).includes(raw))
    return raw as KolChannel
  throw new KolError('invalid_input', `渠道只能是这五个之一：${KOL_CHANNEL_IDS.join(' / ')}。`, {
    details: { channels: [...KOL_CHANNEL_IDS] },
  })
}

/** `@SomeCreator` → `somecreator`。形状不对就拒（不猜、不截断）。 */
export function normalizeHandle(raw: unknown): string {
  if (typeof raw !== 'string') throw new KolError('invalid_input', 'handle 要是一串字符。')
  const value = raw.trim().replace(/^@+/, '').toLowerCase()
  if (!HANDLE_RE.test(value))
    throw new KolError(
      'invalid_input',
      'handle 只能是字母、数字与 . _ -，最长 100 个字符（前面的 @ 会自动去掉）。',
    )
  return value
}

/** 邮箱：小写化 + 形状检查。**不做任何"猜测式修正"**。 */
export function normalizeEmail(raw: unknown): string {
  if (typeof raw !== 'string') throw new KolError('invalid_input', '邮箱要是一串字符。')
  const value = raw.trim().toLowerCase()
  if (value.length > 254 || !/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(value))
    throw new KolError('invalid_input', '这不像一个邮箱地址。')
  return value
}

const asFiniteNumber = (value: unknown, field: string): number => {
  const n = typeof value === 'number' ? value : Number.NaN
  if (!Number.isFinite(n)) throw new KolError('invalid_input', `${field} 要是一个数。`)
  return n
}

function categoriesOf(raw: unknown): string[] | undefined {
  if (raw === undefined) return undefined
  if (!Array.isArray(raw)) throw new KolError('invalid_input', 'categories 要是一个数组。')
  if (raw.length > MAX_CATEGORIES)
    throw new KolError('invalid_input', `categories 最多 ${MAX_CATEGORIES} 个。`)
  return raw.map((one) => {
    if (typeof one !== 'string' || one.trim() === '' || one.length > MAX_CATEGORY_LENGTH)
      throw new KolError(
        'invalid_input',
        `categories 里每一项都要是不超过 ${MAX_CATEGORY_LENGTH} 个字的词。`,
      )
    return one.trim().toLowerCase()
  })
}

/**
 * 一条观察：白名单 + 范围校验。
 *
 * `at` 是服务端的"现在"——`observed_at` 不许在它之后（一条"明天看到的"资料
 * 不是数据，是一个坏掉的钟或者一次试探）。
 */
export function parseObservation(raw: unknown, at: string): PublicCreatorObservation {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    throw new KolError('invalid_input', '每一条观察都要是一个对象。')
  const input = raw as Record<string, unknown>

  const allowed = new Set<string>(PUBLIC_OBSERVATION_FIELDS as readonly string[])
  for (const key of Object.keys(input)) {
    if (!allowed.has(key))
      throw new KolError(
        'invalid_input',
        `观察里不许有 ${key} 这个字段：公共库只收公开资料快照，正文 / 评论 / 私信一个字都不收。`,
        { details: { allowed: [...PUBLIC_OBSERVATION_FIELDS] } },
      )
  }

  const channel = assertChannel(input.channel)
  const handle = normalizeHandle(input.handle)

  const followers = asFiniteNumber(input.followers, 'followers')
  if (!Number.isInteger(followers) || followers < 0 || followers > MAX_FOLLOWERS)
    throw new KolError('invalid_input', `followers 要是 0 到 ${MAX_FOLLOWERS} 之间的整数。`)

  const posts = asFiniteNumber(input.posts_30d, 'posts_30d')
  if (!Number.isInteger(posts) || posts < 0 || posts > MAX_POSTS_30D)
    throw new KolError('invalid_input', `posts_30d 要是 0 到 ${MAX_POSTS_30D} 之间的整数。`)

  const engagement = asFiniteNumber(input.engagement_rate, 'engagement_rate')
  if (engagement < 0 || engagement > 1)
    throw new KolError(
      'invalid_input',
      'engagement_rate 是 0 到 1 之间的小数（3.1% 要写成 0.031，不是 3.1）。',
    )

  const observedAt = input.observed_at
  if (typeof observedAt !== 'string' || Number.isNaN(Date.parse(observedAt)))
    throw new KolError('invalid_input', 'observed_at 要是一个 ISO 8601 时间戳。')
  if (observedAt > at) throw new KolError('invalid_input', 'observed_at 在未来——这一条不收。')

  const language = input.language
  if (language !== undefined && (typeof language !== 'string' || language.length > 20))
    throw new KolError('invalid_input', 'language 要是一个 BCP-47 语言码。')

  const region = input.region
  if (region !== undefined && (typeof region !== 'string' || !/^[A-Za-z]{2}$/.test(region)))
    throw new KolError('invalid_input', 'region 要是两位的 ISO-3166 地区码。')

  const categories = categoriesOf(input.categories)

  return {
    channel,
    handle,
    followers,
    posts_30d: posts,
    engagement_rate: engagement,
    ...(language === undefined ? {} : { language }),
    ...(region === undefined ? {} : { region: region.toUpperCase() }),
    ...(categories === undefined ? {} : { categories }),
    observed_at: observedAt,
  }
}

/** 内容 id 的形状：平台原生 id（videoId / shortcode），不许有空白，最长 160。 */
export const CONTENT_ID_RE = /^[A-Za-z0-9._:-]{1,160}$/

/** 播放 / 点赞这类计数的上限（比地球人口多两个数量级——超过它就是报错了）。 */
export const MAX_CONTENT_COUNT = 1_000_000_000_000

/** 标题最长多少字（与本机 schema 同一顶帽子）。 */
export const MAX_CONTENT_TITLE = 300

/** 一条内容最长多少秒（24 小时的直播回放封顶）。 */
export const MAX_CONTENT_DURATION_SECONDS = 24 * 60 * 60

const optionalCount = (value: unknown, field: string): number | undefined => {
  if (value === undefined) return undefined
  const n = asFiniteNumber(value, field)
  if (!Number.isInteger(n) || n < 0 || n > MAX_CONTENT_COUNT)
    throw new KolError('invalid_input', `${field} 要是 0 到 ${MAX_CONTENT_COUNT} 之间的整数。`)
  return n
}

const optionalFlag = (value: unknown, field: string): boolean | undefined => {
  if (value === undefined) return undefined
  if (typeof value !== 'boolean')
    throw new KolError('invalid_input', `${field} 要是 true / false（没看到就别带这一格）。`)
  return value
}

/**
 * 一条内容观测（WP129）：白名单 + 范围校验，与 {@link parseObservation} 同一套"拒而不改"。
 *
 * **评论文本没有入口**：白名单里没有它，带了就整批拒——`comments` 只收一个数。
 */
export function parseContentObservation(raw: unknown, at: string): PublicContentObservation {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    throw new KolError('invalid_input', '每一条内容观测都要是一个对象。')
  const input = raw as Record<string, unknown>

  const allowed = new Set<string>(PUBLIC_CONTENT_OBSERVATION_FIELDS as readonly string[])
  for (const key of Object.keys(input)) {
    if (!allowed.has(key))
      throw new KolError(
        'invalid_input',
        `内容观测里不许有 ${key} 这个字段：公共库只收内容的公开计数，评论 / 文案 / 备注一个字都不收。`,
        { details: { allowed: [...PUBLIC_CONTENT_OBSERVATION_FIELDS] } },
      )
  }

  const channel = assertChannel(input.channel)
  const handle = normalizeHandle(input.handle)

  const externalId = input.external_id
  if (typeof externalId !== 'string' || !CONTENT_ID_RE.test(externalId))
    throw new KolError(
      'invalid_input',
      'external_id 要是平台原生的内容 id（字母、数字与 . _ : -，最长 160）。',
    )

  const contentType = input.content_type
  if (contentType !== 'video' && contentType !== 'post' && contentType !== 'reel')
    throw new KolError('invalid_input', 'content_type 只能是 video / post / reel。')

  const title = input.title
  if (
    title !== undefined &&
    (typeof title !== 'string' || title.trim() === '' || title.length > MAX_CONTENT_TITLE)
  )
    throw new KolError('invalid_input', `title 要是不超过 ${MAX_CONTENT_TITLE} 个字的标题。`)

  const publishedAt = input.published_at
  if (
    publishedAt !== undefined &&
    (typeof publishedAt !== 'string' || Number.isNaN(Date.parse(publishedAt)))
  )
    throw new KolError('invalid_input', 'published_at 要是一个 ISO 8601 时间戳。')

  let duration: number | undefined
  if (input.duration_seconds !== undefined) {
    duration = asFiniteNumber(input.duration_seconds, 'duration_seconds')
    if (duration < 0 || duration > MAX_CONTENT_DURATION_SECONDS)
      throw new KolError(
        'invalid_input',
        `duration_seconds 要在 0 到 ${MAX_CONTENT_DURATION_SECONDS} 秒之间。`,
      )
    duration = Math.round(duration)
  }

  const orientation = input.orientation
  if (orientation !== undefined && orientation !== 'landscape' && orientation !== 'portrait')
    throw new KolError('invalid_input', 'orientation 只能是 landscape / portrait。')

  const observedAt = input.observed_at
  if (typeof observedAt !== 'string' || Number.isNaN(Date.parse(observedAt)))
    throw new KolError('invalid_input', 'observed_at 要是一个 ISO 8601 时间戳。')
  if (observedAt > at) throw new KolError('invalid_input', 'observed_at 在未来——这一条不收。')

  const views = optionalCount(input.views, 'views')
  const likes = optionalCount(input.likes, 'likes')
  const comments = optionalCount(input.comments, 'comments')
  const shares = optionalCount(input.shares, 'shares')
  const paid = optionalFlag(input.paid_promotion, 'paid_promotion')
  const shoppable = optionalFlag(input.shoppable, 'shoppable')

  return {
    channel,
    handle,
    external_id: externalId,
    content_type: contentType,
    ...(title === undefined ? {} : { title: (title as string).trim() }),
    ...(publishedAt === undefined ? {} : { published_at: publishedAt as string }),
    ...(duration === undefined ? {} : { duration_seconds: duration }),
    ...(orientation === undefined ? {} : { orientation }),
    ...(views === undefined ? {} : { views }),
    ...(likes === undefined ? {} : { likes }),
    ...(comments === undefined ? {} : { comments }),
    ...(shares === undefined ? {} : { shares }),
    ...(paid === undefined ? {} : { paid_promotion: paid }),
    ...(shoppable === undefined ? {} : { shoppable }),
    observed_at: observedAt,
  }
}

/** `YYYY-MM-DD`（UTC）：日配额与日奖励按它分桶。 */
export function dayOf(at: string): string {
  return at.slice(0, 10)
}
