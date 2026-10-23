/**
 * WP496（决策 1738 / 1739 A）：**ego 路采集红人，与插件同一套**。
 *
 * 插件路：用户在自己的 Chrome 里开着红人主页 / 视频页 / 列表页 / Linktree，插件的采集器读出快照，
 * 面板把它换成请求体交给本机服务（`/v1/extension/observations` 等）。
 *
 * ego 路（这里）：AI 只决定看哪几页；每一页在 ego 里开一个空间 → 打开 → 把**同一套采集器**
 * （`@agentsws/creator-capture` 打好的页面脚本）注进页面读一遍 → 主页上有 link-in-bio 就顺手读那一页 →
 * `finish({ keep: [] })` 收掉。读到的快照用插件**同一份换形**（`ingestPlanOf`）变成请求体，过插件那几条路由
 * **同一道 schema**，再交给**同一个** `ExtensionPort`（`ingest` / `contentObservation` / `bioLinkObservation`）——
 * 存进本机红人库、公开联系方式（`public_contacts`）与「不出门」清单、登录了云账号就备份上云（1661 / 1663 / 1693），
 * 全是那一侧的规矩，这里一条都不另写。
 *
 * 数字一律由采集器读，AI 不填；采集器读不到（不是这几家、页面没渲染出来）时如实回「没读到」，
 * AI 再用 `record_creator_observations` 手记兜底。
 *
 * WP498：
 * - **1740 B**：读到的每个红人主页都「存入红人池」——插件面板那个按钮的**同一个入口**（`ExtensionPort.saveCreator`，
 *   过插件那条路由同一道 schema），同一份换形（`creatorSaveBodyOf`）外加加入时间 / 近期作品。先存入、再报观测：
 *   观测那一跳送公共库时就带得上存入时记下的国家（1707b 的资料字段，见 `extension-service.ts` 的 `publicProfileOf`）。
 *   内容页 / 列表页照旧只报观测。
 * - **1742 C**：列表页先过插件那套预筛（`prescreenList`：视频页右栏拿种子频道的主题词打分），一行不丢全记，
 *   分随观测一起记；回给 AI 时按分排序、标出插件会筛掉的那几行。
 */
import {
  EXTENSION_BIO_LINK_OBSERVATION_SCHEMA,
  EXTENSION_CONTENT_OBSERVATION_SCHEMA,
  EXTENSION_CREATOR_SAVE_SCHEMA,
  EXTENSION_INGEST_SCHEMA,
  type ExtensionBioLinkObservation,
  type ExtensionContentObservation,
  type ExtensionCreatorSave,
  type ExtensionObservation,
  type ExtensionPort,
} from '@agentsws/api'
import type { WorkspaceId } from '@agentsws/contracts'
import {
  type BioLinkSnapshot,
  type ContentMetrics,
  type CreatorMetrics,
  contentMetrics,
  creatorCapturePageTemplate,
  creatorMetrics,
  type IngestPlan,
  ingestPlanOf,
  type ListPrescreen,
  listWantsSeedTopics,
  PAGE_ARGS_PLACEHOLDER,
  type PageCapture,
  type PageListCapture,
  prescreenList,
} from '@agentsws/creator-capture'
import type { EgoPageReader } from './reader.js'
import { egoReadWhy } from './reader.js'
import type { EgoReadCall } from './runner.js'

/** 一次最多读几页（一页一趟，一趟十几秒；再多就分几次叫）。 */
export const EGO_CAPTURE_MAX_PAGES = 10
/** 主页上顺手读几个 link-in-bio 页。 */
export const EGO_CAPTURE_BIO_LINKS = 2

export interface EgoCaptureOptions {
  lang?: 'zh' | 'en'
  /** 顺手读主页上的 link-in-bio 页（缺省 {@link EGO_CAPTURE_BIO_LINKS}；0 = 不读）。 */
  follow_bio_links?: number
  /** **只给本机假页面测试用**：真地址 → 假页面地址（见 `script.ts` 的 `capture` 步）。 */
  rewrite?: Record<string, string>
}

/** 一页的那一趟 ego 怎么跑。 */
export function egoCaptureCall(url: string, options: EgoCaptureOptions = {}): EgoReadCall {
  const open = options.rewrite?.[url] ?? (options.rewrite === undefined ? url : undefined)
  if (open === undefined) throw new Error(`假页面映射里没有 ${url}`)
  return {
    url: open,
    capture: { template: creatorCapturePageTemplate(), placeholder: PAGE_ARGS_PLACEHOLDER },
    steps: [
      {
        op: 'capture',
        id: 'capture',
        ...(options.lang === undefined ? {} : { lang: options.lang }),
        follow_bio_links: options.follow_bio_links ?? EGO_CAPTURE_BIO_LINKS,
        ...(options.rewrite === undefined ? {} : { rewrite: options.rewrite }),
      },
    ],
  }
}

