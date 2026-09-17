/**
 * 58 §2 `specs.ts`：规格表这一侧的**取数口**。
 *
 * 屏幕与印刷那一份的真源在契约（`@agentsws/contracts` 的 {@link DESIGN_SPECS}）——
 * 那张表要给职责 yml、面板、界面下拉一起读，所以它住在契约里，不住在这里。
 * 这个文件做两件事：
 *
 * 1. **广告规格暂时本地定义**（见 {@link AdCreativeSpec}）。真源是 WP75 的
 *    `@agentsws/ads-core` 的 `spec.ts`，那个包还没合进 main。
 * 2. 把两份合成一份给调用方（{@link specsForDuty} / {@link resolveSpec}），
 *    这样 `brief.ts` 与 `variants.ts` 不用关心某个规格是从哪张表来的。
 */

import type { DesignDuty, DesignSafeArea, DesignSpec, DesignSpecFamily } from '@agentsws/contracts'
import { DESIGN_SPECS, designDutySpec } from '@agentsws/contracts'

export type { DesignSafeArea, DesignSpec, DesignSpecFamily } from '@agentsws/contracts'
export { DESIGN_SPECS, designSpec, designSpecsOfFamily } from '@agentsws/contracts'

/* ── 广告规格：暂时本地定义 ─────────────────────────────────────── */

/**
 * 一条广告素材规格。
 *
 * **TODO（WP75 合并后改为 `import` `@agentsws/ads-core` 的 `spec.ts`）**：
 * 四平台广告素材规格表的真源是投放那一侧——广告位是投放的概念（Meta 的
 * `feed` / `story` / `reels`，Google 的 `pmax`），尺寸随平台改版而变，
 * 改的时候投放那边一定先知道。WP76 在这里本地定义一份**形状**，是因为
 * `ads-core` 还没合进 main，import 一个不存在的包等于让整个包编不过。
 * 合并之后这一段（{@link AdCreativeSpec} 与 {@link AD_CREATIVE_SPECS}）
 * 整段删掉，换成一行 `export { AD_SPECS } from '@agentsws/ads-core'`，
 * 下面的 {@link adSpecToDesignSpec} 与它的调用方一个字不用改。
 */
export interface AdCreativeSpec {
  platform: 'meta' | 'google' | 'tiktok' | 'x'
  /** 广告位（`feed` / `story` / `reels` / `discovery` / `in_feed`）。 */
  placement: string
  width: number
  height: number
  /** 视频素材才有。 */
  max_duration_s?: number
  /** 文案字数上限（平台会截断的那个数）。 */
  max_text_chars?: number
  /** 文案安全区：平台在素材上盖 UI 的那一圈。 */
  safe_area?: DesignSafeArea
}

/**
 * 四平台的常用广告位。**这不是完整清单**，是 WP76 够用的那几条——
 * 完整那份在 `ads-core`（见 {@link AdCreativeSpec} 的 TODO）。
 */
export const AD_CREATIVE_SPECS: readonly AdCreativeSpec[] = [
  { platform: 'meta', placement: 'feed', width: 1080, height: 1080, max_text_chars: 125 },
  {
    platform: 'meta',
    placement: 'story',
    width: 1080,
    height: 1920,
    max_duration_s: 60,
    max_text_chars: 125,
    safe_area: { top: 250, right: 60, bottom: 340, left: 60 },
  },
  {
    platform: 'meta',
    placement: 'reels',
    width: 1080,
    height: 1920,
    max_duration_s: 90,
    safe_area: { top: 250, right: 180, bottom: 420, left: 60 },
  },
  { platform: 'google', placement: 'display', width: 1200, height: 628, max_text_chars: 90 },
  { platform: 'google', placement: 'pmax_square', width: 1200, height: 1200, max_text_chars: 90 },
  {
    platform: 'tiktok',
    placement: 'in_feed',
    width: 1080,
    height: 1920,
    max_duration_s: 60,
    max_text_chars: 100,
    safe_area: { top: 180, right: 180, bottom: 500, left: 60 },
  },
  { platform: 'x', placement: 'timeline', width: 1600, height: 900, max_text_chars: 280 },
]

/** 广告规格 id 的写法：`ads.<platform>.<placement>`。 */
export function adSpecId(spec: AdCreativeSpec): string {
  return `ads.${spec.platform}.${spec.placement}`
}

