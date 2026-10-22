/**
 * WP476（决策 1590）：「帮助改进工坊（匿名使用数据）」开关与第一次启动那一句提示。
 * 界面少字：开关一句白话，细节进问号；提示只有一句 + 两个按钮。
 */
export const TELEMETRY_ZH: Record<string, string> = {
  'telemetry.title': '帮助改进工坊',
  'telemetry.desc': '发送匿名使用数据，不含你的任何内容',
  'telemetry.hint':
    '只记：打开了哪一页、点了哪个关键按钮、任务成没成、花费大概在哪一档、出了什么错（只有错误类型）。不记：信件、草稿、客户名、商品名、你输入的任何字。用的是匿名设备号；登录了工坊账号时附上账号编号（不含邮箱）。关掉立刻停。',
  'telemetry.notice': '工坊会发送匿名使用数据来改进产品，不含你的任何内容。',
  'telemetry.notice.ok': '知道了',
  'telemetry.notice.off': '不发送',
}

export const TELEMETRY_EN: Record<string, string> = {
  'telemetry.title': 'Help improve Agents Workshop',
  'telemetry.desc': 'Send anonymous usage data — none of your content',
  'telemetry.hint':
    'We record: which page you opened, which key button you clicked, whether a task worked, its rough cost tier, and error types. We never record: emails, drafts, customer or product names, or anything you type. Uses an anonymous device ID; if you are signed in to a Workshop account, its account ID (never the email). Turning it off stops it at once.',
  'telemetry.notice':
    'Agents Workshop sends anonymous usage data to improve the product — none of your content.',
  'telemetry.notice.ok': 'Got it',
  'telemetry.notice.off': "Don't send",
}
