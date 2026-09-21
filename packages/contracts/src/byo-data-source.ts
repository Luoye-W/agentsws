/**
 * WP126：**用户自带数据接口**的公开约定（只加不删）。
 *
 * 一句话：任何能按下面四个端点形状回 JSON 的 HTTP 服务，都可以当某条渠道的
 * 数据接口挂进 Agents 工坊。适配器跑在**本机**，走用户自己的额度，不扣积分。
 *
 * 纪律（Luoye 09-19 定）：
 *
 * 1. **不做任何平台预设**：界面、文档、示例、注释里不出现任何第三方数据平台的
 *    名字，也不告诉用户市面上有哪些这类服务。这里只有一份通用格式——
 *    能照着实现这个格式的服务都能接，接的是什么由用户自己决定。
 * 2. **归一化形状**：四个端点回的都是本仓已有的归一化对象（红人 / 指标 / 内容 /
 *    联系方式），不是各平台的原始响应。翻译成本在服务那一侧，不在工坊这一侧。
 * 3. **鉴权就一种**：`Authorization: Bearer <密钥>`。密钥在连接卡上填，
 *    落本机加密库，不落明文配置。
 * 4. **错误也是 JSON**：非 2xx 回 `{ code, message }`，`message` 是一句给人看的
 *    话（限流 / 超时 / 密钥不对……本机适配器会把它原样带给人，不吞、不编）。
 *
 * 参考实现（假数据、可运行）：`examples/byo-data-source/server.mjs`。
 */

import type { Iso8601 } from './common.js'
import type { KolChannel } from './kol.js'

/** 四个动作各一个端点（挂在用户的服务地址后面）。 */
export type ByoDataSourceAction = 'search' | 'profile' | 'audit' | 'contacts'

/** 全部端点的公共前缀约定：`<服务地址>/byo/v1`。 */
export const BYO_DATA_SOURCE_PREFIX = '/byo/v1'

/** 四个动作的路径（相对 `BYO_DATA_SOURCE_PREFIX`）。 */
export const BYO_DATA_SOURCE_PATHS: Record<ByoDataSourceAction, string> = {
  search: '/search',
  profile: '/profile',
  audit: '/audit',
  contacts: '/contacts',
}

/* ------------------------------------------------------------------ */
/* 归一化对象                                                          */
/* ------------------------------------------------------------------ */

/** 一条归一化的红人（search / profile 回它）。 */
export interface ByoCreator {
  channel: KolChannel
  /** 平台上的账号名（不带 @）。 */
  handle: string
  display_name: string
  /** 主页地址（完整 URL）。 */
  url: string
  followers?: number
  /** 互动率（0–1 的小数，例如 0.035 = 3.5%）。 */
  engagement_rate?: number
  category?: string
  language?: string
  /** 两位国家 / 地区码（大写）。 */
  region?: string
  /** 这份数据是什么时候看到的（ISO 8601）。 */
  observed_at: Iso8601
}

/** 一条归一化的内容指标（audit 回它）。 */
export interface ByoContentMetric {
  /** 内容 id（服务那一侧自己的命名空间）。 */
  id: string
  kind: 'video' | 'post' | 'story' | 'reel' | 'thread' | 'live'
  published_at: Iso8601
  views?: number
  likes?: number
  comments?: number
  shares?: number
}

/** 一条归一化的联系方式（contacts 回它）。 */
export interface ByoContact {
  kind: 'email' | 'dm' | 'form' | 'phone'
  /** 明文只在这一次响应里出现；工坊那一侧落本机加密库。 */
  value: string
  /** 服务那一侧说这是从哪儿看到的（自由文本，例如「主页公开邮箱」）。 */
  source?: string
}

/* ------------------------------------------------------------------ */
/* 四个端点的请求 / 返回形状                                           */
/* ------------------------------------------------------------------ */

/** `POST /byo/v1/search` 的请求体。 */
export interface ByoSearchRequest {
  channel: KolChannel
  /** 关键词；空串 = 这条渠道上都算候选。 */
  q?: string
  limit?: number
  min_followers?: number
  max_followers?: number
}

/** `POST /byo/v1/search` 的返回。搜到 0 条回空数组，不是错误。 */
export interface ByoSearchResponse {
  creators: ByoCreator[]
}

/** `POST /byo/v1/profile` 的请求体。 */
export interface ByoProfileRequest {
  channel: KolChannel
  handle: string
}

/** `POST /byo/v1/profile` 的返回。查无此人回 404（`{ code: 'not_found' }`）。 */
export interface ByoProfileResponse {
  creator: ByoCreator
  /** 最近的内容指标（最多 30 条，新的在前）。 */
  recent_content?: ByoContentMetric[]
}

/** `POST /byo/v1/audit` 的请求体。 */
export interface ByoAuditRequest {
  channel: KolChannel
  handle: string
}

/** `POST /byo/v1/audit` 的返回。样本不够就 `insufficient_samples: true`，不编数。 */
export interface ByoAuditResponse {
  creator: ByoCreator
  sample_size: number
  insufficient_samples: boolean
  /** 粉丝真实度估计（0–1）。样本不够就没有。 */
  follower_authenticity?: number
  /** 互动率分位（0–100）。样本不够就没有。 */
  engagement_percentile?: number
  /** 机器可读的风险标记（与工坊体检报告同一套词）。 */
  risk_flags: string[]
  note?: string
}

/** `POST /byo/v1/contacts` 的请求体。 */
export interface ByoContactsRequest {
  channel: KolChannel
  handle: string
}

/** `POST /byo/v1/contacts` 的返回。没有联系方式回空数组（不是错误）。 */
export interface ByoContactsResponse {
  contacts: ByoContact[]
}

/** 连不上 / 回得不对时，服务那一侧的错误体（非 2xx）。 */
export interface ByoErrorResponse {
  /** `invalid_input` / `not_found` / `rate_limited` / `unauthorized` / `internal`。 */
  code: string
  /** 一句给人看的话。 */
  message: string
}

/* ------------------------------------------------------------------ */
/* JSON Schema（给想自己实现一份服务的人；与上面四个接口逐字对应）        */
/* ------------------------------------------------------------------ */

/** search 端点的返回 Schema（其余端点同构，完整版见 docs/75）。 */
export const BYO_SEARCH_RESPONSE_SCHEMA = {
  type: 'object',
  required: ['creators'],
  properties: {
    creators: {
      type: 'array',
      items: {
        type: 'object',
        required: ['channel', 'handle', 'display_name', 'url', 'observed_at'],
        properties: {
          channel: { type: 'string', enum: ['youtube', 'instagram', 'tiktok', 'facebook', 'x'] },
          handle: { type: 'string' },
          display_name: { type: 'string' },
          url: { type: 'string', format: 'uri' },
          followers: { type: 'number' },
          engagement_rate: { type: 'number', minimum: 0, maximum: 1 },
          category: { type: 'string' },
          language: { type: 'string' },
          region: { type: 'string', minLength: 2, maxLength: 2 },
          observed_at: { type: 'string', format: 'date-time' },
        },
      },
    },
  },
} as const
