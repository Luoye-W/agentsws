/**
 * WP394（docs/104 一期 B）：Amazon 运营面板「竞品动向」块的词条（中英各一份，在 `i18n.ts` 的 `TABLES` 并进去）。
 * 其余几句（现在读一次、没读到、变化种类）沿用竞品监控那份 `cwatch.*`。界面少字；不提数据供应商名。
 */
export const AMAZON_COMPETITORS_ZH: Record<string, string> = {
  'amzcw.summary': '盯 {n} 家 · {asins} 款',
  'amzcw.next': '下次 {when}',
}

export const AMAZON_COMPETITORS_EN: Record<string, string> = {
  'amzcw.summary': '{n} rivals · {asins} products',
  'amzcw.next': 'next {when}',
}
