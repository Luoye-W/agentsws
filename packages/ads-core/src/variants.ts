/**
 * 素材 / 文案变体计划（57 §2：一个 campaign 下 A/B，文案过 `commitment_scan`）。
 *
 * 三条纪律：
 *
 * 1. **一次只变一样**。{@link planVariants} 出的每一版与基准版之间**只差一个维度**
 *    （只换图、或只换标题、或只换主文案）。同时换图又换文案的 A/B 跑完也不知道是
 *    哪一样起了作用——那不是实验，是换了一版。
 * 2. **文案先自查一遍，拦下就打回重写**（与 `social-core` 的 `checkOutbound`、
 *    `kol-core` 的起草那一跳同一个位置）。真正的强制在 guardrail 的
 *    `AD_COPY_FORBIDDEN`；这里早一步说，是为了别让一版必然被拦的文案跑到卡面上。
 *    **不静默删改**：命中就回理由，由人或模型重写。
 * 3. **过不了规格的变体不进计划**。规格表是 `spec.ts` 那一份（全仓唯一），
 *    超字数的那一版在平台上会被截掉——截出来的半句话比没有更糟。
 */

import { scanOutboundCommitment } from '@agentsws/support-core'
import { type AdCreativeSpec, checkAgainstSpec, creativeSpec } from './spec.js'

/** 一版变体改的是哪一样。**一次只变一样**（文件头第 1 条）。 */
export type VariantAxis = 'creative' | 'headline' | 'primary_text'

/** 一版广告（基准版或变体）。 */
export interface AdVariant {
  /** 变体 id（`v1` / `v2`…；基准版是 `base`）。 */
  id: string
  /** 与基准版差在哪一样；基准版没有这一格。 */
  axis?: VariantAxis
  creative_ref?: string
  headline?: string
  primary_text?: string
  /** 这一版改了什么，一句人话（卡面与实验记录上那一行）。 */
  note: string
}

/** 文案自查的结论。 */
export interface CopyCheck {
  ok: boolean
  /** 命中的规则名（`scanOutboundCommitment` 报的那些）。 */
  hits: string[]
  /** 一句人话：为什么要重写。原样进卡面，**不静默删改**。 */
  message?: string
}

/**
 * 广告文案自查（承诺扫描，与客服出站、社群群发**同一份词表**）。
 *
 * 真正的拦在 guardrail（`AD_COPY_FORBIDDEN`，那一份还多了极限词与没批过的促销）。
 * 这一跳只是早点给模型反馈——过了这里不代表过得了那里，所以调用方**不许**
 * 拿这个结果当放行凭据。
 */
export function checkAdCopy(
  text: string,
  options: { banned_terms?: readonly string[] } = {},
): CopyCheck {
  const scan = scanOutboundCommitment(text)
  const lower = text.toLowerCase()
  const banned = (options.banned_terms ?? []).filter((t) => lower.includes(t.trim().toLowerCase()))
  const hits = [
    ...scan.hits.map((h) => h.rule),
    ...(scan.unsourced_concession ? ['unsourced_concession'] : []),
    ...banned,
  ]
  if (hits.length === 0) return { ok: true, hits: [] }
  return {
    ok: false,
    hits,
    message: `这版文案里有承诺或禁用词（${hits.join('、')}）。广告是挂在付费流量上给所有人看的，"我们会…""一定…""买一送一"这类话要么走 promotion 那张卡、要么别写。重写一版再来。`,
  }
}

export interface VariantPlanInput {
  platform: string
  placement: string
  /** 基准版（现在正在跑的那一版）。 */
  base: Omit<AdVariant, 'id' | 'axis' | 'note'>
  /** 候选素材（每一个出一版「只换图」）。 */
  creative_refs?: readonly string[]
  /** 候选标题（每一条出一版「只换标题」）。 */
  headlines?: readonly string[]
  /** 候选主文案（每一条出一版「只换主文案」）。 */
  primary_texts?: readonly string[]
  /** 最多出几版（不含基准版）。默认 3——一个 campaign 下同时跑五六版，每版分不到量。 */
  max_variants?: number
  /** 品牌禁用词（公司层技能里那一份，不在这里编）。 */
  banned_terms?: readonly string[]
}

