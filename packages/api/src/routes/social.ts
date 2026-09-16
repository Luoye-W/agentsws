/**
 * WP73（56 §6 第三项）：**社媒库的 `/v1` 面**。
 *
 * WP72 把四类对象、六个模块与九条职责都建了起来，可是工作台上一个增删改的
 * 入口都没有——面板读得到社媒，只是因为服务进程在装配期直接把投影塞给了 deck。
 * 这个文件补的就是那条缺口：**社媒库从此有门**（照 `kol.ts` 的写法）。
 *
 * 四条纪律，每条都在类型上看得见：
 *
 * 1. **一个对象域一把闸**。`social_account` / `community_member` /
 *    `community_thread` 三条各自判权。这一条不是形式主义：56 §4 定了
 *    **客服的「社群管理」读不到成员名册**，而它与社媒运营那九条的动作 id
 *    几乎一样——分得开它们的正是这三把闸（`dtc.community-support.yml` 的
 *    scopes 里没有 `community_member`）。所以 `GET /v1/social/members`
 *    对客服那条职责天然是 403，不用在路由里写一行 if。
 * 2. **写动作永远先出卡**。入群审核 → `community_membership`（L2）、
 *    管理动作 → `community_moderation`（封禁那一档 guardrail 升 L1）。
 *    这里一条都不直接改库——改库是执行器在卡被批准之后做的事。
 * 3. **线程只读 + 手动标转客服**。`POST /v1/social/threads` 收的是一条
 *    **新入站**的帖子 / 私信：落库 → `social-core` 的 `triageThread` 判类 →
 *    客户问题出一张转客服卡（社媒运营**不答**，56 的边界），其余按群规匹配
 *    出审核卡。判类不是路由参数——调用方递不进来一个 `triage`。
 * 4. **正文是外部文本**。线程的 `text` 原样存、原样端出去，不在这一层改写，
 *    也不当指令读（21 §1 / 39）。
 */
import type {
  CommunityMember,
  CommunityThread,
  CommunityTriage,
  Iso8601,
  MaybePromise,
  SocialAccount,
  SocialChannel,
  SocialPost,
  SocialPostKind,
  SocialPostStatus,
} from '@agentsws/contracts'
import { SOCIAL_CHANNELS } from '@agentsws/contracts'
import { z } from 'zod'
import { ApiError } from '../errors.js'
import { assignmentOf, body, intParam, ok, param, principalOf } from '../helpers.js'
import { type Route, route } from '../route-spec.js'
import type { GatewayDeps } from '../types.js'
import type { SocialActor } from './social-types.js'

/* ── 鉴权元组：三个对象域各一把闸（31 §3.1 完整元组） ─────────────────── */

const READ_ACCOUNT = {
  domain: 'social_account',
  op: 'read',
  range: 'assigned',
  sensitivity: 'internal',
} as const
const STAGE_ACCOUNT = { ...READ_ACCOUNT, op: 'stage' } as const
/**
 * 成员名册那一把（文件头第 1 条）。
 *
 * **只有社群组五条读得到**：内容组四条的 yml 里没有这个域，客服的「社群管理」
 * 也没有。56 §4 那句"与它真正不同的只有三处：读的是社群线程（读不到成员名册）"
 * 就靠这一把闸兑现。
 */
const READ_MEMBER = {
  domain: 'community_member',
  op: 'read',
  range: 'assigned',
  sensitivity: 'internal',
} as const
const STAGE_MEMBER = { ...READ_MEMBER, op: 'stage' } as const
const READ_THREAD = {
  domain: 'community_thread',
  op: 'read',
  range: 'assigned',
  sensitivity: 'internal',
} as const
const STAGE_THREAD = { ...READ_THREAD, op: 'stage' } as const

/* ── 视图 ─────────────────────────────────────────────────────────────── */

