/**
 * WP452（docs/109 §5.2 #15）：**广告与落地页说法一致性**——广告里说的价格、优惠、包邮、卖点，落地页上有没有、
 * 对不对得上。规则判，不经模型手。
 *
 * 落地页抓两份（复用 WP381 网站体检那一口）：不开 JS 的原始 HTML，与开 JS 渲染后的那份。调用方把两份都换成
 * 「读得到的文字」再给这里（`@agentsws/site-core` 的 `crawlerReadableText`），这个包不碰 HTML。
 *
 * 结论五种：对得上（ok）、页上写的是另一个数（mismatch）、只有开 JS 才看得到（js_only）、页上没写（missing）、
 * 页抓不到（unknown）。谁来改：页上写着另一个价 / 另一个折扣 → 改广告（页上的价跟着店铺后台走）；
 * 页上没写、只靠 JS 才出来 → 改页面（网站运营）。这条分法可以在调用时换（`fixFor`）。
 *
 * 方法借鉴 AgriciDaniel/claude-ads（MIT）`skills/ads-landing`：先记下广告承诺了什么，再看页上接不接得住
 * （message & offer continuity），抓不到的照实说（THIRD-PARTY-NOTICES）。
 *
 * 纯函数：无 IO。
 */
import type { AdClaim, AdClaimKind, LandingCheckItem, LandingFix } from '@agentsws/contracts'

const squash = (s: string): string => s.replace(/\s+/g, ' ').trim()

/** 金额：`$29.99`、`29.99 USD`、`€29`、`¥199`、`US$29`。回规整后的 `29.99`（整数补 `.00`）。 */
const MONEY =
  /(?:US\$|C\$|A\$|[$€£¥])\s?(\d{1,6}(?:[.,]\d{3})*(?:[.,]\d{1,2})?)|(\d{1,6}(?:[.,]\d{1,2})?)\s?(?:USD|EUR|GBP|CAD|AUD|元)/giu

function normMoney(raw: string): string | undefined {
  let t = raw.trim()
  // 1,299.00 / 1.299,00 → 1299.00
  if (/^\d{1,3}([.,]\d{3})+([.,]\d{1,2})?$/u.test(t)) {
    const dec = /[.,](\d{1,2})$/u.exec(t)
    const int = (dec === null ? t : t.slice(0, -dec[0].length)).replace(/[.,]/gu, '')
    t = dec === null ? int : `${int}.${dec[1]}`
  } else t = t.replace(',', '.')
  const n = Number(t)
  return Number.isFinite(n) && n > 0 ? n.toFixed(2) : undefined
}

/** 一段文字里的全部金额（规整后去重）。 */
export function moneyIn(text: string): string[] {
  const out = new Set<string>()
  for (const m of text.matchAll(MONEY)) {
    const v = normMoney(m[1] ?? m[2] ?? '')
    if (v !== undefined) out.add(v)
  }
  return [...out]
}

/** 折扣：`20% off`、`save 20%`、`-20%`、`8 折`、`减 20%`。回 `20%`（8 折记成 `20%`）。 */
export function discountsIn(text: string): string[] {
  const out = new Set<string>()
  for (const m of text.matchAll(/(\d{1,2})\s?%\s?(?:off|discount|折扣|优惠)/giu))
    out.add(`${m[1]}%`)
  for (const m of text.matchAll(/(?:save|up to|减|立减|省)\s?(\d{1,2})\s?%/giu)) out.add(`${m[1]}%`)
  for (const m of text.matchAll(/(?<![\d.])-(\d{1,2})\s?%/gu)) out.add(`${m[1]}%`)
  for (const m of text.matchAll(/(\d(?:\.\d)?)\s?折/gu)) {
    const n = Number(m[1])
    if (n > 0 && n < 10) out.add(`${Math.round(100 - n * 10)}%`)
  }
  return [...out]
}

const FREE_SHIPPING = /free\s+(?:shipping|delivery)|ships?\s+free|包邮|免运费/iu

/** 包邮那一句在不在。 */
export function mentionsFreeShipping(text: string): boolean {
  return FREE_SHIPPING.test(text)
}

/**
 * 广告文案 → 要核对的说法。价格 / 折扣 / 包邮按规则抽；卖点由调用方给（模型从文案里挑出来的短句，
 * 只做「页上有没有」的比对，不让模型判对不对）。
 */
