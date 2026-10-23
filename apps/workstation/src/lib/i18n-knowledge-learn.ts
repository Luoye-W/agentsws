/**
 * WP488（决策 1680 / 1681 / 1682 / 1686）：客服知识库「学一遍」与公共 / 售前 / 售后三份。中英各一份，在 `i18n.ts`
 * 的 `TABLES` 那一行并进去。少字：长说明进问号，卡上只放条目、范围、按钮。
 */
export const KNOWLEDGE_LEARN_ZH: Record<string, string> = {
  // 三个标签页（公共 = 两边都用）
  'kl.tab.both': '公共',
  'kl.tab.presales': '售前',
  'kl.tab.postsales': '售后',
  'kl.tabs.hint':
    '一个知识库，每条标一个范围。回客户之前先判这封是售前还是售后（有订单号 / 已买 / 物流售后词 → 售后；问价 / 选型 / 发货前 → 售前），取对应那份 + 公共；判不出两边都取。',
  'kl.stage.label': '范围',
  // 学一遍
  'kl.email': '从过往邮件学',
  'kl.email.months': '回看',
  'kl.email.months.unit': '个月',
  'kl.site': '从网站学',
  'kl.site.placeholder': '官网 / 售后网站，多个用空格隔开',
  'kl.site.default': '不填就用建品牌时的官网',
  'kl.estimate': '问模型 {calls} 次',
  'kl.estimate.cost': '约 {cost}',
  'kl.estimate.pairs': '{pairs} 段往来',
  'kl.estimate.over': '这个月的模型用量快到上限了',
  'kl.estimate.no_mail': '还没接客服邮箱',
  'kl.estimate.no_model': '还没接 AI 模型',
  'kl.start': '开始',
  'kl.learn.hint':
    '从过往邮件里拼「客户问 → 我们人工回」（跳过 AI 发的、群发、没人回的），同类的归纳成一条口径；网站只读公开页面，政策和 FAQ 先读。学到的都要你确认才生效，网站那几页以后每周复查一次。',
  'kl.job.running': '学着呢 {done}/{total}',
  'kl.job.done': '学到 {n} 条',
  'kl.job.none': '这一次没学到',
  'kl.job.failed': '没学成：{note}',
  'kl.job.needs_connection': '先接上客服邮箱',
  'kl.job.over_budget': '模型用量快到上限，没跑',
  'kl.job.no_model': '还没接 AI 模型',
  'kl.job.open': '打开',
  // 汇总卡
  'kl.card.basis': '依据：{basis}',
  'kl.card.hold': '含承诺 / 政策，细看一眼',
  'kl.card.drop': '不要这条',
  'kl.card.confirm': '采纳 {n} 条',
  'kl.card.more': '还有 {n} 条在知识库「待确认」里',
  'kl.card.failed': '没存上：{message}',
  // 过期卡
  'kl.stale.unchanged': '都没变',
  'kl.stale.relearn': '按网站重学',
  'kl.stale.ignore': '忽略',
  // 岗位快捷按钮
  'landing.learn_email': '从过往邮件学',
}

export const KNOWLEDGE_LEARN_EN: Record<string, string> = {
  'kl.tab.both': 'Shared',
  'kl.tab.presales': 'Pre-sales',
  'kl.tab.postsales': 'Post-sales',
  'kl.tabs.hint':
    'One knowledge base; every entry has a scope. Before replying we decide whether a message is pre-sales or post-sales (order number / already bought / shipping & after-sales words → post-sales; price / which model / before shipping → pre-sales) and use that set plus Shared; if unclear, both.',
  'kl.stage.label': 'Scope',
  'kl.email': 'Learn from past emails',
  'kl.email.months': 'Look back',
  'kl.email.months.unit': 'months',
  'kl.site': 'Learn from websites',
  'kl.site.placeholder': 'Website / help center, space-separated',
  'kl.site.default': 'Empty = the website from brand setup',
  'kl.estimate': '{calls} model calls',
  'kl.estimate.cost': '≈ {cost}',
  'kl.estimate.pairs': '{pairs} conversations',
  'kl.estimate.over': 'Close to this month’s model cap',
  'kl.estimate.no_mail': 'No support mailbox connected',
  'kl.estimate.no_model': 'No AI model connected',
  'kl.start': 'Start',
  'kl.learn.hint':
    'Pairs “customer asked → we replied” from past email (skipping AI-sent, bulk and unanswered mail) and turns each recurring topic into one answer; websites are read as public pages, policies and FAQ first. Nothing takes effect until you confirm; learned pages are rechecked weekly.',
  'kl.job.running': 'Learning {done}/{total}',
  'kl.job.done': 'Learned {n}',
  'kl.job.none': 'Nothing learned this time',
  'kl.job.failed': 'Didn’t finish: {note}',
  'kl.job.needs_connection': 'Connect the support mailbox first',
  'kl.job.over_budget': 'Model cap almost reached, not run',
  'kl.job.no_model': 'No AI model connected',
  'kl.job.open': 'Open',
  'kl.card.basis': 'From: {basis}',
  'kl.card.hold': 'Contains a promise / policy — check it',
  'kl.card.drop': 'Drop this one',
  'kl.card.confirm': 'Adopt {n}',
  'kl.card.more': '{n} more under “Pending” in Knowledge',
  'kl.card.failed': 'Not saved: {message}',
  'kl.stale.unchanged': 'Nothing changed',
  'kl.stale.relearn': 'Relearn from site',
  'kl.stale.ignore': 'Ignore',
  'landing.learn_email': 'Learn from past emails',
}
