/**
 * WP75（57 §5）：广告库 `/v1/ads/*` 的**实现**（网关那一层只做装配与校验）。
 *
 * 四条纪律：
 *
 * 1. **写动作永远先出卡。** 五个写口子全部经 `ledger.stage` 走 guardrail；
 *    这个文件里**没有一处直接改库、也没有一处打平台**——真正动到账户是执行器
 *    在卡被批准之后做的事（04 §5：开花钱口子永远 L1）。
 * 2. **额度与等级从本次那条分配来**（05 §4），不是从职责模板的默认值来。
 *    同一个人在两个品牌里做同一个平台，总闸可以不一样。
 * 3. **总闸是岗位级的，在 stage 之前算一次、跟着卡走。** `GuardrailFacts`
 *    的 `dailySpendTotal` 收的是**四个平台加起来**今天花了多少（`AdsStore.spendToday`）
 *    ——各判各的等于四条职责一起把总闸撑爆而谁都没越自己那条线。
 *    算出来的那句话也进卡面（`spend_gate`）：人点头之前要看得见还剩多少。
 * 4. **止损判据在这一跳算一次、原样进卡。** `ads-core` 的 `stopLossVerdict`
 *    出的 `reason` 是给人看的那句话（"ROAS 0.6（线是 1），今天花了 400，
 *    占日预算 1000 的 40%"），它原样上卡面——卡上只写"止损"的话，
 *    点头这件事就没有内容。
 */

import {
  type AdSheetOp,
  buildAdUploadBundle,
  daySpendGate,
  stopLossVerdict,
} from '@agentsws/ads-core'
import type { AdsActor, AdsCampaignRow, AdsPort, AdsStagedView } from '@agentsws/api'
import { ApiError } from '@agentsws/api'
import type {
  AdAccount,
  AdCampaign,
  AdsCaps,
  AdsPlatform,
  AssignmentId,
  BreakEvenView,
  ChangeKind,
  Clock,
  EffectiveConfig,
  EventEnvelope,
  Mandate,
  ObjectRef,
  ProvenanceState,
  Recipient,
  StagedChange,
  WorkspaceId,
} from '@agentsws/contracts'
import { ADS_DEFAULT_CAPS, adsPlatformOfRole } from '@agentsws/contracts'
import type { StageInput, StageOutcome } from '@agentsws/txn'
import type { AdsStore } from './ads.js'
import { createAdsProposals } from './ads-wiring/propose.js'
import { type AdsWiring, actionPlatformOf } from './ads-wiring/service.js'
import { cardFileOf, cardFingerprint } from './ads-wiring/sheet-card.js'
import { recipientOf, type ScopeManagerRouter } from './supervisor.js'

export interface AdsServiceOptions {
  workspace_id: WorkspaceId
  clock: Clock
  store: AdsStore
  /** 15 §5 变更账本：五个写口子唯一的出口。 */
  ledger: { stage(input: StageInput): Promise<StageOutcome> }
  /** 05 §4 生效配置：额度与等级从本次那条分配来（纪律 2）。 */
  effectiveConfig(id: AssignmentId): EffectiveConfig
  appendEvent(e: Omit<EventEnvelope, 'id' | 'at'> & { at?: string }): void
  random(): number
  /**
   * WP174：`scope_manager` 的卡落到谁（岗位上级 → 老板，`./supervisor.ts`）。
   * 不给就照旧落在提的人自己身上（单测与没装公司页的进程）。
   */
  routeScopeManager?: ScopeManagerRouter
  /**
   * WP224（docs/91 §2.2 #3）：盈亏线那一格（品牌那一格毛利率算的）。止损卡上判据旁边
   * 并排写一句——**只是显示**，这张卡停不停仍按 `stop_loss_roas_below`（先并排两周再定）。
   * 不给就不写（单测与没装毛利率那一层的进程）。
   */
  breakEven?: () => BreakEvenView
  /**
   * WP316：插件执行那一半（广告变更账本、磨合期、插件连没连）。不给 = 只出卡（单测与托管实例）。
   */
  wiring?: AdsWiring
  /** WP316：按 id 读回一条变更（撤销要原来的改前值、作废了要原样重出）。 */
  changeOf?: (id: string) => Promise<StagedChange | undefined>
}