/** 一页读下来的样子（还没交给本机服务）。 */
export type EgoPageCapture =
  | { url: string; ok: true; capture: PageCapture; bio_links: BioLinkSnapshot[] }
  | { url: string; ok: false; why: string; state: string }

const isCapture = (v: unknown): v is PageCapture =>
  v !== null && typeof v === 'object' && typeof (v as { href?: unknown }).href === 'string'

/** 在 ego 里读一页（一趟：开空间 → 读 → 收空间）。 */
export async function egoCapturePage(
  reader: EgoPageReader,
  url: string,
  options: EgoCaptureOptions = {},
): Promise<EgoPageCapture> {
  let call: EgoReadCall
  try {
    call = egoCaptureCall(url, options)
  } catch (e) {
    return { url, ok: false, state: 'failed', why: e instanceof Error ? e.message : String(e) }
  }
  const res = await reader.run(call)
  const step = res.steps.find((s) => s.id === 'capture')
  const [main, ...rest] = ((step?.captures ?? []) as unknown[]).filter(isCapture)
  if (res.state !== 'ok' || main === undefined || step?.ok !== true)
    return {
      url,
      ok: false,
      state: res.state,
      why:
        res.state === 'ok'
          ? step?.why === 'not-rendered'
            ? '页面一直没渲染出来（可能要登录、被拦了，或网速慢）'
            : '这一页不是认得出的红人主页 / 视频页 / 列表页 / Linktree'
          : egoReadWhy(res),
    }
  const bio_links: BioLinkSnapshot[] = rest.flatMap((c) => (c.bio_link == null ? [] : [c.bio_link]))
  return { url, ok: true, capture: main, bio_links }
}

/** 交给本机服务那一侧（和插件同一个 `ExtensionPort`）。 */
export type EgoCapturePort = Pick<
  ExtensionPort,
  'ingest' | 'contentObservation' | 'bioLinkObservation' | 'saveCreator' | 'seedSignature'
>

export interface EgoCaptureActor {
  workspace_id: WorkspaceId
  person_id: string
}

/** 和 `observeViaIngest` 同一个会话：「谁采的」记在这个人头上，令牌那一格写 `ego`。 */
function egoSession(actor: EgoCaptureActor) {
  return {
    token_id: 'ego',
    workspace_id: actor.workspace_id,
    person_id: actor.person_id as never,
    extension_id: 'ego',
    scopes: ['kol.observe' as const],
  }
}

/** 交给本机服务之后的回执（按页）。 */
export interface EgoIngestOutcome {
  saved: number
  deduped: number
  invalid: number
  forwarded: number
  pending?: number
  contents_recorded: number
  bio_links_recorded: number
  /** 被那道 schema 拒掉的（和插件一样整批拒，照实说）。 */
  rejected: string[]
}

/** 一份读页结果 → 过插件那几条路由同一道 schema → 交给同一个 `ExtensionPort`。 */
export async function ingestEgoPlan(
  port: EgoCapturePort,
  actor: EgoCaptureActor,
  plan: IngestPlan,
): Promise<EgoIngestOutcome> {
  const session = egoSession(actor)
  const out: EgoIngestOutcome = {
    saved: 0,
    deduped: 0,
    invalid: 0,
    forwarded: 0,
    contents_recorded: 0,
    bio_links_recorded: 0,
    rejected: [],
  }
  let batchId: string | undefined
  for (const batch of plan.observation_batches) {
    const parsed = EXTENSION_INGEST_SCHEMA.safeParse({
      observations: batch,
      ...(batchId === undefined ? {} : { batch_id: batchId }),
    })
    if (!parsed.success) {
      out.rejected.push(`观测：${parsed.error.issues[0]?.message ?? '形状不对'}`)
      continue
    }
    const res = await port.ingest(
      session as never,
      parsed.data as { observations: ExtensionObservation[]; batch_id?: string },
    )
    batchId ??= res.batch_id
    for (const row of res.rows) {
      if (row.status === 'ok') out.saved += 1
      else if (row.status === 'deduped') out.deduped += 1
      else out.invalid += 1
    }
    out.forwarded += res.forwarded_to_public_library
    const pending = (res as { public_library_pending?: number }).public_library_pending
    if (pending !== undefined) out.pending = (out.pending ?? 0) + pending
  }
  for (const body of plan.content_observations) {
    const parsed = EXTENSION_CONTENT_OBSERVATION_SCHEMA.safeParse(body)
    if (!parsed.success) {
      out.rejected.push(`内容观测：${parsed.error.issues[0]?.message ?? '形状不对'}`)
      continue
    }
    await port.contentObservation(session as never, parsed.data as ExtensionContentObservation)
    out.contents_recorded += 1
  }
  for (const body of plan.bio_link_observations) {
    const parsed = EXTENSION_BIO_LINK_OBSERVATION_SCHEMA.safeParse(body)
    if (!parsed.success) {
      out.rejected.push(`链接页：${parsed.error.issues[0]?.message ?? '形状不对'}`)
      continue
    }
    await port.bioLinkObservation(session as never, parsed.data as ExtensionBioLinkObservation)
    out.bio_links_recorded += 1
  }
  return out
}

