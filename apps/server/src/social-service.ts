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
  SocialMemberRow,
  SocialPort,
  SocialPostRow,
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
  Mandate,
  ObjectRef,
  ProvenanceState,
  SocialAccount,
  WorkspaceId,
} from '@agentsws/contracts'
import type { CommunityRule, ModerationAction } from '@agentsws/social-core'
import { ACTION_WORDS, handoffOf, moderate, triageThread } from '@agentsws/social-core'
import type { StageInput, StageOutcome } from '@agentsws/txn'
import type { SocialStore } from './social.js'

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
} as const

export interface SocialServiceOptions {
  workspace_id: WorkspaceId
  store: SocialStore
  clock: Clock
  approvals: ApprovalBus
  /** 15 §5 变更账本的 stage 口。 */
  ledger: { stage(input: StageInput): Promise<StageOutcome> }
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
}

export interface SocialServiceAssembly {
  port: SocialPort
}

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
        recipients: [{ person: input.actor.person_id, via: input.rule }],
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

  const port: SocialPort = {
    accounts: (_actor, filter) => ({
      rows: store.accounts(
        filter.channel === undefined ? undefined : { channel: filter.channel },
      ) as SocialAccountRow[],
    }),

    createAccount: (actor, input: SocialAccountInput) => {
      const row: SocialAccount = {
        id: nextId('sa'),
        workspace_id,
        channel: input.channel,
        handle: input.handle,
        display_name: input.display_name,
        url: input.url,
        external_id: input.external_id,
        ...(input.connection_id === undefined ? {} : { connection_id: input.connection_id }),
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
      return row
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
      const prior = store
        .threads({ account_id: account.id })
        .filter(
          (t) => t.author_external_id === input.author_external_id && t.triage === 'spam',
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

  return { port }
}
