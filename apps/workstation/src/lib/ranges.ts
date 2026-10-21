/**
 * WP138：一条范围在屏幕上怎么说。
 *
 * 「整个品牌」（`brand`）的 id 是工作区 id——内部值，不许上屏。
 *
 * WP457（WP456 §3.8 P0）：其余几种也**只显示名字**。范围本身没有名字表（店铺范围就是岗位上
 * 出现过的那个 id），演示世界和老数据里是 `store_main` / `pl_xxx` 这种内部键，原来原样上屏，
 * 设置 → 岗位与职责里每个人后面挂着「(store_main)」。现在的口径：
 *
 * - 给了名字（`names`，比如范围候选里产品线的名字）就写名字；
 * - 市场（`账号id:站点`）只写站点（`US`），账号 id 是内部的；
 * - 看着像内部键的（全小写 + 下划线，如 `store_main`）不写；
 * - 别的（人手填的店名、站点）照写。
 */
import { parseMarketId } from '@agentsws/contracts'

/** 全小写字母数字、带下划线的一串：`store_main`、`pl_kitchen`、`amz_na`——内部键，不上屏。 */
const INTERNAL_KEY = /^[a-z][a-z0-9]*(_[a-z0-9]+)+$/

export function rangeText(
  r: { kind: string; id: string },
  t: (key: string) => string,
  names?: ReadonlyMap<string, string>,
): string | undefined {
  if (r.kind === 'brand') return t('range.kind.brand')
  const named = names?.get(`${r.kind}:${r.id}`)?.trim()
  if (named !== undefined && named !== '' && named !== r.id) return named
  if (r.kind === 'market') {
    const market = parseMarketId(r.id)
    if (market !== undefined) return market.site
  }
  return INTERNAL_KEY.test(r.id) ? undefined : r.id
}

/** 一串范围 → 「、」连起来的那一句；一个名字都没有就回空串（调用方据此整段不画）。 */
export function rangesText(
  ranges: readonly { kind: string; id: string }[],
  t: (key: string) => string,
  names?: ReadonlyMap<string, string>,
): string {
  return ranges
    .map((r) => rangeText(r, t, names))
    .filter((x): x is string => x !== undefined)
    .join('、')
}
