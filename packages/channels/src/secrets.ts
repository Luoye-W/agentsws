/**
 * 入站秘密检测与脱敏（13 §4.3、31 §4「不留秘密 vs raw_ref 留原文」的定案）。
 *
 * **表不在这里**——WP13 的遗留「秘密模式表三处重复」已由 WP31 上移到
 * `@agentsws/core` 的 `secret-patterns.ts`。本文件只保留渠道包对外的名字，
 * 判定一律走那一份表：替身（`@agentsws/stand-ins`）与真实现必须在同一批样本上
 * 给出同样的判定，否则 WP9 的不变量测不到真管线。
 */

import { hasSecret, type ScrubResult, scrub } from '@agentsws/core'

export type { ScrubResult }

/** 18 §5 用例 3：命中即替换成占位符，并回报命中了哪几条规则。 */
export const scrubSecrets: (text: string) => ScrubResult = scrub

/** 只问「有没有」，不改文本（用于日志前置判断）。 */
export { hasSecret }
