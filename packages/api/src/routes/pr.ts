/**
 * WP78（60 §5）：**公关库的 `/v1` 面**（最小一套）。
 *
 * 四条职责要动起来，工作台上至少得有四条路：看外面在说什么、攒一篇稿子、
 * 提一条外部发帖、看媒体名单。这个文件就是那四条（照 `social.ts` 的写法）。
 *
 * 五条纪律，每条都在类型上看得见：
 *
 * 1. **一个对象域一把闸**。`mention` / `press_release` / `external_post` /
 *    `media_contact` 各判各的。这不是形式主义：`pr.reddit` 与 `pr.forums`
 *    的 scopes 里**没有** `media_contact`，所以 `GET /v1/pr/contacts`
 *    对它们天然是 403，路由里一行 if 都不用写（同 56 §4 成员名册那一闸）。
 * 2. **判类不是参数**。`POST /v1/pr/mentions` 收的是外面那句话，情绪与归属由
 *    `@agentsws/pr-core` 的 `triageMention` 判；调用方递不进来一个 `triage`。
 *    判成客户问题就出一张**转客服卡**，公关一个字都不答（60 分界行）。
 * 3. **写动作永远先出卡**。稿子 → `press_release`，外部发帖 → `community_post`
 *    （**HARD_L1**）。这里一条都不直接改库——改库是执行器在卡被批准之后做的事。
 * 4. **联系方式只出脱敏那一格**。{@link PrContactRow} 上**根本没有明文那一格**，
 *    所以它不可能漏进响应体、事件或模型上下文（同 48 §5.4 的 `KolContactView`）。
 * 5. **正文是外部文本**。提及的 `text` 原样存、原样端出去，不在这一层改写，
 *    也不当指令读（21 §1 / 39）。
 */
import type {
  AssignmentId,
  ExternalPost,
  ExternalPostRuleCheck,
  GoogleAlertsPanelView,
  Iso8601,
  MaybePromise,
  MediaContact,
  Mention,
  MentionSentiment,
  MentionSource,
  MentionTriage,
  MonitorGroup,
  MonitorPlanItem,
  MonitorRun,
  MonitorSettings,
  MonitorSource,
  PersonId,
  PressQuote,
  PressRelease,
  RoleId,
  WorkspaceId,
} from '@agentsws/contracts'
import { z } from 'zod'
import { ApiError } from '../errors.js'
import { assignmentOf, body, ok, param, principalOf } from '../helpers.js'
import { type Route, route } from '../route-spec.js'
import type { GatewayDeps } from '../types.js'

/* ── 鉴权元组：四个对象域各一把闸（31 §3.1 完整元组） ─────────────────── */

const READ_MENTION = {
  domain: 'mention',
  op: 'read',
  range: 'assigned',
  sensitivity: 'internal',
} as const
const STAGE_MENTION = { ...READ_MENTION, op: 'stage' } as const
const READ_RELEASE = {
  domain: 'press_release',
  op: 'read',
  range: 'assigned',
  sensitivity: 'internal',
} as const
const STAGE_RELEASE = { ...READ_RELEASE, op: 'stage' } as const
const READ_POST = {
  domain: 'external_post',
  op: 'read',
  range: 'assigned',
  sensitivity: 'internal',
} as const
const STAGE_POST = { ...READ_POST, op: 'stage' } as const
/**
 * 媒体名单那一把（文件头第 1 条）。
 *
 * **只有 `pr.press` 读得到**，而且敏感级是 `confidential`：名单上那几个人的
 * 邮箱是这家公司攒了很多年的东西。`pr.reddit` / `pr.forums` / `pr.monitoring`
 * 的 yml 里没有这个域，于是它们天然进不来。
 */
const READ_CONTACT = {
  domain: 'media_contact',
  op: 'read',
  range: 'assigned',
  sensitivity: 'confidential',
} as const

/* ── actor 与视图 ─────────────────────────────────────────────────────── */

export interface PrActor {
  workspace_id: WorkspaceId
  person_id: PersonId
  /** 本次绑定的那条分配（31 §3.1）——额度、等级与"能不能动"全从它来。 */
  assignment_id: AssignmentId
  role_id: RoleId
}

/** 清单上的一行提及（就是契约那个对象，多一格"被转了几次"）。 */
export interface PrMentionRow extends Mention {
  seen_count: number
}

