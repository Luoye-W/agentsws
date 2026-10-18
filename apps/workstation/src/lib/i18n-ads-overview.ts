/**
 * WP420（自查 ads-amazon A6 / A8）：投放看板的词条（中英各一份；在 `i18n.ts` 的 `TABLES` 那一行并进去）。
 * 界面少字：四个数 + 一行数据状态 + 一张表；说明进问号。
 */
export const ADS_OVERVIEW_ZH: Record<string, string> = {
  'adsov.title': '今天',
  'adsov.hint': '数从你的广告后台每天导出的报表里来（插件导），不经 AI。白天每 3 小时再导一次。',
  'adsov.spend': '今天花了',
  'adsov.gate': '总闸还剩',
  'adsov.roas': 'ROAS',
  'adsov.stops': '今天止损',
  'adsov.none': '—',
  'adsov.data.ready': '日报数据：{when} 导进来了',
  'adsov.data.waiting': '日报数据：插件连着，今天还没导',
  'adsov.data.away': '日报数据：插件一天没来了（电脑或 Chrome 没开）',
  'adsov.data.not_connected': '日报数据：插件没连上这家后台',
  'adsov.data.unavailable': '日报数据：这台没有插件',
  'adsov.data.no_account': '日报数据：还没设是哪个广告账户',
  'adsov.col.name': '广告系列',
  'adsov.col.budget': '日预算',
  'adsov.col.spend': '今天',
  'adsov.col.roas': 'ROAS',
  'adsov.paused': '停着',
  'adsov.empty': '还没有广告系列的数',
}

export const ADS_OVERVIEW_EN: Record<string, string> = {
  'adsov.title': 'Today',
  'adsov.hint':
    'Numbers come from the reports the helper exports from your ad account daily — not from AI. Re-exported every 3 hours during the day.',
  'adsov.spend': 'Spent today',
  'adsov.gate': 'Cap left',
  'adsov.roas': 'ROAS',
  'adsov.stops': 'Stop-loss today',
  'adsov.none': '—',
  'adsov.data.ready': 'Report data: imported {when}',
  'adsov.data.waiting': 'Report data: helper connected, nothing imported today yet',
  'adsov.data.away': 'Report data: helper hasn’t checked in for a day (computer or Chrome off)',
  'adsov.data.not_connected': 'Report data: helper isn’t connected to this ad account',
  'adsov.data.unavailable': 'Report data: no helper on this machine',
  'adsov.data.no_account': 'Report data: ad account not set yet',
  'adsov.col.name': 'Campaign',
  'adsov.col.budget': 'Daily budget',
  'adsov.col.spend': 'Today',
  'adsov.col.roas': 'ROAS',
  'adsov.paused': 'Paused',
  'adsov.empty': 'No campaign numbers yet',
}
