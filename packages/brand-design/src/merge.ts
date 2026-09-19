/**
 * 三条来路合成一份（71 §2）。
 *
 * 规则只有三条，但第一条是全篇最重要的一条：
 *
 * > **1. 用户改过的格子，整格不动。**
 *
 * 与 WP121 的 `mergeProfile` 一字不差，理由也一字不差：一个按钮只要有一次
 * 吃掉过你的手工修改，它就死了。用户上周把主色改对了，这周重抓一次又被覆盖
 * 回 CSS 里量出来的那个近似值——「重新抓」这个按钮从此没人敢按。
 *
 * > **2. 手册 > 官网。** 文件里写的是**规范**，官网是**实现**，实现可能没跟上。
 *
 * > **3. 但"优先"不等于"删掉另一个"。**
 *
 * 第三条是这个文件与一个普通的深合并之间的全部差别。冲突的那个值被搬到
 * {@link BrandDesignValue.conflict} 里留着，界面上并排画两个色块让用户点一下。
 * 我们没资格替用户判他的手册和他的官网哪个是对的——**我们只有资格让他看见
 * 这两个不一样**。这件事恰恰是这份功能对一个真实品牌最有用的一刻：很多品牌
 * 根本不知道自己的官网没照手册做。
 */
import type { BrandDesignOrigin, BrandDesignProfile, BrandDesignValue } from '@agentsws/contracts'

/** 来路的优先级。数字大的赢（赢的只是 `value` 那一格，见文件头注释）。 */
const PRIORITY: Record<BrandDesignOrigin, number> = {
  manual: 4,
  file: 3,
  theme: 2,
  site: 1,
}

function originOf(v: BrandDesignValue<unknown>): BrandDesignOrigin {
  return v.source[0]?.origin ?? 'site'
}

