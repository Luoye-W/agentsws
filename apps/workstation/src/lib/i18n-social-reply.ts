/**
 * WP255（决策 144）：「回复」按钮与社群线程列表的词条（中英各一份）。
 *
 * 单独一个文件、在 `i18n.ts` 的 `TABLES` 那一行并进去（同 `i18n-own-sub.ts`）。
 * 界面少字：按钮一个词，说明进问号（`*.hint`）。
 */
export const SOCIAL_REPLY_ZH: Record<string, string> = {
  'reply.button': '回复',
  'reply.hint':
    '写一句回复，出一张回帖卡；你在上面「要你处理」里批了，过两分钟才发出去。可以先点「AI 起草」再改。别许诺退款、补发、折扣或时间点，这类话会被打回。',
  'reply.label': '回复内容',
  'reply.placeholder': '写一句回复…',
  'reply.draft': 'AI 起草',
  'reply.submit': '出卡',
  'reply.cancel': '取消',
  'reply.template': '这次没用 AI，先给了一句开头，你接着写',
  'reply.warning': '这句会被打回：{message}',
  'reply.rejected': '被打回：{message}',
  'reply.failed': '没出卡：{message}',
  'reply.staged': '回帖卡已出，在上面「要你处理」里批',
  'pos2.quick.threads': '群里的帖子',
  'threads.empty': '还没有要回的帖子',
  'threads.surface.thread': '帖子',
  'threads.surface.comment': '评论',
  'threads.surface.dm': '私信',
  'threads.triage.customer_question': '客户问题',
  'threads.triage.praise': '夸奖',
  'threads.triage.complaint': '抱怨',
  'threads.triage.spam': '广告',
  'threads.triage.partnership': '合作',
  'threads.triage.other': '其他',
  'threads.hint':
    '这条渠道里还没处理完的帖子、评论和私信。客户问题已经转给客服，不在这里。回复都先出卡，你批了才发。Discord 按设定的频率自动拉登记过的频道；Reddit 自家版的新帖在读「自家版待处理」时顺手拉进来，没人看时一小时补读一次。',
  // WP256（决策 147）：空态按渠道照实说
  'threads.empty.no_posts': '这个群还没有新帖',
  'threads.empty.not_connected': '还没连上',
  'threads.empty.connect': '去连接页',
  'threads.empty.manual': '这条渠道还不会自动拉新帖',
  'threads.empty.no_channel': '还没登记要读的频道',
  'threads.empty.no_own_sub': '还没登记自家版，去「自家版待处理」登记',
  'threads.register.placeholder': '粘贴频道链接',
  'threads.register': '登记',
  'threads.register.invalid': '认不出这个链接：在 Discord 里右键频道 →「复制链接」再粘贴',
  'threads.register.hint':
    '在 Discord 里右键要读的频道，点「复制链接」，粘贴到这里。登记后按设定的频率自动读这个频道的新消息，只读不回。',
  'threads.every': '每 {n}',
  'threads.every.label': '多久读一次',
  'threads.every.5': '5 分钟',
  'threads.every.15': '15 分钟',
  'threads.every.30': '30 分钟',
  'threads.every.60': '1 小时',
  'threads.every.180': '3 小时',
  'threads.every.1440': '1 天',
  'threads.issue.missing_hint':
    '「查看频道」「读取消息历史」：Discord 服务器设置 → 角色 → 机器人的角色里打开（或在这个频道的权限里给机器人打开）。「Message Content Intent」：Discord 开发者后台 → 你的应用 → Bot 页打开。改好后下一轮自己就能读。',
}

export const SOCIAL_REPLY_EN: Record<string, string> = {
  'reply.button': 'Reply',
  'reply.hint':
    'Write a reply to create a reply card. It is sent two minutes after you approve it in “Needs you” above. Try “Draft with AI” first, then edit. Promises of refunds, replacements, discounts or dates get rejected.',
  'reply.label': 'Reply text',
  'reply.placeholder': 'Write a reply…',
  'reply.draft': 'Draft with AI',
  'reply.submit': 'Create card',
  'reply.cancel': 'Cancel',
  'reply.template': 'No AI this time — here is an opener, keep writing',
  'reply.warning': 'This will be rejected: {message}',
  'reply.rejected': 'Rejected: {message}',
  'reply.failed': 'No card: {message}',
  'reply.staged': 'Reply card created — approve it in “Needs you” above',
  'pos2.quick.threads': 'Community threads',
  'threads.empty': 'Nothing to reply to yet',
  'threads.surface.thread': 'Post',
  'threads.surface.comment': 'Comment',
  'threads.surface.dm': 'DM',
  'threads.triage.customer_question': 'Customer question',
  'threads.triage.praise': 'Praise',
  'threads.triage.complaint': 'Complaint',
  'threads.triage.spam': 'Spam',
  'threads.triage.partnership': 'Partnership',
  'threads.triage.other': 'Other',
  'threads.hint':
    'Open posts, comments and DMs on this channel. Customer questions already went to support and are not listed. Every reply becomes a card first and is sent only after you approve. Discord channels you registered are pulled on a schedule; new posts in your own subreddit come in whenever “Own sub queue” is read, and once an hour when nobody is looking.',
  'threads.empty.no_posts': 'No new posts in this group yet',
  'threads.empty.not_connected': 'Not connected yet',
  'threads.empty.connect': 'Go to Connections',
  'threads.empty.manual': 'New posts are not pulled in automatically on this channel yet',
  'threads.empty.no_channel': 'No channel registered to read yet',
  'threads.empty.no_own_sub': 'No own subreddit yet — register one in “Own sub queue”',
  'threads.register.placeholder': 'Paste channel link',
  'threads.register': 'Add',
  'threads.register.invalid':
    'Not a channel link: right-click the channel in Discord → “Copy Link”',
  'threads.register.hint':
    'Right-click the channel in Discord, choose “Copy Link” and paste it here. New messages are then read on a schedule — read only, nothing is posted.',
  'threads.every': 'Every {n}',
  'threads.every.label': 'How often to read',
  'threads.every.5': '5 min',
  'threads.every.15': '15 min',
  'threads.every.30': '30 min',
  'threads.every.60': '1 hour',
  'threads.every.180': '3 hours',
  'threads.every.1440': '1 day',
  'threads.issue.missing_hint':
    '“View Channel” and “Read Message History”: Discord server settings → Roles → the bot role (or this channel’s permissions). “Message Content Intent”: Discord Developer Portal → your app → Bot. The next round picks it up by itself.',
}
