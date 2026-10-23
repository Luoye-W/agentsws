/**
 * WP73（56 §6 第三项）：社媒库 `/v1/social/*` 的**实现**（网关那一层只做装配与校验）。
 *
 * WP72 留下的洞与红人那次一模一样：四张表在那里，面板读得到，可是工作台上
 * 登记一个号、批一条入群申请、下一个管理动作，一条路都没有。更要紧的是
 * `social-core` 的 `triage.ts` 与 `moderation.ts` **一个调用方都没有**——
 * 56 那条"群里的客户问题不归社媒运营"的边界，在服务进程里还只是一段注释。
 * 这个文件把它变成代码。
 *
 * 四条纪律：
 *
 * 1. **判类不是参数。** `POST /v1/social/threads` 收的是对方说的那句话，
 *    类由 `triageThread` 判；调用方递不进来一个 `triage`。判成客户问题就出
 *    一张**转客服卡**（`claim`，路由到真持有 `dtc.community-support` 的人），
 *    社媒运营一个字都不答——它手上根本没有订单域。
 * 2. **写动作永远先出卡。** 入群审核是 `community_membership`、管理动作是
 *    `community_moderation`，都经 `ledger.stage` 走 guardrail。这个文件里
 *    **没有一处直接改成员状态或删线程**——那是执行器在卡被批准之后做的事。
 * 3. **额度与等级从本次那条分配来**（05 §4），不是从职责模板的默认值来。
 *    同一个人在两个品牌里做同一条渠道，额度可以不一样。
 * 4. **正文原样进卡、判据名进日志。** 线程正文是外部文本，它在卡上给人看
 *    （人本来就要读它），进事件日志的只有判据名（21 §1）。
 */

import type {
  SocialAccountInput,
  SocialAccountRow,
  SocialActor,
  SocialBroadcastInput,
  SocialBroadcastView,
  SocialCalendarCell,
  SocialCalendarView,
  SocialMemberRow,
  SocialPort,
  SocialPostInput,
  SocialPostRow,
  SocialPostView,
  SocialReplyDraftView,
  SocialStagedView,
  SocialThreadInput,
  SocialThreadRow,
  SocialThreadView,
} from '@agentsws/api'
import { ApiError } from '@agentsws/api'
import type {
  ApprovalBus,
  AssignmentId,
  ChangeKind,
  Clock,
  CommunityMember,
  CommunityThread,
  EffectiveConfig,
  EventEnvelope,
  Iso8601,
  Mandate,
  ObjectRef,
  OutboundRecordInput,
  ProvenanceState,
  Recipient,
  SocialAccount,
  SocialChannel,
  SocialPost,
  StagedChange,
  WorkspaceId,
} from '@agentsws/contracts'
import {
  EGO_HUMAN_WAIT_MS,
  EGO_MEDIA_REQUIRED,
  EGO_READBACK_DELAYS_MS,
  type EgoWriteResult,
  egoPostPlatformOf,
  egoWriteNext,
  egoWriteSentence,
  SOCIAL_CHANNELS,
  SOCIAL_COMPOSE_HOSTS,
  socialChannelSpec,
} from '@agentsws/contracts'
import type { CommunityRule, ModerationAction } from '@agentsws/social-core'
import {
  ACTION_WORDS,
  buildAudience,
  checkBroadcast,
  checkOutbound,
  contentCalendar,
  handoffOf,
  moderate,
  nextFreeSlot,
  type ScheduleConflict,
  scheduleConflicts,
  scheduleRulesFor,
  triageThread,
  weekStart,
} from '@agentsws/social-core'
import type { StageInput, StageOutcome } from '@agentsws/txn'
import type { EgoWriteCall } from './ego-write/writer.js'
import { createOwnSubQueue, type OwnSubQueue, type OwnSubQueueOptions } from './own-sub-queue.js'
import type { SocialStore } from './social.js'
import type { SocialChannelsAssembly } from './social-channels.js'
import {
  createSocialExecutor,
  SOCIAL_REPLY_FORM,
  type SocialExecutor,
  type SocialExecutorOptions,
} from './social-executor.js'
import { createSocialIngest, type SocialIngest } from './social-ingest.js'
import { type ReplyDrafter, replyBlockedReason, templateReply } from './social-reply-draft.js'
import type { TagReviewer } from './social-tags.js'
import { recipientOf, type ScopeManagerRouter } from './supervisor.js'

/**
 * 群规的默认一份（56 §2「群规」那一格还没有界面，所以先给一份能用的）。
 *
 * **不是我们替用户定的规矩**：它是"多数群都会写的那三条"，用户改群规那条动作
 * （`stage_rules_edit`，L1）落地之后就该从库里读。写死在这里的代价说在明处——
 * 面板上那句话会说"用的是默认群规"。
 */
export const DEFAULT_COMMUNITY_RULES: readonly CommunityRule[] = [
  {
    id: 'no_ads',
    text: '群里不发外部推广链接与广告',
    terms: ['低价', '批发', '加我私聊', '代购', 'dm me', 'cheap', 'wholesale', 'telegram.me'],
    action: 'delete_post',
    escalate_after: 2,
  },
  {
    id: 'no_abuse',
    text: '不人身攻击、不骂人',
    terms: ['傻逼', '滚', 'idiot', 'stupid', 'shut up'],
    action: 'warn',
    escalate_after: 2,
  },
  {
    id: 'no_scam',
    text: '不发私下交易 / 诈骗链接',
    terms: ['私下交易', '免费送', 'free gift card', 'claim your prize', 'bit.ly'],
    action: 'mute',
    escalate_after: 2,
  },
]

/** 动作 id（职责 yml 里那几个）。**只有这一处拼它们**。 */
export const SOCIAL_ACTIONS = {
  approveMember: 'approve_member',
  moderate: 'moderate',
  stagePost: 'stage_post',
  stageBroadcast: 'stage_broadcast',
  // WP254：回帖 / 回私信（职责 yml 里那一条，出站卡）
  replyThread: 'reply_thread',
} as const

/** WP483：社媒发帖的 ego 那一路（服务端注入）。 */
export interface SocialEgo {
  available(): boolean
  run(cfg: EgoWriteCall): Promise<EgoWriteResult>
  /** 帖子素材 → 本机临时文件（跑完删）。取不到回 `why`（宁可退插件也不少挂一张图）。 */
  media?(refs: readonly string[]): Promise<{ files: string[]; cleanup(): void } | { why: string }>
  /** 发起人岗位上「发之前让我看一眼」开没开（默认关）。 */
  reviewFirst?(who: { assignment_id?: string; role_id?: string }): boolean
}

export interface SocialServiceOptions {
  workspace_id: WorkspaceId
  store: SocialStore
  clock: Clock
  approvals: ApprovalBus
  /**
   * 15 §5 变更账本的 stage / list 口。
   *
   * `list` 是定时发布那一跳用的：**"这条排期批了没有"只有账本知道**——
   * 在社媒库那张表上另记一格 `approved` 就是第二本账，两本账必然对不上。
   */
  ledger: {
    stage(input: StageInput): Promise<StageOutcome>
    list(filter: { workspace_id: WorkspaceId; kind?: ChangeKind }): Promise<StagedChange[]>
  }
  /** 05 §4 生效配置：额度与等级从本次那条分配来。 */
  effectiveConfig(id: AssignmentId): EffectiveConfig
  appendEvent(e: Omit<EventEnvelope, 'id' | 'at'> & { at?: string }): void
  random(): number
  /**
   * 现在谁持有某条职责（转客服卡要落到**真持有社群管理的那个人**头上）。
   *
   * 没人持有就落到 owner 身上——而不是悄悄没人接。
   */
  holdersOf(role_id: string): { person_id: string }[]
  /** 这个工作区的 owner（兜底收件人）。 */
  owner(): Promise<string | undefined>
  /** 这个群用的群规。不给就按 {@link DEFAULT_COMMUNITY_RULES}。 */
  rulesOf?(account_id: string): readonly CommunityRule[]
  /**
   * 九条渠道的适配器（WP73）。不给的话"到点真发出去"那一跳照实说没装配——
   * 其余的路（排期、草稿、审批、日历）一条都不少。
   */
  channels?: SocialChannelsAssembly
  /**
   * 抑制名单（退订过、投诉过、手工加的）。
   *
   * 不给就按库里那份保守的一份：**自己退群 / 被封的那些人**
   * （`status: 'left' | 'banned'`）。规则本身一个字都不在这里——
   * `@agentsws/core` 的 `suppression.ts` 是全仓唯一一份（客服出站、邮件营销、
   * 开发信、群发，四处同一份）。
   */
  suppressionList?(): readonly string[]
  /**
   * 分批之间等一下（毫秒）。测试塞一个不等的。
   *
   * 为什么要等：平台那一侧看的是"一分钟里来了多少条"，一口气打三百跳
   * 与分六批慢慢打，在对方眼里是两件事。
   */
  sleep?(ms: number): Promise<void>
  /**
   * 日界线的时区偏移（分钟；东八区是 480）。
   *
   * 不是装饰：一条排在北京时间 09-10 07:30 的帖子在 UTC 上是 09-09，按 UTC 分日
   * "今天三条"会算成两天各一条半，日额度就形同虚设（`social-core/calendar.ts`）。
   */
  tzOffsetMinutes?: number
  /**
   * WP174：`scope_manager` 的卡落到谁（岗位上级 → 老板，`./supervisor.ts`）。
   * 不给就照旧落在提的人自己身上（单测与没装公司页的进程）。
   */
  routeScopeManager?: ScopeManagerRouter
  /**
   * WP191（docs/86 §4）：到点那条**已批准**的帖子在这条渠道上发不出去时，开一条
   * 「复制文案去平台发」的待办（只在契约上标了 `publish_fallback: 'manual_task'` 的渠道——
   * 现在只有 LinkedIn）。回待办 id；不给这个口子就照旧只记一句"没发"。
   *
   * 为什么是待办不是卡：这一步已经批过了，再出一张"请批准"的卡是让人批两次；
   * 剩下的是**一件要人去做的事**，那正是待办。
   */
  manualPublishTask?(input: {
    post: SocialPost
    account: SocialAccount | undefined
    channel_label: string
    /** 为什么发不出去（平台原话或"没连上"），写进待办备注。 */
    reason: string
  }): { todo_id: string; owner?: string } | undefined
  /** WP419：交给人发的那一条发好了 / 不发了——把那条待办收掉。不给 = 待办留着人自己勾。 */
  closeManualTask?(todo_id: string): void
  /**
   * WP483（决策 1658 / 1660）：发帖走 ego 那一路。给了、能用 = 没接官方发布接口的内容渠道（FB / IG / X / LinkedIn /
   * TikTok）出卡在工坊批，批了（到点）工坊自己在 ego 里挂图、填字、点发布、读回；ego 跑失败退插件「等你发」，
   * 被平台拦就停下。不给 = 只有插件 / 人发那一路（老行为）。
   */
  ego?: SocialEgo
  /**
   * WP249（决策 81 / 89）：「自家版待处理」要的那几样（官方号浏览器、施行口）。不给 = 不装配
   * 这一块（那几个路由照实说没装配）。审批、额度、事件与库由这里注入，不另起一套。
   */
  ownSub?: Pick<
    OwnSubQueueOptions,
    'officialBrowser' | 'apiConnected' | 'applyApproval' | 'cancelWindowMs'
  >
  /**
   * WP254（决策 117）：别的社群的版务卡与回帖卡批了之后的执行器要的那几样（施行口、取消窗口、
   * 补扫时看哪些卡）。不给 = 只能由执行器被动调（`backendApply` / `deliverOutbound`），没人主动施行。
   */
  executor?: Pick<
    SocialExecutorOptions,
    'applyApproval' | 'cancelWindowMs' | 'approvedItems' | 'redditFill'
  >
  /**
   * WP255（决策 144）：「回复」框里那一句的起草引擎（`social-reply-draft.ts` 的 `modelReplyDrafter`，
   * 按点起草那个人这会儿开着的品牌取模型）。不给 / 回 `undefined` = 没接上模型，给一句模板并照实说。
   */
  replyDrafter?(actor: SocialActor): ReplyDrafter | undefined
  /** WP257（决策 152）：品牌名（自动进帖判类时，正文里提到品牌名算「冲着我们来的」）。 */
  brandName?(): string
  /**
   * WP257：自动进帖判类的模型复核引擎（默认关；按渠道取，用量记在持有那条社媒职责的人头上）。
   * 不给 / 回 `undefined` = 没接上真模型或没人持有那条职责，只按规则判。
   */
  tagReviewer?(channel: SocialChannel): TagReviewer | undefined
  /** WP257：这台接没接上真模型（「模型复核」开关旁照实说）。 */
  modelReady?(): boolean
  /**
   * WP323：发出去了一条（回帖、到点发帖、群发）→ 记进发出记录。不给 = 不记。
   * 记失败不影响发送结果。
   */
  onSent?(input: OutboundRecordInput): void
  /**
   * WP329：Reddit 写的三个口（起草 / 出卡 / 进度），由 `reddit-write/` 那一份接（装配期晚绑定）。
   * 不给 = 路由照实说没装配。
   */
  reddit?: Pick<
    SocialPort,
    | 'redditDraft'
    | 'redditStage'
    | 'redditWrites'
    | 'redditRefill'
    | 'redditDismiss'
    | 'redditRevise'
  >
}

