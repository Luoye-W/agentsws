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
  'threads.triage.spam': '广告垃圾',
  'threads.triage.partnership': '合作',
  'threads.triage.other': '闲聊 / 其他',
  'threads.hint':
    '这条渠道里还没处理完的帖子、评论和私信。自动进来的帖子按关键词、渠道和有没有 @品牌判了类，只打标签，不出卡也不转客服；点上面的标签按类看。回复都先出卡，你批了才发。Discord 频道、Telegram 群按设定的频率自动拉；Reddit 自家版的新帖在读「自家版待处理」时顺手拉进来，没人看时一小时补读一次。',
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
  // WP257（决策 152 / 156）：标签筛选、模型复核、Telegram 群登记
  'threads.tags.label': '按归类筛',
  'threads.tags.all': '全部',
  'threads.tags.review': '模型复核',
  'threads.tags.review.hint':
    '自动进来的帖子默认按规则判类（关键词、渠道、有没有 @品牌），不花钱。打开后每隔几分钟请模型再看最近几条，用的是这个品牌的模型额度。只改标签，不出卡。',
  'threads.tags.review.not_ready': '这台还没接上模型，开着也只按规则判。',
  'threads.empty.no_channel.telegram_group': '还没登记要读的群',
  'threads.register.placeholder.telegram_group': '粘贴群链接或 @群名',
  'threads.register.invalid.telegram_group':
    '认不出这个地址：在群里长按（右键）一条消息 →「复制消息链接」再粘贴；公开群也可以填 @群名',
  'threads.register.hint.telegram_group':
    '在群里长按（右键）任意一条消息，点「复制消息链接」，粘贴到这里；公开群也可以直接填 @群名。机器人要先在群里。登记后按设定的频率自动读新消息，只读不回。',
  'threads.issue.missing_hint.telegram_group':
    '隐私模式：在 Telegram 里找 @BotFather，发 /setprivacy，选这个机器人，选 Disable；然后把机器人移出群、再拉回来（Telegram 要重新进群才生效）。也可以把机器人设成群管理员，管理员机器人看得到全部消息。webhook：在设了 webhook 的那个工具里停掉，或给 Agents 工坊单独建一个机器人。改好后下一轮自己就能读。',
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
    'Open posts, comments and DMs on this channel. Posts pulled in automatically are tagged by keywords, channel and whether they mention the brand — tags only, no cards and nothing is handed to support; use the tags above to filter. Every reply becomes a card first and is sent only after you approve. Discord channels and Telegram groups are pulled on a schedule; new posts in your own subreddit come in whenever “Own sub queue” is read, and once an hour when nobody is looking.',
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
  'threads.tags.label': 'Filter by tag',
  'threads.tags.all': 'All',
  'threads.tags.review': 'Model check',
  'threads.tags.review.hint':
    'Posts pulled in automatically are tagged by rules (keywords, channel, brand mentions) at no cost. Turn this on to have the model re-check the latest few every few minutes, using this brand’s model quota. Tags only — no cards.',
  'threads.tags.review.not_ready':
    'No model connected yet, so rules are used even when this is on.',
  'threads.empty.no_channel.telegram_group': 'No group registered to read yet',
  'threads.register.placeholder.telegram_group': 'Paste a message link or @group',
  'threads.register.invalid.telegram_group':
    'Not a group link: long-press (right-click) a message in the group → “Copy Message Link”; public groups can use @name',
  'threads.register.hint.telegram_group':
    'Long-press (right-click) any message in the group, choose “Copy Message Link” and paste it here; public groups can just use @name. The bot must already be in the group. New messages are then read on a schedule — read only, nothing is posted.',
  'threads.issue.missing_hint.telegram_group':
    'Privacy mode: message @BotFather in Telegram, send /setprivacy, pick this bot, choose Disable, then remove the bot from the group and add it back (Telegram applies it on re-join). Or make the bot a group admin — admin bots see every message. Webhook: turn it off in the tool that set it, or create a separate bot for Agents Workshop. The next round picks it up by itself.',
}
