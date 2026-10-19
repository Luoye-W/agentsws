/**
 * WP426（Luoye 10-19 beta.3 截图）：输入框 AI 钮那份清单收短、能力小标只标例外。
 *
 * 1. **实验 / 预览型号不进清单**（`-exp` / `-experimental` / `-preview`…）：搜的时候照样搜得到；
 *    当前选着的、品牌默认的那一个永远留着。
 * 2. **别名与带版本号的是同一个就只留一个**：同一个来源里 `deepseek-flash` 与 `deepseek-v4-flash`
 *    这种——去掉版本段（`-v4`、`-v4.1`）后一样、而且正好一个不带版本一个带版本，才算同一个；
 *    留默认 / 当前那一个，都不是就留不带版本的别名（短、跟着上游升级）。两个都带版本（v4 与 v4.1）
 *    不合并——那可能真是两代。
 * 3. **能力小标只标例外**：一项能力（看图 / 自带联网 / 长上下文）清单里过半都有，就不在每行写；
 *    「看图」反过来只标**看不了图**的那几行；联网、长上下文只在少数有的时候标出有的那几行。
 *
 * 纯函数，不碰 React，单测直接测。
 */
import type { FreeChatModelChoice } from './free-chat'

/** 实验 / 预览那一类的型号段。 */
const EXPERIMENTAL = /(^|[-_.])(exp|experimental|preview|beta|alpha|test|nightly)([-_.]|\d|$)/i
/** 版本段：`-v4`、`-v4.1`、`-v3.2`。 */
const VERSION = /-v\d+(?:\.\d+)*(?=-|$)/i

const modelOf = (id: string): string => id.slice(id.indexOf('/') + 1)
const sourceOf = (id: string): string => id.slice(0, Math.max(0, id.indexOf('/')))

export function isExperimentalModel(id: string): boolean {
  return EXPERIMENTAL.test(modelOf(id))
}

/** 去掉版本段之后的名字（判「别名」用）。 */
export function aliasKey(id: string): string {
  return `${sourceOf(id)}/${modelOf(id).toLowerCase().replace(VERSION, '')}`
}

/**
 * 收短：去掉实验型号、合并别名。`keep` 里的 id（当前 / 默认）一律留着。顺序不变。
 */
export function compactChoices<T extends { id: string }>(
  choices: readonly T[],
  keep: ReadonlySet<string>,
): T[] {
  const visible = choices.filter((c) => keep.has(c.id) || !isExperimentalModel(c.id))
  const byKey = new Map<string, T[]>()
  for (const c of visible) {
    const k = aliasKey(c.id)
    byKey.set(k, [...(byKey.get(k) ?? []), c])
  }
  const drop = new Set<string>()
  for (const same of byKey.values()) {
    if (same.length !== 2) continue
    const [a, b] = same as [T, T]
    const aVer = VERSION.test(modelOf(a.id))
    const bVer = VERSION.test(modelOf(b.id))
    if (aVer === bVer) continue
    const alias = aVer ? b : a
    const versioned = aVer ? a : b
    // 两个都要留（一个当前、一个默认）就都留
    if (keep.has(alias.id) && keep.has(versioned.id)) continue
    drop.add(keep.has(versioned.id) ? alias.id : versioned.id)
  }
  return visible.filter((c) => !drop.has(c.id))
}

export interface CapabilityMarks {
  /** 看不了图的那几行才标（过半都看不了时反过来不标——那时整份都差不多）。 */
  noVision: boolean
  /** 自带联网只在不超过一半有的时候标（人人都有就不标）。 */
  web: boolean
  /** 长上下文只在少数有的时候标。 */
  long: boolean
}

/** 这份清单里哪几项能力值得逐行标出来。 */
export function capabilityMarks(
  choices: readonly FreeChatModelChoice[],
  longTokens: number,
): CapabilityMarks {
  const n = choices.length
  if (n === 0) return { noVision: false, web: false, long: false }
  const count = (f: (c: FreeChatModelChoice) => boolean): number => choices.filter(f).length
  const noVision = count((c) => c.vision === 'no')
  const web = count((c) => c.native_search === true)
  const long = count((c) => (c.context_window ?? 0) >= longTokens)
  return {
    noVision: noVision > 0 && noVision * 2 <= n,
    web: web > 0 && web * 2 <= n && web < n,
    long: long > 0 && long * 2 <= n && long < n,
  }
}
