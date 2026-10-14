/**
 * WP333（决策 584）：一张卡自己的页面 `/cards/:id`（个人微信卡片里的链接落到这里）。
 *
 * 单独一个文件、在 `i18n.ts` 的 `TABLES` 那一行并进去（同 `i18n-handoff.ts`）。
 */
export const CARD_PAGE_ZH: Record<string, string> = {
  'cardPage.home': '首页',
  'cardPage.done': '处理好了',
  'cardPage.settled': '这张卡已经处理过了',
  'cardPage.missing': '找不到这张卡（可能不在这个品牌，或已经撤下）',
}

export const CARD_PAGE_EN: Record<string, string> = {
  'cardPage.home': 'Home',
  'cardPage.done': 'Done',
  'cardPage.settled': 'This card has already been handled',
  'cardPage.missing': "Can't find this card (it may be in another brand, or withdrawn)",
}
