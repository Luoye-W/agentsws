/**
 * WP394（docs/104 一期 B）：Amazon 运营面板「竞品动向」块的词条（中英各一份，在 `i18n.ts` 的 `TABLES` 并进去）。
 * 其余几句（现在读一次、没读到、变化种类）沿用竞品监控那份 `cwatch.*`。界面少字；不提数据供应商名。
 */
export const AMAZON_COMPETITORS_ZH: Record<string, string> = {
  'amzcw.summary': '盯 {n} 家 · {asins} 款',
  'amzcw.next': '下次 {when}',
  'amzcw.see_table': '最近 {n} 条变化在上面的竞品变化表里',
  // WP402（决策 1140 / 1146）：Amazon 读不到时用你自己的浏览器读（同意 / 撤回）；品牌级暂停那一句
  'amzcw.own.label': '读不到时用你的浏览器',
  'amzcw.own.tip':
    '内置浏览器和工坊云端都没读到时，通过插件在你自己的浏览器里打开商品页读价格、评分（只读，不点不填、不碰你的账号；每家每天至多一次）',
  'amzcw.own.on': '已同意',
  'amzcw.own.off': '没开',
  'amzcw.own.grant': '打开',
  'amzcw.own.revoke': '撤回',
  'amzcw.paused': 'Amazon 要人机验证，内置浏览器停到 {when}（这期间换别的路读）',
}

export const AMAZON_COMPETITORS_EN: Record<string, string> = {
  'amzcw.summary': '{n} rivals · {asins} products',
  'amzcw.next': 'next {when}',
  'amzcw.see_table': '{n} recent changes — see the competitor changes table above',
  'amzcw.own.label': 'Fallback to your browser',
  'amzcw.own.tip':
    'When the built-in browser and the workshop cloud both fail, the extension opens product pages in your own browser to read price and rating (read-only, no clicks or forms, nothing on your account; at most once per competitor per day)',
  'amzcw.own.on': 'On',
  'amzcw.own.off': 'Off',
  'amzcw.own.grant': 'Turn on',
  'amzcw.own.revoke': 'Revoke',
  'amzcw.paused':
    'Amazon asked for a human check; the built-in browser pauses until {when} (other routes meanwhile)',
}
