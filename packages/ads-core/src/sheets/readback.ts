/**
 * 读回核对（docs/101 §5.1② 第 7 步，照搬 Reddit 通道的「读回自证」）。
 *
 * 平台处理完以后再导出一次，逐条对：新建的在不在、是不是暂停；预算是不是新数；
 * 状态是不是改成了要的那个。对不上就照实报，不替平台圆。
 */

import { type ExportEntity, exportEntities, type ParsedAdsExport } from './parse.js'
import type { AdEntityLevel, AdEntityRef, AdSheetOp, SetStatusOp } from './types.js'

export interface ReadBackItem {
  op_index: number
  /** ok 对上了；mismatch 找到了但不对；missing 没找到；unverifiable 这份导出里没有能对的列。 */
  result: 'ok' | 'mismatch' | 'missing' | 'unverifiable'
  message: string
}

export interface ReadBackReport {
  ok: boolean
  items: ReadBackItem[]
  /** 一句白话（账本与卡面用）。 */
  sentence: string
}

const same = (a: string | undefined, b: string | undefined): boolean =>
  a !== undefined && b !== undefined && a.trim().toLowerCase() === b.trim().toLowerCase()

function locate(
  es: readonly ExportEntity[],
  level: AdEntityLevel,
  ref: AdEntityRef,
): ExportEntity | undefined {
  const id =
    level === 'campaign' ? ref.campaign_id : level === 'ad_group' ? ref.ad_group_id : ref.ad_id
  if (id !== undefined) {
    const byId = es.find((e) =>
      level === 'campaign'
        ? e.campaign_id === id && e.level === 'campaign'
        : level === 'ad_group'
          ? e.ad_group_id === id && e.level === 'ad_group'
          : e.ad_id === id,
    )
    if (byId !== undefined) return byId
  }
  return es.find((e) => {
    if (e.level !== level || !same(e.campaign, ref.campaign)) return false
    if (level === 'campaign') return true
    if (!same(e.ad_group, ref.ad_group)) return false
    if (level === 'ad_group') return true
    if (level === 'keyword')
      return same(e.keyword, ref.keyword) && (ref.match === undefined || e.match === ref.match)
    return ref.ad !== undefined && (same(e.ad, ref.ad) || same(e.headline_1, ref.ad))
  })
}

/** 把一条 op 变成「去导出里找谁、该是什么样」。 */
function expectation(op: AdSheetOp): {
  level: AdEntityLevel
  ref: AdEntityRef
  status?: 'paused' | 'enabled'
  budget?: number
} {
  switch (op.kind) {
    case 'create_campaign':
      return { level: 'campaign', ref: { campaign: op.campaign }, status: 'paused' }
    case 'create_ad_group':
      return {
        level: 'ad_group',
        ref: { campaign: op.campaign, ad_group: op.ad_group },
        status: 'paused',
      }
    case 'create_ad':
      return {
        level: 'ad',
        ref: {
          campaign: op.campaign,
          ad_group: op.ad_group,
          ad: op.meta?.ad_name ?? op.google?.headlines[0] ?? op.meta?.title ?? '',
        },
        status: 'paused',
      }
    case 'add_keyword':
      return {
        level: 'keyword',
        ref: { campaign: op.campaign, ad_group: op.ad_group, keyword: op.text, match: op.match },
        status: 'paused',
      }
    case 'set_budget':
      return { level: op.level, ref: op.ref, budget: op.after }
    case 'set_status':
      return { level: op.level, ref: op.ref, status: op.status }
  }
}

/** 对一份「改后导出」逐条核对。 */
export function readBackCheck(ops: readonly AdSheetOp[], after: ParsedAdsExport): ReadBackReport {
  const es = exportEntities(after)
  const items: ReadBackItem[] = ops.map((op, i) => {
    const want = expectation(op)
    const name = [want.ref.campaign, want.ref.ad_group, want.ref.ad ?? want.ref.keyword]
      .filter((x) => x !== undefined && x !== '')
      .join(' › ')
    const got = locate(es, want.level, want.ref)
    if (got === undefined)
      return { op_index: i, result: 'missing', message: `导出里没找到「${name}」。` }
    if (want.budget !== undefined) {
      if (got.budget === undefined)
        return {
          op_index: i,
          result: 'unverifiable',
          message: `「${name}」找到了，但导出里没有预算这一列。`,
        }
      if (Math.abs(got.budget - want.budget) > 0.005)
        return {
          op_index: i,
          result: 'mismatch',
          message: `「${name}」预算是 ${got.budget}，不是 ${want.budget}。`,
        }
    }
    if (want.status !== undefined) {
      if (got.status === 'unknown')
        return {
          op_index: i,
          result: 'unverifiable',
          message: `「${name}」找到了，但导出里看不出状态。`,
        }
      if (got.status !== want.status)
        return {
          op_index: i,
          result: 'mismatch',
          message: `「${name}」现在是${got.status === 'enabled' ? '启用' : got.status === 'paused' ? '暂停' : '已删除'}，应该是${want.status === 'paused' ? '暂停' : '启用'}。`,
        }
    }
    return { op_index: i, result: 'ok', message: `「${name}」对上了。` }
  })
  const bad = items.filter((x) => x.result === 'mismatch' || x.result === 'missing').length
  const unsure = items.filter((x) => x.result === 'unverifiable').length
  return {
    ok: bad === 0 && unsure === 0,
    items,
    sentence:
      bad === 0 && unsure === 0
        ? `读回核对：${items.length} 条全部对上。`
        : `读回核对：${items.length} 条里 ${bad} 条对不上${unsure > 0 ? `、${unsure} 条没法核对` : ''}，照实报给人。`,
  }
}

/** 给「开始投放」那几条补上平台给的编号（上传、读回之后）。找不到的原样留着。 */
export function attachIdsFromExport(
  ops: readonly SetStatusOp[],
  after: ParsedAdsExport,
): SetStatusOp[] {
  const es = exportEntities(after)
  return ops.map((op) => {
    const got = locate(es, op.level, op.ref)
    if (got === undefined) return op
    const ref: AdEntityRef = { ...op.ref }
    if (got.campaign_id !== undefined) ref.campaign_id = got.campaign_id
    if (op.level !== 'campaign' && got.ad_group_id !== undefined) ref.ad_group_id = got.ad_group_id
    if (op.level === 'ad' && got.ad_id !== undefined) ref.ad_id = got.ad_id
    return { ...op, ref }
  })
}
