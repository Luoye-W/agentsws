/**
 * WP317（docs/101 §5.1④「设计岗批量出图」）：投放 → 设计岗的**批量出图需求单**。
 *
 * 这对应 Austin 的 Figma 插件（同一个版式，一次换几十种标题出图）。三步三个级别：
 *
 * | 步 | 谁 | 级别 |
 * |---|---|---|
 * | 下需求单（这个文件拼的那一张） | 投放岗 `request_design` | **L3**（不出图、不花钱） |
 * | 出变体给人挑 | 设计岗 `generate_variants` | **L2**（每单 ≤ 30、每天 ≤ 100，决策 559） |
 * | 入库 | 设计岗 `stage_asset` | **L1**（永远人点） |
 *
 * 这里只拼单子：标题、需求原文（文案用「」括起来——设计岗的 `readNeed` 就是按引号
 * 切图上文案的）、规格、要几版。额度在这里**先说**（超了就截并写一句），
 * 设计岗那边的 guardrail 再真拦——同一个数两个位置，读的都是契约的 `DESIGN_ADS_CAPS`。
 */

import type { AdCreativePlatform, AdCreativeRewrite } from '@agentsws/contracts'
import { DESIGN_ADS_CAPS } from '@agentsws/contracts'

/** 设计岗那边广告规格的 id（`design-core` 的 `adSpecId`）。不给规格时按平台给默认两个。 */
export const AD_DESIGN_DEFAULT_SPECS: Readonly<Record<AdCreativePlatform, readonly string[]>> = {
  google: ['ads.google.display', 'ads.google.pmax_square'],
  meta: ['ads.meta.feed', 'ads.meta.story'],
}

export interface DesignBatchInput {
  platform: AdCreativePlatform
  rewrites: readonly AdCreativeRewrite[]
  /** 要几版；不给 = 收下的标题有几条就几版（封顶 30）。 */
  variants?: number
  spec_ids?: readonly string[]
  /** 这批图想验证什么（会写进需求单的「目标」）。 */
  goal?: string
  audience?: string
  /** 今天设计岗已经出了几张（广告那条）。 */
  generated_today?: number
}

export interface DesignBatchPlan {
  title: string
  need: string
  spec_ids: string[]
  variants: number
  /** 上图的那几句（按顺序轮）。 */
  copy: string[]
  /** 额度那一侧的话（空 = 额度内）。 */
  notes: string[]
}

/**
 * 一轮新文案 → 一张批量出图需求单。
 *
 * 上图的只用**标题**：图上的字要短（规格表里展示广告的标题上限就是 30），
 * 描述留给平台自己拼在图下面。没有一条标题就不出单，回一句话。
 */
export function planDesignBatch(input: DesignBatchInput): DesignBatchPlan {
  const caps = DESIGN_ADS_CAPS
  const copy = [...new Set(input.rewrites.flatMap((r) => r.headlines.map((h) => h.text)))]
  const notes: string[] = []
  let variants = input.variants ?? Math.max(copy.length, 1)
  if (variants > caps.max_variants_per_brief) {
    notes.push(
      `一单最多 ${caps.max_variants_per_brief} 版，先出 ${caps.max_variants_per_brief} 版。`,
    )
    variants = caps.max_variants_per_brief
  }
  const left = Math.max(0, caps.max_generations_per_day - (input.generated_today ?? 0))
  if (variants > left)
    notes.push(
      left === 0
        ? `设计岗今天的出图额度（${caps.max_generations_per_day} 张）用完了，单子先排着，明天出。`
        : `设计岗今天还能出 ${left} 张（一天 ${caps.max_generations_per_day}），超出的会转人审。`,
    )
  if (copy.length === 0) notes.push('这一轮没有收下的标题，图上没字可放——先出文案再下单。')
  const specs = input.spec_ids?.length
    ? [...input.spec_ids]
    : [...AD_DESIGN_DEFAULT_SPECS[input.platform]]
  const campaigns = [...new Set(input.rewrites.map((r) => r.campaign))].slice(0, 3).join('、')
  const need = [
    `广告批量出图，同一个版式换图上文字，一共 ${variants} 版。`,
    `目标：${input.goal?.trim() || '测哪句标题点击率高'}。`,
    ...(input.audience?.trim() ? [`受众：${input.audience.trim()}。`] : []),
    `用在：${campaigns || '这一轮的广告'}。`,
    `图上文字按下面轮，一字不改：${copy.map((c) => `「${c}」`).join('')}`,
  ].join('\n')
  return {
    title: `广告批量出图：${variants} 版（${input.platform === 'google' ? 'Google' : 'Meta'}）`,
    need,
    spec_ids: specs,
    variants,
    copy,
    notes,
  }
}