/** 清单上的一行账号（就是契约里那个对象——这一层不加工）。 */
export type SocialAccountRow = SocialAccount
/** 清单上的一行帖子。 */
export type SocialPostRow = SocialPost
/** 清单上的一行成员。 */
export type SocialMemberRow = CommunityMember

/** 清单上的一行线程。多一格账号名——卡面与表格上要认得出是哪个号。 */
export interface SocialThreadRow extends CommunityThread {
  account_name: string
}

/**
 * 提了一条变更之后回来的那一份（照 `KolStagedView`）。
 *
 * `staged` 为假 = guardrail 拦了，`message` 是那句人话。**不抛异常**：
 * 被拦下来是正常结果之一，界面要照实显示而不是弹一个红框。
 */
export interface SocialStagedView {
  staged: boolean
  change_id?: string
  approval_item_id?: string
  /** 被拦下来 / 自动放行的那句话。 */
  message?: string
  /** 这次提上去时的等级（硬顶按回来的话这里就是 L1）。 */
  level?: string
}

/** 一条新入站线程处理完之后回来的那一份。 */
export interface SocialThreadView {
  thread: SocialThreadRow
  /** 判成六类里的哪一类（`social-core` 的 `triageThread` 判的，不是调用方给的）。 */
  triage: CommunityTriage
  /** 判据名（**不含原句**——原句在卡上给人看，不进事件日志）。 */
  signals: string[]
  /** 转出去了没有：`support` = 出了转客服卡；`kol` = 只提示；`social` = 自己处理。 */
  route: 'social' | 'support' | 'kol'
  /** 转客服卡 / 审核卡的 id（有的话）。 */
  approval_item_id?: string
  /** 群规匹配的结论（没违反就是 `none`）。 */
  moderation?: {
    action: string
    needs_approval: boolean
    reason: string
    matched_rules: string[]
  }
}

/**
 * 周视图上的一格（WP73 内容日历）。
 *
 * `conflicts` 是 `social-core` 的 `scheduleConflicts` 当场算的，**不落库**：
 * 撞车是"这一屏排期的一个函数"，存一份就要回答"什么时候重算"。
 */
export interface SocialCalendarCell {
  post_id: string
  account_id: string
  account_name: string
  channel: SocialChannel
  kind: SocialPostKind
  status: SocialPostStatus
  scheduled_at: Iso8601
  /** 文案的前 60 字（格子里显示的那一截）。 */
  preview: string
  /** 撞车说明（空数组 = 没撞）。原样进卡面与格子上那个角标。 */
  conflicts: string[]
}

/** `GET /v1/social/calendar` 回的那一份。 */
export interface SocialCalendarView {
  from: Iso8601
  to: Iso8601
  /** 周视图的**行**：这一屏里出现过的渠道（按 `SOCIAL_CHANNELS` 的顺序）。 */
  channels: SocialChannel[]
  cells: SocialCalendarCell[]
}

/** 建一条草稿 / 改一次排期之后回来的那一份。 */
export interface SocialPostView {
  post: SocialPostRow
  /** 这条排期撞了什么（`social-core` 的 `scheduleConflicts` 算的）。 */
  conflicts: string[]
  /** 撞了的话下一个空档在什么时候（找不到就没有这一格，**不硬塞一个**）。 */
  next_free_slot?: Iso8601
  /** 那张发布卡（`social_post` **永远 L1**）。 */
  staged: SocialStagedView
}

/** 群发向导三步里的第二步（56 §2「群发」那一行）。 */
export type SocialBroadcastAudience = 'all' | 'tagged' | 'active_30d'

