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
