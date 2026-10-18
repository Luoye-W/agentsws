/**
 * WP386：信息监控（多条监控源、贴 RSS、Google 账号那一步）。单独一张表，免得与别的单在 `i18n.ts` 里撞行。
 * 界面少字：卡上一句 + 接法，怎么建 Google 提醒进教程（`conn-google`）。
 */
export const PR_WATCH_ZH: Record<string, string> = {
  'prwatch.empty': '还没有监控源',
  'prwatch.paste.placeholder': '贴 RSS 链接，一行一条',
  'prwatch.paste.add': '订上',
  'prwatch.paste.adding': '正在拉一次…',
  'prwatch.run': '现在拉一轮',
  'prwatch.running': '正在拉…',
  'prwatch.remove': '删掉这条',
  'prwatch.failed': '拉不到',
  'prwatch.unchecked': '还没拉过',
  'prwatch.paused': '暂停了',
  'prwatch.ok_at': '{when} 拉到 {n} 条',
  'prwatch.next': '下次 {when}',
  'prwatch.boosted': '每 4 小时',
  'prwatch.not_held': '担了「信息监控」这条职责才看得到监控源。',
  'prwatch.group.own': '自家',
  'prwatch.group.competitor': '竞品',
  'prwatch.group.industry': '行业',
  'prwatch.group.site': '网站',
  'prwatch.plan.row': '信息监控',
  'prwatch.conn.name': 'Google Alerts',
  'google_account.line':
    '信息监控靠 Google 提醒：在这台电脑的浏览器里登录你的 Google 账号，登好了点「接着做」。',
  'google_account.open': '打开 Google 登录',
  'setup.need.google_account': 'Google 账号',
}

export const PR_WATCH_EN: Record<string, string> = {
  'prwatch.empty': 'No sources yet',
  'prwatch.paste.placeholder': 'Paste RSS links, one per line',
  'prwatch.paste.add': 'Add',
  'prwatch.paste.adding': 'Fetching once…',
  'prwatch.run': 'Pull now',
  'prwatch.running': 'Pulling…',
  'prwatch.remove': 'Remove',
  'prwatch.failed': 'Not fetched',
  'prwatch.unchecked': 'Not pulled yet',
  'prwatch.paused': 'Paused',
  'prwatch.ok_at': '{n} items {when}',
  'prwatch.next': 'Next {when}',
  'prwatch.boosted': 'Every 4 h',
  'prwatch.not_held': 'Sources show up for whoever holds the Information Monitoring duty.',
  'prwatch.group.own': 'Own',
  'prwatch.group.competitor': 'Competitor',
  'prwatch.group.industry': 'Industry',
  'prwatch.group.site': 'Site',
  'prwatch.plan.row': 'Information monitoring',
  'prwatch.conn.name': 'Google Alerts',
  'google_account.line':
    'Monitoring runs on Google Alerts: sign in to your Google account in this computer’s browser, then click Continue.',
  'google_account.open': 'Open Google sign-in',
  'setup.need.google_account': 'Google account',
}