/** 清单上的一行稿子，多两个算好的数（"有几个数 / 几个有出处"）。 */
export interface PrReleaseRow extends PressRelease {
  figure_count: number
  cited_count: number
}

/** 清单上的一行外部露出。 */
export type PrExternalPostRow = ExternalPost

/**
 * 一条媒体联系人在响应体里的样子。
 *
 * **没有明文那一格**（文件头第 4 条）：`email_masked` 是 `a***@x.com` 这种形态，
 * 够人认出"是哪一个邮箱"，又不足以拿去发信。`email_ref` 也不给——那是加密库的
 * key 名，模型要发信是经出站那一跳，不是自己拿一个 key。
 */
export interface PrContactRow {
  id: string
  kind: MediaContact['kind']
  name: string
  outlet: string
  url?: string
  beats: string[]
  stage: MediaContact['stage']
  last_pitched_at?: Iso8601
  last_covered_at?: Iso8601
  /** 有没有邮箱（**只说有没有**）。 */
  has_email: boolean
  email_masked?: string
}

/**
 * 提了一条变更之后回来的那一份（照 `SocialStagedView`）。
 *
 * `staged` 为假 = guardrail 拦了，`message` 是那句人话。**不抛异常**：
 * 被拦下来是正常结果之一（一篇数字没出处的稿子、一个禁推广的版），
 * 界面要照实显示而不是弹一个红框。
 */
export interface PrStagedView {
  staged: boolean
  change_id?: string
  approval_item_id?: string
  message?: string
  /** 这次提上去时的等级（硬顶按回来的话这里就是 L1）。 */
  level?: string
}

/** 一条新提及处理完之后回来的那一份。 */
export interface PrMentionView {
  mention: PrMentionRow
  /** 是不是新的一条（`false` = 去重合并了，只把"被转了几次"加一）。 */
  created: boolean
  /** 判成五类里的哪一类（`pr-core` 的 `triageMention` 判的，不是调用方给的）。 */
  triage: MentionTriage
  sentiment: MentionSentiment
  /** 判据名（**不含原句**——原句在卡上给人看，不进事件日志）。 */
  signals: string[]
  /** 该谁接：`support` = 出了转客服卡；`pr` = 公关自己处理。 */
  route: 'pr' | 'support'
  /** 转客服卡 / 负面预警卡 / 回应草稿卡的 id（有的话）。 */
  approval_item_id?: string
  /** 出的是哪一种卡（没出卡就是 `archive`）。 */
  card: 'support_handoff' | 'negative_alert' | 'response_draft' | 'archive'
}

/** 提一条外部发帖之后回来的那一份。 */
export interface PrExternalPostView extends PrStagedView {
  post_id: string
  /** 版规检查的结论（**先查再提**，查不过就根本提不上去）。 */
  rules_checked: ExternalPostRuleCheck
  /** 给人看的那一句（与 guardrail 拦下来时说的是同一件事）。 */
  rules_explained: string
}

/* ── 入参 ─────────────────────────────────────────────────────────────── */

export interface PrMentionInput {
  source: MentionSource
  origin: string
  url?: string | undefined
  title?: string | undefined
  text: string
  author?: string | undefined
  published_at?: Iso8601 | undefined
  /** WP386：盯的哪一组 / 哪个竞品 / 哪条监控源（信息监控那一轮拉回来的才有）。 */
  group?: MonitorGroup | undefined
  competitor?: string | undefined
  source_id?: string | undefined
  /** WP386：feed 里这一条的 guid（去重用）。 */
  guid?: string | undefined
}

/** WP386：提及清单的筛选（按组、竞品、来源、情绪、时间窗）。 */
export interface PrMentionFilter {
  sentiment?: MentionSentiment | undefined
  triage?: MentionTriage | undefined
  open?: boolean | undefined
  group?: MonitorGroup | undefined
  competitor?: string | undefined
  /** 监控源 id（`reddit` = Reddit 那一路）。 */
  source_id?: string | undefined
  /** 按发布时间（含 since，不含 until）。 */
  since?: Iso8601 | undefined
  until?: Iso8601 | undefined
  limit?: number | undefined
}

/* ── WP386：信息监控的监控源（多条 feed）──────────────────────────────── */

/** 一条监控源在响应体里的样子：**地址只出脱敏那一格**（Google Alerts 的地址本身就是钥匙）。 */
export interface PrWatchSourceRow extends Omit<MonitorSource, 'url'> {
  url_masked: string
}