/** WP498（1740 B）：存入红人池的回执（按页；只有主页有）。 */
export type EgoPoolOutcome =
  | { saved: true; new: boolean; creator_id: string }
  | { saved: false; why: string }

/**
 * WP498（1740 B）：主页那一条「存入红人池」——过插件那条路由（`POST /v1/extension/creators`）同一道 schema，
 * 交给同一个 `ExtensionPort.saveCreator`（本机红人库 + 页面上的商务邮箱进本机加密库，和插件按钮一样）。
 */
export async function saveEgoCreator(
  port: Pick<EgoCapturePort, 'saveCreator'>,
  actor: EgoCaptureActor,
  plan: IngestPlan,
): Promise<EgoPoolOutcome | undefined> {
  if (plan.creator_save === undefined) return undefined
  const parsed = EXTENSION_CREATOR_SAVE_SCHEMA.safeParse(plan.creator_save)
  if (!parsed.success)
    return { saved: false, why: `存入红人池：${parsed.error.issues[0]?.message ?? '形状不对'}` }
  const res = await port.saveCreator(
    egoSession(actor) as never,
    parsed.data as unknown as ExtensionCreatorSave,
  )
  return { saved: true, new: res.status === 'ok', creator_id: res.creator_id }
}

/**
 * WP498（1742 C）：列表页的种子主题词——插件只在视频页右栏要（种子 = 这条视频的频道，按它的平台 id 问本机）。
 * 种子不在红人库里 / 本机没这一口 / 出错，都是「没有主题词」（不打分），不是故障。
 */
export async function seedTopicsOf(
  port: Pick<EgoCapturePort, 'seedSignature'> | undefined,
  actor: EgoCaptureActor,
  list: PageListCapture,
): Promise<string[] | undefined> {
  if (port === undefined || !listWantsSeedTopics(list) || list.seed === undefined) return undefined
  try {
    const sig = await port.seedSignature(egoSession(actor) as never, {
      channel: list.target.platform,
      handle: list.seed.externalId,
    })
    return sig === undefined || sig.topic_keywords.length === 0 ? undefined : sig.topic_keywords
  } catch {
    return undefined
  }
}

/** 回给 AI 的一页摘要（采集器读出来的数 + 面板上那几块算出来的数 + 记下了几条）。 */
export interface EgoCaptureSummary {
  url: string
  ok: boolean
  why?: string
  kind?: ('creator' | 'content' | 'bio_link' | 'list')[]
  creator?: Record<string, unknown> & { metrics: CreatorMetrics }
  content?: Record<string, unknown> & { metrics: ContentMetrics }
  bio_link?: Record<string, unknown>
  list?: Record<string, unknown>
  recorded?: EgoIngestOutcome
  /** WP498（1740 B）：这个主页存入红人池了没有、是不是新收的。 */
  pool?: EgoPoolOutcome
}

const RECENT_SAMPLE = 5

