/**
 * 把 CSS 拆成「哪个选择器、哪个属性、什么值」（71 §5）。
 *
 * **没有无头浏览器，所以也没有真正的"计算后样式"。** 那几个开源实现（dembrandt、
 * design-extract、design-md-extractor）共同的做法是开一个 Puppeteer / Playwright、
 * 对每个元素调 `getComputedStyle`。我们不这么做，两个理由：
 *
 * 1. 每个都自带一套浏览器运行时（几百兆），而桌面壳里已经有一个工作浏览器；
 * 2. 公司端**明令禁止**让 AI 在网页里跑脚本（`BROWSER_SCRIPT_TOOLS` 那道闸），
 *    而 `getComputedStyle` 只能靠跑脚本拿。一个只在个人端能用的抽取器，等于
 *    公司端的用户永远抓不出设计规范。
 *
 * 所以这一层读的是**声明后样式**：内联 `<style>`、外链样式表、元素上的
 * `style=""`。拿不到的（JS 运行时才算出来的、媒体查询里按视口挑的）**如实缺席**。
 *
 * 换来的东西不只是省依赖：CSS 变量的**名字**在计算后样式里是看不见的
 * （`getComputedStyle` 给你 `rgb(26,28,30)`，不给你 `--color-ink`）。而站方
 * 自己给这个色起的名字，是判它是不是品牌色最硬的一条证据。
 *
 * 借鉴（算法，不是代码）：
 * - `dembrandt/dembrandt`（MIT）——令牌分组与 W3C DTCG 的出口形状；
 * - `Manavarya09/design-extract`（MIT）——primitive / semantic / composite 三层；
 * - `sunil-dsb/design.md`（MIT）——每个值带出处（页面 + CSS 变量名 + 所在区域）；
 * - `jpoindexter/design-md-extractor`（MIT）——渐变 / 阴影 / 动效也要抽。
 */

/** 一条声明。`order` 是它在整份 CSS 里的次序（后面的覆盖前面的）。 */
export interface CssDecl {
  selector: string
  prop: string
  value: string
  order: number
  /** 这条是从哪个样式表来的（出处用）。内联的记页面地址。 */
  from: string
  /** 外面套着的 at-rule（`@media (min-width: 768px)`）。没套就没有。 */
  at?: string
}

/** 一份样式表。 */
export interface StyleSheet {
  /** 样式表地址；内联的记它所在的页面地址。 */
  url: string
  css: string
}

/** 去注释。**先去再解析**：注释里写 `{}` 是常事，不去会把花括号配对搞乱。 */
export function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, ' ')
}

/**
 * 解析。**不是一个合规的 CSS 解析器**，是一个够用的花括号配对器。
 *
 * 认得：普通规则、一层 at-rule 嵌套（`@media` / `@supports` 里面的规则）。
 * 不认得：嵌套语法（CSS Nesting）、`@import` 里的媒体条件。不认得的那些
 * **跳过**，不猜。
 */
export function parseCss(sheet: StyleSheet): CssDecl[] {
  const css = stripComments(sheet.css)
  const out: CssDecl[] = []
  let order = 0

  const walk = (text: string, at: string | undefined): void => {
    let i = 0
    while (i < text.length) {
      const open = text.indexOf('{', i)
      if (open < 0) break
      const prelude = text.slice(i, open).trim()
      const close = matchBrace(text, open)
      if (close < 0) break
      const inner = text.slice(open + 1, close)

      if (prelude.startsWith('@')) {
        // 带块的 at-rule：@media / @supports 里面还是规则，递归；
        // @keyframes / @font-face 里面不是规则，单独收（字体名要用）。
        if (/^@(media|supports|layer|container)/i.test(prelude)) {
          walk(inner, at === undefined ? prelude : `${at} ${prelude}`)
        } else if (/^@font-face/i.test(prelude)) {
          for (const d of declarations(inner)) {
            out.push({
              selector: '@font-face',
              ...d,
              order: order++,
              from: sheet.url,
              ...(at === undefined ? {} : { at }),
            })
          }
        }
      } else {
        const decls = declarations(inner)
        for (const selector of prelude.split(',').map((s) => s.trim())) {
          if (selector === '') continue
          for (const d of decls) {
            out.push({
              selector,
              ...d,
              order: order++,
              from: sheet.url,
              ...(at === undefined ? {} : { at }),
            })
          }
        }
      }
      i = close + 1
    }
  }

  walk(css, undefined)
  return out
}

/** 配对花括号（考虑嵌套）。配不上回 -1。 */
function matchBrace(text: string, open: number): number {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    const ch = text[i]
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

/** 一个块里的 `prop: value` 们（跳过嵌套块）。 */
function declarations(block: string): { prop: string; value: string }[] {
  const flat = block.replace(/\{[^{}]*\}/g, ' ')
  const out: { prop: string; value: string }[] = []
  for (const piece of flat.split(';')) {
    const colon = piece.indexOf(':')
    if (colon < 0) continue
    const prop = piece.slice(0, colon).trim().toLowerCase()
    const value = piece
      .slice(colon + 1)
      .trim()
      .replace(/\s*!important$/i, '')
    if (prop === '' || value === '') continue
    if (/[{}]/.test(prop)) continue
    out.push({ prop, value })
  }
  return out
}

/** 页面里的内联 `<style>` 块。 */
export function inlineStyles(html: string, pageUrl: string): StyleSheet[] {
  const out: StyleSheet[] = []
  for (const m of html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) {
    const css = m[1]
    if (css !== undefined && css.trim() !== '') out.push({ url: pageUrl, css })
  }
  return out
}

/** 页面里外链样式表的地址（相对的已经补成绝对，补不成的丢掉）。 */
export function stylesheetHrefs(html: string, pageUrl: string): string[] {
  const out: string[] = []
  for (const m of html.matchAll(/<link[^>]*>/gi)) {
    const tag = m[0]
    const rel = /rel\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1]
    if (rel === undefined || !/stylesheet/i.test(rel)) continue
    const href = /href\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1]
    if (href === undefined) continue
    try {
      const u = new URL(href, pageUrl)
      if (u.protocol !== 'http:' && u.protocol !== 'https:') continue
      const s = u.toString()
      if (!out.includes(s)) out.push(s)
    } catch {
      // 补不成绝对地址就丢掉。一个补错的地址会把我们引到别人的站上去。
    }
  }
  return out
}

/**
 * CSS 变量表（`--name` → 值）。
 *
 * **变量名是证据。** 站方把一个色起名叫 `--color-brand` 或 `--primary`，
 * 这句话比"这个色在页面上出现了 37 次"硬得多——它是站方自己声明的语义，
 * 和 JSON-LD 是同一类东西。
 */
export function cssVariables(decls: readonly CssDecl[]): Map<string, CssDecl> {
  const out = new Map<string, CssDecl>()
  for (const d of decls) {
    if (!d.prop.startsWith('--')) continue
    // 后面的覆盖前面的（同名变量在 :root 与主题类里各一份是常见写法）
    out.set(d.prop, d)
  }
  return out
}

/** 一个值里 `var(--x, fallback)` 的解引用。绕圈就停，解不开就原样留着。 */
export function resolveVar(value: string, vars: Map<string, CssDecl>, depth = 0): string {
  if (depth > 6 || !value.includes('var(')) return value
  const replaced = value.replace(
    /var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*))?\)/g,
    (whole, name: string, fallback?: string) => {
      const hit = vars.get(name)
      if (hit !== undefined) return hit.value
      return fallback === undefined ? whole : fallback.trim()
    },
  )
  return replaced === value ? value : resolveVar(replaced, vars, depth + 1)
}