export interface VariantPlan {
  spec?: AdCreativeSpec
  /** 基准版 + 进了计划的那几版。 */
  variants: AdVariant[]
  /** 被挡在外面的候选，以及为什么。**照实摆出来**，不静默丢掉。 */
  rejected: { axis: VariantAxis; value: string; reason: string }[]
  /** 这个平台 / 位没在规格表里时那一句话。 */
  note?: string
}

/**
 * 出一份 A/B 变体计划。
 *
 * 顺序按维度来（先换图、再换标题、最后换主文案），因为**素材的差别最大**：
 * 三版预算有限的时候，先把最可能有差别的那一维跑出来。
 */
export function planVariants(input: VariantPlanInput): VariantPlan {
  const spec = creativeSpec(input.platform, input.placement)
  const max = input.max_variants ?? 3
  const variants: AdVariant[] = [
    {
      id: 'base',
      ...(input.base.creative_ref === undefined ? {} : { creative_ref: input.base.creative_ref }),
      ...(input.base.headline === undefined ? {} : { headline: input.base.headline }),
      ...(input.base.primary_text === undefined ? {} : { primary_text: input.base.primary_text }),
      note: '基准版：现在正在跑的这一版。',
    },
  ]
  const rejected: VariantPlan['rejected'] = []
  let seq = 0

  const accept = (axis: VariantAxis, value: string): void => {
    if (variants.length - 1 >= max) {
      rejected.push({ axis, value, reason: `这一批最多出 ${max} 版，它排在后面了。` })
      return
    }
    // 文案两维要过自查（文件头第 2 条）
    if (axis !== 'creative') {
      const check = checkAdCopy(value, {
        ...(input.banned_terms === undefined ? {} : { banned_terms: input.banned_terms }),
      })
      if (!check.ok) {
        rejected.push({ axis, value, reason: check.message ?? '文案没过自查。' })
        return
      }
    }
    // 规格（字数 / 素材）对不上的不进计划（文件头第 3 条）
    if (spec !== undefined) {
      const asset =
        axis === 'headline' ? { headline: value } : axis === 'primary_text' ? { text: value } : {}
      const fit = checkAgainstSpec(spec, asset)
      if (!fit.ok) {
        rejected.push({ axis, value, reason: fit.problems.join(' ') })
        return
      }
    }
    seq += 1
    variants.push({
      id: `v${seq}`,
      axis,
      // 一次只变一样：别的两格照抄基准版
      creative_ref: axis === 'creative' ? value : input.base.creative_ref,
      headline: axis === 'headline' ? value : input.base.headline,
      primary_text: axis === 'primary_text' ? value : input.base.primary_text,
      note:
        axis === 'creative'
          ? '只换图，文案与基准版一个字不差。'
          : axis === 'headline'
            ? '只换标题，图与主文案与基准版一样。'
            : '只换主文案，图与标题与基准版一样。',
    } as AdVariant)
  }

  for (const v of input.creative_refs ?? [])
    if (v !== input.base.creative_ref) accept('creative', v)
  for (const v of input.headlines ?? []) if (v !== input.base.headline) accept('headline', v)
  for (const v of input.primary_texts ?? [])
    if (v !== input.base.primary_text) accept('primary_text', v)

  return {
    ...(spec === undefined ? {} : { spec }),
    variants,
    rejected,
    ...(spec === undefined
      ? {
          note: `规格表里没有 ${input.platform} / ${input.placement} 这个位——尺寸与字数这一关就没判。出图之前照平台后台再对一遍。`,
        }
      : {}),
  }
}