/** 信息监控那一块（连接卡、右栏、配置卡读它）。 */
export interface PrWatchView {
  sources: PrWatchSourceRow[]
  plan: MonitorPlanItem[]
  settings: MonitorSettings
  /** 一句话（「17 条 · 1 条拉不到」/「还没有监控源」）。 */
  summary: string
  /** 拉不到的几条（红点）。 */
  failed: number
  /** 下一次什么时候拉（按设置算；没源 / 关了就没有）。 */
  next_run_at?: Iso8601
  last_run?: MonitorRun
}

/** 贴进来的一条链接的结局（一次可以贴一批）。 */
export interface PrWatchLinkResult {
  /** 贴的那一条（脱敏）。 */
  input_masked: string
  ok: boolean
  /** 一句人话（成了说「已订上 Super73，拉到 20 条」；错了说为什么）。 */
  message: string
  source_id?: string
  plan_item_id?: string
  label?: string
  kind?: MonitorSource['kind']
}

export interface PrWatchSourcePatch {
  paused?: boolean | undefined
  every_hours?: number | undefined
  group?: MonitorGroup | undefined
  label?: string | undefined
  competitor?: string | undefined
  keywords?: string[] | undefined
  exclude?: string[] | undefined
}

export interface PrReleaseInput {
  headline: string
  dek: string
  body: string
  boilerplate: string
  contact: { name: string; email: string; phone?: string | undefined }
  facts_cited: { figure: string; fact_card_id: string; statement?: string | undefined }[]
  quotes?: PressQuote[] | undefined
  embargo_until?: Iso8601 | undefined
}

export interface PrExternalPostInput {
  platform: string
  venue: string
  kind: ExternalPost['kind']
  title?: string | undefined
  body: string
  flair?: string | undefined
  parent_external_id?: string | undefined
  /**
   * WP332：被回那一条的链接（`https://www.reddit.com/r/x/comments/…/` 或站内路径）。Reddit 上回一条**评论**
   * 要它，插件才找得到回复框；不给就从巡查条目 / 社群线程 / 提及里补，补不到不出卡。
   */
  parent_permalink?: string | undefined
}

/* ── 端口 ─────────────────────────────────────────────────────────────── */

export interface PrPort {
  mentions(actor: PrActor, filter: PrMentionFilter): MaybePromise<{ rows: PrMentionRow[] }>
  /**
   * 收一条新提及：去重落库 → `triageMention` 判类 → 按类出卡。
   *
   * **判类不是参数**（文件头第 2 条）。客户问题出转客服卡，负面舆情出预警卡，
   * 媒体询问出回应草稿卡，其余归档。
   */
  ingestMention(actor: PrActor, input: PrMentionInput): MaybePromise<PrMentionView>

  releases(
    actor: PrActor,
    filter: { status?: PressRelease['status'] | undefined },
  ): MaybePromise<{ rows: PrReleaseRow[] }>
  /** 起草一篇稿子：先自查（数字有没有出处、引语是不是人给的）→ 提一条 `press_release`。 */
  draftRelease(actor: PrActor, input: PrReleaseInput): MaybePromise<PrStagedView>
  /**
   * 把一篇稿子发出去 / 分发给媒体：`after.distributed === true` → guardrail 升 L1。
   *
   * 分发服务还没接（连接目录里是"待增加"），所以这一跳出的是**一张卡 + 一份
   * 可复制的正文**——批了之后由人自己发出去，**不假装已经发出去了**。
   */
  distributeRelease(actor: PrActor, id: string): MaybePromise<PrStagedView>

  externalPosts(
    actor: PrActor,
    filter: { platform?: string | undefined; status?: ExternalPost['status'] | undefined },
  ): MaybePromise<{ rows: PrExternalPostRow[] }>
  /**
   * 提一条外部发帖：先查版规 → 落一条 `external_post` → 提一条 `community_post`。
   *
   * **永远人审**（`HARD_L1`）；版规不让 / 冷却没过的当场被 guardrail 拦下，
   * 回的 `staged` 是假、`message` 是那句人话。
   */
  proposeExternalPost(actor: PrActor, input: PrExternalPostInput): MaybePromise<PrExternalPostView>

