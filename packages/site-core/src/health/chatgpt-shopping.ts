/**
 * WP381 ①附：「能否进 ChatGPT 购物」——拿店铺后台的商品对照 OpenAI 商品 feed 规范逐字段评估。
 *
 * **只评估，不对接**：不生成、不上传 feed。规范读自 developers.openai.com/commerce/specs/feed
 * （{@link CHATGPT_FEED_SPEC_READ_AT} 那天读的；必填 9 项、做变体与结账时的条件项、几项常用选填）。
 */
import type { ChatGptShoppingAssessment, ChatGptShoppingField } from '@agentsws/contracts'
import type { ProductTruth, StoreTruth } from './product-facts.js'

export const CHATGPT_FEED_SPEC_READ_AT = '2026-10-17'

/** GTIN 校验位（8 / 12 / 13 / 14 位，最后一位按 3-1 加权）。 */
export function validGtin(v: string | undefined): boolean {
  if (v === undefined || !/^(\d{8}|\d{12}|\d{13}|\d{14})$/.test(v)) return false
  const digits = v.split('').map(Number)
  const check = digits.pop() as number
  const sum = digits.reverse().reduce((s, d, i) => s + d * (i % 2 === 0 ? 3 : 1), 0)
  return (10 - (sum % 10)) % 10 === check
}

const plain = (html: string | undefined): string =>
  (html ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
const httpUrl = (u: string | undefined): boolean => u !== undefined && /^https?:\/\//i.test(u)

type Rule = {
  field: string
  requirement: ChatGptShoppingField['requirement']
  ok: (p: ProductTruth, s: StoreTruth) => boolean
  /** 只对一部分商品算（如多规格才看变体字段）。 */
  applies?: (p: ProductTruth) => boolean
  fix: string
}

const RULES: Rule[] = [
  {
    field: 'item_id',
    requirement: 'required',
    ok: (p) => p.variants.length > 0,
    fix: '商品至少要有一个规格',
  },
  {
    field: 'title',
    requirement: 'required',
    ok: (p) => p.title.trim() !== '' && p.title.length <= 150,
    fix: '标题不超过 150 字',
  },
  {
    field: 'description',
    requirement: 'required',
    ok: (p) => {
      const d = plain(p.description)
      return d !== '' && d.length <= 5000
    },
    fix: '补商品描述（纯文字 5000 字内）',
  },
  {
    field: 'url',
    requirement: 'required',
    ok: (p) => httpUrl(p.url),
    fix: '商品要在网店上架、有公开地址',
  },
  {
    field: 'brand',
    requirement: 'required',
    ok: (p) => (p.vendor ?? '').trim() !== '',
    fix: '后台「厂商」填品牌名',
  },
  {
    field: 'seller_name',
    requirement: 'required',
    ok: (_p, s) => (s.name ?? '').trim() !== '',
    fix: '店铺名',
  },
  { field: 'image_url', requirement: 'required', ok: (p) => httpUrl(p.image), fix: '至少一张主图' },
  {
    field: 'availability',
    requirement: 'required',
    ok: (p) => p.variants.some((v) => v.available !== undefined),
    fix: '开库存跟踪或标明有货 / 缺货',
  },
  {
    field: 'price',
    requirement: 'required',
    ok: (p) => p.variants.some((v) => Number(v.price) > 0),
    fix: '价格要大于 0',
  },
  {
    field: 'group_id / variant_dict',
    requirement: 'conditional',
    applies: (p) => p.variants.length > 1,
    ok: (p) => (p.options ?? []).length > 0,
    fix: '多规格要有规格名（颜色 / 尺码）',
  },
  {
    field: 'seller_privacy_policy',
    requirement: 'conditional',
    ok: (_p, s) => httpUrl(s.policy_urls?.privacy),
    fix: '后台补隐私政策页（要开结账时必填）',
  },
  {
    field: 'seller_tos',
    requirement: 'conditional',
    ok: (_p, s) => httpUrl(s.policy_urls?.terms),
    fix: '后台补服务条款页（要开结账时必填）',
  },
  {
    field: 'gtin',
    requirement: 'optional',
    ok: (p) => p.variants.every((v) => validGtin(v.barcode)),
    fix: '条码填有效的 GTIN（没有就留空，别编）',
  },
  {
    field: 'return_policy',
    requirement: 'optional',
    ok: (_p, s) => httpUrl(s.policy_urls?.refund),
    fix: '后台补退货政策页',
  },
  {
    field: 'return_deadline_in_days',
    requirement: 'optional',
    ok: (_p, s) => s.return_days !== undefined,
    fix: '退货政策里写明几天内可退',
  },
  {
    field: 'product_category',
    requirement: 'optional',
    ok: (p) => (p.product_type ?? '').trim() !== '',
    fix: '后台填商品类型',
  },
]

export function assessChatGptShopping(
  products: readonly ProductTruth[],
  store: StoreTruth,
): ChatGptShoppingAssessment {
  const fields: ChatGptShoppingField[] = RULES.map((r) => {
    const pool = products.filter((p) => r.applies?.(p) ?? true)
    const covered = pool.filter((p) => r.ok(p, store)).length
    const total = pool.length
    const state: ChatGptShoppingField['state'] =
      total === 0 || covered === total ? 'ok' : covered === 0 ? 'missing' : 'partial'
    return {
      field: r.field,
      requirement: r.requirement,
      covered,
      total,
      state,
      ...(state === 'ok' ? {} : { fix: r.fix }),
    }
  })
  const required = fields.filter((f) => f.requirement === 'required')
  const verdict: ChatGptShoppingAssessment['verdict'] =
    products.length === 0 || required.some((f) => f.state === 'missing')
      ? 'not_ready'
      : required.some((f) => f.state !== 'ok') ||
          fields.some((f) => f.requirement === 'conditional' && f.state !== 'ok')
        ? 'almost'
        : 'ready'
  return { verdict, fields, spec_read_at: CHATGPT_FEED_SPEC_READ_AT }
}
