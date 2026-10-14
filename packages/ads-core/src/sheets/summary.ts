/**
 * 改前 / 改后对比（docs/101 §5.1② 第 3 步：审批卡上一句白话 + 一张预览表）。
 *
 * 卡面照「界面少字」：一句话说清改了什么，细节在预览表里。新建的一律写「已暂停」，
 * 启用单独点名「开始花钱」——人点头之前要看得见哪一下会花钱。
 */

import { deltaPct } from '../budget.js'
import { type ExportEntity, exportEntities, type ParsedAdsExport } from './parse.js'
import type {
  AdEntityLevel,
  AdEntityRef,
  AdSheetOp,
  SetStatusOp,
  SheetPlatform,
  SheetPreviewRow,
  SheetSummary,
} from './types.js'

const LEVEL_ZH: Record<AdEntityLevel, string> = {
  campaign: '广告系列',
  ad_group: '广告组',
  ad: '广告',
  keyword: '关键词',
}
const UNIT: Record<AdEntityLevel, string> = {
  campaign: '个',
  ad_group: '个',
  ad: '条',
  keyword: '个',
}

const STATUS_ZH = { enabled: '启用', paused: '暂停', removed: '已删除', unknown: '不清楚' } as const

function pathOf(ref: AdEntityRef, level: AdEntityLevel): string {
  const parts = [ref.campaign]
  if (level !== 'campaign' && ref.ad_group !== undefined) parts.push(ref.ad_group)
  if (level === 'ad') parts.push(ref.ad ?? (ref.ad_id === undefined ? '广告' : `广告 ${ref.ad_id}`))
  if (level === 'keyword' && ref.keyword !== undefined) parts.push(ref.keyword)
  return parts.join(' › ')
}

const clip = (s: string, n = 24): string =>
  [...s].length > n ? `${[...s].slice(0, n).join('')}…` : s

/** 在改前导出里找这条对象（按编号，没编号按名字）。 */
function findBefore(
  entities: readonly ExportEntity[],
  level: AdEntityLevel,
  ref: AdEntityRef,
): ExportEntity | undefined {
  const id =
    level === 'campaign' ? ref.campaign_id : level === 'ad_group' ? ref.ad_group_id : ref.ad_id
  return entities.find((e) => {
    if (e.level !== level) return false
    if (id !== undefined) {
      const eid =
        level === 'campaign' ? e.campaign_id : level === 'ad_group' ? e.ad_group_id : e.ad_id
      return eid === id
    }
    if (level === 'keyword')
      return e.ad_group === ref.ad_group && e.keyword?.toLowerCase() === ref.keyword?.toLowerCase()
    return e.campaign === ref.campaign && (level === 'campaign' || e.ad_group === ref.ad_group)
  })
}

/**
 * 出卡面那一句话和预览表。`before` 给了的话，暂停 / 启用那几行的「改前」从导出里取。
 */
