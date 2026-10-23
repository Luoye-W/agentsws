/**
 * 移植自 agentsws-extension `src/lib/follower-count.ts` @ 57fca9c（WP131，私有插件外壳），逐字照搬（只改 import 路径）。
 *
 * **列表页收的人也上公共库**：公共库的卡要一个粉丝数，而列表页上只有页面原文（`312K subscribers`、
 * `1.2万位订阅者`…）。这里把原文换算成整数，随观测的 `followers` 一起送；**原文照带**（`followers_text`）。
 * 用的是列表筛选那**同一个解析器**（`searchFilters.parseCompactCount`）。**换算不了就不带**（回 `undefined`，不是 0）；
 * 明显不像粉丝数的（超过 50 亿）也当换算不了。
 */
import { parseCompactCount } from '../collectors/searchFilters.js'

/** 地球上没有哪个账号的粉丝数超过这个数；超过 = 读错了（把别的数字当成了粉丝数）。 */
export const MAX_PLAUSIBLE_FOLLOWERS = 5_000_000_000

export function followersFromText(text: string | undefined | null): number | undefined {
  const value = parseCompactCount(text)
  if (value === undefined || !Number.isInteger(value) || value < 0) return undefined
  if (value > MAX_PLAUSIBLE_FOLLOWERS) return undefined
  return value
}