/** 群发向导算完之后回来的那一份（卡面上那几个数就是它）。 */
export interface SocialBroadcastView {
  channel: SocialChannel
  account_id: string
  /** 真要发给的人数（已剔除名单上的与频率疲劳的）。 */
  audience_size: number
  /** 因为在抑制名单上被剔掉的人数。 */
  suppressed: number
  /** 因为离上一条太近被剔掉的人数。 */
  too_soon: number
  /** 一句人话，原样进卡面（"342 人收，退订 / 抑制名单剔了 18 个"）。 */
  note: string
  /**
   * 提交前的自查（`social-core` 的 `checkBroadcast` + 承诺扫描）。
   *
   * 不为空 = **没提上去**：先把这些解决掉。真正的拦在 guardrail，
   * 这里只是早点给人反馈（18 §3 fail-closed 的形状）。
   */
  problems: string[]
  staged: SocialStagedView
}

/* ── 端口 ─────────────────────────────────────────────────────────────── */

export interface SocialAccountInput {
  channel: SocialChannel
  handle: string
  display_name: string
  url: string
  external_id: string
  connection_id?: string | undefined
}

export interface SocialPostInput {
  account_id: string
  kind: SocialPostKind
  body: string
  /** 排期时刻；不给 = 批了就发。 */
  scheduled_at?: Iso8601 | undefined
  media_refs?: string[] | undefined
}

export interface SocialBroadcastInput {
  account_id: string
  /** 群发正文（过承诺扫描）。 */
  body: string
  audience: SocialBroadcastAudience
  /** `audience: 'tagged'` 才有：发给带这个标签的人。 */
  tag?: string | undefined
  /** WhatsApp 才有：后台批过的模板名。少了它一律不发。 */
  template_id?: string | undefined
  /** WhatsApp 才有：这批人都 opt-in 过吗。不为真一律不发。 */
  opt_in_verified?: boolean | undefined
}

export interface SocialThreadInput {
  account_id: string
  external_id: string
  surface: 'thread' | 'comment' | 'dm'
  author_external_id: string
  author_handle: string
  /** 对方说的那句话。**外部文本**，原样存。 */
  text: string
  created_at?: string | undefined
}

export interface SocialPort {
  accounts(
    actor: SocialActor,
    filter: { channel?: SocialChannel | undefined },
  ): MaybePromise<{ rows: SocialAccountRow[] }>
  createAccount(actor: SocialActor, input: SocialAccountInput): MaybePromise<SocialAccountRow>

  posts(
    actor: SocialActor,
    filter: {
      channel?: SocialChannel | undefined
      account_id?: string | undefined
      status?: SocialPostStatus | undefined
      limit?: number | undefined
    },
  ): MaybePromise<{ rows: SocialPostRow[] }>

  /** 内容日历（周视图那一屏）。 */
  calendar(
    actor: SocialActor,
    filter: { from?: Iso8601 | undefined; to?: Iso8601 | undefined },
  ): MaybePromise<SocialCalendarView>
  /**
   * 建一条草稿并提上去（`stage_post` → `social_post` 卡，**永远 L1**）。
   *
   * 排期时间要写在卡面上：批了之后它会在那个时刻自己出去，人按下那一下之前
   * 必须看得见（36 §2）。
   */
  createPost(actor: SocialActor, input: SocialPostInput): MaybePromise<SocialPostView>
  /**
   * 改一条的排期（周视图上拖一下）。
   *
   * 改时间 = **重新提一张卡**：发布永远 L1，换个时间发也是一次要人点头的发布。
   */
  reschedulePost(
    actor: SocialActor,
    id: string,
    input: { scheduled_at: Iso8601 },
  ): MaybePromise<SocialPostView>

  threads(
    actor: SocialActor,
    filter: {
      channel?: SocialChannel | undefined
      account_id?: string | undefined
      open?: boolean | undefined
      surface?: 'thread' | 'comment' | 'dm' | undefined
    },
  ): MaybePromise<{ rows: SocialThreadRow[] }>
  /**
   * 一条**新入站**的帖子 / 评论 / 私信进来了。
   *
   * 落库 → triage → 客户问题出转客服卡、其余按群规出审核卡（文件头第 3 条）。
   * 判类由 `social-core` 做，这个口子收不下一个 `triage` 参数。
   */
  ingestThread(actor: SocialActor, input: SocialThreadInput): MaybePromise<SocialThreadView>
  /** 手动对一条线程下一个管理动作（出卡，不改库）。 */
  moderateThread(
    actor: SocialActor,
    id: string,
    input: { action: string; reason?: string | undefined },
  ): MaybePromise<SocialStagedView>

