/**
 * 页面快照 → 上报给本机服务的那一条（WP119 定论 2）。
 *
 * 这个文件是**白名单的落点**：快照里有的格子比这里多（`links`、`recent_items`、
 * `total_views`），它们留在页面上给体检与「复制一行」用，**不往上报**。
 * 多报一格没有坏处这句话是错的：本机服务那一侧是 `.strict()`，多一个键整批拒，
 * 于是"往上报的字段"只能在这一个函数里增加，而增加时必然要改这里的注释。
 *
 * 联系方式那一格**只在用户显式收下时才有**：调用方要显式传 `contact`，
 * 而不是从快照里自动带过去。页面上读到一个邮箱与用户决定收下它，是两件事。
 */

import type { BulkCandidate } from './bulk.js'
import type { CreatorHealth } from './health.js'
import type { CreatorSnapshot } from './snapshot.js'
import type { ExtensionObservationInput } from './wire.js'

export function creatorObservation(
  snapshot: CreatorSnapshot,
  health: CreatorHealth,
  options: { contact?: { kind: 'email'; value: string; source?: string } | undefined } = {},
): ExtensionObservationInput {
  return {
    channel: snapshot.platform,
    handle: snapshot.handle ?? snapshot.external_id,
    external_id: snapshot.external_id,
    ...(snapshot.name === '' ? {} : { display_name: snapshot.name }),
    url: snapshot.page_url,
    ...(snapshot.avatar_url === undefined ? {} : { avatar_url: snapshot.avatar_url }),
    ...(snapshot.followers === undefined ? {} : { followers: snapshot.followers }),
    ...(snapshot.followers_text === undefined ? {} : { followers_text: snapshot.followers_text }),
    ...(health.avg_views === undefined ? {} : { avg_views: health.avg_views }),
    ...(snapshot.video_count === undefined ? {} : { video_count: snapshot.video_count }),
    ...(snapshot.country === undefined ? {} : { country: snapshot.country }),
    ...(snapshot.bio === undefined ? {} : { bio: snapshot.bio }),
    ...(options.contact === undefined ? {} : { contact: options.contact }),
    observed_at: snapshot.observed_at,
    page_url: snapshot.page_url,
    source: 'channel_page',
  }
}

/**
 * 搜索结果页的一条候选 → 一条观测。
 *
 * 带的是 `followers_text`（页面原文）而**不是**解析出来的 `followers`：
 * 这一批人是"扫一眼就收下的"，解析错的概率比逐个看主页高得多，
 * 而这些数会进公共红人库。让服务端拿原文自己判，错了也只错在一处。
 */
export function candidateObservation(
  candidate: BulkCandidate,
  pageUrl: string,
  now: string,
): ExtensionObservationInput {
  return {
    channel: 'youtube',
    handle: candidate.handle ?? candidate.external_id,
    external_id: candidate.external_id,
    ...(candidate.display_name === undefined ? {} : { display_name: candidate.display_name }),
    ...(candidate.url === undefined ? {} : { url: candidate.url }),
    ...(candidate.avatar_url === undefined ? {} : { avatar_url: candidate.avatar_url }),
    ...(candidate.subscriber_count_text === undefined
      ? {}
      : { followers_text: candidate.subscriber_count_text }),
    observed_at: now,
    page_url: pageUrl,
    source: 'search_results',
  }
}
