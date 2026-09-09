/**
 * Extracted from KefuAgent src/lib/support/verticals/goods/boundaries.ts
 * (`factSignature.contextKeywords` 闭集) 与 src/lib/support/policy/policy-boundaries.ts
 * (`getAnsweredPolicyBoundaries`)，rewritten for agentsws contracts.
 *
 * "这条边界，工作区已经答过了吗？"——中台没有 KefuAgent 的 `support_policy_boundary` 表，
 * 已答的边界以两种形态出现在一次运行的上下文里：
 *   ① 策略层 ContextItem 的结构化键（`return_window_days` 之类）
 *   ② 知识层事实卡的正文（"退货窗口是签收后 14 天内"）
 *
 * 闭集纪律（KefuAgent 用真实政策页反复校准出来的结论）：
 * **只收带语义的短语，不收裸词**。裸 `warranty` 会把每一页页脚的信任徽标拖进保修边界，
 * 裸 `compensation` 会把运费罚金拿去比补偿上限。宁可漏判，不可误判。
 */
import { SUPPORT_BOUNDARIES } from './boundaries.js'
import { sanitizeExternal } from './text.js'
import type { SupportPolicy } from './types.js'

/** boundary id → 上下文闭集词。没有条目的边界不做正文探测（只认结构化键）。 */
export const BOUNDARY_CONTEXT_KEYWORDS: Readonly<Record<string, readonly string[]>> = {
  'policy.refund_window': [
    'return policy',
    'return window',
    'day return',
    'days after receiving',
    'request a return',
    'return it within',
    'refund window',
    'money back guarantee',
    'return an order within',
    '退货政策',
    '退货窗口',
    '退款窗口',
    '内退货',
    '内申请退货',
    '无理由退货',
  ],
  'policy.return_shipping_payer': [
    'return shipping',
    'return label',
    'ship it back',
    'send it back',
    '退货运费',
    '退回运费',
    '寄回运费',
  ],
  'policy.replacement_first': [
    'replacement instead of a refund',
    'we replace',
    'send a replacement',
    '优先补发',
    '走补发流程',
    '补发而不退款',
  ],
  'policy.compensation_cap': [
    'compensation cap',
    'maximum compensation',
    'compensation of up to',
    'partial refund',
    'goodwill',
    'store credit',
    '补偿上限',
    '最高补偿',
    '赔偿上限',
    '部分退款',
  ],
  'policy.cancel_change_window': [
    'cancel before it ships',
    'change the shipping address before',
    'once it has shipped',
    '发货前可以取消',
    '发货后不能改',
    '改址窗口',
  ],
  'policy.logistics_anomaly_days': [
    'tracking has not updated',
    'no tracking update',
    'tracking not updated',
    'tracking stopped',
    'stuck in transit',
    'no movement',
    '物流未更新',
    '物流停滞',
    '物流异常',
    '轨迹未更新',
  ],
  'policy.customs_duty_payer': [
    'customs',
    'duties',
    'import tax',
    'import duty',
    'tariff',
    'ddp',
    'ddu',
    '关税',
    '清关',
    '进口税',
    '税费',
  ],
  'policy.warranty_period': [
    'warranty period',
    'warranty covers',
    'warranty lasts',
    'limited warranty of',
    'month warranty',
    'months warranty',
    'warranty for',
    '保修期',
    '质保期',
    '个月保修',
    '年保修',
  ],
  'policy.lost_package_liability': [
    'marked as delivered but',
    'lost in transit',
    'lost package',
    'carrier claim',
    '丢件',
    '丢失赔付',
    '显示已签收但',
  ],
  'policy.wrong_address_liability': [
    'wrong address provided by the customer',
    'incorrect address',
    'address entered by the customer',
    '地址填错',
    '地址写错',
  ],
  'policy.goodwill_coupon': [
    'goodwill coupon',
    'discount code as an apology',
    'store credit as an apology',
    '补发优惠券',
    '安抚券',
  ],
  'policy.negative_review_response': [
    'negative review policy',
    'do not trade compensation for reviews',
    '差评应对',
    '不拿补偿换评价',
  ],
  'policy.escalation_trigger': [
    'escalate to a human',
    'must be reviewed by a person',
    '必须转人工',
    '升级人工',
  ],
}