export function summarizeAdSheet(
  platform: SheetPlatform,
  ops: readonly AdSheetOp[],
  options: { before?: ParsedAdsExport; currency_symbol?: string } = {},
): SheetSummary {
  const cur = options.currency_symbol ?? '¥'
  const entities = options.before === undefined ? [] : exportEntities(options.before)
  const create: Record<AdEntityLevel, number> = { campaign: 0, ad_group: 0, ad: 0, keyword: 0 }
  const rows: SheetPreviewRow[] = []
  const budgetLines: string[] = []
  let pause = 0
  let enable = 0
  for (const op of ops) {
    switch (op.kind) {
      case 'create_campaign':
        create.campaign += 1
        rows.push({
          action: '新建',
          level: LEVEL_ZH.campaign,
          name: op.campaign,
          after:
            op.daily_budget === undefined ? '已暂停' : `已暂停 · 日预算 ${cur}${op.daily_budget}`,
        })
        break
      case 'create_ad_group': {
        create.ad_group += 1
        const b = op.meta?.daily_budget
        rows.push({
          action: '新建',
          level: platform === 'meta' ? '广告组（Ad Set）' : LEVEL_ZH.ad_group,
          name: `${op.campaign} › ${op.ad_group}`,
          after: b === undefined ? '已暂停' : `已暂停 · 日预算 ${cur}${b}`,
        })
        break
      }
      case 'create_ad': {
        create.ad += 1
        const label = op.google?.headlines[0] ?? op.meta?.title ?? op.meta?.body ?? ''
        rows.push({
          action: '新建',
          level: LEVEL_ZH.ad,
          name: `${op.campaign} › ${op.ad_group} › ${clip(op.meta?.ad_name ?? label)}`,
          after: '已暂停',
        })
        break
      }
      case 'add_keyword':
        create.keyword += 1
        rows.push({
          action: '新建',
          level: LEVEL_ZH.keyword,
          name: `${op.campaign} › ${op.ad_group} › ${op.text}`,
          after: '已暂停',
        })
        break
      case 'set_budget': {
        const pct = Math.round(deltaPct(op.before, op.after))
        const sign = op.after >= op.before ? '+' : '-'
        rows.push({
          action: '改预算',
          level: LEVEL_ZH[op.level],
          name: pathOf(op.ref, op.level),
          before: `${cur}${op.before}`,
          after: `${cur}${op.after}（${sign}${Number.isFinite(pct) ? pct : '∞'}%）`,
        })
        budgetLines.push(
          `${clip(op.ref.ad_group ?? op.ref.campaign, 16)} 预算从 ${cur}${op.before} 改到 ${cur}${op.after}`,
        )
        break
      }
      case 'set_status': {
        if (op.status === 'paused') pause += 1
        else enable += 1
        const b = findBefore(entities, op.level, op.ref)
        rows.push({
          action: op.status === 'paused' ? '暂停' : '启用',
          level: LEVEL_ZH[op.level],
          name: pathOf(op.ref, op.level),
          ...(b === undefined ? {} : { before: STATUS_ZH[b.status] }),
          after: op.status === 'paused' ? '暂停' : '启用（开始花钱）',
        })
        break
      }
    }
  }
  const parts: string[] = []
  const created = (Object.keys(create) as AdEntityLevel[])
    .filter((l) => create[l] > 0)
    .map((l) => `${create[l]} ${UNIT[l]}${LEVEL_ZH[l]}`)
  if (created.length > 0) parts.push(`新建 ${created.join('、')}，都先暂停`)
  if (budgetLines.length > 0 && budgetLines.length <= 2) parts.push(budgetLines.join('，'))
  else if (budgetLines.length > 2) parts.push(`改 ${budgetLines.length} 处预算`)
  if (pause > 0) parts.push(`暂停 ${pause} 条`)
  if (enable > 0) parts.push(`启用 ${enable} 条（启用后开始花钱）`)
  const who = platform === 'google' ? 'Google 广告' : 'Meta 广告'
  return {
    sentence: parts.length === 0 ? `${who}：没有改动。` : `${who}：${parts.join('；')}。`,
    counts: { create, budget_changes: budgetLines.length, pause, enable },
    rows,
  }
}

/**
 * 「开始投放」那张 L1 卡要启用的东西（决策 553）：本批新建的全部，从上到下。
 *
 * 这时候新对象还没有编号（上传后平台才给），所以这里出的 ref 只有名字；
 * Google 的新广告没有名字，用第一条标题当名字。上传、读回之后用
 * `attachIdsFromExport` 把编号补上再出卡（改已有的要带编号，见校验）。
 */
export function activationOpsFor(
  platform: SheetPlatform,
  ops: readonly AdSheetOp[],
): SetStatusOp[] {
  const out: SetStatusOp[] = []
  const counter = new Map<string, number>()
  const enable = (level: AdEntityLevel, ref: AdEntityRef): void => {
    out.push({ kind: 'set_status', level, ref, status: 'enabled' })
  }
  for (const op of ops) {
    if (op.kind === 'create_campaign') enable('campaign', { campaign: op.campaign })
    else if (op.kind === 'create_ad_group')
      enable('ad_group', { campaign: op.campaign, ad_group: op.ad_group })
    else if (op.kind === 'create_ad') {
      const k = `${op.campaign}\u0000${op.ad_group}`
      const n = (counter.get(k) ?? 0) + 1
      counter.set(k, n)
      const name =
        platform === 'meta'
          ? (op.meta?.ad_name ?? `${op.ad_group} · ${n}`)
          : (op.google?.headlines[0] ?? '')
      enable('ad', { campaign: op.campaign, ad_group: op.ad_group, ad: name })
    } else if (op.kind === 'add_keyword' && platform === 'google')
      enable('keyword', {
        campaign: op.campaign,
        ad_group: op.ad_group,
        keyword: op.text,
        match: op.match,
      })
  }
  return out
}
