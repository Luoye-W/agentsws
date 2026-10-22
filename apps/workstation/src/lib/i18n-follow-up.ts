/**
 * WP442（docs/108 §5.3）：回信跟进——催促卡与规则清单「系统规则」那一行。中英各一份，在 `i18n.ts` 的
 * `TABLES` 那一行并进去。少字：说明进问号，卡上只放「你哪天发的」、草稿、按钮。
 */
export const FOLLOW_UP_ZH: Record<string, string> = {
  // 卡
  'follow_up.category': '催一下',
  'follow_up.surface.messages': '消息',
  'follow_up.card.sent_on': '你 {day} 发的',
  'follow_up.card.promised': '对方说过 {day} 答复',
  'follow_up.card.second': '第二次提醒（之后不再提醒）',
  'follow_up.card.draft': '催促草稿',
  'follow_up.card.to': '发给 {to}',
  'follow_up.card.send': '发出',
  'follow_up.card.edit': '修改',
  'follow_up.card.edit_done': '改好了',
  'follow_up.card.send.hint':
    '从你上次发信的那只邮箱、在原来那封下面回一封。出站急停开着时不会发。',
  'follow_up.card.sent': '已批，马上发出',
  'follow_up.card.failed': '没发出：{message}',
  'follow_up.card.rule': '系统规则：发出 {n} 个工作日没回 → 提醒我',
  'follow_up.card.rule.edit': '改',
  'follow_up.verb.wait': '再等等',
  'follow_up.verb.stop': '不用跟了',
  // 规则清单「系统规则」
  'follow_up.rule.label': '发出 {n} 个工作日没回 → 提醒我',
  'follow_up.rule.hint':
    '你或岗位发出去的信，对方是真人、到点还没回就出一张卡，附一封催促草稿（按对方语言写），批了才发。对方说过哪天答复的，到那天再过 1 个工作日才提醒。催过一次后间隔翻倍，最多提醒两次。红人 / B2B 开发信和客服的信有自己的跟进，这里不重复。周六日不算。',
  'follow_up.rule.toggle': '回信跟进开关',
  'follow_up.rule.less': '少一天',
  'follow_up.rule.more': '多一天',
  'follow_up.rule.per_account': '按邮箱分开设',
  'follow_up.rule.same': '跟着上面',
  'follow_up.rule.own': '{n} 个工作日',
  'follow_up.rule.off': '这只不提醒',
  'follow_up.rule.reset': '恢复跟着上面',
  'follow_up.rule.error': '没改成：{why}',
}

export const FOLLOW_UP_EN: Record<string, string> = {
  'follow_up.category': 'Follow-up',
  'follow_up.surface.messages': 'Messages',
  'follow_up.card.sent_on': 'You sent on {day}',
  'follow_up.card.promised': 'They said they’d reply by {day}',
  'follow_up.card.second': 'Second reminder (the last one)',
  'follow_up.card.draft': 'Follow-up draft',
  'follow_up.card.to': 'To {to}',
  'follow_up.card.send': 'Send',
  'follow_up.card.edit': 'Edit',
  'follow_up.card.edit_done': 'Done',
  'follow_up.card.send.hint':
    'Replies in the same thread from the mailbox you last sent from. Nothing goes out while outbound is paused.',
  'follow_up.card.sent': 'Approved — sending shortly',
  'follow_up.card.failed': 'Not sent: {message}',
  'follow_up.card.rule': 'System rule: no reply {n} business days after sending → remind me',
  'follow_up.card.rule.edit': 'Change',
  'follow_up.verb.wait': 'Wait longer',
  'follow_up.verb.stop': 'Stop following up',
  'follow_up.rule.label': 'No reply {n} business days after sending → remind me',
  'follow_up.rule.hint':
    'When you or a position sends a mail to a real person and no reply comes in time, a card appears with a short follow-up draft (in their language); nothing is sent until you approve. If they said when they’d reply, the reminder waits until one business day after that. After one nudge the wait doubles; at most two reminders. Creator / B2B outreach and customer-care mail have their own follow-ups and are skipped here. Weekends don’t count.',
  'follow_up.rule.toggle': 'Follow-up reminders on/off',
  'follow_up.rule.less': 'One day fewer',
  'follow_up.rule.more': 'One day more',
  'follow_up.rule.per_account': 'Per mailbox',
  'follow_up.rule.same': 'Same as above',
  'follow_up.rule.own': '{n} business days',
  'follow_up.rule.off': 'No reminders for this one',
  'follow_up.rule.reset': 'Back to same as above',
  'follow_up.rule.error': 'Didn’t save: {why}',
}
