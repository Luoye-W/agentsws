/**
 * WP316：广告改动的**出卡那一半**（docs/101 §5.1② ③ / §5.3，决策 552 / 553 / 554 / 558 / 612 / 614）。
 *
 * - `stageChanges`：一批意图（`ads-core` 的 `AdSheetOp[]`）→ 按 552 分路：有新建或 3 条以上 → 一张上传表卡（L1）；
 *   1–2 条暂停 / 启用 / 改预算 → 逐条出卡，插件直接点；
 * - `stageActivation`：让停着的开始花钱（553，L1）；
 * - `stageUndo`：撤销账本里的一条（L1）：Google 上传表用「所有批量操作」里的一次性撤销，
 *   表单那几下反着点，Meta 上传表用改前表反向导入；
 * - `proposeActivation`：上传表做完、读回拿到编号 → 自动出一张「开始投放」卡（新预算这时才算进总闸：614）；
 * - `reissue`：排队 24 小时作废 → 原样重出一张（558；只重出一次）。
 *
 * 出卡都走 ads-service 那一个 `stageOne`（guardrail、额度、总闸、磨合期、插件连没连都在那里）。
 */
import {
  type AdSheetOp,
  type AdUploadBundle,
  buildAdUploadBundle,
  buildUndoOps,
  routeAdChange,
  type SetStatusOp,
  type SheetContext,
} from '@agentsws/ads-core'
import type { AdsActor, AdsChangesView, AdsStagedView } from '@agentsws/api'
import { ApiError } from '@agentsws/api'
import type {
  AdAccount,
  AdCampaign,
  AdsCaps,
  AdsSheetCardAfter,
  ObjectRef,
  StagedChange,
} from '@agentsws/contracts'
import { adsPlatformSpec } from '@agentsws/contracts'
import type { AdsStore } from '../ads.js'
import type { LedgerEntry } from './ledger.js'
import { type AdsWiring, actionPlatformOf, amountText, undoAvailability } from './service.js'
import { sheetCardAfter } from './sheet-card.js'

/** 与 ads-service 的 `stageOne` 同形。 */
export interface AdsStageInput {
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
  adding: number
  field?: string
  account?: AdAccount
}

