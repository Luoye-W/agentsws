/**
 * WP387：「在你的 Google 账号里建 N 条提醒」那张卡的词条（中英各一份）。
 *
 * 单独一个文件、在 `i18n.ts` 的 `TABLES` 那一行并进去（同 `i18n-reddit-write.ts`）。
 * 界面少字：按钮一个短句，四项设置与「你的浏览器怎么建」进问号。
 */
export const GOOGLE_ALERTS_ZH: Record<string, string> = {
  'galert.settings': '每条的设置',
  'galert.settings.hint':
    '即时、来源自动、所有结果、投递到 RSS。确认后你的浏览器一条一条建好，把 RSS 链接读回来；只动这几条，不碰你别的提醒。遇到登录或验证码会停下请你来。',
  'galert.confirm': '确认，去建 {n} 条',
  'galert.confirm.rss': '确认，改这 {n} 条',
  'galert.where': '语言 {language} · 地区 {region}',
  'galert.any': '不限',
  'galert.failed': '没确认成：{message}',
}

export const GOOGLE_ALERTS_EN: Record<string, string> = {
  'galert.settings': 'Settings for each',
  'galert.settings.hint':
    'As-it-happens, sources automatic, all results, delivered to RSS. Once you confirm, your browser creates them one by one and reads back the RSS links. Only these are touched — your other alerts stay as they are. It stops and asks you if Google wants a sign-in or a captcha.',
  'galert.confirm': 'Confirm and create {n}',
  'galert.confirm.rss': 'Confirm and switch {n}',
  'galert.where': 'Language {language} · Region {region}',
  'galert.any': 'any',
  'galert.failed': 'Not confirmed: {message}',
}

/** WP387：信息监控连接卡上的两个按钮。 */
export const PR_ALERTS_ZH: Record<string, string> = {
  'palerts.build': '让工坊替你建',
  'palerts.read': '读一遍我已有的',
  'palerts.hint':
    '「替你建」：先出一张卡列出要建的提醒，你确认一次，你的浏览器才一条一条去建。「读一遍」：只看不改，读完已经是 RSS 的可以勾了导入，还在发邮件的另出一张卡问要不要改成 RSS。过程在「运行中的浏览器」里看得到。',
  'palerts.not_ready':
    '你的浏览器还没接上（设置 → 浏览器 → 选「我正在用的浏览器」）。现在可以先手动建、把 RSS 链接贴到上面。',
  'palerts.build.done': '出了一张卡（{n} 条），确认一次就去建',
  'palerts.read.done': '你的浏览器去读了，读完在对话里说',
}

export const PR_ALERTS_EN: Record<string, string> = {
  'palerts.build': 'Let the Workshop create them',
  'palerts.read': 'Read my existing alerts',
  'palerts.hint':
    '"Create": a card lists the alerts first; confirm once and your browser creates them one by one. "Read": look only — RSS ones can be ticked and imported; email ones get a separate card asking to switch them to RSS. Watch it happen under "Browser in use".',
  'palerts.not_ready':
    'Your browser is not connected yet (Settings → Browser → "The browser I am using"). For now, create them by hand and paste the RSS links above.',
  'palerts.build.done': 'A card is out ({n} alerts) — confirm once and they get created',
  'palerts.read.done': 'Your browser is reading them; it will report in the conversation',
}