/** 结构化键 → boundary id + 取值路径。结构化命中比正文命中可靠，优先。 */
export const BOUNDARY_STRUCTURED_KEYS: Readonly<Record<string, { id: string; path: string }>> = {
  return_window_days: { id: 'policy.refund_window', path: 'days' },
  refund_window_days: { id: 'policy.refund_window', path: 'days' },
  warranty_months: { id: 'policy.warranty_period', path: 'months' },
  logistics_anomaly_days: { id: 'policy.logistics_anomaly_days', path: 'days' },
  compensation_cap_amount: { id: 'policy.compensation_cap', path: 'amount' },
  return_shipping_payer: { id: 'policy.return_shipping_payer', path: 'payer' },
  customs_duty_payer: { id: 'policy.customs_duty_payer', path: 'payer' },
}

export interface DetectInput {
  /** 策略层 / 知识层的正文。 */
  texts?: readonly string[]
  /** 策略层的结构化内容（会递归找已知键）。 */
  structured?: readonly unknown[]
  at: string
}

function walk(value: unknown, hit: (key: string, v: unknown) => void, depth = 0): void {
  if (depth > 4 || value === null || typeof value !== 'object') return
  if (Array.isArray(value)) {
    for (const v of value) walk(v, hit, depth + 1)
    return
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    hit(k, v)
    walk(v, hit, depth + 1)
  }
}

/**
 * 从一次运行的上下文里推出"已经答过的边界"。
 *
 * 这是**探测**不是权威：真正的权威是工作区里存下来的 `SupportPolicy`。
 * 探测存在的意义只有一个——让运行时在没有策略存储的路径上（stub / 规则脑 / evals）
 * 也不会把"其实已经写在政策页上的口径"当成没答过而反复发卡。
 */
export function detectAnsweredBoundaries(input: DetectInput): SupportPolicy[] {
  const found = new Map<string, SupportPolicy>()
  const add = (id: string, value: Record<string, unknown>, statement: string): void => {
    if (found.has(id)) return
    const boundary = SUPPORT_BOUNDARIES.find((b) => b.id === id)
    if (boundary === undefined) return
    found.set(id, {
      boundary_id: id,
      value,
      statement: `${boundary.label}：${statement}`,
      answered_by: 'import',
      answered_at: input.at,
      source: 'import',
    })
  }

  for (const item of input.structured ?? []) {
    walk(item, (key, v) => {
      const mapped = BOUNDARY_STRUCTURED_KEYS[key]
      if (mapped === undefined) return
      if (v === null || v === undefined || typeof v === 'object') return
      add(mapped.id, { [mapped.path]: v }, String(v))
    })
  }

  const haystack = (input.texts ?? [])
    .map((t) => sanitizeExternal(t))
    .join('\n')
    .toLowerCase()
  if (haystack.length > 0) {
    for (const [id, terms] of Object.entries(BOUNDARY_CONTEXT_KEYWORDS)) {
      const hit = terms.find((t) => haystack.includes(t.toLowerCase()))
      if (hit !== undefined) add(id, { detected_from: hit }, hit)
    }
  }

  return [...found.values()]
}

/** 运行时已经从知识层解析出退货窗口时，直接把它当作"这条边界已答"。 */
export function returnWindowPolicy(days: number, at: string, fact_card_id?: string): SupportPolicy {
  return {
    boundary_id: 'policy.refund_window',
    value: { days, ...(fact_card_id === undefined ? {} : { fact_card_id }) },
    statement: `退款/退货窗口：${days} 天`,
    answered_by: 'import',
    answered_at: at,
    source: 'import',
  }
}