  /** 媒体名单（**只出脱敏那一格**，见 {@link PrContactRow}）。 */
  contacts(
    actor: PrActor,
    filter: { stage?: MediaContact['stage'] | undefined; beat?: string | undefined },
  ): MaybePromise<{ rows: PrContactRow[] }>

  /* ── WP386：信息监控的监控源（没装就 501）──────────────────────────── */
  watchView?(actor: PrActor): MaybePromise<PrWatchView>
  /** 贴一批链接（换行 / 空格分开）：每条当场拉一次，拉到了才算配好；按 feed 标题对上清单上的哪一行。 */
  watchAddLinks?(
    actor: PrActor,
    input: { links: string; plan_item_id?: string | undefined; group?: MonitorGroup | undefined },
  ): Promise<{ results: PrWatchLinkResult[]; view: PrWatchView }>
  watchRunNow?(actor: PrActor): Promise<{ run?: MonitorRun; message: string; view: PrWatchView }>
  watchUpdateSource?(
    actor: PrActor,
    id: string,
    patch: PrWatchSourcePatch,
  ): MaybePromise<PrWatchView>
  watchRemoveSource?(actor: PrActor, id: string): MaybePromise<PrWatchView>
  watchUpdateSettings?(actor: PrActor, patch: Partial<MonitorSettings>): MaybePromise<PrWatchView>

  /* ── WP387：你的浏览器替你建 / 导入 Google 提醒（没装就 501）──────────── */
  /** 最近几趟、读到的已有提醒、你的浏览器接上没有（链接只出脱敏那一格）。 */
  alertsView?(actor: PrActor): MaybePromise<GoogleAlertsPanelView>
  /** 出一张「要在你的 Google 账号里建 N 条提醒」的卡（清单取配置卡上确认过、还没挂上源的）。 */
  alertsBuild?(
    actor: PrActor,
  ): Promise<{ ok: true; approval_id: string; count: number } | { ok: false; reason: string }>
  /** 让你的浏览器只读一遍已有的提醒（不出卡；读完 RSS 的出勾选导入卡、邮箱的出「改成 RSS」卡）。 */
  alertsReadExisting?(
    actor: PrActor,
  ): Promise<{ ok: true; matter_id: string } | { ok: false; reason: string }>
}

/* ── 装配 ─────────────────────────────────────────────────────────────── */

function portOf(deps: GatewayDeps): PrPort {
  const p = deps.pr
  if (p === undefined)
    throw new ApiError(
      'not_implemented',
      '这个服务进程没有装配公关库（GatewayDeps.pr）。公共关系那四条职责要它才动得了。',
    )
  return p
}

function actorOf(c: Parameters<typeof principalOf>[0]): PrActor {
  const p = principalOf(c)
  const a = assignmentOf(c)
  return {
    workspace_id: p.workspace_id,
    person_id: p.person_id,
    assignment_id: a.id,
    role_id: a.role_id,
  }
}

const SOURCES = ['news', 'reddit', 'forum', 'review', 'social', 'blog', 'other'] as const
const SENTIMENTS = ['negative', 'neutral', 'positive'] as const
const GROUPS = ['own', 'competitor', 'industry', 'site'] as const
const TRIAGES = ['customer_issue', 'reputation', 'media_inquiry', 'praise', 'noise'] as const
const RELEASE_STATUSES = ['draft', 'approved', 'distributed', 'withdrawn'] as const
const POST_STATUSES = ['draft', 'approved', 'published', 'blocked', 'removed'] as const

const enumQuery = <T extends string>(
  c: Parameters<typeof param>[0],
  name: string,
  allowed: readonly T[],
): T | undefined => {
  const raw = c.req.query(name)
  if (raw === undefined || raw.trim() === '') return undefined
  const found = allowed.find((x) => x === raw.trim())
  if (found === undefined)
    throw new ApiError(
      'invalid_input',
      `${name} 只能是这几个之一：${allowed.join(' / ')}（拿到的是 ${raw}）`,
    )
  return found
}

const MentionBody = z.object({
  source: z.enum(SOURCES),
  origin: z.string().min(1).max(200),
  url: z.string().url().max(1000).optional(),
  title: z.string().min(1).max(500).optional(),
  /** 外面说的那句话（外部文本，原样存）。 */
  text: z.string().min(1).max(20_000),
  author: z.string().min(1).max(200).optional(),
  published_at: z.string().min(1).max(40).optional(),
})

