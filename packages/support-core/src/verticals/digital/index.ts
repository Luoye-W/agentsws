/**
 * `digital` 包 —— 虚拟产品与服务（App / SaaS / 在线服务）。
 *
 * 这一版的 digital 是什么：**靠知识答题、正确分流邮件、正确求助**。
 *
 * 这一版的 digital **不是**什么，以及为什么这不是缺陷：没有账户上下文 provider
 * （身份 token 与账户查询是后面的活）。后果是**账户类问题一律求助**——AI 手上没有
 * 任何账户事实，能做的只有坦诚说"我帮您向同事核实"并请对方留下注册邮箱。
 * 反过来才是事故：让一个查不到账户的 AI 去回答"我为什么被扣了两次费"，它只能编。
 */
import type { VerticalPack } from '../types.js'
import { DIGITAL_BOUNDARIES } from './boundaries.js'
import { DIGITAL_DRAFT } from './draft.js'
import { DIGITAL_CHAT_PLAN, DIGITAL_INTENTS, DIGITAL_PRESALES } from './intents.js'
import { DIGITAL_KNOWLEDGE } from './knowledge.js'
import { DIGITAL_L3_DENYLIST } from './l3.js'
import { DIGITAL_PERSONA } from './persona.js'
import { DIGITAL_CHAT_RULES, DIGITAL_EMAIL_RULES } from './rules.js'
import { DIGITAL_TRIAGE } from './triage.js'

export const digitalPack: VerticalPack = {
  key: 'digital',
  labelZh: '虚拟产品与服务',
  // WP79 ⑤：同上，一行短句
  hintZh: '不用发货的东西，客户会问"怎么用""为什么扣费"。',
  persona: DIGITAL_PERSONA,
  chatRules: DIGITAL_CHAT_RULES,
  emailRules: DIGITAL_EMAIL_RULES,
  intents: DIGITAL_INTENTS,
  chatPlan: DIGITAL_CHAT_PLAN,
  presales: DIGITAL_PRESALES,
  l3Denylist: DIGITAL_L3_DENYLIST,
  knowledge: DIGITAL_KNOWLEDGE,
  boundaries: DIGITAL_BOUNDARIES,
  changeGate: {
    // 没有实物就没有补发与改地址，这两类变更在这个垂直里根本不会被提出来。
    governing: {
      refund: ['policy.subscription_refund'],
      goodwill_credit: ['policy.credit_compensation_cap'],
      discount_code: ['policy.discount_authority'],
    },
    window: { boundaryId: 'policy.subscription_refund', valuePath: 'days', defaultDays: 14 },
    // 丢件那条对虚拟产品没有指涉对象。
    extra: [],
  },
  triage: DIGITAL_TRIAGE,
  draft: DIGITAL_DRAFT,
}

export { DIGITAL_BOUNDARIES } from './boundaries.js'
export { DIGITAL_DRAFT } from './draft.js'
export { DIGITAL_CHAT_PLAN, DIGITAL_INTENTS, DIGITAL_PRESALES } from './intents.js'
export { DIGITAL_KNOWLEDGE } from './knowledge.js'
export { DIGITAL_L3_DENYLIST } from './l3.js'
export { DIGITAL_PERSONA } from './persona.js'
export { DIGITAL_CHAT_RULES, DIGITAL_EMAIL_RULES, DIGITAL_TRIAGE_SCOPE } from './rules.js'
export { DIGITAL_TRIAGE } from './triage.js'
