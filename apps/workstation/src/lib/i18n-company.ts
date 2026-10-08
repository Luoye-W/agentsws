/**
 * WP277（docs/95 §3.4–§3.6，决策 239–241）：③ 开公司模式的词——向导三步、同事收的那张卡、
 * 回到同事互联、降回之后同事那一行通知、上级派活那一行通知。中英各一份，在 `i18n.ts` 的
 * `TABLES` 那一行并进去。
 *
 * 少字（docs/36）：按钮与卡面只留短句，为什么、会怎样进问号（`*.hint`）；同一屏不说两遍。
 */
export const COMPANY_ZH: Record<string, string> = {
  // ── 入口（设置页底部 + 团队页底部，各一行小字）
  'company.entry': '开公司模式…',
  'company.entry.hint':
    // ② 团队页底部也出这一句：不用「主管 / 老板 / 审批」这些词（决策 256）
    '要分上下级、给成员设额度时再开。开了以后每位同事收一张卡，可以选择退出。',
  // ── 向导三步
  'company.wizard.title': '开公司模式',
  'company.wizard.step': '{n} / 3',
  'company.wizard.legal_name': '公司全称',
  'company.wizard.legal_name.hint': '营业执照上的全称；开发信页脚、报价单也用它。',
  'company.wizard.boss': '谁是老板',
  'company.wizard.boss.hint': '超了授权、没设上级的岗位，都转给老板批；只有老板能改回同事互联。',
  'company.wizard.admins': '管理员（可不选）',
  'company.wizard.admins.hint':
    '管理员能邀请人、建品牌、办离职。上级、店铺组、额度都可以开完再慢慢设——不设的时候，主管定的事转老板，人人看整个品牌，额度不限。',
  'company.wizard.none': '还没有别人。',
  'company.wizard.you': '{name}（你）',
  'company.wizard.next': '下一步',
  'company.wizard.back': '上一步',
  'company.wizard.open': '开公司模式',
  // ── 回到同事互联（只有老板）
  'company.close': '回到同事互联…',
  'company.close.title': '回到同事互联？',
  'company.close.body':
    '上级、店铺组、额度先收起来，再开时原样回来；等主管或老板批的卡退回给本人。',
  'company.close.confirm': '回到同事互联',
  'company.close.cancel': '算了',
  // ── 同事收的那张卡（决策 239）
  'category.company_notice': '公司模式',
  'company.notice.leave.hint':
    '退出后，你的个人渠道跟你走；共享品牌里的客户、知识留下。想带走自己建的，先导出一份。',
  'company.notice.export': '导出我的副本',
  'company.notice.exported': '导出好了',
  // ── 降回 ② 后同事那一行通知（不是卡）
  'mode.notice.peers': '{name} 把这里改回了同事互联',
  'mode.notice.ok': '知道了',
  // ── ③ 上级派活（决策 241）
  'handoff.dispatched': '{name} 派给你「{title}」',
  // ── docs/95 §6.3：「范围」只在 ③——② 里岗位页那张「还没挂上品牌」不说范围、不叫人去分配
  'view.no_range@peers': '这个岗位还没挂上品牌',
  'view.no_range.self@peers': '挂上整个品牌',
  'view.no_range.self.hint@peers': '挂上之后，这个岗位看整个品牌的数据。',
  'view.no_range.detail@peers': '还没挂品牌，所以看不到店铺数据——不是没数。',
  'view.no_range.ask_owner@peers': '请发起人挂上整个品牌。',
}

export const COMPANY_EN: Record<string, string> = {
  'company.entry': 'Switch to company mode…',
  'company.entry.hint':
    'Turn it on when you need reporting lines or per-member credit limits. Every colleague gets a card and can choose to leave.',
  'company.wizard.title': 'Company mode',
  'company.wizard.step': '{n} / 3',
  'company.wizard.legal_name': 'Legal company name',
  'company.wizard.legal_name.hint':
    'The name on your business licence; also used in email footers and quotes.',
  'company.wizard.boss': 'Who is the boss',
  'company.wizard.boss.hint':
    'Over-limit work and positions without a manager go to the boss. Only the boss can switch back.',
  'company.wizard.admins': 'Admins (optional)',
  'company.wizard.admins.hint':
    'Admins can invite people, add brands and handle offboarding. Managers, store groups and credit limits can be set later — until then the boss approves, everyone sees the whole brand, and credits are unlimited.',
  'company.wizard.none': 'Nobody else yet.',
  'company.wizard.you': '{name} (you)',
  'company.wizard.next': 'Next',
  'company.wizard.back': 'Back',
  'company.wizard.open': 'Turn on company mode',
  'company.close': 'Back to working as peers…',
  'company.close.title': 'Back to working as peers?',
  'company.close.body':
    'Managers, store groups and credit limits are put away and come back as they were if you switch again; cards waiting for a manager or the boss go back to their owner.',
  'company.close.confirm': 'Back to peers',
  'company.close.cancel': 'Cancel',
  'category.company_notice': 'Company mode',
  'company.notice.leave.hint':
    'If you leave, your personal channels go with you; customers and knowledge in the shared brand stay. Export a copy of what you made first if you want to keep it.',
  'company.notice.export': 'Export my copy',
  'company.notice.exported': 'Exported',
  'mode.notice.peers': '{name} switched this back to working as peers',
  'mode.notice.ok': 'Got it',
  'handoff.dispatched': '{name} assigned you “{title}”',
  'view.no_range@peers': 'This position is not linked to a brand yet',
  'view.no_range.self@peers': 'Link the whole brand',
  'view.no_range.self.hint@peers': 'Once linked, this position sees data for the whole brand.',
  'view.no_range.detail@peers':
    'No brand linked yet, so store numbers are hidden — the data is there.',
  'view.no_range.ask_owner@peers': 'Ask the initiator to link the whole brand.',
}