  /**
   * 群发向导那一下：算受众 → 自查 → 出一张 `community_broadcast` 卡（**永远 L1**）。
   *
   * 一次群发出去收不回来，而且收的是群里的人不是同事——所以它在 `HARD_L1` 里，
   * 职责 yml 放宽不了。
   */
  broadcast(actor: SocialActor, input: SocialBroadcastInput): MaybePromise<SocialBroadcastView>

  members(
    actor: SocialActor,
    filter: {
      channel?: SocialChannel | undefined
      account_id?: string | undefined
      pending?: boolean | undefined
    },
  ): MaybePromise<{ rows: SocialMemberRow[] }>
  /** 批 / 拒一条入群申请（`community_membership` L2 的卡）。 */
  decideMember(
    actor: SocialActor,
    id: string,
    input: { decision: 'approve' | 'reject'; reason?: string | undefined },
  ): MaybePromise<SocialStagedView>
}

/* ── 装配 ─────────────────────────────────────────────────────────────── */

function portOf(deps: GatewayDeps): SocialPort {
  const p = deps.social
  if (p === undefined)
    throw new ApiError(
      'not_implemented',
      '这个服务进程没有装配社媒库（GatewayDeps.social）。社媒运营那九条职责要它才动得了。',
    )
  return p
}

function actorOf(c: Parameters<typeof principalOf>[0]): SocialActor {
  const p = principalOf(c)
  const a = assignmentOf(c)
  return {
    workspace_id: p.workspace_id,
    person_id: p.person_id,
    assignment_id: a.id,
    role_id: a.role_id,
  }
}

const CHANNEL_IDS = SOCIAL_CHANNELS.map((c) => c.id)

const channelQuery = (c: Parameters<typeof param>[0]): SocialChannel | undefined => {
  const raw = c.req.query('channel')
  if (raw === undefined || raw.trim() === '') return undefined
  const found = CHANNEL_IDS.find((x) => x === raw.trim())
  if (found === undefined) throw new ApiError('invalid_input', `不认识这条渠道：${raw}`)
  return found
}

const STATUSES = ['draft', 'scheduled', 'published', 'failed'] as const
const SURFACES = ['thread', 'comment', 'dm'] as const
/** 群规允许的动作（与 `social-core` 的 `ModerationAction` 一字不差）。 */
const MODERATION_ACTIONS = [
  'warn',
  'delete_post',
  'mute',
  'unmute',
  'ban',
  'permanent_ban',
  'unban',
] as const

const ChannelSchema = z.enum(CHANNEL_IDS as [SocialChannel, ...SocialChannel[]])

const AccountBody = z.object({
  channel: ChannelSchema,
  handle: z.string().min(1).max(200),
  display_name: z.string().min(1).max(200),
  url: z.string().url().max(500),
  /** 平台那一侧的 id（页面 id / 频道 id / 群 id）。发布与群发按它打。 */
  external_id: z.string().min(1).max(200),
  connection_id: z.string().min(1).max(200).optional(),
})

const ThreadBody = z.object({
  account_id: z.string().min(1),
  external_id: z.string().min(1).max(200),
  surface: z.enum(SURFACES),
  author_external_id: z.string().min(1).max(200),
  author_handle: z.string().min(1).max(200),
  /** 对方说的那句话（外部文本，原样存）。 */
  text: z.string().min(1).max(20_000),
  created_at: z.string().min(1).max(40).optional(),
})

