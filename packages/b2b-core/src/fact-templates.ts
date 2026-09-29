/**
 * WP182（docs/84 §3.1）：知识库里 **B2B 六类事实卡的模板**（产品线、价格与 MOQ、认证清单、
 * 交付能力、样品政策、售后规则——`company-brain.ts` 那六类）。
 *
 * 首次设置时按官网判断的行业（`onboarding.ts` 的 `guessIndustry`）**预填认证清单**：
 * 3C → CE / FCC / RoHS / UKCA / PSE，智能家居加 Matter……其余五类只给「该写什么」的空模板。
 *
 * 三条纪律（与 `brand-knowledge.ts` 同一套，19 §4）：
 * 1. **一律提议（proposed）**：机器按行业猜的认证不是「我们有这些证」，人核过、点了生效才被起草引用；
 * 2. **每条带出处**：预填那张写官网网址 +「按官网推荐的行业预填，待核」；空模板写「模板，待填」；
 * 3. **起草只引生效了的卡**，而且模板只引 `structured.reply_en` 那一句英文——空着就说「我去确认」。
 */
import type { B2bFactCategoryId } from './company-brain.js'
import { B2B_FACT_CATEGORIES } from './company-brain.js'
import type { IndustryGuess } from './onboarding.js'

/** `subject.key` 的前缀（`b2b:<类别>`）。 */
export const B2B_FACT_KEY_PREFIX = 'b2b:'

export const b2bFactKey = (category: B2bFactCategoryId): string =>
  `${B2B_FACT_KEY_PREFIX}${category}`

/** `subject.key` → 类别（不是 B2B 事实卡回 `undefined`）。 */
export function b2bFactCategoryOf(key: string): B2bFactCategoryId | undefined {
  if (!key.startsWith(B2B_FACT_KEY_PREFIX)) return undefined
  const id = key.slice(B2B_FACT_KEY_PREFIX.length)
  return B2B_FACT_CATEGORIES.find((c) => c.id === id)?.id
}

export interface B2bFactTemplate {
  category: B2bFactCategoryId
  key: string
  /** 卡上那一句（中文，给人看；人改完就是这家公司的口径）。 */
  statement: string
  /** 结构化几格：`reply_en` 是起草能直接引的英文那一句；`fields` 是这一类该填的几格。 */
  structured: {
    category: B2bFactCategoryId
    fields: Record<string, string>
    reply_en: string
    /** 预填的值从哪来（`industry` = 按官网行业推荐）。 */
    prefilled?: 'industry'
    certifications?: string[]
  }
  /** 出处的 locator（给人认「这条是谁写的」）。 */
  locator: string
}

export const B2B_FACT_TEMPLATE_LOCATOR = '模板，待填'
export const B2B_FACT_PREFILL_LOCATOR = '按官网推荐的行业预填，待核'

/** 每一类该填的几格（中文名 → 空值）。 */
const FIELDS: Readonly<Record<B2bFactCategoryId, readonly string[]>> = {
  product_lines: ['主推型号', '暂停推广的型号', '可定制项'],
  pricing_moq: ['MOQ（每款）', '阶梯价', '低于 MOQ 怎么办', '独家与账期边界'],
  certifications: ['已有认证', '哪些型号有', '证书挂谁的名'],
  delivery: ['常规交期', '加急交期', '月产能', '出货港口'],
  sample_policy: ['样品费', '运费谁付', '下单后能否抵扣', '样品交期'],
  after_sales: ['质保期', '到货即坏（DOA）怎么处理', 'RMA 流程'],
}

/**
 * 六张模板。`industry` 给了就预填认证清单（没有推荐认证的行业仍是空模板）。
 * 认证那一张的 `reply_en` 也预填——但卡是 proposed，人不点生效，起草一个字都不会引。
 */
export function b2bFactTemplates(
  industry?: Pick<IndustryGuess, 'industry' | 'certifications'>,
): B2bFactTemplate[] {
  return B2B_FACT_CATEGORIES.map((c): B2bFactTemplate => {
    const fields = Object.fromEntries(FIELDS[c.id].map((f) => [f, '']))
    const certs = c.id === 'certifications' ? (industry?.certifications ?? []) : []
    if (certs.length > 0) {
      // 只把确定的证名进英文那一句（「UL/ETL（按产品与市场确认）」这种带括号的只留在中文里）
      const plain = certs.filter((x) => !/[（(]/.test(x))
      return {
        category: c.id,
        key: b2bFactKey(c.id),
        statement: `认证清单（按官网判断的行业「${industry?.industry ?? ''}」预填，待核）：${certs.join('、')}。请核对哪些型号真有、证书挂谁的名。`,
        structured: {
          category: c.id,
          fields: { ...fields, 已有认证: certs.join('、') },
          reply_en:
            plain.length === 0
              ? ''
              : `Our products are certified to ${plain.join(', ')} (by model — we can share the certificates).`,
          prefilled: 'industry',
          certifications: certs,
        },
        locator: B2B_FACT_PREFILL_LOCATOR,
      }
    }
    return {
      category: c.id,
      key: b2bFactKey(c.id),
      statement: `${c.name}（模板，待填）：${c.description}。`,
      structured: { category: c.id, fields, reply_en: '' },
      locator: B2B_FACT_TEMPLATE_LOCATOR,
    }
  })
}
