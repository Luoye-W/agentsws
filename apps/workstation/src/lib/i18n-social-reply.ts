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
    '这条渠道里还没处理完的帖子、评论和私信。客户问题已经转给客服，不在这里。回复都先出卡，你批了才发。群里的新帖暂时还不会自动拉进来；自家版的帖子在「自家版待处理」里回。',
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
    'Open posts, comments and DMs on this channel. Customer questions already went to support and are not listed. Every reply becomes a card first and is sent only after you approve. New posts are not pulled in from the group automatically yet; reply to your own subreddit from “Own sub queue”.',
}
