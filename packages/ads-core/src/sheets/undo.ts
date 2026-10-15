/**
 * 撤销底稿（docs/101 §5.1② 第 9 步，WP316）：把一批改动**反过来**，拼成另一张上传表的意图。
 *
 * - 改预算 → 改回原来那个数；暂停 ↔ 启用 → 反过来；
 * - 新建的（广告系列 / 广告组 / 广告 / 关键词）→ **暂停**，不删：删除广告系列在「默认不碰」区域里（决策 557），
 *   而且新建本来就是暂停着建的（553），多半只是把「开始投放」那一下撤回来；
 * - 顺序倒过来（先撤最后做的）。
 *
 * Google 有一次性「撤销」按钮，优先用它（插件 `undo_upload`）；这一份给 Meta（用改前表反向导入）
 * 和 Google 撤销按钮已经用掉的时候。纯函数，不碰 IO。
 */

import type { ParsedAdsExport } from './parse.js'
import { attachIdsFromExport } from './readback.js'
import type { AdSheetOp, SetStatusOp } from './types.js'

export interface UndoPlan {
  ops: AdSheetOp[]
  /** 一句白话（卡面用）。 */
  sentence: string
}

function pauseOf(op: AdSheetOp): SetStatusOp | undefined {
  switch (op.kind) {
    case 'create_campaign':
      return {
        kind: 'set_status',
        level: 'campaign',
        ref: { campaign: op.campaign },
        status: 'paused',
      }
    case 'create_ad_group':
      return {
        kind: 'set_status',
        level: 'ad_group',
        ref: {
          campaign: op.campaign,
          ...(op.campaign_id === undefined ? {} : { campaign_id: op.campaign_id }),
          ad_group: op.ad_group,
        },
        status: 'paused',
      }
    case 'create_ad': {
      const ad = op.meta?.ad_name ?? op.google?.headlines[0] ?? op.meta?.title
      if (ad === undefined) return undefined
      return {
        kind: 'set_status',
        level: 'ad',
        ref: {
          campaign: op.campaign,
          ...(op.campaign_id === undefined ? {} : { campaign_id: op.campaign_id }),
          ad_group: op.ad_group,
          ...(op.ad_group_id === undefined ? {} : { ad_group_id: op.ad_group_id }),
          ad,
        },
        status: 'paused',
      }
    }
    case 'add_keyword':
      return {
        kind: 'set_status',
        level: 'keyword',
        ref: {
          campaign: op.campaign,
          ...(op.campaign_id === undefined ? {} : { campaign_id: op.campaign_id }),
          ad_group: op.ad_group,
          ...(op.ad_group_id === undefined ? {} : { ad_group_id: op.ad_group_id }),
          keyword: op.text,
          match: op.match,
        },
        status: 'paused',
      }
    default:
      return undefined
  }
}

/**
 * 把 `ops` 反过来。`after` 是改后导出（读回那一份）：新建的东西靠它补上平台给的编号，
 * 改已有的那几条本来就带着编号。
 */
export function buildUndoOps(ops: readonly AdSheetOp[], after?: ParsedAdsExport): UndoPlan {
  const out: AdSheetOp[] = []
  let restored = 0
  let paused = 0
  for (const op of [...ops].reverse()) {
    if (op.kind === 'set_budget') {
      out.push({ ...op, before: op.after, after: op.before })
      restored += 1
      continue
    }
    if (op.kind === 'set_status') {
      out.push({ ...op, status: op.status === 'paused' ? 'enabled' : 'paused' })
      restored += 1
      continue
    }
    const p = pauseOf(op)
    if (p === undefined) continue
    out.push(after === undefined ? p : (attachIdsFromExport([p], after)[0] ?? p))
    paused += 1
  }
  const parts: string[] = []
  if (restored > 0) parts.push(`${restored} 条改回原样`)
  if (paused > 0) parts.push(`新建的 ${paused} 个先暂停（不删）`)
  return {
    ops: out,
    sentence: parts.length === 0 ? '没有能撤的改动。' : `撤销：${parts.join('，')}。`,
  }
}
