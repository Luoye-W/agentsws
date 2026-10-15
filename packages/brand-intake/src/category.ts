/**
 * WP335（决策 659）：品牌档案的「品类」一格——**品牌分析时 AI 填、人可改**。
 *
 * 结构化数据里很少直接写品类（Amazon 的面包屑是例外，那一层已经在 `amazon.ts` 里读了）；
 * 官网这一路就把已经读到的几格（品牌名、一句话、主打商品名）交给模型，请它说一个**短的品类名**。
 * 这里只有纯函数：提示词、读回复、落成一格（层 = `model`，把握度 `low`，界面标「请确认」）。
 * 调模型那一下在服务端（注入的模型口；没配模型就不填，人自己写）。
 *
 * 纪律同 70 §4：
 * - 已经有品类（面包屑读到的、或人改过的）不问模型；
 * - 模型回不出像样的（空、太长、像一句话）就**不填**——空格子人知道要填，填错的格子人会当真。
 */
import type { BrandIntakeField, BrandIntakeProfile } from '@agentsws/contracts'
import { field } from './field.js'

/** 品类名最长几个字（「宠物自动饮水机」「AR glasses」这种长度）。 */
export const CATEGORY_MAX_CHARS = 40

/** 这一轮要不要请模型认品类：已经有了（读到的 / 人改的）就不问；连品牌名和商品都没有也不问。 */
export function wantsModelCategory(profile: BrandIntakeProfile): boolean {
  if (profile.category !== undefined) return false
  return (
    profile.brand_name !== undefined ||
    profile.one_liner !== undefined ||
    (profile.products?.value.length ?? 0) > 0
  )
}

const fence = (s: string): string => s.replace(/[`<>]/g, ' ').slice(0, 300)

/** 交给模型的那一段（只给已经读到的几格；页面原文不进来）。 */
export function categoryPrompt(profile: BrandIntakeProfile): string {
  const products = (profile.products?.value ?? []).slice(0, 5).map((p) => `- ${fence(p.title)}`)
  return [
    'Name the product category this brand sells, in 1-4 words (e.g. "power bank", "AR glasses", "宠物饮水机").',
    'Use the same language as the brand facts. Reply with JSON only: {"category": string | null}. Use null if unsure.',
    '',
    ...(profile.brand_name === undefined ? [] : [`brand: ${fence(profile.brand_name.value)}`]),
    ...(profile.one_liner === undefined ? [] : [`one-liner: ${fence(profile.one_liner.value)}`]),
    ...(products.length === 0 ? [] : ['products:', ...products]),
  ].join('\n')
}

/** 读模型回复：拿不出像样的品类名回 `undefined`（不填）。 */
export function parseCategoryReply(text: string): string | undefined {
  const raw = /\{[\s\S]*\}/.exec(text)?.[0]
  let value: unknown
  try {
    value = raw === undefined ? undefined : (JSON.parse(raw) as { category?: unknown }).category
  } catch {
    return undefined
  }
  if (typeof value !== 'string') return undefined
  const v = value
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.。]$/, '')
  if (v === '' || v.length > CATEGORY_MAX_CHARS) return undefined
  // 像一句话（带句号、逗号分句）就不要：品类是个名词
  if (/[,，;；!?！？]/.test(v)) return undefined
  return v
}

/** 落成一格（层 `model` → 把握度 `low`；出处写首页那一条）。 */
export function modelCategoryField(value: string, url: string): BrandIntakeField<string> {
  return field(value, 'model', { url, locator: 'model' })
}
