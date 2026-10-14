/**
 * WP329：Reddit「发出去」卡的词条（中英各一份）。
 *
 * 单独一个文件、在 `i18n.ts` 的 `TABLES` 那一行并进去（同 `i18n-social-reply.ts`）。
 * 界面少字：按钮一个词，说明进问号（`*.hint`）。
 */
export const REDDIT_WRITE_ZH: Record<string, string> = {
  'redditw.title': '标题',
  'redditw.text': '正文',
  'redditw.send': '发送',
  'redditw.send.hint':
    '批了两分钟后，Chrome 里的「Agents 工坊助手」新开一个 Reddit 标签页把这段填好，你看一眼、自己点发送。发出去才记进发出记录。',
  'redditw.facts': '依据',
  'redditw.rules': '版规 {n} 条',
  'redditw.failed': '没交出去：{message}',
}

export const REDDIT_WRITE_EN: Record<string, string> = {
  'redditw.title': 'Title',
  'redditw.text': 'Text',
  'redditw.send': 'Send',
  'redditw.send.hint':
    'Two minutes after you approve, the Agents Workshop helper in Chrome opens a Reddit tab and fills this in. You review it and click send yourself. It is logged once it is posted.',
  'redditw.facts': 'Based on',
  'redditw.rules': '{n} sub rules',
  'redditw.failed': 'Not handed over: {message}',
}