/**
 * 广告规格 → 通用规格（{@link DesignSpec}）。
 *
 * 换算而不是让 `brief.ts` / `variants.ts` 认两种形状：那两个模块关心的只有
 * "画布多大、哪儿不能放东西、能写几个字"，而这三样两边都有。
 * `ads-core` 合并之后只有这个函数的入参类型要换，调用方不动。
 */
export function adSpecToDesignSpec(spec: AdCreativeSpec): DesignSpec {
  return {
    id: adSpecId(spec),
    family: 'ads',
    zh: `${PLATFORM_ZH[spec.platform]} ${spec.placement}`,
    en: `${spec.platform} ${spec.placement}`,
    unit: 'px',
    width: spec.width,
    height: spec.height,
    color_mode: 'sRGB',
    ...(spec.safe_area === undefined ? {} : { safe_area: spec.safe_area }),
    ...(spec.max_duration_s === undefined ? {} : { max_duration_s: spec.max_duration_s }),
    ...(spec.max_text_chars === undefined ? {} : { max_text_chars: spec.max_text_chars }),
  }
}

const PLATFORM_ZH: Record<AdCreativeSpec['platform'], string> = {
  meta: 'Meta',
  google: 'Google',
  tiktok: 'TikTok',
  x: 'X',
}

/** 广告那一族换算好的规格（与 {@link DESIGN_SPECS} 同形，可以混在一起用）。 */
export const AD_DESIGN_SPECS: readonly DesignSpec[] = AD_CREATIVE_SPECS.map(adSpecToDesignSpec)

/* ── 合成一份给调用方 ─────────────────────────────────────────── */

/** 屏幕 + 印刷 + 广告，**全部**规格。id 唯一（广告那一族带 `ads.` 前缀）。 */
export const ALL_DESIGN_SPECS: readonly DesignSpec[] = [...DESIGN_SPECS, ...AD_DESIGN_SPECS]

/** 按 id 取一条（含广告）。不认识的回 `undefined`——**不编一条出来**。 */
export function resolveSpec(id: string): DesignSpec | undefined {
  return ALL_DESIGN_SPECS.find((s) => s.id === id)
}

/**
 * 这条职责吃得到哪些规格（58 §1：五条骨架相同，差别只在规格表）。
 *
 * 不认识的职责回空数组而不是全部——"不知道你要什么"与"什么都给你"
 * 在面板上必须分得开。
 */
export function specsForDuty(duty: DesignDuty): readonly DesignSpec[] {
  const families = designDutySpec(duty)?.spec_families ?? []
  return ALL_DESIGN_SPECS.filter((s) => families.includes(s.family))
}

/** 规格的画布字符串（`"1080x1920"`），直接喂图片模型的 `size`。 */
export function canvasOf(spec: DesignSpec): string {
  if (spec.unit === 'px') return `${spec.width}x${spec.height}`
  // 印刷：mm × dpi ÷ 25.4 = 像素。没写 dpi 按 300（画册与名片的通行值）
  const dpi = spec.dpi ?? 300
  const px = (mm: number) => Math.round((mm * dpi) / 25.4)
  return `${px(spec.width)}x${px(spec.height)}`
}

/**
 * 一条规格的人话说明（brief 与卡面上那一行）。
 *
 * 把 `note_zh`、安全区、字数上限、出血拼成一句——**这些是平台的硬规矩**，
 * 藏在数据结构里没人看得见，写出来才拦得住"主图上加一行促销文案"这种事。
 */
export function specNoteZh(spec: DesignSpec): string {
  const parts: string[] = [
    spec.unit === 'px'
      ? `${spec.width}×${spec.height}px`
      : `${spec.width}×${spec.height}mm @ ${spec.dpi ?? 300}dpi ${spec.color_mode}`,
  ]
  if (spec.bleed_mm !== undefined) parts.push(`出血 ${spec.bleed_mm}mm`)
  if (spec.max_text_chars === 0) parts.push('**一个字都不许有**')
  else if (spec.max_text_chars !== undefined) parts.push(`图上文字不超过 ${spec.max_text_chars} 字`)
  if (spec.max_duration_s !== undefined) parts.push(`最长 ${spec.max_duration_s} 秒`)
  if (spec.safe_area !== undefined) {
    const a = spec.safe_area
    parts.push(`安全区：上 ${a.top} 右 ${a.right} 下 ${a.bottom} 左 ${a.left}`)
  }
  if (spec.note_zh !== undefined) parts.push(spec.note_zh)
  return parts.join('；')
}
