/**
 * WP405（私有 docs/107 §6 / §7，Luoye 10-19 定）：**岗位更新订阅**——工坊与云之间的约定。
 *
 * 官方持续更新的岗位内容（persona、技能、规则表、快捷问题、知识包……）在私有内容仓里审过、签名、打包，
 * 传进云上一个**不公开**的存储；订阅了「岗位更新」的公司（30 积分 / 月，按公司订，公司下所有品牌生效，
 * **不给试用**）才能下清单与文件。没订阅的人只拿得到「更新摘要」——每个岗位最近一周更新了几项、标题、
 * 有没有「急」，给岗位设定里那一行小字用，**只回标题不回正文**。
 *
 * ```
 * GET|POST|DELETE /v1/content/subscription          订阅的状态 / 开通 / 取消（令牌动作集 content）
 * GET /v1/content/official/manifest?channel=        清单（原始字节，签名就是对它签的；先查订阅，没订 402）
 * GET /v1/content/official/manifest.sig?channel=    清单签名（ed25519，base64；先查订阅）
 * GET /v1/content/official/blobs/{sha256}           一个文件（按内容哈希取；先查订阅；哈希格式不对 / 对不上 404）
 * GET /v1/content/official/summary?positions=       更新摘要（不查订阅）
 * ```
 *
 * 包格式、签名、验哈希、按段合并、退回全部照 docs/90（`content-updates.ts`）；这里只多了「按订阅放行」
 * 这一层与摘要的形状。**不做加密、不做防拷贝**（客户端是开源的，docs/107 §6）。
 */
import type { Iso8601 } from './common.js'
import type { ContentChannel, ContentManifest, LocalizedText } from './content-updates.js'
import { CONTENT_CHANNELS } from './content-updates.js'
import type { CONTENT_SERVICE_ID, SubscriptionStatus } from './subscription.js'

/** 令牌动作集（进默认集；老令牌撞上 403 `details.required_scope` 时后台自动补签）。 */
export const CONTENT_SCOPE = 'content' as const

/** 订阅那一条路（GET 状态 / POST 开通 / DELETE 取消）。 */
export const CONTENT_SUBSCRIPTION_PATH = '/v1/content/subscription'

/** 官方内容那几条路。`blobs` 是前缀，后面接 64 位小写十六进制的 sha256。 */
export const OFFICIAL_CONTENT_PATHS = {
  manifest: '/v1/content/official/manifest',
  signature: '/v1/content/official/manifest.sig',
  blobs: '/v1/content/official/blobs/',
  summary: '/v1/content/official/summary',
} as const

/** 下载回的响应头。 */
export const OFFICIAL_CONTENT_HEADERS = {
  /** 清单 / 签名：这一版清单的序号（只增）。 */
  serial: 'X-Agentsws-Content-Serial',
  /** 文件：它的 sha256（就是路径里那一串）。 */
  sha256: 'X-Agentsws-Content-Sha256',
} as const

/**
 * 云上私有存储里的键（私有内容仓的 CI 照这个传：**先文件、再签名、最后清单**——
 * 清单一换，用户下一次就照它取，文件必须已经在了）。文件按内容哈希放，同一份内容只存一次。
 */
export const OFFICIAL_CONTENT_KEYS = {
  manifest: (channel: ContentChannel): string => `${channel}/content-manifest.json`,
  signature: (channel: ContentChannel): string => `${channel}/content-manifest.json.sig`,
  blob: (sha256: string): string => `blobs/${sha256}`,
} as const

/** 摘要看最近几天（Luoye 10-19：周更）。 */
export const OFFICIAL_CONTENT_SUMMARY_DAYS = 7
/** 摘要里一个岗位最多列几条标题（条数照实给）。 */
export const OFFICIAL_CONTENT_SUMMARY_MAX_TITLES = 20
/** `positions=` 一次最多几个岗位。 */
export const OFFICIAL_CONTENT_SUMMARY_MAX_POSITIONS = 64

/** 文件路径里那一串是不是一个 sha256（64 位小写十六进制）。 */
export function isContentSha256(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value)
}

/** 渠道参数：不给 = `stable`；认不出 = `undefined`（调用方回 400）。 */
export function officialContentChannelOf(raw: string | null | undefined): ContentChannel | undefined {
  if (raw === null || raw === undefined || raw === '') return 'stable'
  return (CONTENT_CHANNELS as readonly string[]).includes(raw) ? (raw as ContentChannel) : undefined
}

/**
 * `positions=a,b,c` → 岗位 id 列表。不给 / 空 = `undefined`（全部岗位）；有一个不像岗位 id 的、
 * 或者超过 {@link OFFICIAL_CONTENT_SUMMARY_MAX_POSITIONS} 个 = `null`（调用方回 400）。
 */
export function parseContentPositionsQuery(raw: string | null | undefined): string[] | undefined | null {
  if (raw === null || raw === undefined) return undefined
  const ids = [...new Set(raw.split(',').map((p) => p.trim()).filter((p) => p !== ''))]
  if (ids.length === 0) return undefined
  if (ids.length > OFFICIAL_CONTENT_SUMMARY_MAX_POSITIONS) return null
  return ids.every((id) => /^[a-z0-9][a-z0-9._-]{0,63}$/.test(id)) ? ids : null
}

/* ------------------------------------------------------------------ */
/* 订阅                                                                 */
/* ------------------------------------------------------------------ */

