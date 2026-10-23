/**
 * 一次「读一页」的结果 → 要交给本机服务 `ingest` 的那几批（WP496）。
 *
 * 顺序与分批照私有插件面板做的那几步（新写的接线，换形全用 `observations.ts` 里照搬来的那几个函数）：
 *
 * - **主页**：主页卡读到快照 → 用看过的链接页把 link-in-bio 展开（`expandBioLinks`）→ YouTube 补上过完人机验证后
 *   弹出来的商务邮箱（已在页面里做了）→ 一条观测（`toObservationPayload` + `publicContactsOfProfile`）。
 *   插件面板稳定后最后一次同步的就是这一条。
 * - **内容页**：`toContentObservationPayload` → 内容观测（认不出作者的不报，同插件）。
 * - **链接页**：`toBioLinkObservationPayload` → 链接页观测。
 * - **列表页**：每个候选 `toBulkObservationItem` → 按 20 个一块（`chunkItems`）→ 每块一批观测 + 这一块里红人带着的内容观测。
 *   插件里是人点「采集」时勾着的那些（缺省全勾）；这里是全部（AI 想挑人，就只把要的那几页交过来）。
 */
import { type CachedBioLink, expandBioLinks } from '../kol/bioLinkCache.js'
import { chunkItems, toBulkObservationItem } from '../kol/bulkCapture.js'
import { type BioLinkSnapshot, toBioLinkObservationPayload } from '../kol/utils/bioLink.js'
import { toContentObservationPayload } from '../kol/utils/contentSnapshot.js'
import { type CreatorSnapshot, toObservationPayload } from '../kol/utils/creatorSnapshot.js'
import type { PageCapture } from '../page/capture.js'
import {
  type BioLinkObservationBody,
  bioLinkObservationBodyOf,
  type CaptureObservation,
  type ContentObservationBody,
  contentObservationBodyOf,
  creatorObservationOf,
  listContentBodiesOf,
  listObservationsOf,
} from './observations.js'
import { publicContactsOfProfile } from './publicContacts.js'

export interface IngestPlan {
  /** 主页那一条（展开过 link-in-bio 的快照），没有就是 `undefined`。 */
  creator?: CreatorSnapshot
  /** 一批一批的观测（主页：一批一条；列表：20 条一批）。 */
  observation_batches: CaptureObservation[][]
  content_observations: ContentObservationBody[]
  bio_link_observations: BioLinkObservationBody[]
}

export interface IngestPlanOptions {
  /** 「现在」（列表那一批的观测时间、内容观测的采集时间）。 */
  now: string
  /** 同一趟里顺手读到的链接页（展开主页上的 link-in-bio，与插件「看过就记住」那份缓存同一个用法）。 */
  bio_links?: readonly BioLinkSnapshot[]
}

export function ingestPlanOf(capture: PageCapture, options: IngestPlanOptions): IngestPlan {
  const plan: IngestPlan = {
    observation_batches: [],
    content_observations: [],
    bio_link_observations: [],
  }

  if (capture.creator) {
    const cached: CachedBioLink[] = (options.bio_links ?? []).map((snapshot) => ({
      snapshot,
      cachedAt: options.now,
    }))
    let snap = capture.creator
    const expanded = expandBioLinks(snap.links, cached)
    if (expanded.length !== snap.links.length) snap = { ...snap, links: expanded }
    plan.creator = snap
    plan.observation_batches.push([
      creatorObservationOf(toObservationPayload(snap), publicContactsOfProfile(snap)),
    ])
  }

  if (capture.content) {
    const payload = toContentObservationPayload(capture.content)
    if (payload) plan.content_observations.push(contentObservationBodyOf(payload))
  }

  if (capture.bio_link) {
    plan.bio_link_observations.push(
      bioLinkObservationBodyOf(toBioLinkObservationPayload(capture.bio_link)),
    )
  }

  if (capture.list && capture.list.candidates.length > 0) {
    const { target } = capture.list
    const items = capture.list.candidates.map(toBulkObservationItem)
    for (const chunk of chunkItems(items)) {
      const batch = {
        platform: target.platform,
        sourceQuery: target.sourceQuery,
        pageType: target.pageType,
        items: chunk,
      }
      plan.observation_batches.push(listObservationsOf(batch, options.now))
      plan.content_observations.push(...listContentBodiesOf(batch, options.now))
    }
  }

  return plan
}
