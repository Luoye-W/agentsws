/**
 * WP328：「Reddit 巡查」快捷视图的词条（中英各一份；在 `i18n.ts` 的表里并进去）。界面少字：长说明进问号。
 */
export const REDDIT_WATCH_ZH: Record<string, string> = {
  'pos2.quick.reddit_watch': 'Reddit 巡查',
  'rwatch.run': '现在巡查',
  'rwatch.last': '上次 {at}',
  'rwatch.never': '还没巡查过',
  'rwatch.hint':
    '每天一次（可改），周五出周报前再巡查一次。收件箱和自家版块用 Chrome 插件只读，不改已读；外部社区按关键词搜。',
  'rwatch.part.inbox': '收件箱',
  'rwatch.part.own_sub': '自家版块',
  'rwatch.part.external': '外部社区',
  'rwatch.status.ok': '好了',
  'rwatch.status.waiting': '等插件',
  'rwatch.status.skipped': '跳过',
  'rwatch.status.needs_connection': '缺连接',
  'rwatch.status.needs_setup': '缺设置',
  'rwatch.status.failed': '没读成',
  'rwatch.unconfigured': '还没配自家版块和关键词，卡片流里有一张设置卡。',
  'rwatch.pending.empty': '没有要回的',
  'rwatch.source.inbox': '收件箱',
  'rwatch.source.own_sub': '自家版块',
  'rwatch.source.external': '外部',
  'rwatch.dismiss': '不回',
  'rwatch.open': '打开原帖',
}

export const REDDIT_WATCH_EN: Record<string, string> = {
  'pos2.quick.reddit_watch': 'Reddit patrol',
  'rwatch.run': 'Patrol now',
  'rwatch.last': 'Last {at}',
  'rwatch.never': 'Not run yet',
  'rwatch.hint':
    'Daily by default, plus one more run right before the Friday weekly report. Inbox and own subreddits are read read-only through the Chrome extension (read state untouched); other communities are searched by keyword.',
  'rwatch.part.inbox': 'Inbox',
  'rwatch.part.own_sub': 'Own subs',
  'rwatch.part.external': 'Elsewhere',
  'rwatch.status.ok': 'Done',
  'rwatch.status.waiting': 'Waiting',
  'rwatch.status.skipped': 'Skipped',
  'rwatch.status.needs_connection': 'Needs connection',
  'rwatch.status.needs_setup': 'Needs setup',
  'rwatch.status.failed': 'Failed',
  'rwatch.unconfigured': 'No subreddits or keywords yet — there is a setup card in your feed.',
  'rwatch.pending.empty': 'Nothing to reply to',
  'rwatch.source.inbox': 'Inbox',
  'rwatch.source.own_sub': 'Own sub',
  'rwatch.source.external': 'Elsewhere',
  'rwatch.dismiss': 'Skip',
  'rwatch.open': 'Open',
}
