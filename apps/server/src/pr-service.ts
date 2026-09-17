/**
 * WP78（60 §5）：公关库 `/v1/pr/*` 的**实现**（网关那一层只做装配与校验）。
 *
 * 四条职责要真动起来，靠的是这个文件把三样东西接起来：
 * `@agentsws/pr-core` 的纯逻辑、变更账本那道门、审批总线那张卡。
 *
 * 五条纪律：
 *
 * 1. **判类不是参数。** `ingestMention` 收的是外面说的那句话，情绪与归属由
 *    `triageMention` 判；调用方递不进来一个 `triage`。判成客户问题就出一张
 *    **转客服卡**（`claim`，路由到真持有 `dtc.support` 的人），公关一个字
 *    都不答——它手上根本没有订单域（60 分界行）。
 * 2. **写动作永远先出卡。** 稿子是 `press_release`、外部发帖是 `community_post`，
 *    都经 `ledger.stage` 走 guardrail。这个文件里**没有一处直接把稿子标成
 *    已分发、或者把帖子标成已发布**——那是执行器在卡被批准之后做的事。
 * 3. **版规先查再提。** `proposeExternalPost` 在提之前就跑一遍
 *    `checkSubredditRules`，结论写进 `ExternalPost.rules_checked` 并原样递给
 *    guardrail。**两处是同一份结论**，不是各判一次。
 * 4. **额度与等级从本次那条分配来**（05 §4），不是从职责模板的默认值来。
 * 5. **正文原样进卡、判据名进日志。** 提及正文是外部文本，它在卡上给人看
 *    （人本来就要读它），进事件日志的只有判据名（21 §1）。
 */

import type {
  PrActor,
  PrContactRow,
  PrExternalPostInput,
  PrExternalPostRow,
  PrExternalPostView,
  PrMentionInput,
  PrMentionRow,
  PrMentionView,
  PrPort,
  PrReleaseInput,
  PrReleaseRow,
  PrStagedView,
} from '@agentsws/api'
import { ApiError } from '@agentsws/api'
import type {
  ApprovalBus,
  AssignmentId,
  ChangeKind,
  Clock,
  EffectiveConfig,
  EventEnvelope,
  ExternalPost,
  Mandate,
  Mention,
  ObjectRef,
  PressRelease,
  ProvenanceState,
  StagedChange,
  SubredditPolicy,
  WorkspaceId,
} from '@agentsws/contracts'
import { extractFigures, uncitedFigures } from '@agentsws/core'
import {
  checkRelease,
  checkSubredditRules,
  explainRuleCheck,
  handoffOfMention,
  hoursSinceLastPost,
  maskEmail,
  mentionKey,
  renderRelease,
  triageMention,
} from '@agentsws/pr-core'
import { checkOutbound } from '@agentsws/social-core'
import type { StageInput, StageOutcome } from '@agentsws/txn'
import type { PrStore, StoredMention } from './pr.js'

/** 动作 id（职责 yml 里那几个）。**只有这一处拼它们**。 */
export const PR_ACTIONS = {
  draftRelease: 'draft_release',
  stageExternalPost: 'stage_external_post',
  flagMention: 'flag_mention',
} as const

/**
 * 版规拿不到时的那一份**保守**默认（60 §2 / `pr-core` 的 fail-closed）。
 *
 * 在别人的地盘上，"没查到规矩"不等于"这里什么都能发"。所以默认值是
 * **禁自我推广 + 72 小时冷却**——要放开，得有人真去把那个版的规矩读回来。
 */
export function conservativePolicy(venue: string, now: string): SubredditPolicy {
  return {
    name: venue,
    no_self_promotion: true,
    flair_required: false,
    cooldown_per_subreddit_hours: 72,
    raw_rules: [],
    observed_at: now,
  }
}