/** 快照 → 摘要（数字原样；近期作品只带前几条，免得把上下文撑爆）。 */
export function summarizeCapture(
  url: string,
  plan: IngestPlan,
  capture: PageCapture,
  recorded: EgoIngestOutcome | undefined,
  prescreen?: ListPrescreen,
): EgoCaptureSummary {
  const kind: NonNullable<EgoCaptureSummary['kind']> = []
  const out: EgoCaptureSummary = { url, ok: true, kind }
  const c = plan.creator
  if (c !== undefined) {
    kind.push('creator')
    const obs = plan.observation_batches[0]?.[0]
    out.creator = {
      platform: c.platform,
      external_id: c.externalId,
      handle: c.handle,
      name: c.name,
      page_url: c.pageUrl,
      followers: c.followers,
      followers_text: c.followersText,
      video_count: c.videoCount,
      avg_views: c.avgViews,
      total_views: c.totalViews,
      country: c.country,
      joined: c.joinedDate,
      bio: c.bio,
      business_email: c.businessEmail,
      links: c.links,
      public_contacts: obs?.public_contacts ?? [],
      recent_items: c.recentItems.slice(0, RECENT_SAMPLE),
      recent_items_total: c.recentItems.length,
      metrics: creatorMetrics(c),
    }
  }
  if (capture.content !== undefined) {
    kind.push('content')
    const s = capture.content
    out.content = {
      platform: s.platform,
      content_id: s.contentId,
      content_type: s.contentType,
      title: s.title,
      url: s.url,
      views: s.views,
      likes: s.likes,
      comments: s.comments,
      shares: s.shares,
      published_at: s.publishedAt,
      duration_seconds: s.durationSeconds,
      orientation: s.orientation,
      paid_promotion: s.paidPromotion,
      shoppable: s.shoppable,
      author: s.author,
      metrics: contentMetrics(s),
    }
  }
  if (capture.bio_link !== undefined) {
    kind.push('bio_link')
    const b = capture.bio_link
    out.bio_link = {
      platform: b.platform,
      slug: b.slug,
      links: b.links,
      social_links: b.socialLinks,
      emails: b.emails,
      bio: b.bio,
    }
  }
  if (capture.list !== undefined && capture.list.candidates.length > 0) {
    kind.push('list')
    // WP498（1742 C）：按插件预筛的分排（有分的从高到低，没分的照页面顺序在后），插件会筛掉的那几行标出来
    const pre = prescreen ?? prescreenList(capture.list, undefined)
    out.list = {
      target: capture.list.target,
      candidates_total: capture.list.candidates.length,
      relevance: pre.scored
        ? {
            scored: true,
            topics: pre.topics,
            tally: pre.tally,
            plugin_would_skip: pre.skipped_keys.length,
            note: '按插件预筛的相关度分排（0–100，≥40 相关；20–40 疑似无关；<20 无关）。插件会把 plugin_would_skip 的那几行默认不勾、不收；这里全记了，挑人时先看前面的。',
          }
        : {
            scored: false,
            note: listWantsSeedTopics(capture.list)
              ? '没打相关度分：这条视频的频道还不在红人库里（或库里没有它的主题词），插件这时也不预筛。先读一次这个频道的主页（会存入红人池），再读这一页就有分。'
              : '搜索 / 话题页插件不打相关度分（结果本来就按搜索词排过），照页面顺序。',
          },
      candidates: pre.ranked.map(({ candidate: x, band, matched_topics, plugin_would_skip }) => ({
        handle: x.handle ?? x.externalId,
        name: x.displayName,
        url: x.url,
        followers_text: x.subscriberCountText,
        videos: (x.videos ?? []).length,
        ...(typeof x.relevanceScore === 'number'
          ? { relevance_score: x.relevanceScore, relevance_band: band, matched_topics }
          : {}),
        ...(plugin_would_skip ? { plugin_would_skip: true } : {}),
      })),
      ...(capture.list.unidentified === undefined
        ? {}
        : { unidentified: capture.list.unidentified }),
    }
  }
  if (recorded !== undefined) out.recorded = recorded
  return out
}

export interface EgoCreatorCapture {
  /** ego 这会儿能不能用。 */
  available(): boolean
  /** 读几页、交给本机服务；`record: false` 只读不记。 */
  capture(
    actor: EgoCaptureActor,
    urls: readonly string[],
    options?: EgoCaptureOptions & { record?: boolean },
  ): Promise<EgoCaptureSummary[]>
}

export interface EgoCreatorCaptureOptions {
  reader: EgoPageReader
  port(): EgoCapturePort | undefined
  now(): string
}

export function createEgoCreatorCapture(deps: EgoCreatorCaptureOptions): EgoCreatorCapture {
  return {
    available: () => deps.reader.available(),
    async capture(actor, urls, options = {}) {
      const out: EgoCaptureSummary[] = []
      for (const url of urls.slice(0, EGO_CAPTURE_MAX_PAGES)) {
        const got = await egoCapturePage(deps.reader, url, options)
        if (!got.ok) {
          out.push({ url, ok: false, why: got.why })
          continue
        }
        const port = deps.port()
        // WP498（1742 C）：列表页先过插件那套预筛（只有视频页右栏、种子在库里才有分）
        const list = got.capture.list
        const prescreen =
          list === undefined || list.candidates.length === 0
            ? undefined
            : prescreenList(list, await seedTopicsOf(port, actor, list))
        const plan = ingestPlanOf(got.capture, {
          now: deps.now(),
          bio_links: got.bio_links,
          ...(prescreen === undefined ? {} : { list_candidates: prescreen.candidates }),
        })
        let recorded: EgoIngestOutcome | undefined
        let pool: EgoPoolOutcome | undefined
        if (options.record !== false && port !== undefined) {
          // WP498（1740 B）：主页先存入红人池（插件按钮同一个入口），再报观测（同插件那几条）
          pool = await saveEgoCreator(port, actor, plan)
          recorded = await ingestEgoPlan(port, actor, plan)
        }
        const summary = summarizeCapture(url, plan, got.capture, recorded, prescreen)
        if (pool !== undefined) summary.pool = pool
        out.push(summary)
      }
      return out
    },
  }
}