/** 两个值算不算"说的是同一件事"（冲突判定用）。 */
function sameValue(a: unknown, b: unknown): boolean {
  if (typeof a === 'string' && typeof b === 'string')
    return a.trim().toLowerCase() === b.trim().toLowerCase()
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * 一格对一格。
 *
 * `previous` 是库里的，`incoming` 是这一轮新抽的。
 */
export function mergeValue<T>(
  previous: BrandDesignValue<T> | undefined,
  incoming: BrandDesignValue<T> | undefined,
): BrandDesignValue<T> | undefined {
  if (previous === undefined) return incoming
  if (incoming === undefined) {
    // 这一轮没抽到、上一轮有的：**留着上一轮的**。抓不到不等于"这一格现在
    // 是空的"，可能只是那天那份样式表 502 了。
    return previous
  }
  // 规则 1：改过的整格不动。连出处都不刷新——那时候的出处说的是"我们当初
  // 为什么填错"，留着没有意义。
  if (previous.edited === true) return previous

  const pOrigin = originOf(previous)
  const iOrigin = originOf(incoming)

  if (sameValue(previous.value, incoming.value)) {
    // 两条路说的是同一个值：把出处并起来（这反而让这一格更硬）
    const merged: BrandDesignValue<T> = {
      value: incoming.value,
      confidence: strongerConfidence(previous.confidence, incoming.confidence),
      source: [...incoming.source, ...previous.source].slice(0, 6),
    }
    if (previous.conflict !== undefined) merged.conflict = previous.conflict
    return merged
  }

  const winner = PRIORITY[iOrigin] >= PRIORITY[pOrigin] ? incoming : previous
  const loser = winner === incoming ? previous : incoming
  return {
    value: winner.value,
    confidence: winner.confidence,
    source: winner.source,
    ...(winner.edited === true ? { edited: true } : {}),
    // 规则 3：输的那个留着，不删
    conflict: { value: loser.value, source: loser.source },
  }
}

function strongerConfidence(
  a: BrandDesignValue<unknown>['confidence'],
  b: BrandDesignValue<unknown>['confidence'],
): BrandDesignValue<unknown>['confidence'] {
  const rank = { high: 3, medium: 2, low: 1 } as const
  return rank[a] >= rank[b] ? a : b
}

function mergeRecord<T>(
  previous: Record<string, BrandDesignValue<T>> | undefined,
  incoming: Record<string, BrandDesignValue<T>> | undefined,
): Record<string, BrandDesignValue<T>> | undefined {
  if (previous === undefined) return incoming
  if (incoming === undefined) return previous
  const out: Record<string, BrandDesignValue<T>> = { ...previous }
  for (const key of new Set([...Object.keys(previous), ...Object.keys(incoming)])) {
    const merged = mergeValue(previous[key], incoming[key])
    if (merged !== undefined) out[key] = merged
  }
  return out
}

/**
 * 两份档案合一份。
 *
 * **不对称**：`previous` 是已经在库里的（可能带着用户的手改），`incoming` 是
 * 这一轮新抽的。反过来调会把"改过的不动"这条规则调反。
 */
export function mergeDesignProfile(
  previous: BrandDesignProfile,
  incoming: BrandDesignProfile,
): BrandDesignProfile {
  const out: BrandDesignProfile = {}

  const name = mergeValue(previous.name, incoming.name)
  if (name !== undefined) out.name = name
  const description = mergeValue(previous.description, incoming.description)
  if (description !== undefined) out.description = description
  const logos = mergeValue(previous.logos, incoming.logos)
  if (logos !== undefined) out.logos = logos
  const imagery = mergeValue(previous.imagery, incoming.imagery)
  if (imagery !== undefined) out.imagery = imagery
  const motion = mergeValue(previous.motion, incoming.motion)
  if (motion !== undefined) out.motion = motion
  const voice = mergeValue(previous.voice, incoming.voice)
  if (voice !== undefined) out.voice = voice

  const colors = mergeRecord(previous.colors, incoming.colors)
  if (colors !== undefined) out.colors = colors
  const typography = mergeRecord(previous.typography, incoming.typography)
  if (typography !== undefined) out.typography = typography
  const rounded = mergeRecord(previous.rounded, incoming.rounded)
  if (rounded !== undefined) out.rounded = rounded
  const spacing = mergeRecord(previous.spacing, incoming.spacing)
  if (spacing !== undefined) out.spacing = spacing
  const shadows = mergeRecord(previous.shadows, incoming.shadows)
  if (shadows !== undefined) out.shadows = shadows

  if (previous.components !== undefined || incoming.components !== undefined) {
    const components: Record<
      string,
      Record<string, import('@agentsws/contracts').BrandDesignValue<string>>
    > = {}
    const keys = new Set([
      ...Object.keys(previous.components ?? {}),
      ...Object.keys(incoming.components ?? {}),
    ])
    for (const key of keys) {
      const merged = mergeRecord(previous.components?.[key], incoming.components?.[key])
      if (merged !== undefined) components[key] = merged
    }
    if (Object.keys(components).length > 0) out.components = components
  }
  return out
}

/** 这份档案里还有几处两边说法不一样（界面上那个「2 处不一致」的角标）。 */
export function conflictCount(profile: BrandDesignProfile): number {
  let n = 0
  const walkOne = (v: BrandDesignValue<unknown> | undefined): void => {
    if (v?.conflict !== undefined) n++
  }
  const walkRecord = (rec: Record<string, BrandDesignValue<unknown>> | undefined): void => {
    for (const v of Object.values(rec ?? {})) walkOne(v)
  }
  walkOne(profile.name)
  walkOne(profile.description)
  walkOne(profile.logos)
  walkOne(profile.imagery)
  walkOne(profile.motion)
  walkOne(profile.voice)
  walkRecord(profile.colors)
  walkRecord(profile.typography)
  walkRecord(profile.rounded)
  walkRecord(profile.spacing)
  walkRecord(profile.shadows)
  for (const props of Object.values(profile.components ?? {})) walkRecord(props)
  return n
}

/**
 * 用户在界面上改了一格。
 *
 * 打上 `edited` 并把出处记成"这个人本人"——比任何一层 CSS 都硬。
 * 顺手把 `conflict` 清掉：他已经在两个值之间做了选择，那个角标该消失了。
 */
export function editValue<T>(value: T, at: string): BrandDesignValue<T> {
  return {
    value,
    confidence: 'high',
    source: [{ origin: 'manual', locator: `edited:${at}` }],
    edited: true,
  }
}