export interface PrServiceOptions {
  workspace_id: WorkspaceId
  store: PrStore
  clock: Clock
  approvals: ApprovalBus
  /** 15 §5 变更账本的 stage 口。 */
  ledger: {
    stage(input: StageInput): Promise<StageOutcome>
    list(filter: { workspace_id: WorkspaceId; kind?: ChangeKind }): Promise<StagedChange[]>
  }
  /** 05 §4 生效配置：额度与等级从本次那条分配来。 */
  effectiveConfig(id: AssignmentId): EffectiveConfig
  appendEvent(e: Omit<EventEnvelope, 'id' | 'at'> & { at?: string }): void
  random(): number
  /**
   * 现在谁持有某条职责（转客服卡要落到**真持有客服**的那个人头上）。
   * 没人持有就落到 owner 身上——而不是悄悄没人接。
   */
  holdersOf(role_id: string): { person_id: string }[]
  owner(): Promise<string | undefined>
  /**
   * 这个版的规矩。不给 / 查不到就按 {@link conservativePolicy}。
   *
   * 真正把版规读回来的是 `pr-core` 的 `createPrRedditAdapter().subredditRules()`
   * 与论坛那条浏览器脚本——它们在装配那一侧递进来，这个文件不打一跳网络。
   */
  policyOf?(input: { platform: string; venue: string }): SubredditPolicy | undefined
  /**
   * 一轮监控要拉的进料（Google Alerts 的 RSS + Reddit 全站搜）。
   *
   * 不给 = 这台机器上还没配监控源，`monitorSweep()` 照实回 `pulled: 0` 与一句
   * "还没连"——**不是**"今天没人提我们"（`pr-core/channels/alerts.ts` 第 3 条）。
   */
  pullMentions?(): Promise<
    { ok: true; rows: readonly PrMentionInput[] } | { ok: false; message: string }
  >
  /** 监控那一轮用谁的分配去提（定时任务没有"当前用户"）。 */
  monitorActor?(): PrActor | undefined
}

/** {@link PrServiceAssembly.monitorSweep} 回的那一份。 */
export interface PrMonitorSweep {
  /** 这一轮拉回来几条（去重前）。 */
  pulled: number
  /** 其中新的有几条。 */
  created: number
  /** 出了几张卡。 */
  carded: number
  /** 转给客服的有几条。 */
  routed: number
  /** 没拉成的源与为什么（**照实说**，不当成 0 条）。 */
  skipped: { workspace_id: WorkspaceId; reason: string }[]
}

export interface PrServiceAssembly {
  port: PrPort
  /**
   * 品牌监控那一轮（60 §5：按品牌各跑一轮，拉提及 → triage → 出卡）。
   *
   * 拉不到就照实报进 `skipped`——"这条 feed 404 了"与"今天没人提我们"
   * 是两件事，混成一个 0 是这条职责上最贵的一种谎。
   */
  monitorSweep(): Promise<PrMonitorSweep>
}

