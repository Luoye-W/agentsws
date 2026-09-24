/**
 * WP138：一条范围在屏幕上怎么说。
 *
 * 「整个品牌」（`brand`）的 id 是工作区 id——内部值，不许上屏；其余几种照旧显示 id
 * （店铺 / 账号 / 市场的 id 本来就是用户认得的店名或站点）。
 */
export function rangeText(r: { kind: string; id: string }, t: (key: string) => string): string {
  return r.kind === 'brand' ? t('range.kind.brand') : r.id
}
