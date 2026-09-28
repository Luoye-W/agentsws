/**
 * B2B 知识六类（docs/84 §3.1：知识库里的 B2B 事实卡模板）。
 *
 * 出处：Luoye/BtoBAgents（Luoye 自己的私有仓库，本机 `~/Documents/BtoBAgents`）
 * `src/features/btobagents/demo-data.ts` 第 1015–1047 行的 `companyBrainCategories`
 * （Company Brain），首次 `5d4ed9c`、`29f93fe` 改过、`c832e1e` 改名，移植时仓库 HEAD `940f12b`。
 * 不在 KOLAgents 纯模板提交 `cb506142` 里。
 *
 * 移植改动：原表是演示数据（带"86 条知识"这类假计数与第七类"证据资产"）。这里只取
 * docs/84 点名的六类，名字与标签原样，说明改成"这一类该写什么"；计数去掉（那是真数据的事）；
 * 每一类标上**起草时碰到哪类承诺要先查它**——回信里写价格先查「价格与 MOQ」、
 * 写认证先查「认证清单」，与 `@agentsws/core` 的承诺词表按类对上。
 */
import type { B2bCommitmentCategory } from '@agentsws/core'

export type B2bFactCategoryId =
  | 'product_lines'
  | 'pricing_moq'
  | 'certifications'
  | 'delivery'
  | 'sample_policy'
  | 'after_sales'

export interface B2bFactCategory {
  id: B2bFactCategoryId
  name: string
  /** 这一类事实卡该写什么。 */
  description: string
  /** 常见标签（原表的 tags）。 */
  tags: readonly string[]
  /** 回信 / 报价里碰到这几类承诺时，先查这一类事实卡。 */
  covers: readonly B2bCommitmentCategory[]
}

export const B2B_FACT_CATEGORIES: readonly B2bFactCategory[] = [
  {
    id: 'product_lines',
    name: '产品线',
    description: '主推与暂停推广的产品、型号、规格、可定制项',
    tags: ['GaN 系列', 'Power Bank', 'TWS Earbuds'],
    covers: [],
  },
  {
    id: 'pricing_moq',
    name: '价格与 MOQ',
    description: '阶梯定价、包装、定制加价、起订量与商业边界（独家、账期、折扣）',
    tags: ['分区定价', 'MOQ 阶梯', '定制规则'],
    covers: ['price', 'moq', 'exclusive', 'payment_terms'],
  },
  {
    id: 'certifications',
    name: '认证清单',
    description: '按国家 / 地区列出已有认证与证书文件，哪些型号有、哪些没有',
    tags: ['CE', 'FCC', 'RoHS', 'UKCA', 'PSE'],
    covers: ['certification'],
  },
  {
    id: 'delivery',
    name: '交付能力',
    description: '常规与加急交期、产能、出货港口、物流方式、海外仓',
    tags: ['15–20 天', '加急 7–10 天', 'FOB 深圳'],
    covers: ['lead_time'],
  },
  {
    id: 'sample_policy',
    name: '样品政策',
    description: '样品收费与免费条件、样品交期、寄送方式与运费谁付',
    tags: ['收费样品', '免费条件', 'DHL'],
    covers: [],
  },
  {
    id: 'after_sales',
    name: '售后规则',
    description: '质保期、到货即坏（DOA）处理、退换货与 RMA 流程',
    tags: ['12 个月质保', 'DOA 7 天', 'RMA'],
    covers: ['guarantee'],
  },
]

/** 这一类承诺该先查哪一类事实卡（查不到就不写，只说"我确认后回复你"）。 */
export function factCategoryFor(commitment: B2bCommitmentCategory): B2bFactCategory | undefined {
  return B2B_FACT_CATEGORIES.find((c) => c.covers.includes(commitment))
}