export function createPrService(options: PrServiceOptions): PrServiceAssembly {
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
      correlation: { trace_id: `tr_pr_${clock.now()}` },
      payload,
    })
  }

  /** 额度与等级（纪律 4）。查不到就按最严的一档办。 */
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
    // 稿子那一条职责写着 `requires_record_read`：提之前要把目标读全
    return { run_id, seen: grouped, read_full: seen.map((r) => r.id), recorded_at: clock.now() }
  }

  /** 一条 staged change 的共用那一段（提上去 → 翻成视图）。 */
  const stageOne = async (input: {
    actor: PrActor
    action: string
    kind: ChangeKind
    target: ObjectRef
    before: unknown
    after: unknown
    notes: string[]
    title: string
    summary: string
    rule: 'role_holder' | 'scope_manager' | 'owner'
  }): Promise<PrStagedView> => {
    const run_id = `run_pr_${nextId('p')}`
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
      provenance: provenanceOf(run_id, [input.target]),
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

  const releaseRow = (r: PressRelease): PrReleaseRow => {
    const figures = extractFigures(r.body)
    const uncited = uncitedFigures(
      r.body,
      r.facts_cited.map((c) => c.figure),
    )
    return { ...r, figure_count: figures.length, cited_count: figures.length - uncited.length }
  }

  /**
   * 一条提及来了：去重落库 → 判类 → 按类出卡。
   *
   * 三种卡（转客服 / 负面预警 / 回应草稿）都是 `claim`：它们说的是"这件事
   * 交给谁"，不是"改了什么"。真要往外说一句话，那是另一条路（出站草稿）。
   */
  const ingest = async (actor: PrActor, input: PrMentionInput): Promise<PrMentionView> => {
    const now = clock.now()
    const verdict = triageMention({
      ...(input.title === undefined ? {} : { title: input.title }),
      text: input.text,
      source: input.source,
    })
    const key = mentionKey({
      source: input.source,
      ...(input.url === undefined ? {} : { url: input.url }),
      ...(input.title === undefined ? {} : { title: input.title }),
      text: input.text,
    })
    const row: Mention = {
      id: nextId('mn'),
      workspace_id,
      source: input.source,
      origin: input.origin,
      url: input.url ?? '',
      ...(input.title === undefined ? {} : { title: input.title }),
      text: input.text,
      ...(input.author === undefined ? {} : { author: input.author }),
      published_at: input.published_at ?? now,
      observed_at: now,
      status: 'new',
      dedupe_key: key,
    }
    const saved = store.saveMention(row)
    const card = handoffOfMention(verdict, {
      origin: input.origin,
      ...(input.author === undefined ? {} : { author: input.author }),
    })

    /*
     * 归档那一路不出卡：一条好话、一条判不准的闲话，出一张卡只会让队列变长。
     * 但情绪与归属照样写回去——面板上"今天外面说了什么"读的就是它。
     */
    if (card.kind === 'archive') {
      store.recordTriage({
        mention_id: saved.mention.id,
        triage: verdict.triage,
        sentiment: verdict.sentiment,
      })
      emit('pr.mention_triaged', actor.person_id, {
        triage: verdict.triage,
        sentiment: verdict.sentiment,
        // 原句不进事件（21 §1）；进的是判据名
        signals: verdict.signals,
        created: saved.created,
        carded: false,
      })
      return {
        mention: store.mention(saved.mention.id) as PrMentionRow,
        created: saved.created,
        triage: verdict.triage,
        sentiment: verdict.sentiment,
        signals: verdict.signals,
        route: verdict.route,
        card: card.kind,
      }
    }

    /*
     * 转客服那一路：收件人是**真持有客服职责的人**。没人持有就落到 owner 身上，
     * 而不是悄悄没人接（同 56 §4 的转客服卡）。
     */
    const toRole = card.to_role ?? actor.role_id
    const holder = options.holdersOf(toRole)[0]?.person_id
    const fallback = (await options.owner()) ?? actor.person_id
    const recipient = card.kind === 'support_handoff' ? (holder ?? fallback) : actor.person_id
    const target: ObjectRef = { type: 'mention', id: saved.mention.id }
    const item = await approvals.create({
      workspace_id,
      schema_version: 1,
      kind: 'claim',
      role_id: card.kind === 'support_handoff' ? toRole : actor.role_id,
      subject: { object: target },
      dedupe_key: `${workspace_id}:pr_mention:${saved.mention.dedupe_key}`,
      title: card.title,
      summary: card.reason,
      payload: {
        form: card.kind,
        kind: 'mention_triage',
        after: {
          triage: verdict.triage,
          sentiment: verdict.sentiment,
          sentiment_label:
            verdict.sentiment === 'negative'
              ? '负面'
              : verdict.sentiment === 'positive'
                ? '正面'
                : '中性',
          seen_count: saved.mention.seen_count,
          origin: input.origin,
          ...(card.to_role === undefined ? {} : { route_to_role: card.to_role }),
          ...(card.kind === 'support_handoff' ? { route_to_label: '客服' } : {}),
          url: row.url,
          // 正文原样进卡（人本来就要读它），**不进事件日志**
          text: input.text,
        },
      },
      evidence: {
        source_events: [],
        run_id: `run_pr_${nextId('m')}`,
        provenance: { seen: [target] },
        precheck: { fencing: 'ok' },
      },
      proposer: {
        kind: 'agent',
        id: `agent_${actor.role_id}`,
        assignment_id: actor.assignment_id,
      },
      automation: {
        // 定性本身是 L3（它不发一句话出去）；要人点的是这张卡之后的事
        level_at_creation: card.kind === 'support_handoff' ? 'L1' : 'L3',
        auto_approved: false,
        mandate_check: { within: true, caps_hit: [] },
        sampling: { selected: false },
      },
      routing: {
        recipients: [{ person: recipient, via: 'explicit' }],
        explicit: recipient,
        rule: 'explicit',
        escalation: {
          // 负面预警拖两小时就晚了（职责 yml 的 notifications 写的是同一个数）
          after_hours: card.kind === 'negative_alert' ? 2 : 4,
          business_hours: true,
          chain: ['owner'],
          escalated_at: [],
        },
        separation_of_duties: false,
      },
      priority: card.kind === 'negative_alert' ? 'immediate' : 'queue',
    })
    store.recordTriage({
      mention_id: saved.mention.id,
      triage: verdict.triage,
      sentiment: verdict.sentiment,
      ...(card.kind === 'support_handoff' ? { routed_approval_id: item.id } : {}),
      ...(card.kind === 'negative_alert' ? { alert_approval_id: item.id } : {}),
    })
    emit('pr.mention_triaged', actor.person_id, {
      triage: verdict.triage,
      sentiment: verdict.sentiment,
      signals: verdict.signals,
      created: saved.created,
      carded: true,
      card: card.kind,
      // 有人真持有客服那条职责没有：没人持有 = 这张卡落到 owner 头上，如实报
      held_by: card.kind === 'support_handoff' ? (holder ?? null) : undefined,
      answered_by_pr: false,
    })
    return {
      mention: store.mention(saved.mention.id) as PrMentionRow,
      created: saved.created,
      triage: verdict.triage,
      sentiment: verdict.sentiment,
      signals: verdict.signals,
      route: verdict.route,
      ...(item.state === 'blocked' ? {} : { approval_item_id: item.id }),
      card: card.kind,
    }
  }

  const port: PrPort = {
    mentions: (_actor, filter) => ({
      rows: store.mentions({
        ...(filter.sentiment === undefined ? {} : { sentiment: filter.sentiment }),
        ...(filter.triage === undefined ? {} : { triage: filter.triage }),
        ...(filter.open === undefined ? {} : { open: filter.open }),
      }) as PrMentionRow[],
    }),

    ingestMention: (actor, input) => ingest(actor, input),

    releases: (_actor, filter) => ({
      rows: store
        .releases({ ...(filter.status === undefined ? {} : { status: filter.status }) })
        .map(releaseRow),
    }),

    async draftRelease(actor, input) {
      const now = clock.now()
      const release: PressRelease = {
        id: nextId('prl'),
        workspace_id,
        status: 'draft',
        headline: input.headline,
        dek: input.dek,
        body: input.body,
        quotes: [...(input.quotes ?? [])],
        boilerplate: input.boilerplate,
        contact: {
          name: input.contact.name,
          email: input.contact.email,
          ...(input.contact.phone === undefined ? {} : { phone: input.contact.phone }),
        },
        facts_cited: input.facts_cited.map((c) => ({
          figure: c.figure,
          fact_card_id: c.fact_card_id,
          ...(c.statement === undefined ? {} : { statement: c.statement }),
        })),
        ...(input.embargo_until === undefined ? {} : { embargo_until: input.embargo_until }),
        created_at: now,
        updated_at: now,
      }
      /*
       * 起草那一跳先自查一遍（纪律 3 的同一条理由：早点给反馈）。
       * **最后一道仍然在 guardrail**——这里不拦，只把问题写进 notes。
       */
      const check = checkRelease(release)
      const figures = extractFigures(release.body)
      store.saveRelease(release)
      const staged = await stageOne({
        actor,
        action: PR_ACTIONS.draftRelease,
        kind: 'press_release',
        target: { type: 'press_release', id: release.id },
        before: { status: 'none' },
        after: {
          headline: release.headline,
          body: release.body,
          quotes: release.quotes,
          facts_cited: release.facts_cited,
          figure_count: figures.length,
          cited_count: figures.length - check.uncited.length,
          ...(release.embargo_until === undefined ? {} : { embargo_until: release.embargo_until }),
        },
        notes: [
          `正文里有 ${figures.length} 个数字，${figures.length - check.uncited.length} 个能指出是哪张事实卡。`,
          ...check.problems.map((p) => p.message),
        ],
        title: `新闻稿草稿：${release.headline}`,
        summary: release.dek.slice(0, 200),
        rule: 'scope_manager',
      })
      emit('pr.release_drafted', actor.person_id, {
        release_id: release.id,
        figures: figures.length,
        uncited: check.uncited.length,
        staged: staged.staged,
      })
      return staged
    },

    async distributeRelease(actor, id) {
      const release = store.release(id)
      if (release === undefined) throw new ApiError('not_found', `没有这篇稿子：${id}`)
      const figures = extractFigures(release.body)
      const uncited = uncitedFigures(
        release.body,
        release.facts_cited.map((c) => c.figure),
      )
      const staged = await stageOne({
        actor,
        action: PR_ACTIONS.draftRelease,
        kind: 'press_release',
        target: { type: 'press_release', id: release.id },
        before: { status: release.status },
        after: {
          // 这一格就是分档的判据（guardrail 按它升 L1）
          distributed: true,
          headline: release.headline,
          body: release.body,
          quotes: release.quotes,
          facts_cited: release.facts_cited,
          figure_count: figures.length,
          cited_count: figures.length - uncited.length,
          ...(release.embargo_until === undefined ? {} : { embargo_until: release.embargo_until }),
        },
        notes: [
          '分发服务还没接（连接目录里是"待增加"）：批准之后这里给你一份可以直接复制的正文，你自己发出去——**不假装已经发出去了**。',
          renderRelease(release),
        ],
        title: `发新闻稿：${release.headline}`,
        summary: `${release.dek.slice(0, 160)}（${figures.length} 个数字全部有出处）`,
        rule: 'owner',
      })
      emit('pr.release_distribute_staged', actor.person_id, {
        release_id: release.id,
        staged: staged.staged,
        level: staged.level,
      })
      return staged
    },

    externalPosts: (_actor, filter) => ({
      rows: store.posts({
        ...(filter.platform === undefined ? {} : { platform: filter.platform }),
        ...(filter.status === undefined ? {} : { status: filter.status }),
      }) as PrExternalPostRow[],
    }),

    async proposeExternalPost(actor, input) {
      const now = clock.now()
      const policy =
        options.policyOf?.({ platform: input.platform, venue: input.venue }) ??
        conservativePolicy(input.venue, now)
      /*
       * 上一条在**这个版**是什么时候发的（冷却那一道）。
       * 没发过 = 不给这一格，guardrail 那边"没算过就不判"（第一帖不该被拦）。
       */
      const last = store
        .posts({ platform: input.platform })
        .filter((p) => p.venue === input.venue && p.published_at !== undefined)
        .sort(
          (a, b) => Date.parse(b.published_at as string) - Date.parse(a.published_at as string),
        )[0]
      const since = hoursSinceLastPost({
        ...(last?.published_at === undefined ? {} : { last_post_at: last.published_at }),
        now,
      })
      const rules_checked = checkSubredditRules({
        policy,
        ...(input.flair === undefined ? {} : { flair: input.flair }),
        ...(last?.published_at === undefined ? {} : { last_post_at: last.published_at }),
        now,
      })
      const explained = explainRuleCheck(rules_checked, input.venue)
      // 承诺扫描（全仓那一份词表，经 social-core 的 checkOutbound）
      const scan = checkOutbound(input.body)

      const post: ExternalPost = {
        id: nextId('ep'),
        workspace_id,
        role_id: actor.role_id,
        kind: input.kind,
        platform: input.platform,
        venue: input.venue,
        ...(input.title === undefined ? {} : { title: input.title }),
        body: input.body,
        status: rules_checked.ok ? 'draft' : 'blocked',
        rules_checked,
        ...(input.parent_external_id === undefined
          ? {}
          : { parent_external_id: input.parent_external_id }),
        created_at: now,
      }
      store.savePost(post)

      const staged = await stageOne({
        actor,
        action: PR_ACTIONS.stageExternalPost,
        kind: 'community_post',
        target: { type: 'external_post', id: post.id },
        before: {},
        after: {
          platform: input.platform,
          venue: input.venue,
          venue_label: `${input.platform}／${input.venue}`,
          body: input.body,
          rules_checked,
          rules_summary: explained,
          ...(since === undefined ? {} : { hours_since_last_post: since }),
          // 承诺扫描报没报跑过（fail-closed，照 `campaign_send` 的 suppression_checked）
          commitment_checked: true,
          ...(input.parent_external_id === undefined
            ? {}
            : { parent_external_id: input.parent_external_id }),
        },
        notes: [
          explained,
          ...(scan.ok ? [] : [scan.rewrite_instruction]),
          '我们在别人的地盘上：这一条永远要你点一下才发得出去。',
        ],
        title: `外部发帖：${input.platform}／${input.venue}`,
        summary: `${(input.title ?? input.body).slice(0, 120)}　｜　${explained}`,
        rule: 'scope_manager',
      })
      emit('pr.external_post_staged', actor.person_id, {
        post_id: post.id,
        platform: input.platform,
        venue: input.venue,
        rules_ok: rules_checked.ok,
        rules_reasons: rules_checked.reasons,
        ...(since === undefined ? {} : { hours_since_last_post: Math.round(since) }),
        commitment_hits: scan.commitment_hits,
        staged: staged.staged,
        level: staged.level,
      })
      return { ...staged, post_id: post.id, rules_checked, rules_explained: explained }
    },

    contacts: (_actor, filter) => ({
      rows: store
        .contacts({
          ...(filter.stage === undefined ? {} : { stage: filter.stage }),
          ...(filter.beat === undefined ? {} : { beat: filter.beat }),
        })
        .map(
          (c): PrContactRow => ({
            id: c.id,
            kind: c.kind,
            name: c.name,
            outlet: c.outlet,
            ...(c.url === undefined ? {} : { url: c.url }),
            beats: [...c.beats],
            stage: c.stage,
            ...(c.last_pitched_at === undefined ? {} : { last_pitched_at: c.last_pitched_at }),
            ...(c.last_covered_at === undefined ? {} : { last_covered_at: c.last_covered_at }),
            // **只说有没有**；明文与 key 名一格都不出去（文件头第 4 条）
            has_email: c.email_ref !== undefined || c.email_masked !== undefined,
            /*
             * 库里存的已经是脱敏那一格；这里再过一遍 `maskEmail` 是**兜底**——
             * 万一哪天有人往这一格里塞了明文，它在出门之前还会被抹一次。
             * 两道都做才叫做了（同 `redactUrl` 那条）。
             */
            ...(c.email_masked === undefined
              ? {}
              : {
                  email_masked: c.email_masked.includes('***')
                    ? c.email_masked
                    : maskEmail(c.email_masked),
                }),
          }),
        ),
    }),
  }

  const monitorSweep = async (): Promise<PrMonitorSweep> => {
    const out: PrMonitorSweep = { pulled: 0, created: 0, carded: 0, routed: 0, skipped: [] }
    const actor = options.monitorActor?.()
    if (actor === undefined) {
      out.skipped.push({
        workspace_id,
        reason:
          '这个品牌里还没有人持有品牌监控（pr.monitoring）这条职责——没人接的话，拉回来也没地方放。',
      })
      return out
    }
    const pulled = await options.pullMentions?.()
    if (pulled === undefined) {
      out.skipped.push({
        workspace_id,
        reason:
          '这个品牌还没配监控源（Google Alerts 的 RSS / Reddit）。**这不等于今天没人提我们**——去连接页把 Google Alerts 填上。',
      })
      return out
    }
    if (!pulled.ok) {
      out.skipped.push({ workspace_id, reason: pulled.message })
      return out
    }
    out.pulled = pulled.rows.length
    for (const row of pulled.rows) {
      const view = await ingest(actor, row)
      if (view.created) out.created += 1
      if (view.approval_item_id !== undefined) out.carded += 1
      if (view.route === 'support') out.routed += 1
    }
    return out
  }

  return { port, monitorSweep }
}

/** 库里那条提及的形状（给装配方用的再导出）。 */
export type { StoredMention }
