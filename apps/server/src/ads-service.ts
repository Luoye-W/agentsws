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

import { daySpendGate, stopLossVerdict } from '@agentsws/ads-core'
import type { AdsActor, AdsCampaignRow, AdsPort, AdsStagedView } from '@agentsws/api'
import { ApiError } from '@agentsws/api'
import type {
  AdCampaign,
  AdsCaps,
  AdsPlatform,
  AssignmentId,
  ChangeKind,
  Clock,
  EffectiveConfig,
  EventEnvelope,
  Mandate,
  ObjectRef,
  ProvenanceState,
  WorkspaceId,
} from '@agentsws/contracts'
import { ADS_DEFAULT_CAPS, adsPlatformOfRole } from '@agentsws/contracts'
import type { StageInput, StageOutcome } from '@agentsws/txn'
import type { AdsStore } from './ads.js'

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
  }): Promise<AdsStagedView> => {
    const run_id = `run_ads_${nextId('a')}`
    const { mandate, level } = actionOf(input.actor.assignment_id, input.action)
    const caps = capsOf(input.actor.assignment_id, input.action)
    const gate = gateOf(caps, input.adding)
    const kind = KIND_OF[input.action]
    if (kind === undefined) throw new ApiError('invalid_input', `不认识这个动作：${input.action}`)
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
      // 总闸那句话跟着卡走（纪律 3）
      notes: [...input.notes, gate.reason],
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
    if (!outcome.ok)
      return { staged: false, message: outcome.message, level, spend_gate: gate.view }
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
    }
  }

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
        },
        notes: [
          // 04 §5：新开花钱口子永远人审——这句话写在卡上，不只写在文档里
          '新建一条 campaign 是**开一个新的花钱口子**，永远要人点一下（04 §5）。',
          '批了之后它是**停着**建出来的——让它开始花钱是另一张卡。',
        ],
        title: `新建 campaign：${input.name}`,
        summary: `${account.name}｜日预算 ${input.daily_budget}｜${input.audience_summary ?? '受众没写'}`,
        seen: [{ type: 'ad_account', id: account.id }],
        rule: 'owner',
        adding: input.daily_budget,
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
        },
        notes: [
          input.note ?? '',
          verdict.reason,
          '停了不是删了——历史数据还在，随时能再开。',
        ].filter((s) => s !== ''),
        title: `暂停：${campaign.name}`,
        summary: `${input.reason}｜${verdict.reason}`,
        seen: [{ type: 'campaign', id: campaign.id }],
        rule: 'role_holder',
        // 停掉只会少花钱
        adding: 0,
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

  return { port }
}