export interface SocialServiceAssembly {
  port: SocialPort
  /**
   * 群发那一跳（56 §6：批准之后**分批**发出去，每批 50、间隔 2 秒、失败即停）。
   *
   * 调度器按品牌各跑一轮。失败即停而不是跳过继续：一条群发发到一半断了，
   * 人要知道断在哪儿；接着发下去只会把同一个错重复几百遍，而每一遍都在
   * 这个号上记一笔。
   */
  broadcastDue(): Promise<SocialBroadcastSweep>
  /**
   * 定时发布那一跳（56 §6：到点把**已批准**的帖子经适配器发出去）。
   *
   * 调度器**按品牌各跑一轮**（照 WP66 / WP68 的写法）。发失败就写回
   * `failed` + 平台原话，**不重试**——一条可能已经发出去的帖子重发一次，
   * 代价是关注的人看到两条一样的。
   */
  publishDue(): Promise<SocialPublishSweep>
  /** WP249：自家版待处理（执行器与决定钩子从这里调）。没装配就没有。 */
  ownSub?: OwnSubQueue
  /** WP254：别的社群的版务卡与回帖卡批了之后的执行器（`backendApply` / `deliverOutbound` / 决定钩子调）。 */
  executor: SocialExecutor
  /**
   * WP256（决策 147）：「群里的帖子」自动进帖。定时那一拍挂在社媒每 5 分钟那条任务上（`server.ts` 在
   * {@link publishDue} 之后接着跑它；不另起一条定时，各频道按自己的频率决定这一拍读不读）。
   */
  ingest: SocialIngest
  /** WP419（决策 1231）：到点交给人发、还没回话的那几条（插件侧边栏「等你发的帖子」）。 */
  handoffs(): SocialPost[]
  /**
   * WP419：人回话——发好了（贴了链接 = 读回确认；没贴 = 只是你说发了，照实标）/ 不发了。
   * 不是交给人发的那一条回 `undefined`。
   */
  answerHandoff(post_id: string, answer: SocialHandoffAnswer): SocialPost | undefined
}

/** {@link SocialServiceAssembly.broadcastDue} 回的那一份。 */
export interface SocialBroadcastSweep {
  /** 批过、还没发的有几条。 */
  due: number
  /** 真发出去了几条群发（不是几个人）。 */
  sent: number
  failed: number
  /** 这一轮一共打到多少个收件人。 */
  recipients: number
  skipped: { post_id: string; reason: string }[]
}

/** 每批多少个收件人（56 §6：每批 50，间隔 2 秒）。 */
export const BROADCAST_BATCH_SIZE = 50
export const BROADCAST_BATCH_GAP_MS = 2_000

/** {@link SocialServiceAssembly.publishDue} 回的那一份。 */
export interface SocialPublishSweep {
  /** 到点了的有几条。 */
  due: number
  published: number
  failed: number
  /** 没发的那些与为什么（哪个品牌的哪一条没发要看得出来）。 */
  skipped: { post_id: string; reason: string }[]
  /** WP191：发不出去、已转成「复制文案去平台发」待办的那几条（LinkedIn）。 */
  manual_tasks?: { post_id: string; todo_id: string }[]
  /** WP419（决策 1231）：交给人在自己登录着的后台里发的那几条（内容账号组，插件侧边栏里出）。 */
  handed_off?: string[]
}

/** WP419：交给人发的那一条，人回来说了什么。 */
export type SocialHandoffAnswer =
  | { done: true; by: string; link?: string }
  | { done: false; by: string; reason?: string }

