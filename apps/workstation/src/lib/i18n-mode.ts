/**
 * WP271（docs/95 §2，决策 233 / 235 / 244 / 245）：三种用法里**换说法**的那些词。
 *
 * 写法：`原 key@solo`（① 个人）、`原 key@peers`（② 同事互联）。`useMode().t` 先找带后缀的，
 * 没有就用原来的——③ 公司集体永远是原来那一套，所以这里没有 `@company`。
 *
 * ① 的规矩（Luoye 10-08）：不出现任何公司概念的词（主管 / 老板 / 上级 / 成员 / 部门 / 范围 /
 * 所有者 / 负责人……）；用「确认」系，不用「审批」系；少字。
 */
export const MODE_ZH: Record<string, string> = {
  // 左栏与页头（决策 235）
  'nav.org@solo': '岗位与品牌',
  'nav.org@peers': '团队',
  'org.title@solo': '岗位与品牌',
  'org.title@peers': '团队',
  'org.subtitle@solo': '你的岗位和品牌。',
  // 岗位 tab
  'org.positions.ours@solo': '你的岗位',
  'org.positions.assign@solo': '我来做',
  'org.positions.templates.hint@solo': '挑一个，点「我来做」就开工。',
  'org.assign.receipt@solo': '「{position}」开工了',
  'org.assign.receipt.hint@solo': '左栏「岗位」里能找到它。',
  // 职责规矩：AI 自己能做到哪一步（决策 244，安全闸不是审批）
  'org.level.L1@solo': '每条都要你确认',
  'org.level.L2@solo': '上限内自己做',
  'org.level.L3@solo': '自己做，事后告诉你',
  'org.roles.rename@solo': '这个职责叫什么',
  'org.roles.custom@solo': '自己的',
  'org.roles.copy_note@solo': '内置模板不给直接改。复制一份，改你自己那一份。',
  'org.roles.submitted@solo': '改好了，当场生效。',
  'org.roles.approval_note@solo': '你自己改的当场生效，保存前会再问你一次。',
  'duty.level.L1@solo': '要你确认',
  'duty.level.L2@solo': '上限内自己做',
  'duty.level.L3@solo': '自己做，事后告诉你',
  // 工具箱
  'toolbox.subtitle@solo': '你做过的自动化都在这儿。',
  'toolbox.subtitle.hint@solo': '建之前先来看一眼，做过的就别再做一遍。',
  'toolbox.empty@solo': '还没建过东西。建一条定时任务或在对话里定制一张卡，这儿就有了。',
  'toolbox.dupes.hint@solo': '这几对做的像是同一件事，而且都还在用。合并之后只留一份。',
  'toolbox.dupes.merged@solo': '合好了，只留一份',
  // 设置页：品牌档案 + 主体信息（决策 233）
  'settings.company@solo': '品牌档案',
  'settings.company.hint@solo': 'AI 写回复、写文案时会带上这里的品牌资料。',
  'onboarding.block.company@solo': '主体信息',
  'onboarding.block.company.hint@solo': '开发信页脚、报价单用；选填',
  'onboarding.company.legal_name@solo': '营业执照上的全称',
  'onboarding.company.address@solo': '实体地址',
  'onboarding.company.save@solo': '保存',
  'onboarding.company.empty@solo': '全称还没填。',
  'onboarding.company.promise@solo': '只交换一串哈希，名字不出这台机器。',
  'onboarding.company.discoverable.hint@solo':
    '打开后只往局域网广播一串哈希，全称与任何业务数据都不出去。关着就是一个人用，随时能打开。',
  // 首次设置：邀请码压成一行小字（决策 245）
  'onboarding.join.toggle@solo': '同事已经在用？输入邀请码',
  'onboarding.join.sent@solo': '申请发出去了，等对方点头。',
  // 岗位页数据看板：① 里不挑范围本来就是整个品牌（老分配才会走到这里）
  'view.no_range@solo': '这个岗位还没挂上品牌',
  'view.no_range.self@solo': '挂上整个品牌',
  'view.no_range.self.hint@solo': '挂上之后，这个岗位看整个品牌的数据。',
  'view.no_range.detail@solo': '还没挂品牌，所以看不到店铺数据——不是没数。',
  'view.no_range.ask_owner@solo': '点上面的按钮挂上整个品牌。',
  'pos2.set.duty.reshape.hint@solo':
    '加减、合并、移动、拆出都在「岗位与品牌」页的岗位卡上做；拆走的职责手上没做完的事跟着走',
  // 设置 → 账号：用量
  'credits.scope_note@solo': '这里是你各个品牌一起的用量。',
  'credits.group.workspace@solo': '按品牌',
  // 设置 → 数据地图
  'datamap.hint@solo':
    '这一页只读：按对象类型列出它的真源在哪、多新、你看得到哪些、能对它做什么。数据本身不在这儿，这里只是一张目录。',
  'datamap.col.range@solo': '我能看的',
  'datamap.col.range.hint@solo': '这条岗位能看到哪些：只有我自己的 / 这个岗位管的 / 整个品牌。',
  'datamap.range.assigned@solo': '这个岗位管的',
  'datamap.range.workspace@solo': '整个品牌',
  // 品牌 tab：从某个品牌复制
  'org.brands.add.copy_from.hint@solo':
    '复制岗位（谁做什么）与模型设置（用哪家、哪个模型、预算多少）。**店铺不跟着走**——那是原品牌的店；**API key 也不复制**——去新品牌里填一次。连接与知识一个字节都不复制。',
  // 技能 / 记忆的层级（① 只剩 内置 / 岗位层 / 职责层 / 我的）
  // 「公司 / 部门」层在 ① 里就是整个品牌都用的那一层（docs/95 §2.4）
  'rail.tier.company@solo': '品牌',
  'rail.tier.department@solo': '品牌',
  'skills.tier.company@solo': '品牌',
  'skills.tier.department@solo': '品牌',
  'memory.promote.company@solo': '提到品牌层',
  'memory.promote.department@solo': '提到品牌层',
  'knowledge.scope.kind.department@solo': '分组',
  'rail.tier.personal@solo': '我的',
  'skills.tier.personal@solo': '我的',
  // WP275（docs/95 §5）：① ② 没有审批流——卡片与「自己改」一律「要你确认 / 当场生效」系
  'org.roles.submit@solo': '保存',
  'rail.caps.submit@solo': '保存',
  'rail.caps.approval_hint@solo': '你自己改的当场生效，保存前会再问你一次。',
  'rail.caps.submitted@solo': '改好了，当场生效',
  'memory.promote.hint@solo': '提上去当场生效，点之前会再问你一次',
  'memory.promote.ok@solo': '提上去了',
  'card.instruct.scope.global_rule@solo': '以后都这样',
  'deck.receipt.instruct.global_rule@solo': '记下了：出了一张卡，你点通过以后都这样。',
  'deck.policy.owner_only@solo': '点通过以后都这样做。',
  'deck.keyboard@solo': '→ 通过 · ← 不要 · ↑ 稍后 · ↓ 指导',
  'b2b.sales.approver.role_holder@solo': '等你确认',
  'b2b.sales.approver.scope_manager@solo': '等你确认',
  'b2b.sales.approver.owner@solo': '等你确认',
  'b2b.sales.quote.pending@solo': 'V{version} · {who}',
  'b2b.sales.sample.pending@solo': '等你确认',
  'org.roles.submit@peers': '保存',
  'org.roles.submitted@peers': '改好了，当场生效；在做这条职责的同事会收到通知，可以撤回。',
  'org.roles.approval_note@peers':
    '你自己改的当场生效（保存前会再问你一次）；在做这条职责的同事会收到通知，可以撤回。',
  'rail.caps.submit@peers': '保存',
  'rail.caps.approval_hint@peers':
    '你自己改的当场生效（保存前会再问你一次）；在做这条职责的同事会收到通知，可以撤回。',
  'rail.caps.submitted@peers': '改好了，当场生效',
  'toolbox.dupes.merged@peers': '合好了，只留一份',
  'memory.promote.hint@peers': '提上去当场生效，点之前会再问你一次',
  'memory.promote.ok@peers': '提上去了',
  'card.instruct.scope.global_rule@peers': '以后都这样',
  'deck.receipt.instruct.global_rule@peers': '记下了：出了一张卡，你点通过以后都这样。',
  'deck.policy.owner_only@peers': '点通过以后都这样做。',
  'deck.keyboard@peers': '→ 通过 · ← 不要 · ↑ 稍后 · ↓ 指导',
  'b2b.sales.approver.role_holder@peers': '等你确认',
  'b2b.sales.approver.scope_manager@peers': '等你确认',
  'b2b.sales.approver.owner@peers': '等你确认',
  'b2b.sales.quote.pending@peers': 'V{version} · {who}',
  'b2b.sales.sample.pending@peers': '等你确认',
  'org.level.L1@peers': '每条都要你确认',
  'org.level.L2@peers': '上限内自己做',
  'org.level.L3@peers': '自己做，事后告诉你',
  'duty.level.L1@peers': '要你确认',
  'duty.level.L2@peers': '上限内自己做',
  'duty.level.L3@peers': '自己做，事后告诉你',
  'b2b.sales.quote.staged@solo': '出了一张卡，你点通过才发',
  'b2b.sales.sample.hint@solo': '已寄必须带单号。标已寄的卡你点通过后，会再出一张寄样通知卡。',
  'b2b.sales.quote.staged@peers': '出了一张卡，你点通过才发',
  'b2b.sales.sample.hint@peers': '已寄必须带单号。标已寄的卡你点通过后，会再出一张寄样通知卡。',
}