/** 开通时这一次扣了哪几期（补扣落下的几期也在这里）。`ok: false` = 没扣成，进宽限。 */
export interface ContentSubscriptionCharge {
  cycle_start: Iso8601
  ok: boolean
}

/**
 * `GET / POST / DELETE /v1/content/subscription` 回的：这个公司的「岗位更新」订阅现在怎样。
 *
 * 开通时钱不够**不回 402**（与客服增值服务同一条）：订阅照开、状态进 `grace`，`charged` 里那一期 `ok: false`；
 * 充上钱下一拍自动补扣。`usable` = 现在能不能收新的更新（`active` / `cancelling`）。
 */
export interface ContentSubscriptionView {
  service_id: typeof CONTENT_SERVICE_ID
  status: SubscriptionStatus
  usable: boolean
  /** 每月多少积分（30）。 */
  credits_per_month: number
  cancel_at_period_end: boolean
  /** 当期到哪天（取消后用到这天为止）。 */
  current_cycle_end?: Iso8601
  /** 欠费宽限到哪天。 */
  grace_until?: Iso8601
  /** 只在开通那一次回：这一次扣了哪几期。 */
  charged?: ContentSubscriptionCharge[]
}

/* ------------------------------------------------------------------ */
/* 下载与摘要                                                           */
/* ------------------------------------------------------------------ */

/** 清单 / 签名的查询：哪个渠道（不给 = `stable`）。清单只给 `channel` 对得上的那一份。 */
export interface OfficialContentQuery {
  channel?: ContentChannel
}

/** 文件那一条的路径参数。 */
export interface OfficialContentBlobParams {
  /** 64 位小写十六进制（清单里每个文件的 `sha256`）。 */
  sha256: string
}

/** 摘要的查询。 */
export interface OfficialContentSummaryQuery {
  /** 逗号分隔的岗位 id（只看这几个；不给 = 全部有更新的岗位）。 */
  positions?: string
  channel?: ContentChannel
}

/** 一个岗位最近一周的更新：几项、有没有急的、标题（新的在前；**不含正文**）。 */
export interface OfficialPositionSummary {
  position_id: string
  count: number
  urgent: boolean
  titles: LocalizedText[]
}

/**
 * `GET /v1/content/official/summary` 回的。`available: false` = 云上还没开通岗位更新（存储没接 / 还没发过），
 * 那时 `positions` 是空的——界面不出那行小字，不编数字。
 */
export interface OfficialContentSummary {
  channel: ContentChannel
  available: boolean
  /** 统计窗口（最近 {@link OFFICIAL_CONTENT_SUMMARY_DAYS} 天）。 */
  since: Iso8601
  until: Iso8601
  /** 算这份摘要用的清单序号。 */
  serial?: number
  positions: OfficialPositionSummary[]
}

/**
 * 从一份清单算摘要（云端用它回 `summary`，工坊的替身也用它，两边不各写一份）。
 *
 * 一条算进一个岗位的条件：`positions` 里有这个岗位，并且 `released_at`（不写按清单的 `created_at`）
 * 落在最近 {@link OFFICIAL_CONTENT_SUMMARY_DAYS} 天里。只回标题，不回 `summary` 那句改了什么。
 */
export function summarizeOfficialContent(
  manifest: Pick<ContentManifest, 'channel' | 'serial' | 'created_at' | 'items'>,
  options: { now: Iso8601; positions?: readonly string[]; days?: number },
): OfficialContentSummary {
  const untilMs = Date.parse(options.now)
  const days = options.days ?? OFFICIAL_CONTENT_SUMMARY_DAYS
  const sinceMs = untilMs - days * 86_400_000
  const wanted = options.positions === undefined ? undefined : new Set(options.positions)
  const rows = new Map<string, { at: number; urgent: boolean; title: LocalizedText }[]>()
  for (const item of manifest.items) {
    const at = Date.parse(item.released_at ?? manifest.created_at)
    if (!Number.isFinite(at) || at < sinceMs || at > untilMs) continue
    for (const position of new Set(item.positions ?? [])) {
      if (wanted !== undefined && !wanted.has(position)) continue
      const list = rows.get(position) ?? []
      list.push({ at, urgent: item.urgent === true, title: item.title })
      rows.set(position, list)
    }
  }
  const positions: OfficialPositionSummary[] = [...rows.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([position_id, list]) => {
      list.sort((a, b) => b.at - a.at)
      return {
        position_id,
        count: list.length,
        urgent: list.some((r) => r.urgent),
        titles: list.slice(0, OFFICIAL_CONTENT_SUMMARY_MAX_TITLES).map((r) => r.title),
      }
    })
  return {
    channel: manifest.channel,
    available: true,
    since: new Date(sinceMs).toISOString(),
    until: new Date(untilMs).toISOString(),
    serial: manifest.serial,
    positions,
  }
}

/** 一个文件归哪几个岗位（运营后台「各岗位更新被下载次数」用）：清单里含这个哈希的条目的 `positions` 并起来。 */
export function positionsOfContentBlob(
  manifest: Pick<ContentManifest, 'items'>,
  sha256: string,
): string[] {
  const out = new Set<string>()
  for (const item of manifest.items)
    if (item.files.some((f) => f.sha256 === sha256)) for (const p of item.positions ?? []) out.add(p)
  return [...out].sort()
}