const QuoteBody = z.object({
  speaker: z.string().min(1).max(200),
  text: z.string().min(1).max(2000),
  /** **谁给的这句话**。空着提不上去——模型不替创始人说话（60 §2）。 */
  provided_by: z.string().min(1).max(200),
  provided_at: z.string().min(1).max(40),
})

const ReleaseBody = z.object({
  headline: z.string().min(1).max(300),
  dek: z.string().min(1).max(2000),
  body: z.string().min(1).max(50_000),
  boilerplate: z.string().min(1).max(5000),
  contact: z.object({
    name: z.string().min(1).max(200),
    email: z.string().email().max(300),
    phone: z.string().min(1).max(50).optional(),
  }),
  facts_cited: z
    .array(
      z.object({
        figure: z.string().min(1).max(100),
        fact_card_id: z.string().min(1).max(200),
        statement: z.string().max(2000).optional(),
      }),
    )
    .max(200),
  quotes: z.array(QuoteBody).max(20).optional(),
  embargo_until: z.string().min(1).max(40).optional(),
})

const ExternalPostBody = z.object({
  platform: z.string().min(1).max(100),
  venue: z.string().min(1).max(200),
  kind: z.enum(['post', 'comment', 'answer']),
  title: z.string().min(1).max(300).optional(),
  body: z.string().min(1).max(50_000),
  flair: z.string().min(1).max(100).optional(),
  parent_external_id: z.string().min(1).max(200).optional(),
  parent_permalink: z.string().min(1).max(500).optional(),
})

const WatchLinksBody = z.object({
  /** 一条或一批（换行 / 空格 / 逗号分开）。 */
  links: z.string().min(1).max(20_000),
  plan_item_id: z.string().min(1).max(100).optional(),
  group: z.enum(GROUPS).optional(),
})

const WatchSourceBody = z.object({
  paused: z.boolean().optional(),
  every_hours: z.number().int().min(1).max(168).optional(),
  group: z.enum(GROUPS).optional(),
  label: z.string().min(1).max(120).optional(),
  competitor: z.string().max(120).optional(),
  keywords: z.array(z.string().min(1).max(80)).max(50).optional(),
  exclude: z.array(z.string().min(1).max(80)).max(50).optional(),
})

const WatchSettingsBody = z.object({
  enabled: z.boolean().optional(),
  day_start_hour: z.number().int().min(0).max(23).optional(),
  default_every_hours: z.number().int().min(1).max(168).optional(),
  reddit_queries: z.array(z.string().min(1).max(120)).max(20).optional(),
})

type WatchMethod =
  | 'watchView'
  | 'watchAddLinks'
  | 'watchRunNow'
  | 'watchUpdateSource'
  | 'watchRemoveSource'
  | 'watchUpdateSettings'
  | 'alertsView'
  | 'alertsBuild'
  | 'alertsReadExisting'

/** 信息监控那几口（没装 = 501，说清楚）。 */
function watchOf<K extends WatchMethod>(deps: GatewayDeps, name: K): NonNullable<PrPort[K]> {
  const port = portOf(deps)
  const fn = port[name]
  if (fn === undefined)
    throw new ApiError('not_implemented', '这个服务进程没有装配信息监控（监控源）。')
  return fn.bind(port) as NonNullable<PrPort[K]>
}

