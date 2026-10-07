/**
 * WP259：「交给它」几个入口提交中 / 没交出去的那两句（中英各一份）。
 *
 * 单独一个文件、在 `i18n.ts` 的 `TABLES` 那一行并进去（同 `i18n-social-reply.ts`）。
 */
export const HANDOFF_ZH: Record<string, string> = {
  'handoff.sending': '正在交…',
  'handoff.failed': '没交出去：{message}',
}

export const HANDOFF_EN: Record<string, string> = {
  'handoff.sending': 'Handing over…',
  'handoff.failed': "Couldn't hand it over: {message}",
}