export function createSocialService(options: SocialServiceOptions): SocialServiceAssembly {
  const { workspace_id, store, clock, approvals, ledger, appendEvent } = options

  let seq = 0
  const nextId = (prefix: string): string => {
    seq += 1
    const rand = Math.floor(options.random() * 0xffffffff)
      .toString(36)
      .padStart(7, '0')
    return `${prefix}_${rand}${seq.toString(36)}`
  }

  const emit = (type: string, actor: string, payload: Record<string, unknown>): void => {
    appendEvent({
      schema_version: 1,
      workspace_id,
      type,
      actor: { kind: 'person', id: actor as never },
      correlation: { trace_id: `tr_social_${clock.now()}` },
      payload,
    })
  }

  /** 额度与等级（纪律 3）。查不到就按最严的一档办。 */
  const actionOf = (
    assignment_id: AssignmentId,
    action: string,
  ): { mandate: Mandate; level: 'L1' | 'L2' | 'L3' } => {
    try {
      const config = options.effectiveConfig(assignment_id)
      return {
        mandate: config.actions.find((a) => a.id === action)?.mandate ?? { caps: {} },
        level: config.automation[action]?.level ?? 'L1',
      }
    } catch {
      return { mandate: { caps: {} }, level: 'L1' }
    }
  }

  const provenanceOf = (run_id: string, seen: ObjectRef[]): ProvenanceState => {
    const grouped: Record<string, string[]> = {}
    for (const ref of seen) {
      const list = grouped[ref.type] ?? []
      if (!list.includes(ref.id)) list.push(ref.id)
      grouped[ref.type] = list
    }
    return { run_id, seen: grouped, read_full: [], recorded_at: clock.now() }
  }

  const accountName = (id: string): string => store.account(id)?.display_name ?? id

  const threadRow = (t: CommunityThread): SocialThreadRow => ({
    ...t,
    account_name: accountName(t.account_id),
  })

  const accountOr404 = (id: string): SocialAccount => {
    const found = store.account(id)
    if (found === undefined) throw new ApiError('not_found', `没有这个号 / 群：${id}`)
    return found
  }

  /** WP174：`scope_manager` 的卡按岗位上级走；别的规则照旧落在提的人身上。 */
  const recipientFor = async (
    actor: SocialActor,
    rule: 'role_holder' | 'scope_manager' | 'owner',
  ): Promise<Recipient> =>
    rule === 'scope_manager' && options.routeScopeManager !== undefined
      ? recipientOf(
          await options.routeScopeManager({
            workspace_id: options.workspace_id,
            role_id: actor.role_id,
            proposer: actor.person_id,
          }),
        )
      : { person: actor.person_id, via: rule }

  /**
   * WP254（决策 117）：版务卡卡面那几格——将执行什么（经哪条渠道）、原话、违反了哪几条群规。
   * 执行器读的是 `action` / `target_external_id` 那几格结构化字段，这几格只给人看（只加不改）。
   */
  const moderationCardFields = (
    account: SocialAccount,
    action: ModerationAction,
    from: { author: string; text: string; rules?: string[] },
  ): Record<string, unknown> => {
    const channel_label = socialChannelSpec(account.channel)?.zh ?? account.channel
    const who = action === 'delete_post' || action === 'approve' ? '这条' : from.author
    const will_do =
      action === 'warn'
        ? `提醒一句：${from.author}（只记在工作台里，平台上不做动作；要在群里说话请另出一张回帖卡）`
        : `${ACTION_WORDS[action]}：${who}（经 ${channel_label} · ${account.display_name}）`
    return {
      action_label: ACTION_WORDS[action],
      channel_label: `${channel_label} · ${account.display_name}`,
      author: from.author,
      excerpt: from.text.slice(0, 600),
      will_do,
      ...(from.rules === undefined || from.rules.length === 0 ? {} : { rule_texts: from.rules }),
    }
  }

  /** 一条 staged change 的共用那一段（提上去 → 翻成视图）。 */
  const stageOne = async (input: {
    actor: SocialActor
    action: string
    kind: ChangeKind
    target: ObjectRef
    before: unknown
    after: unknown
    notes: string[]
    title: string
    summary: string
    seen: ObjectRef[]
    rule: 'role_holder' | 'scope_manager' | 'owner'
    /** 已经算好的收件人（不给按 `rule` 现算）。 */
    recipient?: Recipient
  }): Promise<SocialStagedView> => {
    const run_id = `run_social_${nextId('s')}`
    const { mandate, level } = actionOf(input.actor.assignment_id, input.action)
    const outcome = await ledger.stage({
      workspace_id,
      role_id: input.actor.role_id,
      assignment_id: input.actor.assignment_id,
      run_id,
      change_set_id: `cs_${run_id}`,
      kind: input.kind,
      target: input.target,
      before: input.before,
      after: input.after,
      notes: input.notes,
      created_by: { kind: 'person', id: input.actor.person_id },
      mandate,
      level,
      provenance: provenanceOf(run_id, input.seen),
      approval: {
        title: input.title,
        summary: input.summary,
        recipients: [input.recipient ?? (await recipientFor(input.actor, input.rule))],
        proposer: {
          kind: 'person',
          id: input.actor.person_id,
          assignment_id: input.actor.assignment_id,
        },
        rule: input.rule,
        separation_of_duties: false,
        source_events: [],
      },
    })
    if (!outcome.ok) return { staged: false, message: outcome.message, level }
    return {
      staged: true,
      change_id: outcome.change.id,
      approval_item_id: outcome.approval.id,
      level: outcome.approval.automation.level_at_creation,
    }
  }

  const tz = options.tzOffsetMinutes ?? 0

  /** 撞车说明（`conflict` 在前，`notice` 在后；原样进卡面与格子上那个角标）。 */
  const conflictLines = (hits: readonly ScheduleConflict[]): string[] => hits.map((h) => h.message)

  /** 排期撞了什么（`social-core` 的那一份判据，这里不写第二份）。 */
  const conflictsFor = (candidate: {
    id?: string
    account_id: string
    scheduled_at: Iso8601
    body: string
  }): ScheduleConflict[] =>
    scheduleConflicts(candidate, store.posts(), {
      now: clock.now(),
      tz_offset_minutes: tz,
      // WP191（docs/86 §3.1）：每日上限按这个号所在的渠道取（LinkedIn 1、X 5……），与职责 yml 同一个数
      rules: scheduleRulesFor(store.account(candidate.account_id)?.channel ?? ''),
    })

  /**
   * WP445（决策 1322）：这一条会不会「交给你发」——内容账号组、这条渠道没有官方发布接口或没接上（决策 1231 之后
   * 默认就是这样）→ 到点交给插件，人点发布。
   */
  const handsOff = (channel: SocialChannel): boolean => {
    if (socialChannelSpec(channel)?.group !== 'content') return false
    const ch = options.channels
    if (ch?.adapters[channel]?.publish === undefined) return true
    try {
      return !ch.transport.connected(channel)
    } catch {
      return true
    }
  }

  /**
   * 提一张发布卡（`social_post` 在 `HARD_L1` 里，**永远人审**）。
   * WP445（决策 1322）：会交给你在插件里发、又不用主管先批的（① 个人 / ② 同事互联，或落回本人）——卡标
   * `after.desk = 'plugin'`：**工坊不出卡**，到点直接进插件「等你发」，人在插件里点「发好了」= 批 + 发、「不发」= 不要。
   * 回 `desk: true` 告诉调用方（没排时间的这一条当「现在就到点」）。
   */
  const stagePost = async (
    actor: SocialActor,
    post: SocialPost,
    hits: readonly ScheduleConflict[],
  ): Promise<SocialStagedView & { desk?: boolean }> => {
    const account = accountOr404(post.account_id)
    const recipient = await recipientFor(actor, 'scope_manager')
    /*
     * WP483（决策 1658 / 1660）：没接官方接口、ego 能用、这条渠道 ego 做得了 → 走 ego：卡在工坊批（要批的先批），
     * 批了（到点）工坊自己在 ego 里发。ego 用不了才是插件「等你发」那一种。
     */
    const egoRoute =
      handsOff(post.channel) &&
      egoPostPlatformOf(post.channel) !== undefined &&
      options.ego?.available() === true
    const desk = handsOff(post.channel) && recipient.person === actor.person_id && !egoRoute
    const when =
      post.scheduled_at === undefined
        ? '没排时间：批了就发。'
        : `排在 ${post.scheduled_at} 自己出去——到点之后没有第二道门，所以门在这一下。`
    return stageOne({
      actor,
      action: SOCIAL_ACTIONS.stagePost,
      kind: 'social_post',
      target: { type: 'social_account', id: account.id },
      before: { status: 'draft' },
      after: {
        post_id: post.id,
        channel: post.channel,
        account_id: account.id,
        kind: post.kind,
        body: post.body,
        ...(post.scheduled_at === undefined ? {} : { scheduled_at: post.scheduled_at }),
        status: post.scheduled_at === undefined ? 'draft' : 'scheduled',
        ...(desk ? { desk: 'plugin' } : {}),
        ...(egoRoute ? { route: 'ego' } : {}),
      },
      notes: [when, ...conflictLines(hits)],
      title: `发布：${account.display_name}`,
      // 排期时间要**写在卡面上**：批了之后它会在那个时刻自己出去（36 §2）
      summary:
        post.scheduled_at === undefined
          ? post.body.slice(0, 120)
          : `${post.body.slice(0, 100)}（排在 ${post.scheduled_at}）` +
            (hits.length === 0 ? '' : ` ⚠ ${conflictLines(hits).join(' ')}`),
      seen: [{ type: 'social_account', id: account.id }],
      rule: 'scope_manager',
      recipient,
    }).then((v) => (desk && v.staged ? { ...v, desk: true } : v))
  }

  const postView = (
    post: SocialPost,
    hits: readonly ScheduleConflict[],
    staged: SocialStagedView,
  ): SocialPostView => {
    const blocking = hits.filter((h) => h.severity === 'conflict')
    const slot =
      blocking.length === 0 || post.scheduled_at === undefined
        ? undefined
        : nextFreeSlot({ account_id: post.account_id, body: post.body }, store.posts(), {
            now: clock.now(),
            from: post.scheduled_at,
            tz_offset_minutes: tz,
          })
    return {
      post: post as SocialPostRow,
      conflicts: conflictLines(hits),
      ...(slot === undefined ? {} : { next_free_slot: slot }),
      staged,
    }
  }

  /** WP249：自家版待处理（出卡走上面那个 `stageOne`——审批、额度只有一处）。 */
  const ownSub: OwnSubQueue | undefined =
    options.ownSub === undefined
      ? undefined
      : createOwnSubQueue({
          ...options.ownSub,
          workspace_id,
          store,
          clock,
          adapter: () => options.channels?.adapters.reddit,
          stage: stageOne,
          ledger,
          emit: (type, actor, payload) => emit(type, actor, payload),
        })
  /** WP254（决策 117）：别的社群的版务卡与回帖卡批了之后经渠道出口去做。 */
  const executor = createSocialExecutor({
    ...options.executor,
    ...(options.onSent === undefined ? {} : { onSent: options.onSent }),
    // WP483：没有回帖接口的渠道，ego 能用就工坊自己在 ego 里回
    ...(options.ego === undefined ? {} : { ego: options.ego }),
    workspace_id,
    store,
    clock,
    adapter: (channel) => options.channels?.adapters[channel],
    emit: (type, actor, payload) => emit(type, actor, payload),
    ledger,
  })

  /**
   * WP256（决策 147）：「群里的帖子」自动进帖——Discord 按频率读新消息，Reddit 自家版没人看视图时低频补读。
   * 只读、不出卡（人看了要回再点「回复」）。WP257：入库按规则判类打标签（仍不出卡），加 Telegram 群。
   */
  const ingest = createSocialIngest({
    workspace_id,
    store,
    clock,
    adapter: (channel) => options.channels?.adapters[channel],
    connected: (channel) =>
      channel === 'reddit' && ownSub !== undefined
        ? ownSub.route() !== 'none'
        : (options.channels?.transport.connected(channel) ?? false),
    emit: (type, actor, payload) => emit(type, actor, payload),
    blocked: (channel) => {
      if (channel !== 'reddit' || ownSub === undefined) return undefined
      const status = ownSub.browserStatus()
      return status.state === 'blocked'
        ? (status.message ?? 'Reddit 官方号被拦下了，去「自家版待处理」点「登录官方号」处理一下。')
        : undefined
    },
    ...(ownSub === undefined ? {} : { ownSub }),
    brandTerms: () => {
      const name = options.brandName?.().trim() ?? ''
      return name === '' ? [] : [name]
    },
    ...(options.tagReviewer === undefined
      ? {}
      : { tagReviewer: (channel: SocialChannel) => options.tagReviewer?.(channel) }),
    ...(options.modelReady === undefined
      ? {}
      : { modelReady: () => options.modelReady?.() === true }),
  })

  const ownSubOr501 = (): OwnSubQueue => {
    if (ownSub === undefined)
      throw new ApiError('not_implemented', '这个服务进程没有装配「自家版待处理」。')
    return ownSub
  }

  const port: SocialPort = {
    // ── WP256：「群里的帖子」自动进帖 ──
    ingestStatus: (actor, channel) => ingest.view(actor, channel),
    setIngestInterval: (actor, input) => ingest.setInterval(actor, input),
    setTagReview: (actor, input) => ingest.setTagReview(actor, input),

    // ── WP249：自家版待处理 + Reddit 官方号浏览器通道 ──
    ownSubQueue: (actor) => ownSubOr501().queue(actor),
    stageOwnSub: (actor, input) => ownSubOr501().stage(actor, input),
    ownSubThread: (actor, input) => ownSubOr501().thread(actor, input),
    redditBrowserStatus: () => ownSubOr501().browserStatus(),
    redditBrowserLogin: () => ownSubOr501().openLogin(),
    redditBrowserCheck: () => ownSubOr501().checkLogin(),
    redditBrowserClose: () => ownSubOr501().closeWindow(),

    // ── WP329：Reddit 写（起草 → 发出去卡 → 插件填草稿、人点发送 → 读回 → 发出记录）──
    ...(options.reddit?.redditDraft === undefined
      ? {}
      : { redditDraft: options.reddit.redditDraft }),
    ...(options.reddit?.redditStage === undefined
      ? {}
      : { redditStage: options.reddit.redditStage }),
    ...(options.reddit?.redditWrites === undefined
      ? {}
      : { redditWrites: options.reddit.redditWrites }),
    // WP332（决策 762）：没发出去的「再填一次」与收起提醒
    ...(options.reddit?.redditRefill === undefined
      ? {}
      : { redditRefill: options.reddit.redditRefill }),
    ...(options.reddit?.redditDismiss === undefined
      ? {}
      : { redditDismiss: options.reddit.redditDismiss }),
    // WP491：「修改」= 还原成当初那张审核卡
    ...(options.reddit?.redditRevise === undefined
      ? {}
      : { redditRevise: options.reddit.redditRevise }),

    accounts: (_actor, filter) => ({
      rows: store.accounts(
        filter.channel === undefined ? undefined : { channel: filter.channel },
      ) as SocialAccountRow[],
    }),

    createAccount: async (actor, input: SocialAccountInput) => {
      const row: SocialAccount = {
        id: nextId('sa'),
        workspace_id,
        channel: input.channel,
        handle: input.handle,
        display_name: input.display_name,
        url: input.url,
        external_id: input.external_id,
        ...(input.connection_id === undefined ? {} : { connection_id: input.connection_id }),
        // WP249：只有 Reddit 的版能标「自家版」（我们是版主，才有版务队列）
        ...(input.own_subreddit === true && input.channel === 'reddit'
          ? { own_subreddit: true }
          : {}),
        // 刚登记的号还没拉过数：`observed_at` 是"这一份资料什么时候看到的"，
        // 现在看到的就是用户自己填的这一份，所以就是此刻
        observed_at: clock.now(),
      }
      store.saveAccount(row)
      emit('social.account_created', actor.person_id, {
        account_id: row.id,
        channel: row.channel,
        role_id: actor.role_id,
      })
      // WP257（决策 155 / 156）：Discord 频道 / Telegram 群登记时读一次名字（只读一跳；读不到用默认名，下一轮再补）
      return (await ingest.named(row)) as SocialAccountRow
    },

    posts: (_actor, filter) => {
      const rows = store.posts({
        ...(filter.channel === undefined ? {} : { channel: filter.channel }),
        ...(filter.account_id === undefined ? {} : { account_id: filter.account_id }),
        ...(filter.status === undefined ? {} : { status: filter.status }),
      })
      return {
        rows: (filter.limit === undefined ? rows : rows.slice(0, filter.limit)) as SocialPostRow[],
      }
    },

    calendar: (_actor, filter): SocialCalendarView => {
      const now = clock.now()
      const from = filter.from ?? weekStart(now, tz)
      const to = filter.to ?? new Date(Date.parse(from) + 14 * 86_400_000).toISOString()
      const fromMs = Date.parse(from)
      const toMs = Date.parse(to)
      const all = store.posts()
      // 两周那两格由 `social-core` 算（面板与这一屏读的是同一份判据）
      const weeks = contentCalendar(all, { now, tz_offset_minutes: tz })
      const inRange = [...weeks.this_week.entries, ...weeks.next_week.entries].filter((e) => {
        const t = Date.parse(e.scheduled_at)
        return !Number.isNaN(t) && t >= fromMs && t < toMs
      })
      const cells: SocialCalendarCell[] = inRange.map((e) => {
        const post = store.post(e.post_id)
        const hits =
          post === undefined
            ? []
            : conflictsFor({
                id: post.id,
                account_id: post.account_id,
                scheduled_at: e.scheduled_at,
                body: post.body,
              })
        return {
          post_id: e.post_id,
          account_id: e.account_id,
          account_name: accountName(e.account_id),
          channel: e.channel as SocialChannel,
          kind: e.kind as SocialCalendarCell['kind'],
          status: e.status,
          scheduled_at: e.scheduled_at,
          preview: e.preview,
          conflicts: conflictLines(hits),
        }
      })
      // 行的顺序按 `SOCIAL_CHANNELS`（内容组在前，56 §0），不按这一屏碰巧的出现顺序
      const seen = new Set(cells.map((c) => c.channel))
      return {
        from,
        to,
        channels: SOCIAL_CHANNELS.map((c) => c.id).filter((c) => seen.has(c)),
        cells,
      }
    },

    async createPost(actor, input: SocialPostInput): Promise<SocialPostView> {
      const account = accountOr404(input.account_id)
      const post: SocialPost = {
        id: nextId('sp'),
        account_id: account.id,
        channel: account.channel,
        kind: input.kind,
        status: input.scheduled_at === undefined ? 'draft' : 'scheduled',
        body: input.body,
        ...(input.scheduled_at === undefined ? {} : { scheduled_at: input.scheduled_at }),
        ...(input.media_refs === undefined ? {} : { media_refs: input.media_refs }),
      }
      const hits =
        input.scheduled_at === undefined
          ? []
          : conflictsFor({
              account_id: account.id,
              scheduled_at: input.scheduled_at,
              body: input.body,
            })
      store.savePost(post)
      const { desk, ...staged } = await stagePost(actor, post, hits)
      // WP445：插件里审的、没排时间的——当「现在就到点」，下一拍交给插件「等你发」
      if (desk === true && post.scheduled_at === undefined)
        store.savePost({ ...post, status: 'scheduled', scheduled_at: clock.now() })
      emit('social.post_staged', actor.person_id, {
        post_id: post.id,
        channel: post.channel,
        ...(post.scheduled_at === undefined ? {} : { scheduled_at: post.scheduled_at }),
        conflicts: hits.map((h) => h.kind),
        staged: staged.staged,
      })
      return postView(post, hits, staged)
    },

    async reschedulePost(actor, id, input): Promise<SocialPostView> {
      const post = store.post(id)
      if (post === undefined) throw new ApiError('not_found', `没有这条帖子：${id}`)
      if (post.status === 'published')
        throw new ApiError('invalid_input', '这一条已经发出去了，改不了排期。')
      const hits = conflictsFor({
        id: post.id,
        account_id: post.account_id,
        scheduled_at: input.scheduled_at,
        body: post.body,
      })
      const moved: SocialPost = { ...post, scheduled_at: input.scheduled_at, status: 'scheduled' }
      store.savePost(moved)
      // 换个时间发也是一次发布：**重新出一张卡**（`social_post` 永远 L1）
      const { desk: _desk, ...staged } = await stagePost(actor, moved, hits)
      emit('social.post_rescheduled', actor.person_id, {
        post_id: post.id,
        channel: post.channel,
        from: post.scheduled_at ?? null,
        to: input.scheduled_at,
        conflicts: hits.map((h) => h.kind),
        staged: staged.staged,
      })
      return postView(moved, hits, staged)
    },

    threads: (_actor, filter) => ({
      rows: store
        .threads({
          ...(filter.channel === undefined ? {} : { channel: filter.channel }),
          ...(filter.account_id === undefined ? {} : { account_id: filter.account_id }),
          ...(filter.open === undefined ? {} : { open: filter.open }),
          ...(filter.surface === undefined ? {} : { surface: filter.surface }),
        })
        .map(threadRow),
    }),

    async ingestThread(actor, input: SocialThreadInput): Promise<SocialThreadView> {
      const account = accountOr404(input.account_id)
      const row: CommunityThread = {
        id: nextId('ct'),
        account_id: account.id,
        channel: account.channel,
        external_id: input.external_id,
        surface: input.surface,
        author_external_id: input.author_external_id,
        author_handle: input.author_handle,
        // 纪律 4：外部文本原样存
        text: input.text,
        created_at: input.created_at ?? clock.now(),
        status: 'open',
      }
      store.saveThread(row)

      /*
       * ① 判类（纪律 1）。**封闭六类**，判不准落 `other` 不猜。
       */
      const verdict = triageThread({
        text: input.text,
        is_dm: input.surface === 'dm',
        mentions_us: true,
      })
      const handoff = handoffOf(verdict, {
        channel: account.display_name,
        author_handle: input.author_handle,
      })

      const base: SocialThreadView = {
        thread: threadRow({ ...row, triage: verdict.klass }),
        triage: verdict.klass,
        signals: verdict.signals,
        route: verdict.route,
      }

      /*
       * ② 客户问题 → **一张转客服卡，社媒运营不答**（56 的边界行）。
       *
       * 卡是 `claim`（"接 / 不接"）：它不是一条变更，是一件活儿交给另一条职责。
       * 收件人是真持有那条职责的人；没人持有就落到 owner 身上。
       */
      if (handoff !== undefined && verdict.route === 'support') {
        const holder = options.holdersOf(handoff.to_role)[0]?.person_id
        const to = holder ?? (await options.owner()) ?? actor.person_id
        const item = await approvals.create({
          workspace_id,
          schema_version: 1,
          kind: 'claim',
          role_id: handoff.to_role,
          subject: { object: { type: 'community_thread', id: row.id } },
          dedupe_key: `${workspace_id}:social_handoff:${row.id}`,
          title: handoff.title,
          summary: handoff.reason,
          payload: {
            form: 'support_handoff',
            channel: account.channel,
            account: account.display_name,
            thread_id: row.id,
            author: input.author_handle,
            triage: verdict.klass,
            route_to_role: handoff.to_role,
            route_to_label: '社群管理',
            // 正文进卡（人本来就要读它），**不进事件日志**（纪律 4）
            text: input.text,
          },
          evidence: {
            source_events: [],
            provenance: { seen: [{ type: 'community_thread', id: row.id }] },
            precheck: { fencing: 'ok' },
          },
          proposer: {
            kind: 'agent',
            id: `agent_${actor.role_id}`,
            assignment_id: actor.assignment_id,
          },
          automation: { level_at_creation: 'L1' },
          routing: {
            recipients: [{ person: to as never, via: 'explicit' }],
            explicit: to as never,
            rule: 'explicit',
            escalation: {
              after_hours: 4,
              business_hours: true,
              chain: ['owner'],
              escalated_at: [],
            },
            separation_of_duties: false,
          },
          priority: 'queue',
        })
        store.recordTriage({
          thread_id: row.id,
          triage: verdict.klass,
          ...(item.state === 'blocked' ? {} : { routed_approval_id: item.id }),
        })
        emit('social.thread_routed_to_support', actor.person_id, {
          thread_id: row.id,
          channel: account.channel,
          triage: verdict.klass,
          // 判据名进日志，原句不进
          signals: verdict.signals,
          to_role: handoff.to_role,
          held_by: holder ?? null,
          answered_by_social: false,
        })
        return {
          ...base,
          thread: threadRow({
            ...row,
            triage: verdict.klass,
            status: 'routed_to_support',
            ...(item.state === 'blocked' ? {} : { routed_approval_id: item.id }),
          }),
          ...(item.state === 'blocked' ? {} : { approval_item_id: item.id }),
        }
      }

      /*
       * ③ 不是客户问题 → 社媒运营自己处理。按群规匹配一遍：违规的出一张审核卡，
       *    没违规的就只是记一条分类结论（面板上那一块会看到它）。
       */
      store.recordTriage({ thread_id: row.id, triage: verdict.klass })
      const rules = options.rulesOf?.(account.id) ?? DEFAULT_COMMUNITY_RULES
      const prior = store.threads({ account_id: account.id }).filter(
        // WP257：自动进帖只打了标签的不算「前科」（那一步没人看过、也没出卡）
        (t) =>
          t.author_external_id === input.author_external_id &&
          t.triage === 'spam' &&
          t.triage_by === undefined,
      ).length
      const verdictM = moderate({ text: input.text, rules, prior_offenses: prior })
      const moderation = {
        action: verdictM.action,
        needs_approval: verdictM.needs_approval,
        reason: verdictM.reason,
        matched_rules: verdictM.matched_rules.map((r) => r.text),
      }
      if (verdictM.action === 'none') {
        emit('social.thread_triaged', actor.person_id, {
          thread_id: row.id,
          channel: account.channel,
          triage: verdict.klass,
          signals: verdict.signals,
        })
        return { ...base, moderation }
      }

      const staged = await stageOne({
        actor,
        action: SOCIAL_ACTIONS.moderate,
        kind: 'community_moderation',
        target: { type: 'community_thread', id: row.id },
        before: { status: 'open' },
        after: {
          action: verdictM.action,
          channel: account.channel,
          account_id: account.id,
          target_external_id:
            verdictM.action === 'delete_post' ? row.external_id : input.author_external_id,
          matched_rules: verdictM.matched_rules.map((r) => r.id),
          reason: verdictM.reason,
          // WP254：卡面那几格（改动卡「批准执行 / 不做」要把将执行什么、原话、依据写清）
          ...moderationCardFields(account, verdictM.action, {
            author: input.author_handle,
            text: input.text,
            rules: verdictM.matched_rules.map((r) => r.text),
          }),
        },
        notes: [verdictM.reason],
        title: `${ACTION_WORDS[verdictM.action]}：${input.author_handle}（${account.display_name}）`,
        summary: `${verdictM.reason} 原话：${input.text.slice(0, 120)}`,
        seen: [{ type: 'community_thread', id: row.id }],
        rule: 'role_holder',
      })
      emit('social.moderation_staged', actor.person_id, {
        thread_id: row.id,
        channel: account.channel,
        action: verdictM.action,
        matched_rules: verdictM.matched_rules.map((r) => r.id),
        needs_approval: verdictM.needs_approval,
        staged: staged.staged,
      })
      return {
        ...base,
        moderation,
        ...(staged.approval_item_id === undefined
          ? {}
          : { approval_item_id: staged.approval_item_id }),
      }
    },

    async moderateThread(actor, id, input): Promise<SocialStagedView> {
      const thread = store.thread(id)
      if (thread === undefined) throw new ApiError('not_found', `没有这条线程：${id}`)
      const account = accountOr404(thread.account_id)
      const action = input.action as ModerationAction
      return stageOne({
        actor,
        action: SOCIAL_ACTIONS.moderate,
        kind: 'community_moderation',
        target: { type: 'community_thread', id: thread.id },
        before: { status: thread.status },
        after: {
          action,
          channel: thread.channel,
          account_id: account.id,
          target_external_id:
            action === 'delete_post' ? thread.external_id : thread.author_external_id,
          ...(input.reason === undefined ? {} : { reason: input.reason }),
          ...moderationCardFields(account, action, {
            author: thread.author_handle,
            text: thread.text,
          }),
        },
        notes: [
          input.reason ??
            `${ACTION_WORDS[action]}：${thread.author_handle} 在 ${account.display_name} 里的这一条。`,
        ],
        title: `${ACTION_WORDS[action]}：${thread.author_handle}（${account.display_name}）`,
        summary: `原话：${thread.text.slice(0, 120)}`,
        seen: [{ type: 'community_thread', id: thread.id }],
        rule: 'role_holder',
      })
    },

    /*
     * WP254（决策 117）：回一条线程 = 一张**回帖卡**（`outbound_draft`，56 §2 那一列写的是
     * `outbound_message`——回一条评论不是一条变更）。形状与模拟世界那张同一个（`form: 'social_reply'`）。
     * 批了由执行器经这条渠道的出口发出去；正文带第一人称承诺 / 无依据让步就打回（不出卡）。
     */
    async replyThread(actor, id, input): Promise<SocialStagedView> {
      const thread = store.thread(id)
      if (thread === undefined) throw new ApiError('not_found', `没有这条线程：${id}`)
      const account = accountOr404(thread.account_id)
      const text = input.text.trim()
      const scan = checkOutbound(text)
      if (!scan.ok) throw new ApiError('invalid_input', replyBlockedReason(scan))
      const channel_label = socialChannelSpec(thread.channel)?.zh ?? thread.channel
      const target: ObjectRef = { type: 'community_thread', id: thread.id }
      const { level } = actionOf(actor.assignment_id, SOCIAL_ACTIONS.replyThread)
      const run_id = `run_social_${nextId('r')}`
      const item = await approvals.create({
        workspace_id,
        schema_version: 1,
        kind: 'outbound_draft',
        role_id: actor.role_id,
        subject: { object: target },
        dedupe_key: `${workspace_id}:social_reply:${thread.id}:${nextId('d')}`,
        title: `回${thread.surface === 'dm' ? '私信' : '帖子'}：${thread.author_handle}（${channel_label} · ${account.display_name}）`,
        summary: text.slice(0, 120),
        payload: {
          form: SOCIAL_REPLY_FORM,
          channel: thread.channel,
          channel_label: `${channel_label} · ${account.display_name}`,
          account_id: account.id,
          thread_id: thread.id,
          to: target,
          author: thread.author_handle,
          // 回的是哪一句（人批之前要看见；外部文本，只上卡不进事件）
          in_reply_to: thread.text.slice(0, 300),
          body: { text },
        },
        evidence: {
          source_events: [],
          run_id,
          provenance: { seen: [target] },
          precheck: {},
        },
        proposer: { kind: 'person', id: actor.person_id, assignment_id: actor.assignment_id },
        // 回帖卡一律人点（批了就发出去、收不回来）；配置的等级只记进事件，不据此自动放行
        automation: {
          level_at_creation: 'L1',
          auto_approved: false,
          mandate_check: { within: true, caps_hit: [] },
          sampling: { selected: false },
        },
        routing: {
          recipients: [await recipientFor(actor, 'role_holder')],
          rule: 'role_holder',
          escalation: {
            after_hours: 12,
            business_hours: true,
            chain: ['scope_manager'],
            escalated_at: [],
          },
          separation_of_duties: false,
        },
        priority: 'queue',
        context: {
          // 31 §3.3 收件人门禁：回的是这条线程里的人，不是我们自己挑的地址
          thread_participants: [thread.id],
          gates: [
            {
              gate: 'commitment_scan' as const,
              status: 'pass' as const,
              ruleset_hash: 'support-core/commitment',
              evidence: { hits: 0 },
            },
          ],
        },
      })
      emit('social.reply_staged', actor.person_id, {
        thread_id: thread.id,
        channel: thread.channel,
        configured_level: level,
        blocked: item.state === 'blocked',
      })
      if (item.state === 'blocked')
        return {
          staged: false,
          message: `没出卡：前置检查没过（${Object.entries(item.evidence.precheck)
            .filter(([, v]) => v !== 'ok')
            .map(([k]) => k)
            .join('、')}）`,
          level: 'L1',
        }
      return { staged: true, approval_item_id: item.id, level: 'L1' }
    },

    /*
     * WP255（决策 144）：给「回复」框起草一句。只起草：不出卡、不落库；事件只记 id 与来源，不记正文。
     * 起草出来的这句自己过不了承诺扫描就带上那句改写要求（人改掉再出卡，否则出卡那一步打回）。
     */
    async draftReply(actor, id): Promise<SocialReplyDraftView> {
      const thread = store.thread(id)
      if (thread === undefined) throw new ApiError('not_found', `没有这条线程：${id}`)
      const account = accountOr404(thread.account_id)
      const input = {
        channel_label: socialChannelSpec(thread.channel)?.zh ?? thread.channel,
        account_name: account.display_name,
        surface: thread.surface,
        author: thread.author_handle,
        text: thread.text,
      }
      const drafter = options.replyDrafter?.(actor)
      const ai = drafter === undefined ? undefined : await drafter(input).catch(() => undefined)
      const text = ai ?? templateReply(input)
      const scan = checkOutbound(text)
      emit('social.reply_drafted', actor.person_id, {
        thread_id: thread.id,
        channel: thread.channel,
        source: ai === undefined ? 'template' : 'ai',
        flagged: !scan.ok,
      })
      return {
        text,
        source: ai === undefined ? 'template' : 'ai',
        ...(ai === undefined ? { note: '这次没用 AI：先给一句开头，你接着写。' } : {}),
        ...(scan.ok ? {} : { warning: replyBlockedReason(scan) }),
      }
    },

    async broadcast(actor, input: SocialBroadcastInput): Promise<SocialBroadcastView> {
      const account = accountOr404(input.account_id)
      const all = store.members({ account_id: account.id })
      const nowMs = Date.parse(clock.now())

      /*
       * ① 受众三选一。三条都只看**群里那份名册**——标签是运营自己打的，
       *    活跃是"最近说过话"。一格顾客数据都不碰（这条职责没有 `customer` 域）。
       */
      const pool = all
        .filter((m) => m.status === 'active')
        .filter((m) =>
          input.audience === 'tagged'
            ? (m.tags ?? []).includes(input.tag ?? '')
            : input.audience === 'active_30d'
              ? m.last_active_at !== undefined &&
                nowMs - Date.parse(m.last_active_at) <= 30 * 86_400_000
              : true,
        )
        .map((m) => m.external_id)

      /*
       * ② 抑制名单（全仓那一份规则）。不给注入就按库里那份保守的：
       *    自己退群 / 被封的那些人。
       */
      const suppression =
        options.suppressionList?.() ??
        all.filter((m) => m.status === 'left' || m.status === 'banned').map((m) => m.external_id)
      const audience = buildAudience({
        members: pool,
        suppression_list: suppression,
        now: clock.now(),
        // `last_sent_at` 这条渠道上还没记过——**不假装判过**（见 `buildAudience` 的注释）
      })

      /*
       * ③ 文案过承诺扫描（与客服回信、开发信同一份词表），再过一遍
       *    `checkBroadcast`（WhatsApp 的模板与 opt-in 两道硬闸在里面）。
       */
      const scan = checkOutbound(input.body)
      const proposal = {
        channel: account.channel,
        account_id: account.id,
        body: input.body,
        audience: audience.recipients,
        suppressed: audience.suppressed,
        audience_size: audience.recipients.length,
        suppression_checked: true as const,
        ...(input.template_id === undefined ? {} : { template_id: input.template_id }),
        ...(input.opt_in_verified === undefined ? {} : { opt_in_verified: input.opt_in_verified }),
      }
      const check = checkBroadcast(proposal)
      const problems = [...check.problems, ...(scan.ok ? [] : [scan.rewrite_instruction])]

      const view: SocialBroadcastView = {
        channel: account.channel,
        account_id: account.id,
        audience_size: audience.recipients.length,
        suppressed: audience.suppressed.length,
        too_soon: audience.too_soon.length,
        note: audience.note,
        problems,
        staged: { staged: false },
      }
      if (problems.length > 0) {
        // 自查没过就**不提**：早点给反馈，真正的拦在 guardrail（18 §3 fail-closed）
        emit('social.broadcast_blocked', actor.person_id, {
          account_id: account.id,
          channel: account.channel,
          problems,
        })
        return { ...view, staged: { staged: false, message: problems.join(' ') } }
      }

      /*
       * ④ 群发本身在库里也是一条帖子（面板上「群发队列」那一块读的就是它），
       *    收件人名单留在**卡上**（`after.audience`）——guardrail 认的是那几格。
       */
      const post: SocialPost = {
        id: nextId('sb'),
        account_id: account.id,
        channel: account.channel,
        kind: 'post',
        status: 'scheduled',
        body: input.body,
        scheduled_at: clock.now(),
      }
      store.savePost(post)
      const staged = await stageOne({
        actor,
        action: SOCIAL_ACTIONS.stageBroadcast,
        kind: 'community_broadcast',
        target: { type: 'community_member', id: account.id },
        before: null,
        after: {
          post_id: post.id,
          channel: account.channel,
          account_id: account.id,
          body: input.body,
          audience: audience.recipients,
          suppressed: audience.suppressed,
          audience_size: audience.recipients.length,
          // guardrail 认的就是这一格：没报就 block（"没问过"与"问过了没人"分得开）
          suppression_checked: true,
          ...(input.template_id === undefined ? {} : { template_id: input.template_id }),
          ...(input.opt_in_verified === undefined
            ? {}
            : { opt_in_verified: input.opt_in_verified }),
        },
        notes: [audience.note],
        title: `群发：${account.display_name}`,
        // 受众数与剔除数**写在卡面上**（56 §2 那一行）
        summary: `${input.body.slice(0, 100)}（${audience.note}）`,
        seen: [{ type: 'social_account', id: account.id }],
        rule: 'scope_manager',
      })
      if (!staged.staged) store.savePost({ ...post, status: 'draft' })
      emit('social.broadcast_staged', actor.person_id, {
        post_id: post.id,
        channel: account.channel,
        audience_size: audience.recipients.length,
        suppressed_removed: audience.suppressed.length,
        staged: staged.staged,
      })
      return { ...view, staged }
    },

    members: (_actor, filter) => ({
      rows: store.members({
        ...(filter.channel === undefined ? {} : { channel: filter.channel }),
        ...(filter.account_id === undefined ? {} : { account_id: filter.account_id }),
        ...(filter.pending === undefined ? {} : { pending: filter.pending }),
      }) as SocialMemberRow[],
    }),

    async decideMember(actor, id, input): Promise<SocialStagedView> {
      const member: CommunityMember | undefined = store.members().find((m) => m.id === id)
      if (member === undefined) throw new ApiError('not_found', `没有这条入群申请：${id}`)
      if (member.status !== 'pending')
        throw new ApiError('invalid_input', `这个人已经不是待审状态了（现在是 ${member.status}）`)
      const account = accountOr404(member.account_id)
      const word = input.decision === 'approve' ? '批准' : '拒绝'
      return stageOne({
        actor,
        action: SOCIAL_ACTIONS.approveMember,
        kind: 'community_membership',
        target: { type: 'community_member', id: member.id },
        before: { status: 'pending' },
        after: {
          decision: input.decision,
          status: input.decision === 'approve' ? 'active' : 'left',
          channel: member.channel,
          account_id: account.id,
          member_external_id: member.external_id,
          ...(input.reason === undefined ? {} : { reason: input.reason }),
        },
        notes: [
          // 申请答案原样进卡（人要按它判这是不是广告号），**不进事件日志**
          member.application_answers === undefined || member.application_answers.length === 0
            ? '他没填申请答案。'
            : `他填的答案：${member.application_answers.join('；')}`,
        ],
        title: `${word}入群：${member.handle}（${account.display_name}）`,
        summary:
          `${member.display_name ?? member.handle} 递了入群申请。` +
          (member.application_answers === undefined || member.application_answers.length === 0
            ? '他没填答案。'
            : `答案：${member.application_answers.join('；')}`),
        seen: [{ type: 'community_member', id: member.id }],
        rule: 'role_holder',
      })
    },
  }

  /**
   * 到点了的那些真发出去（56 §6 定时方）。
   *
   * 三条：
   *
   * 1. **只发批准过的**。"这条排期批了没有"只有账本知道——所以这里去
   *    `ledger.list({ kind: 'social_post' })` 里找这条帖子那一条变更，
   *    状态是 `approved` / `auto_approved` / `applied` 才发。没批的到点了也不发，
   *    照实记一句（`skipped`）。
   * 2. **发失败不重试**。写回 `failed` + 平台原话（不翻译成"出错了"），
   *    面板上那条会单独摆着，人看得见。重试一条可能已经发出去的帖子，
   *    代价是关注的人看到两条一样的。
   * 3. **没装适配器就照实说**。排期、草稿、审批照常，只是最后那一跳说
   *    "这条渠道还没接上"。
   */
  /** WP323：发出去了一条 → 记进发出记录（记不上不挡发送结果）。 */
  const recordSent = (input: OutboundRecordInput): void => {
    try {
      options.onSent?.(input)
    } catch {
      // 记不上不挡发送结果
    }
  }

  /*
   * ── WP483（决策 1658 / 1660）：社媒发帖的 ego 那一路 ──────────────────────────────────
   * 发出去 → `published`（`published_via: 'ego'`，读回了链接 `readback: 'link'`，没读回 `clicked`）+ 发出记录；
   * 「发之前让我看一眼」→ 填好留在 ego 里 + 交给你（插件「等你发」/ 待办照旧能点「发好了」），之后隔一阵读回；
   * ego 交给人 → 下一轮接着做；没登录 / 选择器对不上 / ego 用不了 → 退插件（交给你发），说一句原因；
   * 平台拦了、或点过发布没确认 → 停下（`failed` + 原因），不绕、不换路重发。
   */
  const egoPublish = async (
    post: SocialPost,
    who: { assignment_id?: string; role_id?: string },
    toManual: (reason: string) => boolean,
    out: SocialPublishSweep,
  ): Promise<void> => {
    const ego = options.ego
    const platform = egoPostPlatformOf(post.channel)
    if (ego === undefined || platform === undefined) return
    const account = store.account(post.account_id)
    const refs = post.media_refs ?? []
    if (refs.length === 0 && EGO_MEDIA_REQUIRED.has(platform)) {
      toManual(egoWriteSentence({ state: 'failed', why: '这条要带图 / 视频，帖子上没挂素材' }))
      return
    }
    const media =
      refs.length === 0
        ? { files: [] as string[], cleanup: () => undefined }
        : ((await ego.media?.(refs).catch((e: unknown) => ({ why: String(e) }))) ?? {
            why: '这台机器取不到帖子素材',
          })
    if ('why' in media) {
      toManual(egoWriteSentence({ state: 'failed', why: `素材取不到：${media.why}` }))
      return
    }
    const review = ego.reviewFirst?.(who) === true
    const prev = post.ego
    const resume = prev?.state === 'needs_human' ? prev.space_id : undefined
    store.savePost({
      ...post,
      ego: { ...(prev ?? {}), state: 'running', tries: (prev?.tries ?? 0) + 1 },
    })
    let r: EgoWriteResult
    try {
      r = await ego
        .run({
          platform,
          mode: 'write',
          ...(post.channel === 'facebook' && account?.url !== undefined
            ? { url: account.url }
            : {}),
          ...(account?.url === undefined ? {} : { readback_url: account.url }),
          text: post.body,
          files: media.files,
          submit: !review,
          ...(resume === undefined ? {} : { resume }),
          space: `工坊 · 发帖 ${post.id}`,
        })
        .catch((e: unknown): EgoWriteResult => ({ state: 'unavailable', platform, why: String(e) }))
    } finally {
      media.cleanup()
    }
    const cur = store.post(post.id) ?? post
    const progress = cur.ego ?? { state: 'running' as const, tries: 1 }
    const note = egoWriteSentence(r)
    const at = clock.now()
    emit('social.post_ego', 'system' as never, {
      post_id: post.id,
      channel: post.channel,
      state: r.state,
      next: egoWriteNext(r),
      ...(r.clicked === true ? { clicked: true } : {}),
    })
    switch (egoWriteNext(r)) {
      case 'done': {
        store.savePost({
          ...cur,
          status: 'published',
          published_at: at,
          published_via: 'ego',
          readback: r.link === undefined ? 'clicked' : 'link',
          ...(r.link === undefined ? {} : { post_url: r.link }),
          ...(r.external_id === undefined ? {} : { external_id: r.external_id }),
          ego: { ...progress, state: 'sent', note },
        })
        out.published += 1
        emit('social.post_published', 'system' as never, {
          post_id: post.id,
          channel: post.channel,
          via: 'ego',
          readback: r.link === undefined ? 'clicked' : 'link',
        })
        recordSent({
          source_key: `post:${post.id}`,
          channel: post.channel,
          action: 'post',
          kind: 'social_post',
          ...(account === undefined ? {} : { destination: account.display_name }),
          content: post.body,
          ...(r.link === undefined ? {} : { link: r.link }),
          ...(r.external_id === undefined ? {} : { external_id: r.external_id }),
        })
        return
      }
      case 'review': {
        toManual(note)
        const after = store.post(post.id) ?? cur
        store.savePost({
          ...after,
          ego: {
            ...progress,
            state: 'filled',
            since: at,
            checks: 0,
            next_check_at: new Date(
              Date.parse(at) + (EGO_READBACK_DELAYS_MS[0] ?? 120_000),
            ).toISOString(),
            ...(r.space_id === undefined ? {} : { space_id: r.space_id }),
            note,
          },
        })
        return
      }
      case 'wait_human': {
        store.savePost({
          ...cur,
          ego: {
            ...progress,
            state: 'needs_human',
            since: prev?.state === 'needs_human' && prev.since !== undefined ? prev.since : at,
            ...(r.space_id === undefined ? {} : { space_id: r.space_id }),
            note,
          },
        })
        out.skipped.push({ post_id: post.id, reason: note })
        emit('social.post_needs_human', 'system' as never, {
          post_id: post.id,
          channel: post.channel,
          note,
        })
        return
      }
      case 'stop': {
        store.savePost({
          ...cur,
          status: 'failed',
          failure_reason: note,
          ego: { ...progress, state: 'stopped', note },
        })
        out.failed += 1
        emit('social.post_failed', 'system' as never, {
          post_id: post.id,
          channel: post.channel,
          reason: r.clicked === true ? 'ego_unconfirmed' : 'ego_blocked',
        })
        return
      }
      case 'plugin': {
        store.savePost({ ...cur, ego: { ...progress, state: 'fell_back', note } })
        if (!toManual(note)) out.skipped.push({ post_id: post.id, reason: note })
        return
      }
    }
  }

  /** 「发之前让我看一眼」：填好留在 ego 里的那几条，到点回去读一次（主页上有没有这一条）。 */
  const egoReadbacks = async (): Promise<void> => {
    const ego = options.ego
    if (ego === undefined || !ego.available()) return
    const nowMs = Date.parse(clock.now())
    for (const post of store.posts({ status: 'scheduled' })) {
      const g = post.ego
      if (g?.state !== 'filled' || g.next_check_at === undefined) continue
      if (Date.parse(g.next_check_at) > nowMs) continue
      const platform = egoPostPlatformOf(post.channel)
      const account = store.account(post.account_id)
      if (platform === undefined || account?.url === undefined) continue
      const r = await ego
        .run({
          platform,
          mode: 'readback',
          url: account.url,
          text: post.body,
          submit: false,
          space: `工坊 · 读回 ${post.id}`,
        })
        .catch((): EgoWriteResult => ({ state: 'failed', platform }))
      if (r.state === 'sent') {
        const done = answerHandoffAs(
          post.id,
          { done: true, ...(r.link === undefined ? {} : { link: r.link }), by: 'system' },
          'ego',
        )
        if (done !== undefined) store.savePost({ ...done, ego: { ...g, state: 'sent' } })
        continue
      }
      const checks = (g.checks ?? 0) + 1
      const wait = EGO_READBACK_DELAYS_MS[checks]
      const { next_check_at: _drop, ...rest } = g
      store.savePost({
        ...post,
        ego: {
          ...rest,
          checks,
          ...(wait === undefined ? {} : { next_check_at: new Date(nowMs + wait).toISOString() }),
        },
      })
    }
  }

  const publishDue = async (): Promise<SocialPublishSweep> => {
    // WP254：顺手补扫批了、过了取消窗口还没施行的版务卡与回帖卡（批准那一刻排的那一次可能随进程重启丢了）
    await executor.sweep().catch(() => 0)
    const now = clock.now()
    const nowMs = Date.parse(now)
    const due = store
      .posts({ status: 'scheduled' })
      // WP419：已经交给人发的不再按到点重发
      .filter(
        (p) =>
          p.scheduled_at !== undefined &&
          Date.parse(p.scheduled_at) <= nowMs &&
          p.handoff === undefined,
      )
    const out: SocialPublishSweep = { due: due.length, published: 0, failed: 0, skipped: [] }
    // WP483：「发之前让我看一眼」填好在 ego 里的那几条，到点回去读一次人发了没有
    await egoReadbacks()
    if (due.length === 0) return out

    const changes = await ledger.list({ workspace_id, kind: 'social_post' })
    /*
     * WP445（决策 1322）：插件里审的那几条（卡标 `desk: 'plugin'`、还没定 / 卡过期了）——到点了直接交给插件「等你发」，
     * 人在插件里点「发好了」才算批 + 发（发布永远人点，门挪到了插件里那一下）。
     */
    const deskPosts = new Set(
      changes
        .filter(
          (ch) =>
            (ch.status === 'staged' || ch.status === 'expired') &&
            (ch.after as { desk?: string } | null)?.desk === 'plugin',
        )
        .map((ch) => (ch.after as { post_id?: string } | null)?.post_id)
        .filter((x): x is string => typeof x === 'string'),
    )
    const approvedPosts = new Set(
      changes
        .filter(
          (ch) =>
            ch.status === 'approved' || ch.status === 'auto_approved' || ch.status === 'applied',
        )
        .map((ch) => (ch.after as { post_id?: string } | null)?.post_id)
        .filter((x): x is string => typeof x === 'string'),
    )
    // WP483：批过的那张卡（谁发起的：查岗位上「发之前让我看一眼」）
    const approvedChange = new Map(
      changes
        .filter(
          (ch) =>
            ch.status === 'approved' || ch.status === 'auto_approved' || ch.status === 'applied',
        )
        .flatMap((ch) => {
          const id = (ch.after as { post_id?: string } | null)?.post_id
          return typeof id === 'string' ? [[id, ch] as const] : []
        }),
    )

    for (const post of due) {
      const desk = !approvedPosts.has(post.id) && deskPosts.has(post.id)
      if (!approvedPosts.has(post.id) && !desk) {
        // 没批的到点了也不发（发布永远人审；门在"排"那一下，不是"到点"那一下）
        out.skipped.push({ post_id: post.id, reason: '这条排期还没人点头，到点了也不发。' })
        continue
      }
      const adapter = options.channels?.adapters[post.channel]
      /*
       * WP419（决策 1231）：内容账号组到点了官方接口发不出去（没接 / 没批 / 这一版不能代发）→ 交给人在自己登录着的
       * 后台里发：帖子挂上「交给你了」（插件侧边栏里打开发帖页、人点发布、回来点「发好了」），同时开一条待办兜底。
       * WP191 的 LinkedIn 待办并进这里（所有内容渠道都这样，不只 LinkedIn）。社群组照旧。
       */
      const toManual = (reason: string): boolean => {
        if (socialChannelSpec(post.channel)?.group !== 'content') return false
        const label = socialChannelSpec(post.channel)?.zh ?? post.channel
        const task = options.manualPublishTask?.({
          post,
          account: store.account(post.account_id),
          channel_label: label,
          reason,
        })
        store.savePost({
          ...(store.post(post.id) ?? post),
          handoff: {
            at: now,
            reason,
            ...(task === undefined ? {} : { todo_id: task.todo_id }),
            ...(task?.owner === undefined ? {} : { owner: task.owner }),
          },
        })
        if (task !== undefined)
          out.manual_tasks = [
            ...(out.manual_tasks ?? []),
            { post_id: post.id, todo_id: task.todo_id },
          ]
        out.handed_off = [...(out.handed_off ?? []), post.id]
        out.skipped.push({
          post_id: post.id,
          reason: `${label}这一条到点了，官方接口发不出去（${reason}）——已交给你：插件侧边栏里打开发帖页、你点发布${task === undefined ? '' : '；也开了一条待办'}。`,
        })
        emit('social.post_handoff', 'system' as never, {
          post_id: post.id,
          channel: post.channel,
          ...(task === undefined ? {} : { todo_id: task.todo_id }),
        })
        return true
      }
      // WP445：插件里审的那一条：只交给人（绝不经接口发）
      if (desk) {
        if (!toManual('在插件里由你看一眼、自己点发布'))
          out.skipped.push({ post_id: post.id, reason: '这一条要在插件里由你发，但交不过去。' })
        continue
      }
      /*
       * WP483（决策 1658 / 1660）：没接官方接口（或没接上）、ego 能用、这条渠道 ego 做得了 → 工坊自己在 ego 里发。
       * ego 交给人（权限框）的那一条到点了还在这个列表里：接着做（等太久退插件）。
       */
      if (
        handsOff(post.channel) &&
        egoPostPlatformOf(post.channel) !== undefined &&
        options.ego?.available() === true
      ) {
        const prev = post.ego
        if (
          prev?.state === 'needs_human' &&
          Date.parse(now) - Date.parse(prev.since ?? now) > EGO_HUMAN_WAIT_MS
        ) {
          store.savePost({ ...post, ego: { ...prev, state: 'fell_back' } })
          toManual(
            `ego 里那个框等了 ${Math.round(EGO_HUMAN_WAIT_MS / 60_000)} 分钟没人处理，改交给你发`,
          )
          continue
        }
        const change = approvedChange.get(post.id)
        await egoPublish(
          post,
          {
            ...(change?.assignment_id === undefined
              ? {}
              : { assignment_id: String(change.assignment_id) }),
            ...(change?.role_id === undefined ? {} : { role_id: String(change.role_id) }),
          },
          toManual,
          out,
        )
        continue
      }
      if (adapter?.publish === undefined) {
        if (toManual('这条渠道现在没接上')) continue
        out.skipped.push({
          post_id: post.id,
          reason: `${post.channel} 这条渠道现在发不出去（还没接上，或者这条渠道没有发布接口）。到点了，去后台手工发一下。`,
        })
        continue
      }
      const account = store.account(post.account_id)
      if (account === undefined) {
        out.skipped.push({ post_id: post.id, reason: '这条帖子挂的那个号已经不在了。' })
        continue
      }
      const result = await adapter.publish({
        account_external_id: account.external_id,
        kind: post.kind,
        body: post.body,
        ...(post.media_refs === undefined ? {} : { media_urls: post.media_refs }),
        // **到点了才调这一跳**，所以不带 `scheduled_at`：排期是我们自己的调度器管的
      })
      if (result.ok) {
        store.savePost({
          ...post,
          status: 'published',
          published_at: now,
          external_id: result.data.external_id,
        })
        out.published += 1
        emit('social.post_published', 'system' as never, {
          post_id: post.id,
          channel: post.channel,
          external_id: result.data.external_id,
        })
        recordSent({
          source_key: `post:${post.id}`,
          channel: post.channel,
          action: 'post',
          kind: 'social_post',
          destination: account.display_name,
          content: post.body,
          ...(result.data.external_id === '' ? {} : { external_id: result.data.external_id }),
        })
        continue
      }
      // WP191：没连 / 没批 / 这一版还不能代发 → 这几种是"人去发就能发"，转成待办
      if (
        (result.reason === 'not_connected' ||
          result.reason === 'needs_approval' ||
          result.reason === 'not_implemented' ||
          result.reason === 'needs_paid_tier') &&
        toManual(result.message)
      )
        continue
      // 纪律 2：平台原话原样留着，**不重试**
      store.savePost({ ...post, status: 'failed', failure_reason: result.message })
      out.failed += 1
      emit('social.post_failed', 'system' as never, {
        post_id: post.id,
        channel: post.channel,
        reason: result.reason,
      })
    }
    return out
  }

  /**
   * 批过的群发**分批**发出去（56 §6：每批 50、间隔 2 秒、失败即停）。
   *
   * 收件人名单从**卡上**来（`after.audience`），不从库里现算——卡面上人看到的
   * 是哪一批人，发出去的就必须是那一批。中间群里进了新人不算数：他没在那张卡上。
   */
  const broadcastDue = async (): Promise<SocialBroadcastSweep> => {
    const out: SocialBroadcastSweep = { due: 0, sent: 0, failed: 0, recipients: 0, skipped: [] }
    const changes = await ledger.list({ workspace_id, kind: 'community_broadcast' })
    const approved = changes.filter(
      (ch) => ch.status === 'approved' || ch.status === 'auto_approved' || ch.status === 'applied',
    )
    const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))

    for (const change of approved) {
      const after = (change.after ?? {}) as {
        post_id?: string
        audience?: string[]
        body?: string
        template_id?: string
        opt_in_verified?: boolean
      }
      const post = after.post_id === undefined ? undefined : store.post(after.post_id)
      // 已经发过 / 已经失败过的不再碰（状态就是"这条群发到哪一步了"的真源）
      if (post === undefined || post.status !== 'scheduled') continue
      out.due += 1

      const account = store.account(post.account_id)
      const adapter = options.channels?.adapters[post.channel]
      if (account === undefined || adapter?.broadcast === undefined) {
        out.skipped.push({
          post_id: post.id,
          reason: `${post.channel} 这条渠道现在群发不出去（还没接上，或者这条渠道没有群发接口）。`,
        })
        continue
      }

      const recipients = after.audience ?? []
      let sent = 0
      let stopped: string | undefined
      for (let i = 0; i < recipients.length; i += BROADCAST_BATCH_SIZE) {
        const batch = recipients.slice(i, i + BROADCAST_BATCH_SIZE)
        const result = await adapter.broadcast({
          account_external_id: account.external_id,
          body: after.body ?? post.body,
          recipients: batch,
          ...(after.template_id === undefined ? {} : { template_id: after.template_id }),
          ...(after.opt_in_verified === undefined
            ? {}
            : { opt_in_verified: after.opt_in_verified }),
        })
        if (!result.ok) {
          // **失败即停**（见 `broadcastDue` 的注释）
          stopped = result.message
          break
        }
        sent += result.data.sent
        if (i + BROADCAST_BATCH_SIZE < recipients.length) await sleep(BROADCAST_BATCH_GAP_MS)
      }

      if (stopped !== undefined) {
        store.savePost({
          ...post,
          status: 'failed',
          // 发到第几个停的要看得见——接着手工补发那几个人时要用
          failure_reason: `发到第 ${sent} 个的时候停下来了：${stopped}`,
        })
        out.failed += 1
        out.recipients += sent
        emit('social.broadcast_failed', 'system' as never, {
          post_id: post.id,
          channel: post.channel,
          sent,
        })
        continue
      }
      store.savePost({ ...post, status: 'published', published_at: clock.now() })
      recordSent({
        source_key: `post:${post.id}`,
        channel: post.channel,
        action: 'broadcast',
        kind: 'community_broadcast',
        destination: `${account.display_name} · ${sent} 人`,
        content: after.body ?? post.body,
      })
      out.sent += 1
      out.recipients += sent
      emit('social.broadcast_sent', 'system' as never, {
        post_id: post.id,
        channel: post.channel,
        recipients: sent,
      })
    }
    return out
  }

  /** WP419：人贴回来的链接——只认这条渠道自己的站（别的当没贴）。 */
  const linkOk = (channel: string, link: string | undefined): string | undefined => {
    if (link === undefined) return undefined
    try {
      const u = new URL(link.trim())
      if (u.protocol !== 'https:') return undefined
      const hosts = SOCIAL_COMPOSE_HOSTS
      const host = u.hostname.toLowerCase()
      const fits = hosts.some((h) =>
        h.startsWith('*.') ? host === h.slice(2) || host.endsWith(h.slice(1)) : host === h,
      )
      const youtube = channel === 'youtube' && /(^|\.)youtube\.com$|^youtu\.be$/u.test(host)
      return fits || youtube ? u.toString() : undefined
    } catch {
      return undefined
    }
  }

  const handoffs = (): SocialPost[] =>
    store.posts({ status: 'scheduled' }).filter((p) => p.handoff !== undefined)

  const answerHandoff = (post_id: string, answer: SocialHandoffAnswer): SocialPost | undefined =>
    answerHandoffAs(post_id, answer, 'extension')

  /** WP483：同一条「发好了 / 不发了」，`via` = 谁认出来的（插件 / 人说的 `extension`；ego 读回 `ego`）。 */
  function answerHandoffAs(
    post_id: string,
    answer: SocialHandoffAnswer,
    via: 'extension' | 'ego',
  ): SocialPost | undefined {
    const post = store.post(post_id)
    if (post === undefined || post.handoff === undefined || post.status !== 'scheduled')
      return undefined
    const now = clock.now()
    const todo = post.handoff.todo_id
    let next: SocialPost
    if (answer.done) {
      const link = linkOk(post.channel, answer.link)
      next = {
        ...post,
        status: 'published',
        published_at: now,
        published_via: via,
        readback: link === undefined ? 'self_report' : 'link',
        ...(link === undefined ? {} : { post_url: link }),
      }
      const account = store.account(post.account_id)
      recordSent({
        source_key: `post:${post.id}`,
        channel: post.channel,
        action: 'post',
        kind: 'social_post',
        ...(account === undefined ? {} : { destination: account.display_name }),
        content: post.body,
        ...(link === undefined ? {} : { link }),
      })
      emit('social.post_published', answer.by as never, {
        post_id: post.id,
        channel: post.channel,
        via,
        readback: next.readback,
      })
    } else {
      next = {
        ...post,
        status: 'failed',
        failure_reason: `交给你发的这一条没发${answer.reason === undefined || answer.reason.trim() === '' ? '' : `：${answer.reason.trim().slice(0, 200)}`}`,
      }
      emit('social.post_failed', answer.by as never, {
        post_id: post.id,
        channel: post.channel,
        reason: 'handoff_skipped',
      })
    }
    store.savePost(next)
    if (todo !== undefined)
      try {
        options.closeManualTask?.(todo)
      } catch {
        // 待办收不掉不挡这一条的结果（人自己勾）
      }
    return next
  }

  return {
    port,
    publishDue,
    handoffs,
    answerHandoff,
    ingest,
    broadcastDue,
    executor,
    ...(ownSub === undefined ? {} : { ownSub }),
  }
}
