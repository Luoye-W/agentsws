/**
 * WP419（自查 P5 / P10）：信息监控拉回来的提及在右侧「报表」里的那张表（按组 / 情绪 / 来源筛）。
 * 中英各一份，在 `i18n.ts` 的表里并进去。
 */
export const PR_MENTIONS_ZH: Record<string, string> = {
  'prm.title': '外面在说什么',
  'prm.empty': '还没有拉到提及',
  'prm.col.group': '哪一组',
  'prm.col.what': '说了什么',
  'prm.col.sentiment': '情绪',
  'prm.col.origin': '来源',
  'prm.col.when': '时间',
  'prm.group.own': '自家',
  'prm.group.competitor': '竞品',
  'prm.group.industry': '行业',
  'prm.group.site': '指定网站',
  'prm.sent.negative': '负面',
  'prm.sent.neutral': '中性',
  'prm.sent.positive': '正面',
  'prm.sent.none': '没判',
  'prm.failed': '{n} 条源这次没拉到——不等于没人提',
}

export const PR_MENTIONS_EN: Record<string, string> = {
  'prm.title': 'What people are saying',
  'prm.empty': 'No mentions pulled yet',
  'prm.col.group': 'Group',
  'prm.col.what': 'What',
  'prm.col.sentiment': 'Sentiment',
  'prm.col.origin': 'Source',
  'prm.col.when': 'When',
  'prm.group.own': 'Us',
  'prm.group.competitor': 'Competitors',
  'prm.group.industry': 'Industry',
  'prm.group.site': 'Sites',
  'prm.sent.negative': 'Negative',
  'prm.sent.neutral': 'Neutral',
  'prm.sent.positive': 'Positive',
  'prm.sent.none': 'Not judged',
  'prm.failed': "{n} sources weren't pulled this time — that doesn't mean nobody mentioned us",
}