export const MODE_EN: Record<string, string> = {
  'nav.org@solo': 'Positions & brands',
  'nav.org@peers': 'Team',
  'org.title@solo': 'Positions & brands',
  'org.title@peers': 'Team',
  'org.subtitle@solo': 'Your positions and brands.',
  'org.positions.ours@solo': 'Your positions',
  'org.positions.assign@solo': 'Take it on',
  'org.positions.templates.hint@solo': 'Pick one and click “Take it on”.',
  'org.assign.receipt@solo': '“{position}” is up and running',
  'org.assign.receipt.hint@solo': 'Find it under Positions in the left rail.',
  'org.level.L1@solo': 'Confirm every one',
  'org.level.L2@solo': 'On its own within limits',
  'org.level.L3@solo': 'On its own, tells you after',
  'org.roles.rename@solo': 'What this duty is called',
  'org.roles.custom@solo': 'yours',
  'org.roles.copy_note@solo': 'Built-in templates are read-only. Copy one and edit your copy.',
  'org.roles.submitted@solo': 'Saved — in effect now.',
  'org.roles.approval_note@solo':
    'Your own changes take effect right away; you get asked once before saving.',
  'duty.level.L1@solo': 'You confirm',
  'duty.level.L2@solo': 'On its own within limits',
  'duty.level.L3@solo': 'On its own, tells you after',
  'toolbox.subtitle@solo': 'Automations you have built live here.',
  'toolbox.subtitle.hint@solo': 'Look here before building — you may have built it already.',
  'toolbox.empty@solo':
    'Nothing built yet. Create a scheduled task or pin a card and it shows up here.',
  'toolbox.dupes.hint@solo':
    'These pairs seem to do the same thing and are both in use. Merge to keep one.',
  'toolbox.dupes.merged@solo': 'Merged — one copy kept',
  'settings.company@solo': 'Brand profile',
  'settings.company.hint@solo': 'The AI uses these brand details when it writes replies and copy.',
  'onboarding.block.company@solo': 'Legal entity',
  'onboarding.block.company.hint@solo': 'For outreach footers and quotes; optional',
  'onboarding.company.legal_name@solo': 'Registered name',
  'onboarding.company.address@solo': 'Street address',
  'onboarding.company.save@solo': 'Save',
  'onboarding.company.empty@solo': 'No registered name yet.',
  'onboarding.company.promise@solo': 'Only a hash is exchanged; names never leave this machine.',
  'onboarding.company.discoverable.hint@solo':
    'When on, only a hash is broadcast on your local network. Off means you use it on your own; turn it on any time.',
  'onboarding.join.toggle@solo': 'Colleagues already on it? Enter an invite code',
  'onboarding.join.sent@solo': 'Request sent. Waiting for them to say yes.',
  'view.no_range@solo': 'This position is not linked to a brand yet',
  'view.no_range.self@solo': 'Link the whole brand',
  'view.no_range.self.hint@solo': 'Once linked, this position sees data for the whole brand.',
  'view.no_range.detail@solo':
    'No brand linked yet, so store numbers are hidden — the data is there.',
  'view.no_range.ask_owner@solo': 'Use the button above to link the whole brand.',
  'pos2.set.duty.reshape.hint@solo':
    'Add, merge, move or split duties on the position cards in Positions & brands; unfinished work moves with a split-off duty',
  'credits.scope_note@solo': 'Usage across all your brands.',
  'datamap.hint@solo':
    'Read-only: where each kind of object really lives, how fresh it is, what you can see and do with it. It is a directory, not the data.',
  'datamap.col.range@solo': 'What I can see',
  'datamap.col.range.hint@solo':
    'What this position can see: only mine / what this position covers / the whole brand.',
  'datamap.range.assigned@solo': 'what this position covers',
  'datamap.range.workspace@solo': 'the whole brand',
  'credits.group.workspace@solo': 'By brand',
  'org.brands.add.copy_from.hint@solo':
    'Copies positions (who does what) and model settings. **Stores stay behind** — they belong to the source brand; **API keys are not copied** either. Connections and knowledge are never copied.',
  'rail.tier.company@solo': 'Brand',
  'rail.tier.department@solo': 'Brand',
  'skills.tier.company@solo': 'Brand',
  'skills.tier.department@solo': 'Brand',
  'memory.promote.company@solo': 'Lift to brand layer',
  'memory.promote.department@solo': 'Lift to brand layer',
  'knowledge.scope.kind.department@solo': 'Group',
  'rail.tier.personal@solo': 'Mine',
  'skills.tier.personal@solo': 'Mine',
  // WP275
  'org.roles.submit@solo': 'Save',
  'rail.caps.submit@solo': 'Save',
  'rail.caps.approval_hint@solo':
    'Your own changes take effect right away; you get asked once before saving.',
  'rail.caps.submitted@solo': 'Saved — in effect now',
  'memory.promote.hint@solo': 'Lifting takes effect right away; you get asked once first',
  'memory.promote.ok@solo': 'Lifted',
  'card.instruct.scope.global_rule@solo': 'Always do this',
  'deck.receipt.instruct.global_rule@solo':
    'Noted: a card is out — once you approve it, this becomes the rule.',
  'deck.policy.owner_only@solo': 'Approve it and this becomes how it is done from now on.',
  'deck.keyboard@solo': '→ approve · ← drop · ↑ later · ↓ guide',
  'b2b.sales.approver.role_holder@solo': 'waiting for you',
  'b2b.sales.approver.scope_manager@solo': 'waiting for you',
  'b2b.sales.approver.owner@solo': 'waiting for you',
  'b2b.sales.quote.pending@solo': 'V{version} · {who}',
  'b2b.sales.sample.pending@solo': 'waiting for you',
  'org.roles.submit@peers': 'Save',
  'org.roles.submitted@peers':
    'Saved — in effect now; teammates on this duty are notified and can undo it.',
  'org.roles.approval_note@peers':
    'Your own changes take effect right away (asked once before saving); teammates on this duty are notified and can undo.',
  'rail.caps.submit@peers': 'Save',
  'rail.caps.approval_hint@peers':
    'Your own changes take effect right away (asked once before saving); teammates on this duty are notified and can undo.',
  'rail.caps.submitted@peers': 'Saved — in effect now',
  'toolbox.dupes.merged@peers': 'Merged — one copy kept',
  'memory.promote.hint@peers': 'Lifting takes effect right away; you get asked once first',
  'memory.promote.ok@peers': 'Lifted',
  'card.instruct.scope.global_rule@peers': 'Always do this',
  'deck.receipt.instruct.global_rule@peers':
    'Noted: a card is out — once you approve it, this becomes the rule.',
  'deck.policy.owner_only@peers': 'Approve it and this becomes how it is done from now on.',
  'deck.keyboard@peers': '→ approve · ← drop · ↑ later · ↓ guide',
  'b2b.sales.approver.role_holder@peers': 'waiting for you',
  'b2b.sales.approver.scope_manager@peers': 'waiting for you',
  'b2b.sales.approver.owner@peers': 'waiting for you',
  'b2b.sales.quote.pending@peers': 'V{version} · {who}',
  'b2b.sales.sample.pending@peers': 'waiting for you',
  'org.level.L1@peers': 'Confirm every one',
  'org.level.L2@peers': 'On its own within limits',
  'org.level.L3@peers': 'On its own, tells you after',
  'duty.level.L1@peers': 'You confirm',
  'duty.level.L2@peers': 'On its own within limits',
  'duty.level.L3@peers': 'On its own, tells you after',
  'b2b.sales.quote.staged@solo': 'A card is out — it sends once you approve',
  'b2b.sales.sample.hint@solo':
    'Shipped needs a tracking number. Once you approve the shipped card, a sample-notice card follows.',
  'b2b.sales.quote.staged@peers': 'A card is out — it sends once you approve',
  'b2b.sales.sample.hint@peers':
    'Shipped needs a tracking number. Once you approve the shipped card, a sample-notice card follows.',
}
