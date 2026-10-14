/**
 * WP328：插件 ↔ 本机服务的「Reddit 只读」通道（线上形状）。路由在
 * `packages/api/src/routes/reddit-watch.ts`。还是**插件主动找本机**：插件定时来问有没有要读的，
 * 读完把条目交回；本机服务永远不能直接伸手进浏览器。
 */

import type { RedditReadJob, RedditReadJobResult } from './runner.js'

/**
 * 插件领活：`GET /v1/extension/reddit/next?connected=1`。
 * `connected=0` = 插件配着对、但还没连 Reddit（没给站点权限）——本机据此出连接卡，不发活。
 */
export interface RedditReadNextResponse {
  job?: RedditReadJob
  /** 多久再来问（毫秒）。 */
  retry_after_ms: number
}

/** 插件交回：`POST /v1/extension/reddit/:id/result`。 */
export type RedditReadResultInput = RedditReadJobResult

/** 一件活最多带几路、一路最多交回几条（防止一次塞爆本机）。 */
export const REDDIT_READ_MAX_PARTS = 12
export const REDDIT_READ_MAX_ITEMS_PER_PART = 500
