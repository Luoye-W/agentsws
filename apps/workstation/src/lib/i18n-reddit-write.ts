/**
 * WP329：Reddit「发出去」卡的词条（中英各一份）。
 *
 * 单独一个文件、在 `i18n.ts` 的 `TABLES` 那一行并进去（同 `i18n-social-reply.ts`）。
 * 界面少字：按钮一个词，说明进问号（`*.hint`）。
 */
export const REDDIT_WRITE_ZH: Record<string, string> = {
  'redditw.title': '标题',
  'redditw.text': '正文',
  // WP445（决策 1322）：工坊里只剩主管先批的那一种卡——按钮叫「批准」，批完进发起人的插件「等你发」
  'redditw.send': '批准',
  'redditw.send.hint':
    '批了不会自己打开任何页面：这一条进发起人浏览器插件的「等你发」，由他在侧边栏里点「打开这一条」、自己点发送。发出去才记进发出记录。',
  'redditw.sent.awaiting': '已批，进了发起人的浏览器插件「等你发」',
  // WP445：看板上一行（不是卡）
  'redditw.awaiting': '插件里 {n} 条等你发',
  'redditw.awaiting.hint':
    'AI 起草的 Reddit 回帖 / 发帖不在工坊出卡，直接进浏览器插件。点 Chrome 工具栏上的「Agents 工坊助手」图标打开侧边栏，在「等你发」里看、改、点「打开这一条」，自己点发送；不发就点「不发」。',
  'redditw.awaiting.go': '去浏览器插件里发：点 Chrome 工具栏上的「Agents 工坊助手」图标。',
  'extreload.title': '插件要重新加载一下',
  'extreload.stale': 'Chrome 里的插件还是 {running}，工坊带的是 {folder}。',
  'extreload.unseen': '这几分钟没看到 Chrome 里的插件（Chrome 没开，或者插件还是旧版）。',
  'extreload.steps':
    '打开 chrome://extensions，找到「Agents 工坊助手」，点它卡片上的 ↻（重新加载）。之后插件会自己跟着工坊更新。',
  'extreload.copy': '复制 chrome://extensions',
  'extreload.copied': '已复制，粘到 Chrome 地址栏回车',
  'redditw.facts': '依据',
  'redditw.rules': '版规 {n} 条',
  'redditw.failed': '没交出去：{message}',
  // WP332（决策 762）：岗位页「没发出去」提醒条
  'redditw.notice.title': '没发出去：{what}',
  'redditw.notice.refill': '再填一次',
  // WP491：再填一次与出卡同一个选路（ego 能用工坊自己在 ego 里发，用不了交给插件）
  'redditw.notice.refill.hint':
    '同一份批过的草稿再发一次，不用重批。ego 能用就工坊在 ego 里发，不能用交给浏览器插件。',
  'redditw.notice.sending': '在发…',
  // WP495（1717）：ego 点过发送、没确认发出去的那一条，再填之前先问
  'redditw.notice.refill.ask': '确认上次没发出去？',
  'redditw.notice.refill.ask.yes': '确认',
  'redditw.notice.refill.ask.no': '取消',
  'redditw.notice.via.ego': '正在 ego 里发：{what}',
  'redditw.notice.via.plugin': '已交给浏览器插件，等你在插件里发：{what}',
  'redditw.notice.sent': '发出去了：{what}',
  'redditw.notice.close': '收起',
  // WP478（Luoye 10-23）：× 就是这一条不发了（收起，不再提醒）
  // WP491：「修改」= 还原成当初那张审核卡（卡片流里改字、批）
  'redditw.notice.dismiss': '不发了',
  'redditw.notice.dismiss.hint': '不发了：收起这一行，不再提醒',
  'redditw.notice.edit': '修改',
  'redditw.notice.edit.hint': '还原成原来那张卡，在卡上改字、批',
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
  'redditw.send': 'Approve',
  'redditw.send.hint':
    'Nothing opens on its own: this goes to “Waiting to send” in the requester’s browser extension. They click “Open this one” in the side panel and send it themselves. It is logged once it is posted.',
  'redditw.sent.awaiting': 'Approved: now waiting in the requester’s browser extension',
  'redditw.awaiting': '{n} waiting to send in the extension',
  'redditw.awaiting.hint':
    'AI-drafted Reddit replies and posts skip the app’s cards and go straight to the browser extension. Click the Agents Workshop icon in the Chrome toolbar to open the side panel; under “Waiting to send”, review, edit, click “Open this one” and send it yourself, or click “Don’t send”.',
  'redditw.awaiting.go':
    'Send it from the browser extension: click the Agents Workshop icon in the Chrome toolbar.',
  'extreload.title': 'Reload the extension',
  'extreload.stale': 'The extension in Chrome is {running}; the app ships {folder}.',
  'extreload.unseen':
    'Haven’t heard from the extension in Chrome for a few minutes (Chrome is closed, or the extension is outdated).',
  'extreload.steps':
    'Open chrome://extensions, find “Agents 工坊助手” and click ↻ (reload) on its card. After that it updates with the app by itself.',
  'extreload.copy': 'Copy chrome://extensions',
  'extreload.copied': 'Copied: paste it into Chrome’s address bar and press Enter',
  'redditw.facts': 'Based on',
  'redditw.rules': '{n} sub rules',
  'redditw.failed': 'Not handed over: {message}',
  'redditw.notice.title': 'Not posted: {what}',
  'redditw.notice.refill': 'Fill again',
  'redditw.notice.refill.hint':
    'Sends the same approved draft again, no new approval. Uses ego if it is available, otherwise the browser extension.',
  'redditw.notice.sending': 'Sending…',
  'redditw.notice.refill.ask': 'Sure the last one didn’t go out?',
  'redditw.notice.refill.ask.yes': 'Confirm',
  'redditw.notice.refill.ask.no': 'Cancel',
  'redditw.notice.via.ego': 'Sending in ego: {what}',
  'redditw.notice.via.plugin': 'Handed to the browser extension, send it there: {what}',
  'redditw.notice.sent': 'Posted: {what}',
  'redditw.notice.close': 'Hide',
  'redditw.notice.dismiss': 'Don’t post',
  'redditw.notice.dismiss.hint': 'Don’t post: hide this line, no more reminders',
  'redditw.notice.edit': 'Edit',
  'redditw.notice.edit.hint': 'Bring back the original card: edit and approve it there',
  'redditw.notice.more': '{n} more',
  'redditw.notice.kind.reply': 'Reply (r/{sub})',
  'redditw.notice.kind.comment': 'Comment (r/{sub})',
  'redditw.notice.kind.submit': 'Post (r/{sub})',
  'redditw.parent': 'Original comment',
  'redditw.prior': 'You replied on {day}: ',
  'redditw.check.prior': 'What you said before: {text}',
  'redditw.check.fixed': '{message}; replaced with "let me check"',
}
