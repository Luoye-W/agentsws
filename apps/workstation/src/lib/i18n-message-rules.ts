/**
 * WP439（docs/108 §5.1.5 / §5.7 ②）：消息页右栏「规则」——你教过的发件人（以后消息规则、AI 自己学的、
 * 系统规则都往这一页上加）。中英各一份，在 `i18n.ts` 的 `TABLES` 那一行并进去。
 *
 * 少字（docs/36、决策 1001 后的「界面少字」）：说明进问号，行里只写发件人、类型、交给谁、命中几次。
 */
export const MESSAGE_RULES_ZH: Record<string, string> = {
  'rail.panel.message-rules': '规则',
  'message_rules.open': '规则',
  'message_rules.group.sender': '你教过的发件人',
  'message_rules.group.sender.hint':
    '改判时勾了「以后都这样」记下的。分拣先看这里，命中了就照它办、不再花模型；整个地址优先于 @域。删掉当场生效，那个发件人的下一封重新让 AI 判。',
  'message_rules.group.message': '消息规则',
  'message_rules.group.ai': 'AI 自己学的',
  'message_rules.group.ai.hint':
    '同一发件人连着几封都判得一样、你没改过，它就记下来。删了 30 天内不再自己学。',
  'message_rules.group.system': '系统规则',
  'message_rules.group.deleted': '刚删的',
  'message_rules.group.deleted.hint': '删了 {days} 天内能撤回。',
  'message_rules.empty': '还没有规则。改判时勾「以后都这样」，同一发件人下次就不再问。',
  'message_rules.to': '→ {name}',
  'message_rules.inbox': '留在收件箱',
  'message_rules.hits': '30 天 {n} 次',
  'message_rules.hits.none': '30 天没碰到',
  'message_rules.by.me': '你教的',
  'message_rules.by.name': '{name} 教的',
  'message_rules.by.someone': '同事教的',
  'message_rules.deleted_by.me': '你删的',
  'message_rules.deleted_by.name': '{name} 删的',
  'message_rules.deleted_by.someone': '同事删的',
  'message_rules.delete': '删除',
  'message_rules.delete.label': '删除 {sender} 这条规则',
  'message_rules.deleted': '已删，下一封会重新判',
  'message_rules.restore': '撤回',
  'message_rules.restored': '已撤回，照旧按这条办',
  'message_rules.restore.gone': '撤不回了（已经又教过这个发件人，或者过了 {days} 天）',
  'message_rules.error': '没办成：{why}',
}

export const MESSAGE_RULES_EN: Record<string, string> = {
  'rail.panel.message-rules': 'Rules',
  'message_rules.open': 'Rules',
  'message_rules.group.sender': 'Senders you taught',
  'message_rules.group.sender.hint':
    'Saved when you ticked "always do this" while correcting. Triage checks these first — a match is handled by the rule, no model call; a full address beats an @domain. Deleting takes effect now: the next mail from that sender is judged by AI again.',
  'message_rules.group.message': 'Message rules',
  'message_rules.group.ai': 'Learned by AI',
  'message_rules.group.ai.hint':
    'When several mails in a row from one sender get the same verdict and you never changed it, it remembers. Delete it and it won’t relearn for 30 days.',
  'message_rules.group.system': 'System rules',
  'message_rules.group.deleted': 'Just deleted',
  'message_rules.group.deleted.hint': 'You can undo a delete for {days} days.',
  'message_rules.empty':
    'No rules yet. Tick "always do this" when correcting a mail and that sender won’t be asked about again.',
  'message_rules.to': '→ {name}',
  'message_rules.inbox': 'Stays in inbox',
  'message_rules.hits': '{n} in 30 days',
  'message_rules.hits.none': 'No hits in 30 days',
  'message_rules.by.me': 'Taught by you',
  'message_rules.by.name': 'Taught by {name}',
  'message_rules.by.someone': 'Taught by a teammate',
  'message_rules.deleted_by.me': 'Deleted by you',
  'message_rules.deleted_by.name': 'Deleted by {name}',
  'message_rules.deleted_by.someone': 'Deleted by a teammate',
  'message_rules.delete': 'Delete',
  'message_rules.delete.label': 'Delete the rule for {sender}',
  'message_rules.deleted': 'Deleted — the next one will be judged again',
  'message_rules.restore': 'Undo',
  'message_rules.restored': 'Restored — handled by this rule again',
  'message_rules.restore.gone':
    'Can’t undo any more (that sender was taught again, or {days} days have passed)',
  'message_rules.error': 'Didn’t work: {why}',
}
