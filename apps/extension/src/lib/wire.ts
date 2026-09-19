/**
 * 插件与**本机服务**之间的线上形状（WP119 定论 2）。
 *
 * 这一份必须与 `packages/api/src/routes/extension.ts` 里的 zod schema 对得上：
 * 那一侧是 `.strict()`，多一个键**整批拒**。听起来苛刻，但这正是
 * 「插件收不到正文」这条纪律唯一可执行的形式——悄悄丢掉多出来的键，
 * 等于把"有人往里塞了正文"这个信号也一起丢了。
 *
 * 插件**不认识云端**：这里没有任何一个云端地址、没有云令牌、没有 `agentsws.com`。
 * 上云（登录态默认共享到公共红人库）是本机服务那一跳做的事，插件只知道 `127.0.0.1`。
 */

import type { Platform } from './snapshot.js'

/** 一条观测。字段就是这几个——正文、评论、私信一个都没有。 */
export interface ExtensionObservationInput {
  channel: Platform
  handle: string
  external_id?: string
  display_name?: string
  url?: string
  avatar_url?: string
  followers?: number
  /** 页面上原样那串。**解析出来的数不算数，这串才算**。 */
  followers_text?: string
  avg_views?: number
  video_count?: number
  country?: string
  bio?: string
  /** 用户显式点过「收下这个邮箱」才有。 */
  contact?: { kind: 'email' | 'dm' | 'phone' | 'form'; value: string; source?: string }
  observed_at: string
  page_url?: string
  source: 'channel_page' | 'content_page' | 'search_results'
}

export interface ExtensionIngestRow {
  handle: string
  status: 'ok' | 'deduped' | 'invalid'
  creator_id?: string
  reason?: string
}

export interface ExtensionIngestResult {
  rows: ExtensionIngestRow[]
  /** 这一批里有几条同时转发去了公共红人库（未登录 = 0）。 */
  forwarded_to_public_library: number
}

/** 插件开屏那一行要的全部事实。 */
export interface ExtensionHello {
  workspace_id: string
  workspace_name: string
  /** 关联了云账号 = 观测默认共享到公共红人库。 */
  cloud_linked: boolean
  shares_to_public_library: boolean
  scopes: string[]
  server_version: string
}

export interface RedeemedToken {
  token: string
  token_id: string
  workspace_id: string
  scopes: string[]
  expires_at: string
}

/** 一次调用的结局。**三种，不是两种**——「应用没开」要与「令牌不对」分开说。 */
export type LocalCallResult<T> =
  | { ok: true; data: T }
  | { ok: false; kind: 'offline'; message: string }
  | { ok: false; kind: 'unauthorized'; message: string }
  | { ok: false; kind: 'error'; message: string }

/** 「桌面应用没开」那一句。卡片上要能直接印出来。 */
export const OFFLINE_MESSAGE =
  'Agents 工坊没在运行，先收进插件里排着。等你打开应用，它会自己补上去。'

/** 「配对失效了」那一句。 */
export const UNAUTHORIZED_MESSAGE =
  '这把配对已经不能用了（可能在工作台撤掉了，或者过期了）。去「连接 → 浏览器插件」重新配一次。'
