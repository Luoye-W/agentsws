/**
 * 一格的构造与合并（70 §4）。
 *
 * 这个文件只有两件事，但第二件是整个 WP121 最容易出人命的地方。
 *
 * **第一件**：把"从哪一层读到的"翻译成把握度。这不是个可调的旋钮——
 * `jsonld` 就是 `high`，`model` 就是 `low`，因为这句话说的是**证据的种类**，
 * 不是我们的心情。
 *
 * **第二件**：重跑分析时的合并。规则只有一条：
 *
 * > **用户改过的格子，整格不动。**
 *
 * 不是"新值把握度更高就覆盖"，也不是"新值非空才覆盖"——就是不动。用户上周
 * 把品牌名改对了，这周换了新品重跑一次，我们又把它覆盖回错的，这种事只要
 * 发生一次，"重新分析"这个按钮就再没有人敢按了。一个按钮只要有一次吃掉过
 * 你的手工修改，它就死了。
 */
import type {
  BrandIntakeConfidence,
  BrandIntakeEvidence,
  BrandIntakeField,
  BrandIntakeProfile,
} from '@agentsws/contracts'

/** 值是从哪一层读来的。 */
export type IntakeLayer = 'jsonld' | 'og' | 'microdata' | 'selector' | 'model'

/**
 * 层 → 把握度。
 *
 * `selector` 是 `medium` 而不是 `high`：站方没声明过这一格，是我们按页面结构
 * 猜的。猜对的时候多，但那仍然是猜。
 */
const CONFIDENCE_OF: Record<IntakeLayer, BrandIntakeConfidence> = {
  jsonld: 'high',
  og: 'high',
  microdata: 'medium',
  selector: 'medium',
  model: 'low',
}

export function confidenceOf(layer: IntakeLayer): BrandIntakeConfidence {
  return CONFIDENCE_OF[layer]
}

/** 原文片段最多留多少字（够人在页面上搜到就行）。 */
export const MAX_QUOTE_CHARS = 200

/**
 * 造一格。
 *
 * `quote` 会被截断——出处是给人核对用的锚点，不是内容的副本。内容的副本该进
 * 知识库，那边有它自己的分块与围栏。
 */
export function field<T>(
  value: T,
  layer: IntakeLayer,
  evidence: { url: string; locator?: string; quote?: string },
): BrandIntakeField<T> {
  const quote = evidence.quote?.trim()
  const one: BrandIntakeEvidence = {
    url: evidence.url,
    locator: evidence.locator ?? layer,
    ...(quote === undefined || quote === '' ? {} : { quote: quote.slice(0, MAX_QUOTE_CHARS) }),
  }
  return { value, confidence: confidenceOf(layer), evidence: [one] }
}

/** 这一格要用户确认吗（界面上那个"请确认"的小标）。 */
export function needsConfirm(f: BrandIntakeField<unknown> | undefined): boolean {
  return f !== undefined && f.edited !== true && f.confidence === 'low'
}

/**
 * 两次分析的结果合一份。
 *
 * - 用户改过的（`edited`）：**原样留着**，新的那一份整格丢掉。
 * - 用户没改过的：新值覆盖旧值（这才是"重新分析"要的效果）。
 * - 新的这一轮没抓到、旧的有：**留着旧的**。抓不到不等于"这一格现在是空的"，
 *   可能只是那天那个页面 502 了。
 */
export function mergeProfile(
  previous: BrandIntakeProfile,
  next: BrandIntakeProfile,
): BrandIntakeProfile {
  const out: Record<string, unknown> = { ...previous }
  for (const [key, incoming] of Object.entries(next)) {
    if (incoming === undefined) continue
    const old = (previous as Record<string, BrandIntakeField<unknown> | undefined>)[key]
    if (old?.edited === true) continue
    out[key] = incoming
  }
  return out as BrandIntakeProfile
}

/**
 * 把用户在档案卡上改的那几格盖进去，并**打上 `edited`**。
 *
 * `edits` 里给了 `undefined` 的那一格表示"这一格我不要"——删掉，而不是留一个
 * 空值。界面按"在不在"决定画不画，留空值会画出一行空格子。
 */
export function applyEdits(
  profile: BrandIntakeProfile,
  edits: Record<string, unknown>,
  at: string,
): BrandIntakeProfile {
  const out: Record<string, unknown> = { ...profile }
  for (const [key, value] of Object.entries(edits)) {
    if (value === undefined || value === null) {
      delete out[key]
      continue
    }
    out[key] = {
      value,
      confidence: 'high' satisfies BrandIntakeConfidence,
      // 出处就是这个人本人。比任何一层结构化数据都硬。
      evidence: [{ url: 'human', locator: `edited:${at}` }],
      edited: true,
    } satisfies BrandIntakeField<unknown>
  }
  return out as BrandIntakeProfile
}