export function extractAdClaims(input: {
  texts: readonly string[]
  selling_points?: readonly string[]
}): AdClaim[] {
  const all = squash(input.texts.join(' · '))
  const claims: AdClaim[] = []
  // 「满 $50 包邮」「orders over $50」里的金额是门槛，不是价格
  const thresholds = new Set(
    [
      ...all.matchAll(/(?:over|above|满|超过|orders? over)\s?((?:US\$|[$€£¥])?\s?\d[\d.,]*)/giu),
    ].flatMap((m) => moneyIn(/[$€£¥]/u.test(m[1] ?? '') ? (m[1] ?? '') : `$${m[1] ?? ''}`)),
  )
  for (const v of moneyIn(all))
    if (!thresholds.has(v)) claims.push({ kind: 'price', text: v, value: v })
  for (const v of discountsIn(all)) claims.push({ kind: 'discount', text: v, value: v })
  const fs = FREE_SHIPPING.exec(all)
  if (fs !== null) claims.push({ kind: 'free_shipping', text: fs[0], value: 'free_shipping' })
  for (const p of input.selling_points ?? []) {
    const t = squash(p)
    if (t.length >= 4) claims.push({ kind: 'selling_point', text: t, value: t })
  }
  return claims
}

const words = (s: string): string[] =>
  s
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 3 || /\p{Script=Han}/u.test(w))

/** 卖点在不在：短句里的实词有八成以上出现在页上（中文按字串整句找）。 */
function sellingPointIn(readable: string, point: string): boolean {
  const lower = readable.toLowerCase()
  if (lower.includes(point.toLowerCase())) return true
  const ws = words(point)
  if (ws.length === 0) return false
  const hit = ws.filter((w) => lower.includes(w)).length
  return hit / ws.length >= 0.8
}

function present(readable: string, c: AdClaim): boolean {
  switch (c.kind) {
    case 'price':
      return moneyIn(readable).includes(c.value)
    case 'discount':
      return discountsIn(readable).includes(c.value)
    case 'free_shipping':
      return mentionsFreeShipping(readable)
    case 'selling_point':
      return sellingPointIn(readable, c.value)
  }
}

const valuesOf = (readable: string, kind: AdClaimKind): string[] =>
  kind === 'price' ? moneyIn(readable) : kind === 'discount' ? discountsIn(readable) : []

const KIND_ZH: Record<AdClaimKind, string> = {
  price: '价格',
  discount: '折扣',
  free_shipping: '包邮',
  selling_point: '卖点',
}

/** 默认的「谁来改」：页上写着另一个数 → 改广告；页上没写 / 只靠 JS → 改页面。 */
export function defaultLandingFix(verdict: LandingCheckItem['verdict']): LandingFix | undefined {
  return verdict === 'mismatch'
    ? 'ad'
    : verdict === 'missing' || verdict === 'js_only'
      ? 'page'
      : undefined
}

/** 逐条核对。`raw` 抓不到给 `undefined`（整张「未知」）；`rendered` 没渲染成就不给。 */
export function checkLanding(input: {
  claims: readonly AdClaim[]
  raw?: string
  rendered?: string
  fixFor?: (item: Omit<LandingCheckItem, 'fix'>) => LandingFix | undefined
}): LandingCheckItem[] {
  return input.claims.map((claim) => {
    const label = `${KIND_ZH[claim.kind]}「${claim.text}」`
    if (input.raw === undefined)
      return {
        claim,
        raw: 'unknown',
        rendered: 'not_checked',
        verdict: 'unknown',
        note: `落地页没抓到：${label}没法核。`,
      }
    const rawHas = present(input.raw, claim)
    const rendHas = input.rendered === undefined ? undefined : present(input.rendered, claim)
    const pageValues = [
      ...new Set([
        ...valuesOf(input.raw, claim.kind),
        ...(input.rendered === undefined ? [] : valuesOf(input.rendered, claim.kind)),
      ]),
    ]
    let verdict: LandingCheckItem['verdict']
    let note: string
    if (rawHas) {
      verdict = 'ok'
      note = `${label}页上写着。`
    } else if (rendHas === true) {
      verdict = 'js_only'
      note = `${label}只有开 JS 才看得到：不跑 JS 的爬虫和慢网络下的人看不到，写进页面本身。`
    } else if (pageValues.length > 0) {
      verdict = 'mismatch'
      note = `广告说${label}，页上写的是 ${pageValues.slice(0, 3).join(' / ')}。`
    } else {
      verdict = 'missing'
      note = `广告说${label}，页上没写：点进来的人找不到，也可能违反平台「落地页要兑现广告」的要求。`
    }
    const base = {
      claim,
      raw: rawHas ? ('present' as const) : ('absent' as const),
      rendered:
        rendHas === undefined
          ? ('not_checked' as const)
          : rendHas
            ? ('present' as const)
            : ('absent' as const),
      verdict,
      ...(pageValues.length > 0 && verdict !== 'ok' ? { page_values: pageValues.slice(0, 5) } : {}),
      note,
    }
    const fix = (input.fixFor ?? ((i) => defaultLandingFix(i.verdict)))(base)
    return fix === undefined ? base : { ...base, fix }
  })
}

/** 交出去那一段话（开事项用；一条一行）。 */
export function landingHandoffText(
  ad_label: string,
  url: string,
  items: readonly LandingCheckItem[],
): string {
  return [`广告「${ad_label}」点进来的落地页 ${url}：`, ...items.map((i) => `- ${i.note}`)].join(
    '\n',
  )
}
