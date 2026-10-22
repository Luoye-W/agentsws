/**
 * WP449（docs/109 §5.1 #8）：**竞品对比页**——「X vs Y」「X 的替代品」。
 *
 * 写法在技能里（`seo-judgment` 的「对比页」一节）；这里放规则能判的两条，发布前质检用：
 *
 * - `comparison_disparaging`：提到竞品的那句里有贬低的词（骗、垃圾、智商税、scam、junk、Abzocke……）→ 挡；
 * - `comparison_unsourced`：在**比**竞品（没有、不支持、更贵、只、比……）却指不回事实卡、也没链到公开可核的页面 → 挡。
 *   链了外链的交给引用核查去查那一页。
 *
 * 竞品名单来自品牌档案（`competitors`）；名单是空的就不查。另给 SEO 与 GEO 认「这个查询是不是对比类」
 * （{@link isComparisonQuery}），选题批了写这一页时把对比页的规矩带过去（{@link COMPARISON_BRIEF}）。
 *
 * 方法借鉴 AgriciDaniel/claude-seo（MIT）的 seo-competitor-pages（对比项要公开可核、不诽谤、承认对方长处、
 * 价格写「截至某日」）；**代码一行没搬**。
 */
import type { ContentQualityIssue } from '@agentsws/contracts'
import { extractFigures } from '@agentsws/core'
import type { ContentSentence } from './content-text.js'

const DISPARAGING = [
  /\b(scam|scams|rip-?off|junk|garbage|trash|crap|useless|worthless|knock-?off|fake|terrible|awful|inferior)\b/i,
  /\b(betrug|abzocke|schrott|müll|minderwertig|nutzlos|billigware)\b/i,
  /\b(arnaque|camelote|nul)\b/i,
  /\b(estafa|basura|timo)\b/i,
  /(垃圾|骗子|骗钱|智商税|山寨|劣质|坑人|割韭菜|假货)/,
]

const COMPARES = [
  /\b(doesn'?t|does not|don'?t|do not|can'?t|cannot|lacks?|without|only|worse|slower|weaker|heavier|bulkier|cheaper|pricier|more expensive|less|fewer|than|unlike)\b/i,
  /\b(nicht|kein\w*|ohne|nur|schlechter|langsamer|schwerer|teurer|billiger|weniger|als)\b/i,
  /\b(ne\s+\w+\s+pas|sans|seulement|moins|plus cher|que)\b/i,
  /(没有|不支持|不能|不带|只有|只能|更贵|更重|更慢|更便宜|不如|比)/,
]

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** 这句提到了哪个竞品（整词、不分大小写；两个字以下的名字不认，免得误伤）。 */
export function competitorIn(sentence: string, names: readonly string[]): string | undefined {
  for (const n of names) {
    const name = n.trim()
    if (name.length < 2) continue
    const re = /[㐀-鿿]/.test(name)
      ? new RegExp(escapeRe(name), 'i')
      : new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(name)}($|[^\\p{L}\\p{N}])`, 'iu')
    if (re.test(sentence)) return name
  }
  return undefined
}

/**
 * 对比句的两条检查。`known(figure)` 回这个数在不在事实卡里（与质检同一个比法）；
 * `flagged` 是已经被别的规则报过的句子（同一句不重复报）。
 */
export function comparisonIssues(input: {
  sentences: readonly ContentSentence[]
  competitors: readonly string[]
  known: (figure: string) => boolean
  /** 事实卡原文（看有没有一张卡在讲这个竞品）。 */
  facts?: readonly { statement: string }[]
  flagged?: ReadonlySet<string>
}): ContentQualityIssue[] {
  if (input.competitors.length === 0) return []
  const out: ContentQualityIssue[] = []
  for (const s of input.sentences) {
    const rival = competitorIn(s.text, input.competitors)
    if (rival === undefined) continue
    const bad = DISPARAGING.map((re) => re.exec(s.text)).find((m) => m !== null)
    if (bad != null) {
      out.push({
        rule: 'comparison_disparaging',
        sentence: s.text,
        detail: `比 ${rival} 时用了贬低的词「${bad[0]}」：只摆事实，承认对方的长处。`,
      })
      continue
    }
    if (input.flagged?.has(s.text) === true) continue
    if (s.links.some((l) => /^https?:\/\//i.test(l))) continue // 链了出处：引用核查去查
    const figures = extractFigures(s.text)
    const unknown = figures.some((f) => !input.known(f))
    // 只是顺带提到竞品、数都是我们自己卡上的（「我们 10,000 mAh，VoltMax 也不错」）不算在比
    if (!unknown && !COMPARES.some((re) => re.test(s.text))) continue
    // 指得回事实卡：有一张卡在讲这个竞品，而且这句里的数都在卡上
    const aboutRival = (input.facts ?? []).some(
      (f) => competitorIn(f.statement, [rival]) !== undefined,
    )
    if (aboutRival && !unknown) continue
    out.push({
      rule: 'comparison_unsourced',
      sentence: s.text,
      detail: `这句在比 ${rival}：要指得回事实卡，或者链到公开可核的页面（对方官网、说明书），写上「截至某日」。`,
    })
  }
  return out
}

/** 是不是对比类的查询（「X vs Y」「X alternative」「X 和 Y 哪个好」「X 替代」）。 */
export function isComparisonQuery(query: string): boolean {
  const q = query.toLowerCase()
  return (
    /\b(vs\.?|versus|alternatives?|compared? to|comparison)\b/.test(q) ||
    /\b(alternative|vergleich|gegen|statt)\b/.test(q) ||
    /(对比|比较|哪个好|还是|替代|平替|代替)/.test(query)
  )
}

/** 选题批了、写这一页时带过去的那几条（对比页的规矩，短）。 */
export const COMPARISON_BRIEF = [
  '这是一页对比：对比项只写指得回事实卡、或对方官网 / 说明书上公开可核的（链过去，写「截至某日」）。',
  '不贬低、不用绝对化词，承认对方的长处；写清这一页是我们自己写的。',
  '结构化数据只标我们自己的商品，别给对方的商品标评分。',
] as const
