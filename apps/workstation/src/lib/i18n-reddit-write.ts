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
  // WP332（决策 762）：岗位页「没发出去」提醒条
  'redditw.notice.title': '没发出去：{what}',
  'redditw.notice.refill': '再填一次',
  'redditw.notice.refill.hint':
    '同一份批过的草稿再交给 Chrome 里的插件填好，你自己点发送。不用重批。',
  'redditw.notice.dismiss': '收起',
  'redditw.notice.more': '还有 {n} 条',
  'redditw.notice.kind.reply': '回复（r/{sub}）',
  'redditw.notice.kind.comment': '回帖（r/{sub}）',
  'redditw.notice.kind.submit': '发帖（r/{sub}）',
  'redditw.parent': '原评论',
  // WP411：品牌号在这串里已经说过的、几道检查
  'redditw.prior': '你 {day} 已回：',
  'redditw.check.prior': '你之前说的：{text}',
  'redditw.check.fixed': '{message}，已换成「我去确认一下」',
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
  'redditw.notice.title': 'Not posted: {what}',
  'redditw.notice.refill': 'Fill again',
  'redditw.notice.refill.hint':
    'Hands the same approved draft to the helper in Chrome again. You click send yourself. No new approval needed.',
  'redditw.notice.dismiss': 'Dismiss',
  'redditw.notice.more': '{n} more',
  'redditw.notice.kind.reply': 'Reply (r/{sub})',
  'redditw.notice.kind.comment': 'Comment (r/{sub})',
  'redditw.notice.kind.submit': 'Post (r/{sub})',
  'redditw.parent': 'Original comment',
  'redditw.prior': 'You replied on {day}: ',
  'redditw.check.prior': 'What you said before: {text}',
  'redditw.check.fixed': '{message}; replaced with "let me check"',
}
