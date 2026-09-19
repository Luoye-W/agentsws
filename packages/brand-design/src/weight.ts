/**
 * 主次判定：**按面积与所在位置，不只按频次**（71 §5.2）。
 *
 * 这个文件存在的全部理由，是下面这个错误：
 *
 * > 数一数页面上哪个颜色出现得最多，最多的那个就是主色。
 *
 * 按这条规则跑任何一个真实的站，选出来的是**边框灰**。一条 1px 的分隔线在
 * 一页上出现四十次，而铺满整个首屏的那块品牌色只出现一次。频次这个数把
 * "出现" 和 "看得见" 当成了同一件事。
 *
 * 所以一个候选值的分数是三样东西相乘：
 *
 * | 乘数 | 它代表 |
 * |---|---|
 * | 属性权重 | `background-color` 铺面积，`border-color` 只有一条线 |
 * | 结构权重 | 首屏的英雄区 ≫ 页脚；按钮虽小，但它是站方**选来放强调色**的地方 |
 * | 区域权重 | 同一个类出现在 `<footer>` 里和出现在首屏，不是一回事 |
 *
 * 再乘一个**开方之后的出现次数**——次数仍然算数，但不让它线性地压倒前三项。
 */

/** 属性 → 它大概铺多少面积。 */
const PROP_WEIGHT: Record<string, number> = {
  'background-color': 6,
  background: 5,
  'background-image': 3,
  color: 3,
  fill: 2,
  'border-color': 1,
  'border-top-color': 0.6,
  'border-bottom-color': 0.6,
  'border-left-color': 0.6,
  'border-right-color': 0.6,
  border: 1,
  'border-top': 0.6,
  'border-bottom': 0.6,
  outline: 0.5,
  'outline-color': 0.5,
  stroke: 1,
  'box-shadow': 0.3,
  'text-decoration-color': 0.3,
}

export function propWeight(prop: string): number {
  return PROP_WEIGHT[prop] ?? 0
}

/** 属性是不是在说一个颜色。 */
export function isColorProp(prop: string): boolean {
  return prop in PROP_WEIGHT
}

/**
 * 选择器 → 结构权重。
 *
 * `button` 那一行是这张表里唯一需要解释的：按钮很小，面积上排不进前十，但
 * **站方把强调色放在按钮上**——它是整个页面里语义最明确的一处"这是我们的颜色"。
 * 给它 4 不是因为它大，是因为它准。
 */
const STRUCTURE: readonly [RegExp, number][] = [
  [/^(:root|html|body)$/i, 10],
  [/hero|banner|masthead|jumbotron|splash/i, 8],
  [/^(main|section|article)\b/i, 3],
  [/btn|button|\bcta\b/i, 4],
  [/card|panel|tile/i, 3],
  [/header|navbar|\bnav\b/i, 3],
  [/badge|tag|chip|pill|label/i, 2],
  [/footer/i, 1],
  [/\ba\b|link/i, 2],
]

export function structureWeight(selector: string): number {
  for (const [re, w] of STRUCTURE) if (re.test(selector)) return w
  return 2
}

/** 页面上的四个区。 */
export type PageRegion = 'hero' | 'header' | 'main' | 'footer'

const REGION_WEIGHT: Record<PageRegion, number> = {
  hero: 1.5,
  header: 1.2,
  main: 1,
  footer: 0.4,
}

export function regionWeight(region: PageRegion): number {
  return REGION_WEIGHT[region]
}

/** 这个字节位置落在哪个区。 */
export function regionAt(html: string, offset: number): PageRegion {
  const footer = /<footer[\s>]/i.exec(html)?.index
  if (footer !== undefined && offset >= footer) return 'footer'
  const headerEnd = /<\/header>/i.exec(html)?.index
  if (headerEnd !== undefined && offset <= headerEnd) return 'header'
  const bodyStart = /<body[^>]*>/i.exec(html)
  const start = bodyStart === null ? 0 : bodyStart.index + bodyStart[0].length
  const end = html.length
  // 首屏没法真的算出来（那要排版）。按正文的前四分之一估——比不估准，
  // 比假装能算出像素高度诚实。
  return offset - start <= (end - start) / 4 ? 'hero' : 'main'
}

/** 选择器里那个能在 HTML 里找得到的键（最后一个类名 / id / 标签名）。 */
export function selectorKey(
  selector: string,
): { kind: 'class' | 'id' | 'tag'; name: string } | undefined {
  const cleaned = selector.replace(/::?[\w-]+(\([^)]*\))?/g, ' ').trim()
  const classes = [...cleaned.matchAll(/\.([\w-]+)/g)].map((m) => m[1])
  const last = classes.at(-1)
  if (last !== undefined) return { kind: 'class', name: last }
  const id = /#([\w-]+)/.exec(cleaned)?.[1]
  if (id !== undefined) return { kind: 'id', name: id }
  const tag = /(^|\s|>|\+|~)([a-z][\w-]*)\s*$/i.exec(cleaned)?.[2]
  return tag === undefined ? undefined : { kind: 'tag', name: tag.toLowerCase() }
}

export interface SelectorReach {
  /** 页面上有多少个元素挂着它（估算）。 */
  count: number
  region: PageRegion
}

/**
 * 一个选择器在这一页上够得着多少东西。
 *
 * **数的是 HTML 里的字符串，不是 DOM 节点**——我们没有 DOM。数出来会偏（一个
 * 类名出现在 JS 里也会被数进去），但偏得一致，而主次判定要的只是相对大小。
 *
 * 一个都找不到的回 `undefined`：那条规则在这一页上是死的，它的颜色不该参与
 * 这一页的主次判定。这一条挡掉了框架自带的那几千行没用上的工具类。
 */
export function selectorReach(selector: string, html: string): SelectorReach | undefined {
  const key = selectorKey(selector)
  if (key === undefined) return undefined
  const pattern =
    key.kind === 'class'
      ? new RegExp(`class\\s*=\\s*["'][^"']*\\b${escapeRe(key.name)}\\b`, 'gi')
      : key.kind === 'id'
        ? new RegExp(`id\\s*=\\s*["']${escapeRe(key.name)}["']`, 'gi')
        : new RegExp(`<${escapeRe(key.name)}[\\s>]`, 'gi')
  let count = 0
  let first: number | undefined
  for (const m of html.matchAll(pattern)) {
    count++
    first ??= m.index
    if (count >= 200) break
  }
  if (count === 0) return undefined
  return { count, region: regionAt(html, first ?? 0) }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 出现次数怎么进总分：开方，且封顶。 */
export function countFactor(count: number): number {
  return Math.sqrt(Math.min(count, 64))
}

/**
 * 站方给这个 CSS 变量起的名字值多少。
 *
 * 这是整套打分里**唯一一条不是估算的证据**：`--color-brand` 是站方自己写下的
 * 一句"这是我们的品牌色"。所以它是乘数里最大的一个。反过来，名字里带 `gray`
 * 的往下压——不是因为灰不重要，是因为它不该去争"主色"那一格。
 */
export function varNameFactor(name: string): number {
  if (/brand|primary|accent|theme(?!-font)/i.test(name)) return 3
  if (/secondary|highlight/i.test(name)) return 2
  if (/success|error|danger|warning|info/i.test(name)) return 1.2
  if (/gray|grey|neutral|muted|border|divider|placeholder/i.test(name)) return 0.5
  return 1
}
