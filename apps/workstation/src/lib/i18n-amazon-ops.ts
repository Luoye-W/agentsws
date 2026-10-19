/**
 * WP395（docs/106 §13）：Amazon 运营岗位面板四块的词条（中英各一份）。
 *
 * 单独一个文件、在 `i18n.ts` 的 `TABLES` 那一行并进去（同 `i18n-reddit-write.ts`）。
 * 界面少字：块头一个词组，说明进问号（`*.hint`）；没数据照实说（docs/36 §3：不出 0）。
 * 用户可见的字不提数据供应商名。
 */
export const AMAZON_OPS_ZH: Record<string, string> = {
  'amzops.title': 'Amazon 店铺',
  // 每日巡检
  'amzops.daily': '每日巡检',
  'amzops.daily.hint': '每天先看这三样：账户有没有红线、哪些货快断了、哪些 Listing 买不了。',
  'amzops.daily.health': '账户健康',
  'amzops.daily.one': '账户健康、断货、买不了',
  'amzops.empty.planned': '要连 Amazon 店铺（还没开放）',
  'amzops.daily.stock': '断货风险',
  'amzops.daily.buyable': 'Listing 买不了',
  'amzops.empty.connect': '连上 Amazon 店铺后才有',
  'amzops.connect': '连上',
  // 竞品动向
  'amzops.competitors': '竞品动向',
  'amzops.competitors.hint': '对标的竞品在 Amazon 上的价格、评分、排名有什么变化。',
  'amzops.competitors.empty': '还没有在盯的竞品',
  // Listing 体检
  'amzops.listing': 'Listing 体检',
  'amzops.listing.hint': '按 Amazon 的规矩看自家 Listing 哪里有问题，只出建议、不改。',
  'amzops.listing.empty': '还没体检过',
  // 词库
  'amzops.keywords': '词库',
  'amzops.keywords.hint': '自家 Listing 该用的词，和「竞品有、你没有」的词。',
  'amzops.keywords.empty': '还没有词库',
}

export const AMAZON_OPS_EN: Record<string, string> = {
  'amzops.title': 'Amazon store',
  'amzops.daily': 'Daily check',
  'amzops.daily.hint':
    'Three things first each day: account health red flags, products about to run out, and listings buyers cannot buy.',
  'amzops.daily.health': 'Account health',
  'amzops.daily.one': 'Account health, stock-outs, unbuyable listings',
  'amzops.empty.planned': 'Needs an Amazon store connection (coming soon)',
  'amzops.daily.stock': 'Stock-out risk',
  'amzops.daily.buyable': 'Listings not buyable',
  'amzops.empty.connect': 'Available once your Amazon store is connected',
  'amzops.connect': 'Connect',
  'amzops.competitors': 'Competitor moves',
  'amzops.competitors.hint':
    'Changes in price, rating and rank for the competitor products you benchmark against on Amazon.',
  'amzops.competitors.empty': 'No competitors watched yet',
  'amzops.listing': 'Listing check',
  'amzops.listing.hint':
    'What is wrong with your own listings by Amazon rules. Suggestions only; nothing is changed.',
  'amzops.listing.empty': 'Not checked yet',
  'amzops.keywords': 'Keywords',
  'amzops.keywords.hint':
    'The words your listings should use, and the ones competitors have that you do not.',
  'amzops.keywords.empty': 'No keyword list yet',
}