export interface AdsServiceAssembly {
  port: AdsPort
}

/** 动作 id → ChangeKind（契约 `ADS_KIND_ALIASES` 那张对照的另一半）。 */
const KIND_OF: Record<string, ChangeKind> = {
  stage_campaign: 'create_campaign',
  stage_budget_change: 'budget_change',
  stage_bid_change: 'bid_change',
  pause_ads: 'pause_ad',
  stage_creative_swap: 'creative_swap',
  // WP316：上传表 / 开始投放 / 撤销
  stage_ads_sheet: 'ads_sheet',
  stage_ads_activate: 'ads_activate',
  stage_ads_undo: 'ads_undo',
}

export function createAdsService(options: AdsServiceOptions): AdsServiceAssembly {
  const { workspace_id, clock, store, ledger, appendEvent } = options

  let seq = 0
  const nextId = (prefix: string): string => {
    seq += 1
    const rand = Math.floor(options.random() * 0xffffffff)
      .toString(36)
      .padStart(7, '0')
    return `${prefix}_${rand}${seq.toString(36)}`
  }

  /** 额度与等级（纪律 2）。查不到就按最严的一档办。 */
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

  /** 这条分配管的是哪个平台；不是投放职责就当场 400（不悄悄按"全部"办）。 */
  const platformOf = (actor: AdsActor): AdsPlatform => {
    const spec = adsPlatformOfRole(actor.role_id)
    if (spec === undefined)
      throw new ApiError(
        'forbidden',
        `${actor.role_id} 不是一条投放职责——广告库这一面只对 ads.* 开（57 §1）。`,
      )
    return spec.id
  }

  /** 这条分配上那份 caps（缺的补 57 §6 的默认值）。 */
  const capsOf = (assignment_id: AssignmentId, action: string): AdsCaps => {
    const raw = actionOf(assignment_id, action).mandate.caps ?? {}
    const pick = (k: keyof AdsCaps): number | undefined => {
      const v = raw[k]
      return typeof v === 'number' ? v : undefined
    }
    return {
      max_daily_spend: pick('max_daily_spend') ?? ADS_DEFAULT_CAPS.max_daily_spend,
      max_budget_delta_pct: pick('max_budget_delta_pct') ?? ADS_DEFAULT_CAPS.max_budget_delta_pct,
      max_bid_delta_pct: pick('max_bid_delta_pct') ?? ADS_DEFAULT_CAPS.max_bid_delta_pct,
      stop_loss_roas_below: pick('stop_loss_roas_below') ?? ADS_DEFAULT_CAPS.stop_loss_roas_below,
      stop_loss_spend_pct: pick('stop_loss_spend_pct') ?? ADS_DEFAULT_CAPS.stop_loss_spend_pct,
      max_changes_per_day: pick('max_changes_per_day') ?? ADS_DEFAULT_CAPS.max_changes_per_day,
    }
  }

  const provenanceOf = (run_id: string, seen: ObjectRef[]): ProvenanceState => {
    const grouped: Record<string, string[]> = {}
    for (const ref of seen) {
      const list = grouped[ref.type] ?? []
      if (!list.includes(ref.id)) list.push(ref.id)
      grouped[ref.type] = list
    }
    return {
      run_id,
      seen: grouped,
      /*
       * 换素材要求"改前必读"（`RECORD_READ_KINDS`）：这一跳是**人**在界面上点的，
       * 而那条广告的正文就摆在他眼前——所以 `read_full` 给的是这次点的那几条，
       * 不是空的。Agent 走的那条路（模拟世界 / 运行时）各有各的 provenance。
       */
      read_full: seen.map((r) => `${r.type}:${r.id}`),
      recorded_at: clock.now(),
    }
  }

  const accountName = (id: string): string => store.account(id)?.name ?? id

  const campaignOr404 = (id: string): AdCampaign => {
    const found = store.campaign(id)
    if (found === undefined) throw new ApiError('not_found', `没有这条 campaign：${id}`)
    return found
  }

  /** 岗位级总闸当时的样子（纪律 3）。 */
  const gateOf = (caps: AdsCaps, adding: number) => {
    const today = store.spendToday()
    const verdict = daySpendGate({
      spend_by_platform: Object.fromEntries(today.by_platform.map((r) => [r.platform, r.spend])),
      adding,
      caps,
      expected_platforms: today.by_platform.map((r) => r.platform),
    })
    return {
      ...verdict,
      view: {
        spent: verdict.spent,
        cap: verdict.cap,
        remaining: verdict.remaining,
        note: verdict.reason,
      },
    }
  }

  /** WP174：`scope_manager` 的卡按岗位上级走；别的规则照旧落在提的人身上。 */
  const recipientFor = async (
    actor: AdsActor,
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

  /** 一条 staged change 的共用那一段（提上去 → 翻成视图）。 */
  const stageOne = async (input: {
    actor: AdsActor
    action: string
    target: ObjectRef
    before: unknown
    after: unknown
    notes: string[]
    title: string
    summary: string
    seen: ObjectRef[]
    rule: 'role_holder' | 'scope_manager' | 'owner'
    /** 这一下会再占掉总闸多少（提预算就是提上去那一截；新建就是它的日预算）。 */
    adding: number
    /** WP316：去重那一格（同一账户上两张不同的上传表不该被并成一张）。 */
    field?: string
    /** WP316：这一下由插件在这个账户上执行（磨合期按它判；也判插件连没连）。 */
    account?: AdAccount
  }): Promise<AdsStagedView> => {
    const run_id = `run_ads_${nextId('a')}`
    const configured = actionOf(input.actor.assignment_id, input.action)
    const { mandate } = configured
    let level = configured.level
    const caps = capsOf(input.actor.assignment_id, input.action)
    const gate = gateOf(caps, input.adding)
    const kind = KIND_OF[input.action]
    if (kind === undefined) throw new ApiError('invalid_input', `不认识这个动作：${input.action}`)
    /*
     * WP316（决策 554）：**磨合期**——这个账户由插件做成第一件写操作起 14 天内（还没做成过 = 还在磨合），
     * 插件执行的 L2 一律升 L1。插件点得准不准要在每个账户上先证明一次。
     */
    const extNotes: string[] = []
    const acct = input.account
    const actionAccount =
      acct !== undefined && (acct.platform === 'google' || acct.platform === 'meta')
        ? { platform: actionPlatformOf(acct.platform), id: acct.external_id }
        : undefined
    if (level === 'L2' && options.wiring?.available() === true && actionAccount !== undefined) {
      const bi = options.wiring.breakIn(actionAccount)
      if (bi.active) {
        level = 'L1'
        extNotes.push(
          bi.until === undefined
            ? '磨合期：插件还没在这个账户上做成过一件，先按 L1 等你点（决策 554）。'
            : `磨合期：这个账户接入不满 2 周（到 ${bi.until.slice(0, 10)}），先按 L1 等你点（决策 554）。`,
        )
      }
    }
    // WP316：插件没配对 / 没连这家后台 → 卡照出（批了排队等插件，决策 558），回执里带上连接那一格（WP324）
    const needsExtension =
      options.wiring?.available() === true &&
      acct !== undefined &&
      (acct.platform === 'google' || acct.platform === 'meta') &&
      !options.wiring.extensionReady(acct.platform)
    const outcome = await ledger.stage({
      workspace_id,
      role_id: input.actor.role_id,
      assignment_id: input.actor.assignment_id,
      run_id,
      change_set_id: `cs_${run_id}`,
      kind,
      target: input.target,
      before: input.before,
      /*
       * 卡面上那三个芯片（`platform` / `spend_gate` / `stop_loss`）读的是
       * **结构化字段**，不是摘要里的字（37 §1 第 4 行）。所以这三格在这一跳
       * 写进 `after`，而不是让渲染层从那句中文里抠。
       */
      after: {
        ...(typeof input.after === 'object' && input.after !== null ? input.after : {}),
        platform: platformOf(input.actor),
        platform_label: adsPlatformOfRole(input.actor.role_id)?.zh ?? platformOf(input.actor),
        spend_gate_note: gate.reason,
      },
      ...(input.field === undefined ? {} : { field: input.field }),
      // 总闸那句话跟着卡走（纪律 3）
      notes: [...input.notes, ...extNotes, gate.reason],
      /*
       * **岗位级总闸的分子**（纪律 3）：四个平台加起来今天花了多少。
       *
       * guardrail 的 `max_daily_spend` / `max_daily_spend_total` 两道门看的都是
       * 这一格。不递进去的话那两道门一声不吭地不判——而"不判"在这件事上等于
       * "永远通过"，那正是 04 §5 那条总闸最不该有的样子。
       */
      daily_spend_total: gate.spent,
      created_by: { kind: 'person', id: input.actor.person_id },
      mandate,
      level,
      provenance: provenanceOf(run_id, input.seen),
      approval: {
        title: input.title,
        // 总闸那句话也进摘要：人点头之前要看得见今天还剩多少
        summary: `${input.summary}｜${gate.reason}`,
        recipients: [await recipientFor(input.actor, input.rule)],
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
    const extensionNeed = needsExtension
      ? { needs_connection: 'extension' as const, connection_name: 'Agents 工坊助手（浏览器插件）' }
      : {}
    if (!outcome.ok)
      return {
        staged: false,
        message: outcome.message,
        level,
        spend_gate: gate.view,
        ...extensionNeed,
      }
    appendEvent({
      schema_version: 1,
      workspace_id,
      type: `ads.${input.action}_staged`,
      actor: { kind: 'person', id: input.actor.person_id },
      correlation: { trace_id: `tr_ads_${clock.now()}`, run_id },
      payload: {
        platform: platformOf(input.actor),
        role_id: input.actor.role_id,
        kind,
        level_requested: level,
        level_at_creation: outcome.approval.automation.level_at_creation,
        auto_approved: outcome.approval.automation.auto_approved,
        // 总闸那几个数进日志（不含正文——那是卡面上给人看的）
        spend_gate_spent: gate.spent,
        spend_gate_cap: gate.cap,
      },
    })
    return {
      staged: true,
      change_id: outcome.change.id,
      approval_item_id: outcome.approval.id,
      level: outcome.approval.automation.level_at_creation,
      spend_gate: gate.view,
      ...(needsExtension
        ? {
            ...extensionNeed,
            message:
              '卡出好了。插件还没连上这家后台：批了会排队，连上插件才执行（排 24 小时没人领就作废重出）。',
          }
        : {}),
    }
  }

  /** WP316：这条 campaign 所在的账户（磨合期、插件连没连按它判）。 */
  const accountOf = (c: AdCampaign): { account?: AdAccount } => {
    const a = store.account(c.account_id)
    return a === undefined ? {} : { account: a }
  }

  /**
   * WP316：新建 campaign 卡上带一张上传表（批了插件就传它）。表出不了（Meta 新系列还要广告组那一层、
   * 缺目标……）就照实写在卡上：批了插件也建不了，改走「改广告」那条路。
   */
  const createSheetOf = (
    account: AdAccount,
    input: { name: string; daily_budget: number; objective?: string | undefined },
  ): { after: Record<string, unknown>; notes: string[] } => {
    if (
      options.wiring === undefined ||
      (account.platform !== 'google' && account.platform !== 'meta')
    )
      return { after: {}, notes: [] }
    const op: AdSheetOp =
      account.platform === 'google'
        ? { kind: 'create_campaign', campaign: input.name, daily_budget: input.daily_budget }
        : {
            kind: 'create_campaign',
            campaign: input.name,
            ...(input.objective === undefined ? {} : { meta: { objective: input.objective } }),
          }
    const bundle = buildAdUploadBundle({ platform: account.platform, ops: [op] })
    if (!bundle.ok)
      return {
        after: {},
        notes: [
          `这张卡的上传表还出不了（${bundle.problems
            .filter((p) => p.severity === 'error')
            .map((p) => p.message)
            .join('；')}）：批了插件也建不了，改走「改广告」那条路出一张带表的卡。`,
        ],
      }
    const files = bundle.files.map(cardFileOf)
    return {
      after: { _files: files, _ops: [op], _fingerprint: cardFingerprint(files) },
      notes: ['批了由插件在你自己的后台里上传；平台先给预览，你再确认一次才提交。'],
    }
  }

  /** WP316：出卡那一半（上传表 / 开始投放 / 撤销 / 重出）。没装插件执行那一半就没有。 */
  const proposals =
    options.wiring === undefined
      ? undefined
      : createAdsProposals({
          store,
          wiring: options.wiring,
          stage: (input) => stageOne(input),
          capsOf: (assignment_id, action) => capsOf(assignment_id as AssignmentId, action),
          ...(options.changeOf === undefined ? {} : { changeOf: options.changeOf }),
        })
  if (proposals !== undefined) options.wiring?.setFollowUps(proposals)

  const port: AdsPort = {
    accounts: (actor, filter) => ({
      rows: store.accounts({ platform: filter.platform ?? platformOf(actor) }),
    }),

    campaigns: (actor, filter) => {
      const rows: AdsCampaignRow[] = store
        .campaigns({
          platform: filter.platform ?? platformOf(actor),
          ...(filter.account_id === undefined ? {} : { account_id: filter.account_id }),
        })
        .map((c) => ({ ...c, account_name: accountName(c.account_id) }))
      return { rows }
    },

    async createCampaign(actor, input) {
      const account = store.account(input.account_id)
      if (account === undefined)
        throw new ApiError('not_found', `没有这个广告账户：${input.account_id}`)
      const sheet = createSheetOf(account, input)
      return stageOne({
        actor,
        action: 'stage_campaign',
        target: { type: 'ad_account', id: account.id },
        before: {},
        after: {
          name: input.name,
          daily_budget: input.daily_budget,
          ...(input.objective === undefined ? {} : { objective: input.objective }),
          ...(input.audience_summary === undefined
            ? {}
            : { audience_summary: input.audience_summary }),
          ...sheet.after,
        },
        notes: [
          // 04 §5：新开花钱口子永远人审——这句话写在卡上，不只写在文档里
          '新建一条 campaign 是**开一个新的花钱口子**，永远要人点一下（04 §5）。',
          '批了之后它是**停着**建出来的——让它开始花钱是另一张卡。',
          ...sheet.notes,
        ],
        title: `新建 campaign：${input.name}`,
        summary: `${account.name}｜日预算 ${input.daily_budget}｜${input.audience_summary ?? '受众没写'}`,
        seen: [{ type: 'ad_account', id: account.id }],
        rule: 'owner',
        adding: input.daily_budget,
        account,
      })
    },

    async changeBudget(actor, campaign_id, input) {
      const campaign = campaignOr404(campaign_id)
      const before = campaign.daily_budget ?? 0
      return stageOne({
        actor,
        action: 'stage_budget_change',
        target: { type: 'campaign', id: campaign.id },
        before: { value: before },
        after: { value: input.value },
        notes: [
          input.reason ?? '没写理由。',
          // 04 §5：减少花钱从宽
          input.value < before
            ? '这是**调低**预算：花得更少，额度与总闸都不卡这一边。'
            : '这是提预算：超过额度或会破总闸的话，要人点一下。',
        ],
        title: `改预算：${campaign.name}`,
        summary: `${before} → ${input.value}`,
        seen: [{ type: 'campaign', id: campaign.id }],
        rule: 'scope_manager',
        adding: Math.max(0, input.value - before),
        ...accountOf(campaign),
      })
    },

    async changeBid(actor, campaign_id, input) {
      const campaign = campaignOr404(campaign_id)
      const set =
        input.ad_set_id === undefined
          ? store.adSets({ campaign_id: campaign.id })[0]
          : store.adSets({ campaign_id: campaign.id }).find((s) => s.id === input.ad_set_id)
      const before = set?.bid_amount ?? 0
      return stageOne({
        actor,
        action: 'stage_bid_change',
        target: { type: 'ad_set', id: set?.id ?? campaign.id },
        before: { value: before },
        after: { value: input.value },
        notes: [input.reason ?? '没写理由。'],
        title: `改出价：${set?.name ?? campaign.name}`,
        summary: `${before} → ${input.value}`,
        seen: [{ type: 'ad_set', id: set?.id ?? campaign.id }],
        rule: 'scope_manager',
        // 改出价不直接占总闸（预算才是闸）：它改的是单次竞价，花多少还看预算
        adding: 0,
      })
    },

    async pauseCampaign(actor, campaign_id, input) {
      const campaign = campaignOr404(campaign_id)
      const caps = capsOf(actor.assignment_id, 'pause_ads')
      /*
       * 止损判据在这一跳算一次（纪律 4）。算出来的那句话原样上卡面——
       * 卡上只写"止损"的话，点头这件事就没有内容。
       *
       * guardrail 会拿 `after` 里那三格再判一遍：报了 `stop_loss` 但判据不成立的
       * 转人审。两处都判**不是重复**——这一处是给人看的话，那一处是门。
       */
      const breakEven = options.breakEven?.()
      const verdict = stopLossVerdict({
        ...(campaign.metrics?.roas === undefined ? {} : { roas: campaign.metrics.roas }),
        ...(campaign.metrics?.spend === undefined ? {} : { spend: campaign.metrics.spend }),
        ...(campaign.daily_budget === undefined ? {} : { daily_budget: campaign.daily_budget }),
        caps,
      })
      return stageOne({
        actor,
        action: 'pause_ads',
        target: { type: 'campaign', id: campaign.id },
        before: { status: campaign.status },
        after: {
          status: 'paused',
          reason: input.reason,
          ...(campaign.metrics?.roas === undefined ? {} : { roas: campaign.metrics.roas }),
          ...(campaign.metrics?.spend === undefined ? {} : { spend: campaign.metrics.spend }),
          ...(campaign.daily_budget === undefined ? {} : { daily_budget: campaign.daily_budget }),
          // 卡面上那一格放的是**判据**不是"止损"两个字（`HighlightType.stop_loss`）
          stop_loss_reason: verdict.reason,
          // WP224：判据旁边并排一格盈亏线（「盈亏线 ROAS 2.5（毛利率 40%）」/「没填毛利率」）
          ...(breakEven === undefined
            ? {}
            : {
                break_even_note: breakEven.note,
                ...(breakEven.break_even_roas === undefined
                  ? {}
                  : { break_even_roas: breakEven.break_even_roas }),
              }),
        },
        notes: [
          input.note ?? '',
          verdict.reason,
          ...(breakEven === undefined
            ? []
            : [`${breakEven.note}——只并排显示，停不停仍按上面那条判据。`]),
          '停了不是删了——历史数据还在，随时能再开。',
        ].filter((s) => s !== ''),
        title: `暂停：${campaign.name}`,
        // WP224：摘要里判据后面并排盈亏线那一句（只显示）
        summary: `${input.reason}｜${verdict.reason}${breakEven === undefined ? '' : `｜${breakEven.note}`}`,
        seen: [{ type: 'campaign', id: campaign.id }],
        rule: 'role_holder',
        // 停掉只会少花钱
        adding: 0,
        ...accountOf(campaign),
      })
    },

    async swapCreative(actor, ad_id, input) {
      const ad = store.ad(ad_id)
      if (ad === undefined) throw new ApiError('not_found', `没有这条广告：${ad_id}`)
      return stageOne({
        actor,
        action: 'stage_creative_swap',
        target: { type: 'ad', id: ad.id },
        before: {
          ...(ad.primary_text === undefined ? {} : { primary_text: ad.primary_text }),
          ...(ad.headline === undefined ? {} : { headline: ad.headline }),
          ...(ad.creative_refs === undefined ? {} : { creative_refs: ad.creative_refs }),
        },
        after: {
          ...(input.primary_text === undefined ? {} : { primary_text: input.primary_text }),
          ...(input.headline === undefined ? {} : { headline: input.headline }),
          ...(input.creative_ref === undefined ? {} : { creative_refs: [input.creative_ref] }),
        },
        notes: [
          '换素材不动受众与账户——那两格是受保护字段，动了 guardrail 当场拦。',
          '新文案会过承诺扫描：效果保证、极限词、没人批准过的促销一律拦死（不是转人审）。',
        ],
        title: `换素材：${ad.name}`,
        summary: `${input.headline ?? ad.headline ?? ''}｜${(input.primary_text ?? '').slice(0, 80)}`,
        seen: [{ type: 'ad', id: ad.id }],
        rule: 'scope_manager',
        adding: 0,
      })
    },
  }

  if (proposals !== undefined && options.wiring !== undefined) {
    const wiring = options.wiring
    /** 账本 / 截图只给这条职责那个平台的（Meta 那条看不见 Google 的）。 */
    const mine = (actor: AdsActor) => {
      const p = platformOf(actor)
      return wiring.entries().filter((e) => e.platform === p)
    }
    port.stageChanges = (actor, input) =>
      proposals.stageChanges(actor, {
        account_id: input.account_id,
        ops: input.ops as AdSheetOp[],
        ...(input.reason === undefined ? {} : { reason: input.reason }),
      })
    port.stageActivation = (actor, campaign_id) => proposals.stageActivation(actor, campaign_id)
    port.stageUndo = (actor, change_id) => {
      if (!mine(actor).some((e) => e.change_id === change_id))
        throw new ApiError('not_found', '账本里没有这一条（或不是这个平台的）。')
      return proposals.stageUndo(actor, change_id)
    }
    port.ledger = (actor) => ({ rows: mine(actor) })
    port.confirmChange = (actor, change_id, input) => {
      if (!mine(actor).some((e) => e.change_id === change_id))
        throw new ApiError('not_found', '账本里没有这一条（或不是这个平台的）。')
      return wiring.confirm(change_id, input.submit)
    }
    port.evidence = async (actor, id) => {
      if (!mine(actor).some((e) => e.evidence.some((x) => x.id === id))) return undefined
      const png = await wiring.evidenceImage(id)
      return png === undefined ? undefined : { png_base64: Buffer.from(png).toString('base64') }
    }
    port.snapshot = async (actor, account_id) => {
      const acc = store.account(account_id)
      if (acc === undefined) throw new ApiError('not_found', `没有这个广告账户：${account_id}`)
      if (
        acc.platform !== platformOf(actor) ||
        (acc.platform !== 'google' && acc.platform !== 'meta')
      )
        throw new ApiError('forbidden', '这个账户不归这条职责。')
      const out = await wiring.requestSnapshot({
        platform: actionPlatformOf(acc.platform),
        id: acc.external_id,
      })
      return { queued: out.ok, message: out.message }
    }
  }

  return { port }
}
