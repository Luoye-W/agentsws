/**
 * 实物商品的邮件词表分流。
 *
 * 数据化自本仓 WP54 改造前 `classify.ts` 里的 `lexiconVerdict`——那段代码本身
 * extracted from KefuAgent `email-triage.ts` 的 `classifyEmailHeuristically`。
 * **行为一字不变**：规则顺序、置信度、原因文案、每条用哪张词表，逐条对得上。
 *
 * 结构上多了一个 `requires`：原来的两层 if（先看是不是客服诉求，命中之后才细分）
 * 在这里表达成"命中本条之前必须先命中这张门词表"。数据化的收益是 digital 能写一张
 * 自己的表，而不是让分类函数里长出一个 `if (vertical === 'digital')`。
 */

import {
  BUSINESS_TERMS,
  CANCELLATION_TERMS,
  COMPLAINT_TERMS,
  DAMAGE_TERMS,
  MARKETING_TERMS,
  MISSING_INFO_RULES,
  PLATFORM_TERMS,
  PRODUCT_QUESTION_TERMS,
  RETURN_REFUND_TERMS,
  RISK_TERMS,
  SPAM_TERMS,
  SUPPORT_TERMS,
  TRACKING_TERMS,
  WARRANTY_TERMS,
} from '../../lexicon.js'
import type { VerticalTriagePack } from '../types.js'

export const GOODS_TRIAGE: VerticalTriagePack = {
  rules: [
    {
      intent: 'spam',
      is_customer_service: false,
      terms: SPAM_TERMS,
      confidence: 0.92,
      reason: '命中垃圾邮件词面，不进客服队列。',
    },
    // 下面七条都在 SUPPORT_TERMS 这道门后面：先确认是客服诉求，再细分。
    {
      intent: 'complaint',
      is_customer_service: true,
      requires: SUPPORT_TERMS,
      terms: COMPLAINT_TERMS,
      confidence: 0.95,
      reason: '邮件包含投诉、差评或争议信号，应由客服职责接管。',
    },
    {
      intent: 'returns_refunds',
      is_customer_service: true,
      requires: SUPPORT_TERMS,
      terms: RETURN_REFUND_TERMS,
      confidence: 0.94,
      reason: '邮件包含退货、退款或换货相关诉求，应由客服职责接管。',
    },
    {
      intent: 'cancellation',
      is_customer_service: true,
      requires: SUPPORT_TERMS,
      terms: CANCELLATION_TERMS,
      confidence: 0.93,
      reason: '邮件在要求取消订单或修改地址，应由客服职责接管。',
    },
    {
      intent: 'order_tracking',
      is_customer_service: true,
      requires: SUPPORT_TERMS,
      terms: TRACKING_TERMS,
      confidence: 0.96,
      reason: '邮件在询问订单、物流、包裹或配送状态，应由客服职责接管。',
    },
    {
      intent: 'complaint',
      is_customer_service: true,
      requires: SUPPORT_TERMS,
      terms: DAMAGE_TERMS,
      confidence: 0.95,
      reason: '邮件包含损坏、错发或少件信号，应由客服职责接管。',
    },
    {
      intent: 'warranty',
      is_customer_service: true,
      requires: SUPPORT_TERMS,
      terms: WARRANTY_TERMS,
      confidence: 0.92,
      reason: '邮件在问保修或维修，应由客服职责接管。',
    },
    {
      intent: 'product_question',
      is_customer_service: true,
      requires: SUPPORT_TERMS,
      terms: PRODUCT_QUESTION_TERMS,
      confidence: 0.9,
      reason: '邮件在问产品用法、尺寸或兼容性，应由客服职责接管。',
    },
    // 进了门却一条细分都没命中：它仍然是客服邮件。
    {
      intent: 'post_sales',
      is_customer_service: true,
      requires: SUPPORT_TERMS,
      terms: SUPPORT_TERMS,
      confidence: 0.91,
      reason: '邮件包含典型售前/售后客服问题，应由客服职责接管。',
    },
    // 门外的三条排除：平台通知 → 推广 → 商务。
    {
      intent: 'platform_notification',
      is_customer_service: false,
      terms: PLATFORM_TERMS,
      confidence: 0.9,
      reason: '邮件更像平台、安全或账单通知，不进客服队列。',
    },
    {
      intent: 'marketing',
      is_customer_service: false,
      terms: MARKETING_TERMS,
      confidence: 0.89,
      reason: '邮件更像推广、SEO、广告或合作邀约，不进客服队列。',
    },
    {
      intent: 'business',
      is_customer_service: false,
      terms: BUSINESS_TERMS,
      confidence: 0.86,
      reason: '邮件更像商务合作或供应链沟通，不进客服队列。',
    },
  ],
  fallback: {
    intent: 'other',
    is_customer_service: false,
    confidence: 0.75,
    reason: '未发现明确售前/售后客服诉求，默认保持在原收件箱。',
  },
  takenOverIntent: 'post_sales',
  riskTerms: RISK_TERMS,
  needs: MISSING_INFO_RULES,
  recordRefNeed: 'order_ref',
}
