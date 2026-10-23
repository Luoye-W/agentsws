/**
 * 一份主页 / 内容快照 → 插件面板上那几块**算出来**的数（WP496）。
 *
 * 新写的接线，算法全是移植来的那几份（本体不改）：
 * - 体检（播放 / 粉丝比、疑似刷粉、优秀 / 正常 / 偏弱）：`computeLocalHealth`；内容页 `computeContentHealth`
 * - 受众真实性（不登录那一档的几条信号）：`localAuthenticitySignals`
 * - 频道估值（不登录那一档的区间；疑似刷粉不报价）：`estimateLocalValuation` + `valuationExportText`
 * - 更新规律：采集器已经算好放在快照的 `regularity` 里（`assessUploadRegularity`）
 *
 * 插件面板与 ego 路拿到的是同一份快照，算出来的就是同一份数。
 */
import { type AuthenticitySignal, localAuthenticitySignals } from './kol/authenticity.js'
import {
  type ContentHealth,
  computeContentHealth,
  computeLocalHealth,
  type LocalHealth,
} from './kol/localHealth.js'
import type { ContentSnapshot } from './kol/utils/contentSnapshot.js'
import type { CreatorSnapshot, UploadRegularity } from './kol/utils/creatorSnapshot.js'
import {
  estimateLocalValuation,
  type LocalValuation,
  valuationExportText,
} from './kol/valuation.js'

export interface CreatorMetrics {
  health: LocalHealth
  authenticity_signals: AuthenticitySignal[]
  valuation: LocalValuation
  /** 估值区间的文字（「$120-$280」这种；不报价时是一句说明）——与插件「复制一行」同一格。 */
  valuation_text: string
  regularity: UploadRegularity | undefined
  recent_items: number
}

export function creatorMetrics(snapshot: CreatorSnapshot): CreatorMetrics {
  const health = computeLocalHealth(snapshot)
  const valuation = estimateLocalValuation(snapshot, {
    likelyFaked: health.boughtAudienceSuspected,
  })
  return {
    health,
    authenticity_signals: localAuthenticitySignals(snapshot),
    valuation,
    valuation_text: valuationExportText(valuation),
    regularity: snapshot.regularity,
    recent_items: snapshot.recentItems.length,
  }
}

export interface ContentMetrics {
  health: ContentHealth
}

export function contentMetrics(snapshot: ContentSnapshot): ContentMetrics {
  return { health: computeContentHealth(snapshot) }
}
