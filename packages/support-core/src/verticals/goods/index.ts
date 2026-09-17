/**
 * `goods` 包 —— 实物商品（独立站 / Amazon）。
 *
 * **实物包 = 本仓改造前的行为逐字节不变。** 这个包里的每一段文字、每一条词表、
 * 每一个枚举值都是 WP54 改造前代码里的原样（或 KefuAgent 现网原文），
 * parity guard 与既有的字节断言一起盯着。对现有电商工作区的可见行为变化为零。
 */
import type { VerticalPack } from '../types.js'
import { GOODS_BOUNDARIES } from './boundaries.js'
import { GOODS_DRAFT } from './draft.js'
import { GOODS_CHAT_PLAN, GOODS_INTENTS, GOODS_PRESALES } from './intents.js'
import { GOODS_KNOWLEDGE } from './knowledge.js'
import { GOODS_L3_DENYLIST } from './l3.js'
import { GOODS_PERSONA } from './persona.js'
import { GOODS_CHAT_RULES, GOODS_EMAIL_RULES } from './rules.js'
import { GOODS_TRIAGE } from './triage.js'

export const goodsPack: VerticalPack = {
  key: 'goods',
  labelZh: '实物商品',
  // WP79 ⑤：这一句会原样铺在首次设置第 ① 步「你卖的是」下面，一行放得下才行
  hintZh: '要发货的东西，客户会问"到哪了""能不能退"。',
  persona: GOODS_PERSONA,
  chatRules: GOODS_CHAT_RULES,
  emailRules: GOODS_EMAIL_RULES,
  intents: GOODS_INTENTS,
  chatPlan: GOODS_CHAT_PLAN,
  presales: GOODS_PRESALES,
  l3Denylist: GOODS_L3_DENYLIST,
  knowledge: GOODS_KNOWLEDGE,
  boundaries: GOODS_BOUNDARIES,
  changeGate: {
    governing: {
      refund: ['policy.refund_window'],
      reship: ['policy.replacement_first'],
      address_change: ['policy.cancel_change_window'],
      discount_code: ['policy.compensation_cap'],
    },
    window: { boundaryId: 'policy.refund_window', valuePath: 'days', defaultDays: 14 },
    extra: [
      {
        // 客户声称"物流说送到了，我没收到"。**两个线索都要有**，只有一个不算。
        changeKind: 'refund',
        allOf: [
          [
            'marked as delivered',
            'says delivered',
            'shows delivered',
            'tracking says it was delivered',
            'was delivered',
            '显示已签收',
            '显示已送达',
            '物流显示',
          ],
          [
            'never arrived',
            'not arrived',
            'never received',
            'did not receive',
            "didn't receive",
            'nothing arrived',
            'lost in transit',
            '没有收到',
            '未收到',
            '没收到',
          ],
        ],
        boundaryId: 'policy.lost_package_liability',
      },
    ],
  },
  triage: GOODS_TRIAGE,
  draft: GOODS_DRAFT,
}

export { GOODS_BOUNDARIES } from './boundaries.js'
export { GOODS_DRAFT } from './draft.js'
export { GOODS_CHAT_PLAN, GOODS_INTENTS, GOODS_PRESALES } from './intents.js'
export { GOODS_KNOWLEDGE } from './knowledge.js'
export { GOODS_L3_DENYLIST } from './l3.js'
export { GOODS_PERSONA } from './persona.js'
export { GOODS_CHAT_RULES, GOODS_EMAIL_RULES, GOODS_TRIAGE_SCOPE } from './rules.js'
export { GOODS_TRIAGE } from './triage.js'