export interface AdsProposalsDeps {
  store: AdsStore
  wiring: AdsWiring
  stage(input: AdsStageInput): Promise<AdsStagedView>
  capsOf(assignment_id: string, action: string): AdsCaps
  changeOf?(id: string): Promise<StagedChange | undefined>
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

export function currencySymbol(code: string | undefined): string {
  if (code === 'CNY' || code === 'JPY') return '¥'
  if (code === 'USD' || code === 'CAD' || code === 'AUD') return '$'
  if (code === 'EUR') return '€'
  if (code === 'GBP') return '£'
  return code === undefined ? '¥' : `${code} `
}

const EDIT_KINDS = new Set(['set_budget', 'set_status'])

export function createAdsProposals(deps: AdsProposalsDeps) {
  const { store, wiring } = deps

  const accountOr404 = (id: string): AdAccount & { platform: 'google' | 'meta' } => {
    const acc = store.account(id)
    if (acc === undefined) throw new ApiError('not_found', `没有这个广告账户：${id}`)
    if (acc.platform !== 'google' && acc.platform !== 'meta')
      throw new ApiError('invalid_input', '插件执行第一期只接 Google / Meta 两家后台。')
    return acc as AdAccount & { platform: 'google' | 'meta' }
  }
  const actionAccount = (acc: AdAccount & { platform: 'google' | 'meta' }) => ({
    platform: actionPlatformOf(acc.platform),
    id: acc.external_id,
  })
  const label = (p: string): string => adsPlatformSpec(p)?.zh ?? p

  /** 按编号 / 名字在库里找那条 campaign（表单那一下要它的平台编号与名字）。 */
  const campaignOf = (
    acc: AdAccount,
    ref: { campaign: string; campaign_id?: string },
  ): AdCampaign | undefined =>
    store
      .campaigns({ account_id: acc.id })
      .find((c) =>
        ref.campaign_id !== undefined ? c.external_id === ref.campaign_id : c.name === ref.campaign,
      )

  /** 一张上传表卡（上传表 / 开始投放 / 撤销三种共用）。 */
  const stageSheet = async (input: {
    actor: AdsActor
    acc: AdAccount & { platform: 'google' | 'meta' }
    action: 'stage_ads_sheet' | 'stage_ads_activate' | 'stage_ads_undo'
    ops: AdSheetOp[]
    title: string
    notes: string[]
    extra?: Partial<AdsSheetCardAfter>
    adding: number
    allowOverCap?: boolean
  }): Promise<AdsChangesView> => {
    const { acc } = input
    const hasEdits = input.ops.some((o) => EDIT_KINDS.has(o.kind))
    // 决策 612：Meta 改已有要先有一份改前导出（照官方「导出 → 在原行改 → 导入」）
    const before = wiring.latestExport(actionAccount(acc))
    if (acc.platform === 'meta' && hasEdits && before === undefined) {
      const queued = await wiring.requestSnapshot(actionAccount(acc))
      return {
        route: 'sheet',
        reason: 'Meta 改已有要先有一份 24 小时内的改前导出。',
        views: [],
        message: queued.ok
          ? '先导出一份改前表（已排队，插件来了就导）；导出来之后再提一次。'
          : `先要一份改前导出，但没排上：${queued.message}`,
        ...(wiring.extensionReady(acc.platform) ? {} : { needs_connection: 'extension' as const }),
      }
    }
    const caps = deps.capsOf(input.actor.assignment_id, input.action)
    const context: SheetContext = {
      caps: {
        max_budget_delta_pct: caps.max_budget_delta_pct,
        max_daily_spend: caps.max_daily_spend,
      },
      currency_symbol: currencySymbol(acc.currency),
      ...(input.allowOverCap === true ? { allow_over_cap: true } : {}),
    }
    const bundle: AdUploadBundle = buildAdUploadBundle({
      platform: acc.platform,
      ops: input.ops,
      ...(before === undefined ? {} : { before }),
      context,
    })
    if (!bundle.ok)
      return {
        route: 'sheet',
        reason: '本地检查没过，表没出。',
        views: [],
        problems: bundle.problems.filter((p) => p.severity === 'error').map((p) => p.message),
        message: '表还出不了，改好再提。',
      }
    const after = sheetCardAfter({
      bundle,
      platform: acc.platform,
      platform_label: label(acc.platform),
      account_id: acc.id,
      account_name: acc.name,
      ops: input.ops,
      extra: { ...input.extra, title: input.title },
    })
    const view = await deps.stage({
      actor: input.actor,
      action: input.action,
      target: { type: 'ad_account', id: acc.id },
      before: {},
      after,
      notes: [
        ...input.notes,
        '批了由插件在你自己的后台里上传；平台先给预览，你再确认一次才提交（横条上或这里）。',
      ],
      title: input.title,
      summary: bundle.summary.sentence,
      seen: [{ type: 'ad_account', id: acc.id }],
      rule: input.action === 'stage_ads_undo' ? 'role_holder' : 'owner',
      adding: input.adding,
      field: after.fingerprint ?? '',
      account: acc,
    })
    return {
      route: 'sheet',
      reason: '走上传表。',
      views: [view],
      ...(view.needs_connection === undefined ? {} : { needs_connection: view.needs_connection }),
    }
  }

  /** 1–2 条小改动：逐条出卡，插件直接点（552）。 */
  const stageForm = async (
    actor: AdsActor,
    acc: AdAccount & { platform: 'google' | 'meta' },
    op: AdSheetOp,
  ): Promise<AdsStagedView> => {
    if (op.kind !== 'set_budget' && op.kind !== 'set_status')
      throw new ApiError('invalid_input', '直接点只做暂停 / 启用 / 改预算。')
    const level = op.level === 'keyword' ? undefined : op.level
    if (level === undefined) throw new ApiError('invalid_input', '关键词的开关走上传表。')
    const id =
      level === 'campaign'
        ? op.ref.campaign_id
        : level === 'ad_group'
          ? op.ref.ad_group_id
          : op.ref.ad_id
    const c = campaignOf(acc, op.ref)
    const entity_id = id ?? (level === 'campaign' ? c?.external_id : undefined)
    if (entity_id === undefined)
      throw new ApiError('invalid_input', `「${op.ref.campaign}」没有平台编号，插件找不到它。`)
    const name = [op.ref.campaign, op.ref.ad_group, op.ref.ad]
      .filter((x) => x !== undefined)
      .join(' › ')
    const target: ObjectRef =
      level === 'campaign' && c !== undefined
        ? { type: 'campaign', id: c.id }
        : { type: 'ad_account', id: acc.id }
    if (op.kind === 'set_budget')
      return deps.stage({
        actor,
        action: 'stage_budget_change',
        target,
        before: { value: op.before },
        after: {
          value: op.after,
          name,
          _form: [
            {
              action: 'set_budget',
              level,
              entity_id,
              entity_name: name,
              amount: amountText(op.after),
            },
          ],
        },
        notes: [
          op.after < op.before
            ? '这是**调低**预算：花得更少，额度与总闸都不卡这一边。'
            : '这是提预算：超过额度或会破总闸的话，要人点一下。',
          '批了由插件在你自己的后台里改，前后截图留档。',
        ],
        title: `改预算：${name}`,
        summary: `${op.before} → ${op.after}`,
        seen: [target],
        rule: 'scope_manager',
        adding: Math.max(0, op.after - op.before),
        field: `${level}:${entity_id}`,
        account: acc,
      })
    if (op.status === 'paused')
      return deps.stage({
        actor,
        action: 'pause_ads',
        target,
        before: { status: 'active' },
        after: {
          status: 'paused',
          reason: 'manual',
          name,
          _form: [{ action: 'pause', level, entity_id, entity_name: name }],
        },
        notes: [
          '停了不是删了——历史数据还在，随时能再开。',
          '批了由插件在你自己的后台里点，前后截图留档。',
        ],
        title: `暂停：${name}`,
        summary: name,
        seen: [target],
        rule: 'role_holder',
        adding: 0,
        field: `${level}:${entity_id}`,
        account: acc,
      })
    // 启用 = 开始投放（553，L1）
    const budget = level === 'campaign' ? (c?.daily_budget ?? 0) : 0
    return deps.stage({
      actor,
      action: 'stage_ads_activate',
      target,
      before: { status: 'paused' },
      after: {
        form: 'ads_sheet',
        platform: acc.platform,
        platform_label: label(acc.platform),
        account_id: acc.id,
        account_name: acc.name,
        sentence: `开始投放「${name}」`,
        rows: [
          {
            action: '启用',
            level: level === 'campaign' ? '广告系列' : level === 'ad_group' ? '广告组' : '广告',
            name,
          },
        ],
        title: `开始投放：${name}`,
        _form: [{ action: 'enable', level, entity_id, entity_name: name }],
      } satisfies AdsSheetCardAfter,
      notes: ['开始投放 = 让它开始花钱，永远要你点一下（决策 553）。'],
      title: `开始投放：${name}`,
      summary: name,
      seen: [target],
      rule: 'owner',
      adding: budget,
      field: `${level}:${entity_id}`,
      account: acc,
    })
  }

  /** 新预算算进总闸的那一截（614：开始投放时才算）。 */
  const addingOfCreates = (ops: readonly unknown[]): number =>
    (ops as AdSheetOp[]).reduce(
      (sum, o) =>
        sum +
        (o.kind === 'create_campaign'
          ? (o.daily_budget ?? 0)
          : o.kind === 'create_ad_group'
            ? (o.meta?.daily_budget ?? 0)
            : 0),
      0,
    )

  return {
    async stageChanges(
      actor: AdsActor,
      input: { account_id: string; ops: AdSheetOp[]; reason?: string },
    ): Promise<AdsChangesView> {
      const acc = accountOr404(input.account_id)
      if (input.ops.length === 0) throw new ApiError('invalid_input', '没有要改的。')
      const route = routeAdChange(input.ops)
      if (route.route === 'form') {
        const views: AdsStagedView[] = []
        for (const op of input.ops) views.push(await stageForm(actor, acc, op))
        const need = views.some((v) => v.needs_connection !== undefined)
        return {
          route: 'form',
          reason: route.reason,
          views,
          ...(need ? { needs_connection: 'extension' } : {}),
        }
      }
      const out = await stageSheet({
        actor,
        acc,
        action: 'stage_ads_sheet',
        ops: input.ops,
        title: `改广告（${label(acc.platform)}）`,
        notes: [route.reason, ...(input.reason === undefined ? [] : [input.reason])],
        // 新建的都停着，不占总闸；在跑的提预算那一截占
        adding: input.ops.reduce(
          (s, o) => s + (o.kind === 'set_budget' ? Math.max(0, o.after - o.before) : 0),
          0,
        ),
      })
      return { ...out, reason: route.reason }
    },

    async stageActivation(actor: AdsActor, campaign_id: string): Promise<AdsStagedView> {
      const c = store.campaign(campaign_id)
      if (c === undefined) throw new ApiError('not_found', `没有这条 campaign：${campaign_id}`)
      const acc = accountOr404(c.account_id)
      return stageForm(actor, acc, {
        kind: 'set_status',
        level: 'campaign',
        ref: { campaign: c.name, campaign_id: c.external_id },
        status: 'enabled',
      })
    },

    async stageUndo(actor: AdsActor, change_id: string): Promise<AdsChangesView> {
      const entry = wiring.entry(change_id)
      if (entry === undefined)
        throw new ApiError('not_found', '账本里没有这一条（或已过了 180 天）。')
      const can = undoAvailability(entry)
      if (!can.available)
        return {
          route: 'form',
          reason: can.why ?? '撤不了。',
          views: [],
          message: can.why ?? '撤不了。',
        }
      const acc = accountOr404(entry.account_id)
      const notes = ['撤销上一次改动，永远要你点一下。']
      // Google 上传表：「所有批量操作」里那次上传点撤销（只能一次；倒着撤）
      if (entry.files !== undefined && entry.platform === 'google') {
        const form = [...entry.files]
          .reverse()
          .map((f) => ({ action: 'undo_upload' as const, upload_name: f.name }))
        return {
          route: 'form',
          reason: 'Google 的一次性撤销。',
          views: [
            await stageUndoCard(
              actor,
              acc,
              entry,
              form,
              notes,
              'Google「所有批量操作」里撤销这次上传（只能撤一次）。',
            ),
          ],
        }
      }
      // 表单那几下：反着点
      if (entry.form !== undefined) {
        const original = await deps.changeOf?.(change_id)
        const beforeValue = isRecord(original?.before) ? original.before.value : undefined
        const form: NonNullable<AdsSheetCardAfter['_form']> = []
        for (const f of [...entry.form].reverse()) {
          if (f.action === 'pause') form.push({ ...f, action: 'enable' })
          else if (f.action === 'enable') form.push({ ...f, action: 'pause' })
          else if (f.action === 'set_budget' && typeof beforeValue === 'number')
            form.push({ ...f, amount: amountText(beforeValue) })
          else
            return {
              route: 'form',
              reason: '撤不了。',
              views: [],
              message: '原来的预算没记下，没法改回去。',
            }
        }
        return {
          route: 'form',
          reason: '反着点一遍。',
          views: [
            await stageUndoCard(
              actor,
              acc,
              entry,
              form,
              notes,
              form
                .map(
                  (f) =>
                    `${f.action === 'enable' ? '重新启用' : f.action === 'pause' ? '暂停' : `预算改回 ${f.amount}`}「${f.entity_name ?? f.entity_id}」`,
                )
                .join('；'),
            ),
          ],
        }
      }
      // Meta 上传表：用改前表反向导入（新建的暂停、不删）
      const plan = buildUndoOps(
        (entry.ops ?? []) as AdSheetOp[],
        wiring.latestExport(actionAccount(acc)),
      )
      return stageSheet({
        actor,
        acc,
        action: 'stage_ads_undo',
        ops: plan.ops,
        title: `撤销：${entry.title}`,
        notes: [...notes, plan.sentence],
        extra: { undo_of: change_id },
        adding: 0,
        allowOverCap: true,
      })
    },

    async proposeActivation(entry: LedgerEntry, ops: SetStatusOp[]): Promise<string | undefined> {
      if (entry.actor === undefined || ops.length === 0) return undefined
      const acc = store.account(entry.account_id)
      if (acc === undefined || (acc.platform !== 'google' && acc.platform !== 'meta'))
        return undefined
      const out = await stageSheet({
        actor: entry.actor as AdsActor,
        acc: acc as AdAccount & { platform: 'google' | 'meta' },
        action: 'stage_ads_activate',
        ops,
        title: `开始投放（${label(acc.platform)}）`,
        notes: ['新建的已经建好、读回对上了，都停着；批了才开始花钱（决策 553）。'],
        extra: { activation_of: entry.change_id },
        adding: addingOfCreates(entry.ops ?? []),
      })
      return out.views[0]?.change_id
    },

    async reissue(change_id: string): Promise<void> {
      const entry = wiring.entry(change_id)
      const original = await deps.changeOf?.(change_id)
      if (entry?.actor === undefined || original === undefined) return
      const after = isRecord(original.after) ? original.after : {}
      if (after.reissued_from !== undefined) return // 只重出一次，免得每天自动出一张
      const action = ACTION_OF_KIND[original.kind]
      if (action === undefined) return
      const acc = store.account(entry.account_id)
      await deps.stage({
        actor: entry.actor as AdsActor,
        action,
        target: original.target,
        before: original.before,
        after: { ...after, reissued_from: change_id },
        notes: [
          '上一张排了 24 小时插件没来领，作废了；这是原样重出的一张（决策 558）。',
          ...original.notes,
        ],
        title: entry.title,
        summary: entry.sentence ?? entry.title,
        seen: [original.target],
        rule: 'role_holder',
        adding: 0,
        field: `reissue:${change_id}`,
        ...(acc === undefined ? {} : { account: acc }),
      })
    },
  }

  async function stageUndoCard(
    actor: AdsActor,
    acc: AdAccount & { platform: 'google' | 'meta' },
    entry: LedgerEntry,
    form: NonNullable<AdsSheetCardAfter['_form']>,
    notes: string[],
    sentence: string,
  ): Promise<AdsStagedView> {
    const after: AdsSheetCardAfter = {
      form: 'ads_sheet',
      platform: acc.platform,
      platform_label: label(acc.platform),
      account_id: acc.id,
      account_name: acc.name,
      sentence,
      rows: form.map((f) => ({
        action:
          f.action === 'undo_upload'
            ? '撤销'
            : f.action === 'enable'
              ? '启用'
              : f.action === 'pause'
                ? '暂停'
                : '改预算',
        level: f.action === 'undo_upload' ? '上传' : '广告系列',
        name: f.upload_name ?? f.entity_name ?? f.entity_id ?? '',
        ...(f.amount === undefined ? {} : { after: f.amount }),
      })),
      undo_of: entry.change_id,
      title: `撤销：${entry.title}`,
      _form: form,
    }
    return deps.stage({
      actor,
      action: 'stage_ads_undo',
      target: { type: 'ad_account', id: acc.id },
      before: {},
      after,
      notes,
      title: `撤销：${entry.title}`,
      summary: sentence,
      seen: [{ type: 'ad_account', id: acc.id }],
      rule: 'role_holder',
      adding: 0,
      field: `undo:${entry.change_id}`,
      account: acc,
    })
  }
}

export type AdsProposals = ReturnType<typeof createAdsProposals>

/** ChangeKind → 出卡用的动作 id（重出时用）。 */
const ACTION_OF_KIND: Partial<Record<string, string>> = {
  create_campaign: 'stage_campaign',
  budget_change: 'stage_budget_change',
  pause_ad: 'pause_ads',
  ads_sheet: 'stage_ads_sheet',
  ads_activate: 'stage_ads_activate',
  ads_undo: 'stage_ads_undo',
}
