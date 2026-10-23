/** 移植自 agentsws-extension `src/lib/kol/bulkWire.ts` @ 57fca9c（源自 KOLAgents 旧插件 d25b877）。决策 1739 A：只搬采集器与指标算法；开源仓这一份只改 import 路径（与注释里点名私有插件 / 模板的几个词），本体逐字不动。 */
/**
 * 批量采集那条线的**数据形状**。
 *
 * 移植自 KOLAgents 浏览器插件 `src/lib/pluginApi.ts` @ f0de89a（第 297–392 行那
 * 四个 type 与一个常量，逐字照抄）。旧仓它们住在云端 API 客户端里；这里单独一个
 * 文件，因为**传输方式换了**：插件不再直连旧云端，而是把批量观测交给
 * 本机服务（`src/lib/local-client.ts` 的 `ingest()`），令牌来自配对。
 *
 * 没有搬过来的两样（都是云端传输的细节，与形状无关）：
 * - `BulkObservationPayload`：那是 POST /api/plugin/public/observations/bulk 的
 *   请求体，带 `organizationId` / `autoScore`。新架构里"这批算哪个工作区"由配对
 *   令牌在本机服务那头决定，插件不自报；请求体按 `src/lib/wire.ts` 拼。
 * - `pluginFetch()` 与 API Key 那一套：换成配对 + 本机服务（WP119 定论 2）。
 *
 * `bulkCapture.ts`（节奏与计数）只依赖这里，于是它仍然是纯函数、仍然可测。
 */

/**
 * One creator on a search-results page, as the plugin saw it (P4).
 *
 * Everything but `externalId` is optional because everything but the identity
 * is optional ON THE PAGE: a channel card carries an avatar and a subscriber
 * line, a video's byline carries a name and a link and nothing else. Sending
 * the fields we do not have as empty strings would teach the library that we
 * looked and found nothing, which is a different claim from not having looked.
 */
export type BulkObservationItem = {
  /** UC id when the page linked one, otherwise the @handle. */
  externalId: string
  handle?: string
  displayName?: string
  url?: string
  avatarUrl?: string
  /** The subscriber line AS RENDERED ("3.5M subscribers") — never parsed here. */
  subscriberCountText?: string
  videoCountText?: string
  /**
   * The videos this creator was seen with on the page, at most five (0.9.17).
   *
   * A search page is mostly video results and several of them belong to one
   * creator, so the identity is one row and the videos are its evidence. Same
   * discipline as the count strings above: `viewsText` and `durationText` go
   * up EXACTLY as rendered, and nothing here is parsed on the way out.
   */
  videos?: BulkVideoEvidence[]
  /**
   * How close the pre-screen judged this row to the seed, 0–100 (0.9.18).
   *
   * Only ever present on a `watch_related` batch, and only when the seed had a
   * signature to score against — an unscored row sends NOTHING rather than a
   * zero, because "we could not judge" and "we judged this irrelevant" are
   * different facts and the inbox sinks rows on the second one.
   */
  relevanceScore?: number
  rawSignals?: Record<string, unknown>
}

export type BulkVideoEvidence = {
  /** YouTube's own id: `v=` on a watch URL, the path on `/shorts/<id>`. */
  contentId: string
  url?: string
  title?: string
  viewsText?: string
  durationText?: string
  /** True for a /shorts/ URL or a Shorts badge. Absent is not false. */
  isShort?: boolean
  /**
   * WP130 补搬（旧仓 `pluginApi.ts` @ 6259a1c）：
   * TikTok 图文 / Instagram 帖子或 Reel。YouTube 不带。
   */
  contentType?: "post" | "reel"
}

/**
 * Per-item outcome. `capped` is not a failure — it means the daily allowance
 * ran out mid-batch and the row was refused rather than stored, and the panel
 * says so with the counts below rather than with an error.
 */
export type BulkObservationStatus = "ok" | "deduped" | "capped" | "invalid"

export type BulkObservationResult = {
  results: Array<{ externalId: string; status: BulkObservationStatus }>
  capturedToday?: number
  dailyLimit?: number
  scoredCount?: number
  scoreCreditsCharged?: number
  /**
   * WP130（本仓加，旧仓没有）：这一批顺手记下的内容观测条数——列表上
   * 每位红人带着的视频 / 帖子（有标题的那些）。0 或没有这一格 = 没记。
   */
  contentsObserved?: number
  /**
   * WP131（本仓加，旧仓没有）：本机服务发的这次采集的批次 id（`bt_…`）。第一块拿到、
   * 后几块带回去；「回作战室看这批」深链拿它筛。老服务不回。
   */
  batchId?: string
  /**
   * WP131（本仓加）：采集后自动评分的排队回执——评分在本机服务里**排队异步跑**，
   * 所以这里只有「排了几位、其中几位会体检、最多约多少积分」，没有旧云端那种当场的
   * `scoredCount`。开关关着没有这一格。
   */
  autoScore?: { queued: number; audits: number; creditsEstimate: number }
}

/** Server-side cap on one request's `items`; the UI chunks well below it. */
export const BULK_OBSERVATION_ITEM_LIMIT = 100