const KINDS = ['post', 'image', 'video', 'short', 'story', 'thread', 'poll'] as const

const PostBody = z.object({
  account_id: z.string().min(1),
  kind: z.enum(KINDS),
  body: z.string().min(1).max(20_000),
  scheduled_at: z.string().min(1).max(40).optional(),
  media_refs: z.array(z.string().min(1).max(500)).max(20).optional(),
})

const ScheduleBody = z.object({
  scheduled_at: z.string().min(1).max(40),
})

const BroadcastBody = z.object({
  account_id: z.string().min(1),
  body: z.string().min(1).max(20_000),
  audience: z.enum(['all', 'tagged', 'active_30d']),
  tag: z.string().min(1).max(100).optional(),
  template_id: z.string().min(1).max(200).optional(),
  opt_in_verified: z.boolean().optional(),
})

const ModerateBody = z.object({
  action: z.enum(MODERATION_ACTIONS),
  reason: z.string().max(500).optional(),
})

const MemberDecisionBody = z.object({
  decision: z.enum(['approve', 'reject']),
  reason: z.string().max(500).optional(),
})

export function socialRoutes(): Route[] {
  return [
    route(
      {
        method: 'get',
        path: '/v1/social/accounts',
        operationId: 'listSocialAccounts',
        summary: '我们自己的社媒账号 / 社群（56 §2）。九条渠道之间零共享——按 channel 筛出自己那条',
        tag: 'social',
        auth: 'bearer',
        assignment: true,
        authz: READ_ACCOUNT,
        params: [{ name: 'channel', in: 'query', description: '只看这条渠道' }],
        returns: '{ rows: SocialAccountRow[] }',
      },
      async (c, deps) => {
        const channel = channelQuery(c)
        return ok(
          c,
          await portOf(deps).accounts(actorOf(c), {
            ...(channel === undefined ? {} : { channel }),
          }),
        )
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/social/accounts',
        operationId: 'createSocialAccount',
        summary: '登记一个我们自己的号 / 群（凭据不在这里：token 走连接页那条路）',
        tag: 'social',
        auth: 'bearer',
        assignment: true,
        authz: STAGE_ACCOUNT,
        body: AccountBody,
        returns: 'SocialAccountRow',
      },
      async (c, deps) =>
        ok(c, await portOf(deps).createAccount(actorOf(c), await body(c, AccountBody)), 201),
    ),
    route(
      {
        method: 'get',
        path: '/v1/social/posts',
        operationId: 'listSocialPosts',
        summary:
          '帖子清单（草稿 / 排期 / 已发 / 退回四态分得开——退回混进排期里就再也没人发现它没发出去）',
        tag: 'social',
        auth: 'bearer',
        assignment: true,
        authz: READ_ACCOUNT,
        params: [
          { name: 'channel', in: 'query', description: '只看这条渠道' },
          { name: 'account_id', in: 'query', description: '只看这个号' },
          { name: 'status', in: 'query', description: 'draft / scheduled / published / failed' },
          { name: 'limit', in: 'query', description: '最多几行', schema: { type: 'integer' } },
        ],
        returns: '{ rows: SocialPostRow[] }',
      },
      async (c, deps) => {
        const channel = channelQuery(c)
        const account_id = c.req.query('account_id')
        const rawStatus = c.req.query('status')
        const status = STATUSES.find((s) => s === rawStatus)
        if (rawStatus !== undefined && rawStatus !== '' && status === undefined)
          throw new ApiError('invalid_input', `不认识这个状态：${rawStatus}`)
        const limit = intParam(c, 'limit')
        return ok(
          c,
          await portOf(deps).posts(actorOf(c), {
            ...(channel === undefined ? {} : { channel }),
            ...(account_id === undefined || account_id === '' ? {} : { account_id }),
            ...(status === undefined ? {} : { status }),
            ...(limit === undefined ? {} : { limit }),
          }),
        )
      },
    ),
    route(
      {
        method: 'get',
        path: '/v1/social/calendar',
        operationId: 'getSocialCalendar',
        summary:
          '内容日历（56 §2 面板那一块的周视图）：一行一条渠道、一列一天；撞车当场算，**不落库**',
        tag: 'social',
        auth: 'bearer',
        assignment: true,
        authz: READ_ACCOUNT,
        params: [
          { name: 'from', in: 'query', description: '从哪天起（ISO）；不给就是本周一' },
          { name: 'to', in: 'query', description: '到哪天止（ISO，左闭右开）；不给就是两周后' },
        ],
        returns: 'SocialCalendarView',
      },
      async (c, deps) => {
        const from = c.req.query('from')
        const to = c.req.query('to')
        return ok(
          c,
          await portOf(deps).calendar(actorOf(c), {
            ...(from === undefined || from === '' ? {} : { from }),
            ...(to === undefined || to === '' ? {} : { to }),
          }),
        )
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/social/posts',
        operationId: 'createSocialPost',
        summary:
          '建一条草稿并提上去：一张 `social_post` 发布卡（**永远 L1**），卡面上带预览与排期时间；撞车在卡上说明',
        tag: 'social',
        auth: 'bearer',
        assignment: true,
        authz: STAGE_ACCOUNT,
        body: PostBody,
        returns: 'SocialPostView',
      },
      async (c, deps) =>
        ok(c, await portOf(deps).createPost(actorOf(c), await body(c, PostBody)), 201),
    ),
    route(
      {
        method: 'patch',
        path: '/v1/social/posts/:id/schedule',
        operationId: 'rescheduleSocialPost',
        summary:
          '改一条的排期（周视图上拖一下）。换个时间发也是一次发布，所以**重新出一张卡**；同渠道同一小时两条会在卡上说撞了',
        tag: 'social',
        auth: 'bearer',
        assignment: true,
        authz: STAGE_ACCOUNT,
        params: [{ name: 'id', in: 'path', required: true, description: 'post_id' }],
        body: ScheduleBody,
        returns: 'SocialPostView',
      },
      async (c, deps) =>
        ok(
          c,
          await portOf(deps).reschedulePost(
            actorOf(c),
            param(c, 'id'),
            await body(c, ScheduleBody),
          ),
        ),
    ),
    route(
      {
        method: 'get',
        path: '/v1/social/threads',
        operationId: 'listSocialThreads',
        summary:
          '群里的帖子 / 评论 / 私信（**只读**）。转给客服的那些不算社媒运营的待处理——球在客服那边',
        tag: 'social',
        auth: 'bearer',
        assignment: true,
        authz: READ_THREAD,
        params: [
          { name: 'channel', in: 'query', description: '只看这条渠道' },
          { name: 'account_id', in: 'query', description: '只看这个号 / 群' },
          {
            name: 'open',
            in: 'query',
            description: '只要还没处理完的',
            schema: { type: 'boolean' },
          },
          { name: 'surface', in: 'query', description: 'thread / comment / dm' },
        ],
        returns: '{ rows: SocialThreadRow[] }',
      },
      async (c, deps) => {
        const channel = channelQuery(c)
        const account_id = c.req.query('account_id')
        const rawSurface = c.req.query('surface')
        const surface = SURFACES.find((s) => s === rawSurface)
        if (rawSurface !== undefined && rawSurface !== '' && surface === undefined)
          throw new ApiError('invalid_input', `不认识这个位置：${rawSurface}`)
        return ok(
          c,
          await portOf(deps).threads(actorOf(c), {
            ...(channel === undefined ? {} : { channel }),
            ...(account_id === undefined || account_id === '' ? {} : { account_id }),
            ...(c.req.query('open') === 'true' ? { open: true } : {}),
            ...(surface === undefined ? {} : { surface }),
          }),
        )
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/social/threads',
        operationId: 'ingestSocialThread',
        summary:
          '一条新入站的帖子 / 私信进来了：落库 → triage → **客户问题出转客服卡**（社媒运营不答，56 边界），其余按群规出审核卡',
        tag: 'social',
        auth: 'bearer',
        assignment: true,
        authz: STAGE_THREAD,
        body: ThreadBody,
        returns: 'SocialThreadView',
      },
      async (c, deps) =>
        ok(c, await portOf(deps).ingestThread(actorOf(c), await body(c, ThreadBody)), 201),
    ),
    route(
      {
        method: 'post',
        path: '/v1/social/threads/:id/moderate',
        operationId: 'moderateSocialThread',
        summary:
          '对一条线程下一个管理动作：出一张 `community_moderation` 卡（删帖 / 禁言 L2，**封禁 L1**——分档在 guardrail 里按动作判）',
        tag: 'social',
        auth: 'bearer',
        assignment: true,
        authz: STAGE_THREAD,
        params: [{ name: 'id', in: 'path', required: true, description: 'thread_id' }],
        body: ModerateBody,
        returns: 'SocialStagedView',
      },
      async (c, deps) =>
        ok(
          c,
          await portOf(deps).moderateThread(
            actorOf(c),
            param(c, 'id'),
            await body(c, ModerateBody),
          ),
        ),
    ),
    route(
      {
        method: 'post',
        path: '/v1/social/broadcasts',
        operationId: 'createSocialBroadcast',
        summary:
          '群发向导：选群 → 选受众（全员 / 标签 / 最近 30 天活跃）→ 写文案 → 算受众数与抑制剔除数 → 出一张群发卡（**永远 L1**）',
        tag: 'social',
        auth: 'bearer',
        assignment: true,
        authz: STAGE_MEMBER,
        body: BroadcastBody,
        returns: 'SocialBroadcastView',
      },
      async (c, deps) =>
        ok(c, await portOf(deps).broadcast(actorOf(c), await body(c, BroadcastBody)), 201),
    ),
    route(
      {
        method: 'get',
        path: '/v1/social/members',
        operationId: 'listCommunityMembers',
        summary:
          '社群成员与入群申请。**只有社群组五条读得到**——客服的「社群管理」在这条路上是 403（56 §4 那条边界）',
        tag: 'social',
        auth: 'bearer',
        assignment: true,
        authz: READ_MEMBER,
        params: [
          { name: 'channel', in: 'query', description: '只看这条渠道' },
          { name: 'account_id', in: 'query', description: '只看这个群' },
          {
            name: 'pending',
            in: 'query',
            description: '只要待审入群的',
            schema: { type: 'boolean' },
          },
        ],
        returns: '{ rows: SocialMemberRow[] }',
      },
      async (c, deps) => {
        const channel = channelQuery(c)
        const account_id = c.req.query('account_id')
        return ok(
          c,
          await portOf(deps).members(actorOf(c), {
            ...(channel === undefined ? {} : { channel }),
            ...(account_id === undefined || account_id === '' ? {} : { account_id }),
            ...(c.req.query('pending') === 'true' ? { pending: true } : {}),
          }),
        )
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/social/members/:id/approve',
        operationId: 'decideCommunityMember',
        summary:
          '批 / 拒一条入群申请：出一张 `community_membership` 卡（L2；**一次一个人**——批错一个踢出去就是了，批错三百个这个群就不是原来那个群了）',
        tag: 'social',
        auth: 'bearer',
        assignment: true,
        authz: STAGE_MEMBER,
        params: [{ name: 'id', in: 'path', required: true, description: 'member_id' }],
        body: MemberDecisionBody,
        returns: 'SocialStagedView',
      },
      async (c, deps) =>
        ok(
          c,
          await portOf(deps).decideMember(
            actorOf(c),
            param(c, 'id'),
            await body(c, MemberDecisionBody),
          ),
        ),
    ),
  ]
}