export function prRoutes(): Route[] {
  return [
    route(
      {
        method: 'get',
        path: '/v1/pr/mentions',
        operationId: 'listPrMentions',
        summary: '外面在说我们什么（60 §1）。转给客服的那些不在"还没处理"里——球在客服那边',
        tag: 'pr',
        auth: 'bearer',
        assignment: true,
        authz: READ_MENTION,
        params: [
          { name: 'sentiment', in: 'query', description: 'negative | neutral | positive' },
          { name: 'triage', in: 'query', description: '五类之一' },
          { name: 'open', in: 'query', description: 'true = 只看还没处理完的' },
          { name: 'group', in: 'query', description: 'own | competitor | industry | site' },
          { name: 'competitor', in: 'query', description: '只看说这个竞品的' },
          {
            name: 'source_id',
            in: 'query',
            description: '只看这条监控源来的（reddit = Reddit 那一路）',
          },
          { name: 'since', in: 'query', description: 'ISO 时间（含）' },
          { name: 'until', in: 'query', description: 'ISO 时间（不含）' },
          { name: 'limit', in: 'query', description: '最多几条' },
        ],
        returns: '{ rows: PrMentionRow[] }',
      },
      async (c, deps) => {
        const sentiment = enumQuery(c, 'sentiment', SENTIMENTS)
        const triage = enumQuery(c, 'triage', TRIAGES)
        const group = enumQuery(c, 'group', GROUPS)
        const open = c.req.query('open') === 'true'
        const text = (name: string): string | undefined => {
          const v = c.req.query(name)?.trim()
          return v === undefined || v === '' ? undefined : v.slice(0, 200)
        }
        const competitor = text('competitor')
        const source_id = text('source_id')
        const since = text('since')
        const until = text('until')
        const limit = Number(c.req.query('limit'))
        return ok(
          c,
          await portOf(deps).mentions(actorOf(c), {
            ...(sentiment === undefined ? {} : { sentiment }),
            ...(triage === undefined ? {} : { triage }),
            ...(open ? { open: true } : {}),
            ...(group === undefined ? {} : { group }),
            ...(competitor === undefined ? {} : { competitor }),
            ...(source_id === undefined ? {} : { source_id }),
            ...(since === undefined ? {} : { since }),
            ...(until === undefined ? {} : { until }),
            ...(Number.isFinite(limit) && limit > 0
              ? { limit: Math.min(500, Math.floor(limit)) }
              : {}),
          }),
        )
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/pr/mentions',
        operationId: 'ingestPrMention',
        summary:
          '收一条新提及：去重 → 判情绪与归属 → 按类出卡。**判类不是参数**；客户的问题转客服，公关不答（60 分界行）',
        tag: 'pr',
        auth: 'bearer',
        assignment: true,
        authz: STAGE_MENTION,
        body: MentionBody,
        returns: 'PrMentionView',
      },
      async (c, deps) =>
        ok(c, await portOf(deps).ingestMention(actorOf(c), await body(c, MentionBody))),
    ),
    route(
      {
        method: 'get',
        path: '/v1/pr/releases',
        operationId: 'listPressReleases',
        summary: '新闻稿（每一行带着"有几个数 / 几个有出处"——两个数不等的稿子发不出去）',
        tag: 'pr',
        auth: 'bearer',
        assignment: true,
        authz: READ_RELEASE,
        params: [
          {
            name: 'status',
            in: 'query',
            description: 'draft | approved | distributed | withdrawn',
          },
        ],
        returns: '{ rows: PrReleaseRow[] }',
      },
      async (c, deps) => {
        const status = enumQuery(c, 'status', RELEASE_STATUSES)
        return ok(
          c,
          await portOf(deps).releases(actorOf(c), { ...(status === undefined ? {} : { status }) }),
        )
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/pr/releases',
        operationId: 'draftPressRelease',
        summary:
          '起草一篇稿子（草稿 L2）。正文里每个数字都要在 facts_cited 里有出处，引语必须带 provided_by——两条都是 block，不是转人审',
        tag: 'pr',
        auth: 'bearer',
        assignment: true,
        authz: STAGE_RELEASE,
        body: ReleaseBody,
        returns: 'PrStagedView',
      },
      async (c, deps) =>
        ok(c, await portOf(deps).draftRelease(actorOf(c), await body(c, ReleaseBody))),
    ),
    route(
      {
        method: 'post',
        path: '/v1/pr/releases/:id/distribute',
        operationId: 'distributePressRelease',
        summary:
          '把稿子发出去（**L1，永远人审**）。分发服务还没接——出的是一张卡 + 一份可复制的正文，不假装已经发出去了',
        tag: 'pr',
        auth: 'bearer',
        assignment: true,
        authz: STAGE_RELEASE,
        params: [{ name: 'id', in: 'path', description: '稿件 id' }],
        returns: 'PrStagedView',
      },
      async (c, deps) => ok(c, await portOf(deps).distributeRelease(actorOf(c), param(c, 'id'))),
    ),
    route(
      {
        method: 'get',
        path: '/v1/pr/posts',
        operationId: 'listExternalPosts',
        summary: '我们在**别人的**地盘上发过什么、反馈怎么样（被删的那一条也在，照实标着）',
        tag: 'pr',
        auth: 'bearer',
        assignment: true,
        authz: READ_POST,
        params: [
          { name: 'platform', in: 'query', description: 'reddit / quora / zhihu / 某个论坛域名' },
          {
            name: 'status',
            in: 'query',
            description: 'draft | approved | published | blocked | removed',
          },
        ],
        returns: '{ rows: PrExternalPostRow[] }',
      },
      async (c, deps) => {
        const platform = c.req.query('platform')
        const status = enumQuery(c, 'status', POST_STATUSES)
        return ok(
          c,
          await portOf(deps).externalPosts(actorOf(c), {
            ...(platform === undefined || platform.trim() === ''
              ? {}
              : { platform: platform.trim() }),
            ...(status === undefined ? {} : { status }),
          }),
        )
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/pr/posts',
        operationId: 'proposeExternalPost',
        summary:
          '提一条外部发帖（**永远人审**）。先查版规：禁自我推广的版、冷却没过的当场拦下，理由原样带回来',
        tag: 'pr',
        auth: 'bearer',
        assignment: true,
        authz: STAGE_POST,
        body: ExternalPostBody,
        returns: 'PrExternalPostView',
      },
      async (c, deps) =>
        ok(c, await portOf(deps).proposeExternalPost(actorOf(c), await body(c, ExternalPostBody))),
    ),
    route(
      {
        method: 'get',
        path: '/v1/pr/contacts',
        operationId: 'listMediaContacts',
        summary:
          '媒体名单（**只出脱敏邮箱**）。这条路只有 pr.press 进得来——另外三条职责的 scopes 里没有 media_contact 域',
        tag: 'pr',
        auth: 'bearer',
        assignment: true,
        authz: READ_CONTACT,
        params: [
          { name: 'stage', in: 'query', description: '到哪一步了' },
          { name: 'beat', in: 'query', description: '只看写这个领域的人' },
        ],
        returns: '{ rows: PrContactRow[] }',
      },
      async (c, deps) => {
        const stage = enumQuery(c, 'stage', [
          'new',
          'pitched',
          'replied',
          'covered',
          'declined',
          'suppressed',
        ] as const)
        const beat = c.req.query('beat')
        return ok(
          c,
          await portOf(deps).contacts(actorOf(c), {
            ...(stage === undefined ? {} : { stage }),
            ...(beat === undefined || beat.trim() === '' ? {} : { beat: beat.trim() }),
          }),
        )
      },
    ),
    /* ── WP386：信息监控的监控源 ───────────────────────────────────── */
    route(
      {
        method: 'get',
        path: '/v1/pr/watch',
        operationId: 'prWatchView',
        summary:
          '信息监控：各条监控源的状态（地址只出脱敏那一格）、AI 建议的提醒清单、设置、下一次什么时候拉。拉不到的照实标红，不当 0 条',
        tag: 'pr',
        auth: 'bearer',
        assignment: true,
        authz: READ_MENTION,
        returns: 'PrWatchView',
      },
      async (c, deps) => ok(c, await watchOf(deps, 'watchView')(actorOf(c))),
    ),
    route(
      {
        method: 'post',
        path: '/v1/pr/watch/links',
        operationId: 'prWatchAddLinks',
        summary:
          '贴 RSS 链接（可以一次贴一批）：每条当场拉一次，拉到了才算配好；按 feed 标题对上清单上的哪一行。不是 RSS 的当场说清楚（多半还是邮箱投递）',
        tag: 'pr',
        auth: 'bearer',
        assignment: true,
        authz: STAGE_MENTION,
        body: WatchLinksBody,
        returns: '{ results: PrWatchLinkResult[]; view: PrWatchView }',
      },
      async (c, deps) => {
        const input = await body(c, WatchLinksBody)
        return ok(
          c,
          await watchOf(deps, 'watchAddLinks')(actorOf(c), {
            links: input.links,
            ...(input.plan_item_id === undefined ? {} : { plan_item_id: input.plan_item_id }),
            ...(input.group === undefined ? {} : { group: input.group }),
          }),
        )
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/pr/watch/run',
        operationId: 'prWatchRunNow',
        summary: '现在拉一轮（所有没暂停的监控源）；拉不到的照实说',
        tag: 'pr',
        auth: 'bearer',
        assignment: true,
        authz: STAGE_MENTION,
        returns: '{ run?: MonitorRun; message: string; view: PrWatchView }',
      },
      async (c, deps) => ok(c, await watchOf(deps, 'watchRunNow')(actorOf(c))),
    ),
    route(
      {
        method: 'patch',
        path: '/v1/pr/watch/sources/:id',
        operationId: 'prWatchUpdateSource',
        summary: '改一条监控源（暂停 / 频率 / 组 / 名字 / 竞品 / 本地过滤词）',
        tag: 'pr',
        auth: 'bearer',
        assignment: true,
        authz: STAGE_MENTION,
        params: [{ name: 'id', in: 'path', description: '监控源 id' }],
        body: WatchSourceBody,
        returns: 'PrWatchView',
      },
      async (c, deps) => {
        const patch = await body(c, WatchSourceBody)
        const clean: PrWatchSourcePatch = {}
        for (const [k, v] of Object.entries(patch))
          if (v !== undefined) (clean as Record<string, unknown>)[k] = v
        return ok(c, await watchOf(deps, 'watchUpdateSource')(actorOf(c), param(c, 'id'), clean))
      },
    ),
    route(
      {
        method: 'delete',
        path: '/v1/pr/watch/sources/:id',
        operationId: 'prWatchRemoveSource',
        summary: '删一条监控源（拉回来的提及留着）',
        tag: 'pr',
        auth: 'bearer',
        assignment: true,
        authz: STAGE_MENTION,
        params: [{ name: 'id', in: 'path', description: '监控源 id' }],
        returns: 'PrWatchView',
      },
      async (c, deps) =>
        ok(c, await watchOf(deps, 'watchRemoveSource')(actorOf(c), param(c, 'id'))),
    ),
    route(
      {
        method: 'put',
        path: '/v1/pr/watch/settings',
        operationId: 'prWatchUpdateSettings',
        summary:
          '改信息监控的设置（开关、几点之后拉、默认隔几小时、Reddit 那一路搜什么）——只给默认值，用户说了算',
        tag: 'pr',
        auth: 'bearer',
        assignment: true,
        authz: STAGE_MENTION,
        body: WatchSettingsBody,
        returns: 'PrWatchView',
      },
      async (c, deps) => {
        const patch = await body(c, WatchSettingsBody)
        const clean: Partial<MonitorSettings> = {}
        for (const [k, v] of Object.entries(patch))
          if (v !== undefined) (clean as Record<string, unknown>)[k] = v
        return ok(c, await watchOf(deps, 'watchUpdateSettings')(actorOf(c), clean))
      },
    ),
    /* ── WP387：你的浏览器替你建 / 导入 Google 提醒 ─────────────────────── */
    route(
      {
        method: 'get',
        path: '/v1/pr/watch/alerts',
        operationId: 'prWatchAlertsView',
        summary:
          '你的浏览器替你建 Google 提醒：最近几趟（建好几条、哪几条没成）、读到的已有提醒、浏览器接上没有。链接只出脱敏那一格',
        tag: 'pr',
        auth: 'bearer',
        assignment: true,
        authz: READ_MENTION,
        returns: 'GoogleAlertsPanelView',
      },
      async (c, deps) => ok(c, await watchOf(deps, 'alertsView')(actorOf(c))),
    ),
    route(
      {
        method: 'post',
        path: '/v1/pr/watch/alerts/build',
        operationId: 'prWatchAlertsBuild',
        summary:
          '让工坊替你建：出一张「要在你的 Google 账号里建 N 条提醒」的卡（一批一张、每行可勾掉、一次同意）。同意了你的浏览器才去建',
        tag: 'pr',
        auth: 'bearer',
        assignment: true,
        authz: STAGE_MENTION,
        returns: '{ ok: true; approval_id: string; count: number } | { ok: false; reason: string }',
      },
      async (c, deps) => ok(c, await watchOf(deps, 'alertsBuild')(actorOf(c))),
    ),
    route(
      {
        method: 'post',
        path: '/v1/pr/watch/alerts/read',
        operationId: 'prWatchAlertsReadExisting',
        summary:
          '让你的浏览器只读一遍已有的 Google 提醒（只看不改）：RSS 投递的出一张勾选导入的卡，还在发邮件的出一张「改成 RSS」的卡',
        tag: 'pr',
        auth: 'bearer',
        assignment: true,
        authz: STAGE_MENTION,
        returns: '{ ok: true; matter_id: string } | { ok: false; reason: string }',
      },
      async (c, deps) => ok(c, await watchOf(deps, 'alertsReadExisting')(actorOf(c))),
    ),
  ]
}
