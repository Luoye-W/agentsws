/**
 * 从官网抽设计令牌（71 §5）。
 *
 * **与 WP121 是同一次抓取**：页面的 HTML 由调用方（`apps/server`）从那一轮
 * `analyzeSite` 手上原样传进来，这里一个页面都不再去要。唯一额外的请求是
 * 外链样式表——那几份 HTML 里拿不到，而且有上限（{@link DESIGN_MAX_STYLESHEETS}）。
 *
 * 出来的每一格都带着出处：**哪一页、哪条 CSS 变量或哪条规则**。
 * 抽不到的**不出现**，不填一个像模像样的猜测。
 *
 * 算法借鉴（不是代码）见 `./css.ts` 的头注释与 `docs/71` §8。
 */

import { absolute, isType, jsonLdNodes, metaContent } from '@agentsws/brand-intake'
import type {
  BrandDesignLogo,
  BrandDesignProfile,
  BrandDesignSource,
  BrandDesignValue,
  DesignTypography,
} from '@agentsws/contracts'
import {
  colorDistance,
  isNeutral,
  luminance,
  normalizeColor,
  parseColor,
  SAME_COLOR_DISTANCE,
} from './color.js'
import {
  type CssDecl,
  cssVariables,
  inlineStyles,
  parseCss,
  resolveVar,
  type StyleSheet,
} from './css.js'
import {
  countFactor,
  isColorProp,
  propWeight,
  regionWeight,
  selectorReach,
  structureWeight,
  varNameFactor,
} from './weight.js'

/** 一次最多读几份外链样式表。 */
export const DESIGN_MAX_STYLESHEETS = 6

/** 色板最多留几格（再多用户也挑不动，而且规范自检会变成噪声）。 */
export const MAX_PALETTE_TOKENS = 12

/** 抽取看哪几页（71 §5.1）。四种页面各一个就够：再多只是同一套令牌又看一遍。 */
export const DESIGN_PAGE_KINDS = ['home', 'product', 'collection', 'blog'] as const
export type DesignPageKind = (typeof DESIGN_PAGE_KINDS)[number]

/** 调用方递进来的一页（HTML 已经抓好了）。 */
export interface DesignPageInput {
  url: string
  kind: DesignPageKind
  html: string
  /** 这一页外链样式表的内容（调用方抓好的）。没有就只读内联的。 */
  sheets?: readonly StyleSheet[]
}

interface ColorCandidate {
  hex: string
  weight: number
  sources: BrandDesignSource[]
  /** 站方给它起的变量名（有的话）。判语义色用。 */
  varName?: string
  /** 出现过它的选择器（判语义色用）。 */
  selectors: string[]
}

/* ── 入口 ─────────────────────────────────────────────────────────── */

/**
 * 跑一遍。
 *
 * 顺序：先把所有页面的声明摊平成一张表，再一组一组地挑令牌。**不按页分别
 * 挑再合并**——同一个色在四页上各排第三，合起来才排第一，分页挑的话它一次
 * 都进不了色板。
 */
export function extractSiteDesign(pages: readonly DesignPageInput[]): BrandDesignProfile {
  const all: { page: DesignPageInput; decls: CssDecl[] }[] = []
  for (const page of pages) {
    const sheets: StyleSheet[] = [...inlineStyles(page.html, page.url), ...(page.sheets ?? [])]
    const decls = sheets.flatMap((s) => parseCss(s))
    all.push({ page, decls })
  }
  const flat = all.flatMap((x) => x.decls)
  const vars = cssVariables(flat)

  const profile: BrandDesignProfile = {}

  const colors = pickColors(all, vars, pages)
  if (Object.keys(colors).length > 0) profile.colors = colors

  const typography = pickTypography(all, vars)
  if (Object.keys(typography).length > 0) profile.typography = typography

  const spacing = pickScale(all, vars, ['padding', 'margin', 'gap', 'row-gap', 'column-gap'])
  if (Object.keys(spacing).length > 0) profile.spacing = spacing

  const rounded = pickRounded(all, vars)
  if (Object.keys(rounded).length > 0) profile.rounded = rounded

  const shadows = pickShadows(all, vars)
  if (Object.keys(shadows).length > 0) profile.shadows = shadows

  const components = pickComponents(all, vars)
  if (Object.keys(components).length > 0) profile.components = components

  const logos = pickLogos(pages)
  if (logos !== undefined) profile.logos = logos

  const motion = pickMotion(all)
  if (motion !== undefined) profile.motion = motion

  const name = siteName(pages)
  if (name !== undefined) profile.name = name

  return profile
}

/* ── 颜色 ─────────────────────────────────────────────────────────── */

function collectColorCandidates(
  all: readonly { page: DesignPageInput; decls: CssDecl[] }[],
  vars: Map<string, CssDecl>,
  pages: readonly DesignPageInput[],
): ColorCandidate[] {
  const byHex = new Map<string, ColorCandidate>()

  const add = (
    hex: string,
    weight: number,
    source: BrandDesignSource,
    extra: { varName?: string; selector?: string },
  ): void => {
    const existing = byHex.get(hex)
    if (existing === undefined) {
      byHex.set(hex, {
        hex,
        weight,
        sources: [source],
        selectors: extra.selector === undefined ? [] : [extra.selector],
        ...(extra.varName === undefined ? {} : { varName: extra.varName }),
      })
      return
    }
    existing.weight += weight
    // 出处最多留 4 条：给人核对够了，再多是噪声
    if (existing.sources.length < 4) existing.sources.push(source)
    if (extra.selector !== undefined && !existing.selectors.includes(extra.selector))
      existing.selectors.push(extra.selector)
    if (existing.varName === undefined && extra.varName !== undefined)
      existing.varName = extra.varName
  }

  // ① CSS 变量本身：站方声明的语义，最硬的一条证据
  for (const [name, decl] of vars) {
    const hex = normalizeColor(resolveVar(decl.value, vars))
    if (hex === undefined) continue
    add(
      hex,
      12 * varNameFactor(name),
      {
        origin: 'site',
        url: decl.from,
        locator: `css-var:${name}`,
        quote: decl.value,
        weight: 12 * varNameFactor(name),
      },
      { varName: name },
    )
  }

  // ② 规则里用到的颜色：属性 × 结构 × 区域 × √次数
  for (const { page, decls } of all) {
    for (const d of decls) {
      if (!isColorProp(d.prop)) continue
      const resolved = resolveVar(d.value, vars)
      const hex = firstColorIn(resolved)
      if (hex === undefined) continue
      const reach = selectorReach(d.selector, page.html)
      if (reach === undefined) continue
      const varName = /var\(\s*(--[\w-]+)/.exec(d.value)?.[1]
      const w =
        propWeight(d.prop) *
        structureWeight(d.selector) *
        regionWeight(reach.region) *
        countFactor(reach.count) *
        (varName === undefined ? 1 : varNameFactor(varName))
      add(
        hex,
        w,
        {
          origin: 'site',
          url: page.url,
          locator: `css:${d.selector}{${d.prop}}`,
          quote: d.value.slice(0, 120),
          weight: Math.round(w * 10) / 10,
        },
        { selector: d.selector, ...(varName === undefined ? {} : { varName }) },
      )
    }
  }

  // ③ `<meta name="theme-color">`：站方写给浏览器看的那个色
  for (const page of pages) {
    const meta = metaContent(page.html, 'theme-color')
    const hex = meta === undefined ? undefined : normalizeColor(meta)
    if (hex === undefined) continue
    add(
      hex,
      40,
      {
        origin: 'site',
        url: page.url,
        locator: 'meta:theme-color',
        weight: 40,
        ...(meta === undefined ? {} : { quote: meta }),
      },
      {},
    )
  }

  return [...byHex.values()].sort((a, b) => b.weight - a.weight)
}

/** 一串 CSS 值里第一个认得出来的颜色（`1px solid #ccc` 里的 `#ccc`）。 */
function firstColorIn(value: string): string | undefined {
  const direct = normalizeColor(value)
  if (direct !== undefined) return direct
  const hex = /#[0-9a-fA-F]{3,8}\b/.exec(value)?.[0]
  if (hex !== undefined) {
    const n = normalizeColor(hex)
    if (n !== undefined) return n
  }
  const fn = /\b(?:rgba?|hsla?)\([^)]*\)/.exec(value)?.[0]
  return fn === undefined ? undefined : normalizeColor(fn)
}

/**
 * 候选 → 色板。
 *
 * 分两堆（彩色 / 中性）再各自挑，**不是从一张总榜上取前 N 名**。原因：中性色
 * 的面积永远压倒品牌色（页面背景是白的，正文是黑的），混在一起排名的话
 * 前四名会是白、黑、灰、灰，一个品牌色都排不进去。
 */
function pickColors(
  all: readonly { page: DesignPageInput; decls: CssDecl[] }[],
  vars: Map<string, CssDecl>,
  pages: readonly DesignPageInput[],
): Record<string, BrandDesignValue<string>> {
  const candidates = collectColorCandidates(all, vars, pages)
  const out: Record<string, BrandDesignValue<string>> = {}
  if (candidates.length === 0) return out

  const taken: string[] = []
  const put = (token: string, c: ColorCandidate): void => {
    out[token] = {
      value: c.hex,
      confidence: c.varName !== undefined ? 'high' : 'medium',
      source: c.sources,
    }
    taken.push(c.hex)
  }
  const distinct = (c: ColorCandidate): boolean =>
    !taken.some((t) => {
      const a = parseColor(t)
      const b = parseColor(c.hex)
      return a !== undefined && b !== undefined && colorDistance(a, b) < SAME_COLOR_DISTANCE
    })

  const chromatic = candidates.filter((c) => {
    const p = parseColor(c.hex)
    return p !== undefined && p.a > 0.1 && !isNeutral(p)
  })
  const neutrals = candidates.filter((c) => {
    const p = parseColor(c.hex)
    return p !== undefined && p.a > 0.1 && isNeutral(p)
  })

  // 语义色先挑：它们由选择器 / 变量名点名，不靠面积竞争
  const semantic: [string, RegExp][] = [
    ['error', /error|danger|invalid|destructive/i],
    ['success', /success|valid|positive|in-stock/i],
    ['warning', /warning|warn|caution|alert/i],
  ]
  for (const [token, re] of semantic) {
    const hit = chromatic.find(
      (c) => (c.varName !== undefined && re.test(c.varName)) || c.selectors.some((s) => re.test(s)),
    )
    if (hit !== undefined && distinct(hit)) put(token, hit)
  }

  // 主 / 辅 / 第三：按分数，且彼此要分得开
  const roles = ['primary', 'secondary', 'tertiary']
  for (const role of roles) {
    const hit = chromatic.find((c) => distinct(c))
    if (hit === undefined) break
    put(role, hit)
  }

  // 中性：最亮的当 surface，最暗的当 on-surface，分最高的当 neutral
  if (neutrals.length > 0) {
    const top = neutrals[0]
    if (top !== undefined && distinct(top)) put('neutral', top)
    const byLum = [...neutrals].sort((a, b) => lum(b.hex) - lum(a.hex))
    const lightest = byLum[0]
    const darkest = byLum.at(-1)
    if (lightest !== undefined && distinct(lightest)) put('surface', lightest)
    if (darkest !== undefined && distinct(darkest)) put('on-surface', darkest)
  }

  // 还没满就把剩下分高的补进来（`accent-1`…），补到封顶
  let extra = 1
  for (const c of candidates) {
    if (Object.keys(out).length >= MAX_PALETTE_TOKENS) break
    if (!distinct(c)) continue
    put(`accent-${String(extra++)}`, c)
  }
  return inCanonicalOrder(out)
}

/**
 * 按规范推荐的次序排一遍。
 *
 * 只是**排列顺序**，不改一个值。但它决定了色板在界面上与 `DESIGN.md` 里
 * 从左到右的样子——语义色（`success`）先于主色出现，会让人以为绿色才是这个
 * 品牌的主色。挑的顺序由算法定（语义色必须先挑，否则会被主色抢走），
 * 呈现的顺序由这张表定。
 */
const TOKEN_ORDER = [
  'primary',
  'secondary',
  'tertiary',
  'neutral',
  'surface',
  'on-surface',
  'success',
  'warning',
  'error',
]

function inCanonicalOrder(
  colors: Record<string, BrandDesignValue<string>>,
): Record<string, BrandDesignValue<string>> {
  const out: Record<string, BrandDesignValue<string>> = {}
  for (const token of TOKEN_ORDER) {
    const v = colors[token]
    if (v !== undefined) out[token] = v
  }
  for (const [token, v] of Object.entries(colors)) if (!(token in out)) out[token] = v
  return out
}

function lum(hex: string): number {
  const c = parseColor(hex)
  return c === undefined ? 0 : luminance(c)
}

/* ── 排版 ─────────────────────────────────────────────────────────── */

/** 选择器 → 排版令牌名。**先到先得**，一个令牌只认第一条命中的规则。 */
const TYPE_TOKENS: readonly [string, RegExp][] = [
  ['display', /\bhero.*(title|heading)|display/i],
  ['h1', /(^|[\s,>])h1\b/i],
  ['h2', /(^|[\s,>])h2\b/i],
  ['h3', /(^|[\s,>])h3\b/i],
  ['h4', /(^|[\s,>])h4\b/i],
  ['body-lg', /\blead\b|body-l|intro/i],
  ['body-md', /^(body|p|:root|html)$/i],
  ['body-sm', /^small$|caption|meta|fine-print/i],
  ['label-md', /btn|button|\blabel\b|\bchip\b|\bbadge\b/i],
]

function pickTypography(
  all: readonly { page: DesignPageInput; decls: CssDecl[] }[],
  vars: Map<string, CssDecl>,
): Record<string, BrandDesignValue<DesignTypography>> {
  const buckets = new Map<
    string,
    { type: DesignTypography; sources: BrandDesignSource[]; fromVar: boolean }
  >()

  for (const { page, decls } of all) {
    for (const d of decls) {
      const token = TYPE_TOKENS.find(([, re]) => re.test(d.selector))?.[0]
      if (token === undefined) continue
      const value = resolveVar(d.value, vars).trim()
      const bucket = buckets.get(token) ?? { type: {}, sources: [], fromVar: false }
      const before = JSON.stringify(bucket.type)
      switch (d.prop) {
        case 'font-family': {
          const family = primaryFamily(value)
          if (family !== undefined) bucket.type.fontFamily ??= family
          break
        }
        case 'font-size': {
          const size = dimension(value)
          if (size !== undefined) bucket.type.fontSize ??= size
          break
        }
        case 'font-weight': {
          const n = Number(value)
          if (Number.isFinite(n)) bucket.type.fontWeight ??= n
          else if (/bold/i.test(value)) bucket.type.fontWeight ??= 700
          break
        }
        case 'line-height': {
          const n = Number(value)
          const lh = Number.isFinite(n) ? n : dimension(value)
          if (lh !== undefined) bucket.type.lineHeight ??= lh
          break
        }
        case 'letter-spacing': {
          const ls = value === 'normal' ? undefined : dimension(value)
          if (ls !== undefined) bucket.type.letterSpacing ??= ls
          break
        }
        case 'font-feature-settings':
          bucket.type.fontFeature ??= value
          break
        case 'font-variation-settings':
          bucket.type.fontVariation ??= value
          break
        default:
          break
      }
      if (JSON.stringify(bucket.type) === before) continue
      if (d.value.includes('var(')) bucket.fromVar = true
      if (bucket.sources.length < 4)
        bucket.sources.push({
          origin: 'site',
          url: page.url,
          locator: `css:${d.selector}{${d.prop}}`,
          quote: d.value.slice(0, 120),
        })
      buckets.set(token, bucket)
    }
  }

  const out: Record<string, BrandDesignValue<DesignTypography>> = {}
  for (const [token, b] of buckets) {
    // 一格里连字体和字号都没有的，不是一个排版令牌，是噪声
    if (b.type.fontFamily === undefined && b.type.fontSize === undefined) continue
    out[token] = { value: b.type, confidence: b.fromVar ? 'high' : 'medium', source: b.sources }
  }
  return out
}

/** `font-family` 那一串里第一个真正的字体名（去引号、去 fallback）。 */
function primaryFamily(value: string): string | undefined {
  const first = value
    .split(',')[0]
    ?.trim()
    .replace(/^["']|["']$/g, '')
  if (first === undefined || first === '') return undefined
  // `inherit` / `sans-serif` 不是一个品牌字体，是一个兜底
  if (/^(inherit|initial|unset|serif|sans-serif|monospace|cursive|fantasy|system-ui)$/i.test(first))
    return undefined
  return first
}

/** 规范的 Dimension：只认 px / em / rem。别的（`%`、`vw`）原样留着当串。 */
function dimension(value: string): string | undefined {
  const m = /^-?\d*\.?\d+(px|em|rem)$/i.exec(value.trim())
  return m === null ? undefined : value.trim()
}

/* ── 间距 / 圆角 / 阴影 ────────────────────────────────────────────── */

const SCALE_NAMES = ['xs', 'sm', 'md', 'lg', 'xl', '2xl'] as const

/**
 * 间距阶梯。
 *
 * 做法是**数出现次数再按大小排名**，不是"取最小值当基数乘 2 的幂"。后者假设
 * 每个站都有一套严整的 8px 网格；真实的站有一半没有，硬套出来的阶梯里一半的
 * 值在站上一次都没出现过——而那正是我们最不该往 DESIGN.md 里写的东西。
 */
function pickScale(
  all: readonly { page: DesignPageInput; decls: CssDecl[] }[],
  vars: Map<string, CssDecl>,
  props: readonly string[],
): Record<string, BrandDesignValue<string | number>> {
  const counts = new Map<number, { count: number; source: BrandDesignSource }>()
  for (const { page, decls } of all) {
    for (const d of decls) {
      if (!props.includes(d.prop)) continue
      const resolved = resolveVar(d.value, vars)
      for (const piece of resolved.split(/\s+/)) {
        const px = toPx(piece)
        if (px === undefined || px <= 0 || px > 160) continue
        const hit = counts.get(px)
        if (hit === undefined)
          counts.set(px, {
            count: 1,
            source: {
              origin: 'site',
              url: page.url,
              locator: `css:${d.selector}{${d.prop}}`,
              quote: piece,
            },
          })
        else hit.count++
      }
    }
  }
  const top = [...counts.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, SCALE_NAMES.length)
    .sort((a, b) => a[0] - b[0])
  const out: Record<string, BrandDesignValue<string | number>> = {}
  top.forEach(([px, info], i) => {
    const name = SCALE_NAMES[i]
    if (name === undefined) return
    out[name] = { value: `${String(px)}px`, confidence: 'medium', source: [info.source] }
  })
  return out
}

function toPx(value: string): number | undefined {
  const m = /^(-?\d*\.?\d+)(px|rem|em)$/i.exec(value.trim())
  if (m?.[1] === undefined) return undefined
  const n = Number(m[1])
  if (!Number.isFinite(n)) return undefined
  // rem / em 按 16px 折算。站可能改过根字号，但折算错 1–2px 不影响阶梯的形状
  return m[2]?.toLowerCase() === 'px' ? n : n * 16
}

function pickRounded(
  all: readonly { page: DesignPageInput; decls: CssDecl[] }[],
  vars: Map<string, CssDecl>,
): Record<string, BrandDesignValue<string>> {
  const counts = new Map<string, { px: number; count: number; source: BrandDesignSource }>()
  for (const { page, decls } of all) {
    for (const d of decls) {
      if (!/^border(-\w+)?-radius$/.test(d.prop)) continue
      const raw = resolveVar(d.value, vars).trim().split(/\s+/)[0]
      if (raw === undefined || raw === '0' || raw === '0px') continue
      const px = /^(9999|999)px$|^50%$/.test(raw) ? Number.POSITIVE_INFINITY : toPx(raw)
      if (px === undefined) continue
      const key = raw
      const hit = counts.get(key)
      if (hit === undefined)
        counts.set(key, {
          px,
          count: 1,
          source: {
            origin: 'site',
            url: page.url,
            locator: `css:${d.selector}{${d.prop}}`,
            quote: raw,
          },
        })
      else hit.count++
    }
  }
  const out: Record<string, BrandDesignValue<string>> = {}
  const entries = [...counts.entries()]
  const full = entries.find(([, v]) => v.px === Number.POSITIVE_INFINITY)
  if (full !== undefined)
    out.full = { value: '9999px', confidence: 'medium', source: [full[1].source] }
  const finite = entries
    .filter(([, v]) => Number.isFinite(v.px))
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 3)
    .sort((a, b) => a[1].px - b[1].px)
  const names = ['sm', 'md', 'lg']
  finite.forEach(([raw, info], i) => {
    const name = names[i]
    if (name === undefined) return
    out[name] = { value: raw, confidence: 'medium', source: [info.source] }
  })
  return out
}

function pickShadows(
  all: readonly { page: DesignPageInput; decls: CssDecl[] }[],
  vars: Map<string, CssDecl>,
): Record<string, BrandDesignValue<string>> {
  const counts = new Map<string, { count: number; source: BrandDesignSource }>()
  for (const { page, decls } of all) {
    for (const d of decls) {
      if (d.prop !== 'box-shadow') continue
      const value = resolveVar(d.value, vars).trim()
      if (value === '' || /^none$/i.test(value)) continue
      const hit = counts.get(value)
      if (hit === undefined)
        counts.set(value, {
          count: 1,
          source: {
            origin: 'site',
            url: page.url,
            locator: `css:${d.selector}{box-shadow}`,
            quote: value.slice(0, 120),
          },
        })
      else hit.count++
    }
  }
  const top = [...counts.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 3)
  const out: Record<string, BrandDesignValue<string>> = {}
  const names = ['sm', 'md', 'lg']
  top.forEach(([value, info], i) => {
    const name = names[i]
    if (name === undefined) return
    out[name] = { value, confidence: 'medium', source: [info.source] }
  })
  return out
}

/* ── 组件 ─────────────────────────────────────────────────────────── */

const COMPONENT_MATCH: readonly [string, RegExp][] = [
  ['button-primary', /(^|[.\s])(btn|button)([-_]?(primary|main|cta))?$/i],
  ['input', /(^|[.\s])(input|form-control|field)$/i],
  ['card', /(^|[.\s])(card|tile|panel)$/i],
  ['nav', /(^|[.\s])(nav|navbar|site-header)$/i],
  ['badge', /(^|[.\s])(badge|tag|chip|pill)$/i],
]

const PROP_TO_TOKEN: Record<string, string> = {
  'background-color': 'backgroundColor',
  color: 'textColor',
  'border-radius': 'rounded',
  padding: 'padding',
  height: 'height',
  width: 'width',
}

function pickComponents(
  all: readonly { page: DesignPageInput; decls: CssDecl[] }[],
  vars: Map<string, CssDecl>,
): Record<string, Record<string, BrandDesignValue<string>>> {
  const out: Record<string, Record<string, BrandDesignValue<string>>> = {}
  for (const { page, decls } of all) {
    for (const d of decls) {
      const component = COMPONENT_MATCH.find(([, re]) => re.test(d.selector))?.[0]
      if (component === undefined) continue
      const token = PROP_TO_TOKEN[d.prop]
      if (token === undefined) continue
      const value = resolveVar(d.value, vars).trim()
      const normalized =
        token === 'backgroundColor' || token === 'textColor' ? firstColorIn(value) : value
      if (normalized === undefined || normalized === '') continue
      const bucket = (out[component] ??= {})
      bucket[token] ??= {
        value: normalized,
        confidence: 'medium',
        source: [
          {
            origin: 'site',
            url: page.url,
            locator: `css:${d.selector}{${d.prop}}`,
            quote: d.value.slice(0, 120),
          },
        ],
      }
    }
  }
  return out
}

/* ── logo / 动效 / 名字 ────────────────────────────────────────────── */

/**
 * logo。
 *
 * **只存 logo**：别人站上的别的图片我们一张都不转存（71 §6 的边界）。
 * 深浅版按类名 / 文件名认（`logo-dark`、`logo--white`、`logo-inverse`）——
 * 认不出来的一律算 `light`，因为绝大多数站的默认 logo 是给浅底用的。
 */
function pickLogos(
  pages: readonly DesignPageInput[],
): BrandDesignValue<BrandDesignLogo[]> | undefined {
  const found = new Map<string, BrandDesignLogo>()
  const sources: BrandDesignSource[] = []

  for (const page of pages) {
    for (const node of jsonLdNodes(page.html)) {
      if (!isType(node, /organization|brand/i)) continue
      const logo = typeof node.logo === 'string' ? node.logo : undefined
      const url = logo === undefined ? undefined : absolute(logo, page.url)
      if (url === undefined || found.has(url)) continue
      found.set(url, { url, variant: 'light' })
      sources.push({ origin: 'site', url: page.url, locator: 'jsonld:Organization.logo' })
    }
    for (const m of page.html.matchAll(/<img[^>]*>/gi)) {
      const tag = m[0]
      if (!/logo/i.test(tag)) continue
      const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]
      const url = src === undefined ? undefined : absolute(src, page.url)
      if (url === undefined || found.has(url)) continue
      const variant: BrandDesignLogo['variant'] = /dark|white|inverse|light-?on/i.test(tag)
        ? 'dark'
        : /mono|mark|icon|symbol/i.test(tag)
          ? 'mark'
          : 'light'
      found.set(url, { url, variant })
      if (sources.length < 4)
        sources.push({
          origin: 'site',
          url: page.url,
          locator: 'selector:img[class*=logo]',
          quote: tag.slice(0, 120),
        })
      if (found.size >= 4) break
    }
  }

  if (found.size === 0) return undefined
  return { value: [...found.values()], confidence: 'medium', source: sources }
}

/** 动效倾向。抽不到就没有——"这个站没有动效"与"我们没读到"不是一回事。 */
function pickMotion(
  all: readonly { page: DesignPageInput; decls: CssDecl[] }[],
): BrandDesignValue<string> | undefined {
  const durations: number[] = []
  const easings = new Set<string>()
  let source: BrandDesignSource | undefined
  for (const { page, decls } of all) {
    for (const d of decls) {
      if (
        !/^(transition|transition-duration|animation|animation-duration|transition-timing-function)$/.test(
          d.prop,
        )
      )
        continue
      for (const ms of d.value.matchAll(/(\d*\.?\d+)(ms|s)\b/g)) {
        const n = Number(ms[1])
        if (!Number.isFinite(n)) continue
        durations.push(ms[2] === 's' ? n * 1000 : n)
      }
      const ease = /\b(ease-in-out|ease-in|ease-out|ease|linear|cubic-bezier\([^)]*\))/.exec(
        d.value,
      )?.[1]
      if (ease !== undefined) easings.add(ease)
      source ??= {
        origin: 'site',
        url: page.url,
        locator: `css:${d.selector}{${d.prop}}`,
        quote: d.value.slice(0, 120),
      }
    }
  }
  if (durations.length === 0 || source === undefined) return undefined
  const sorted = [...durations].sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0
  const pace = median <= 150 ? '干脆（多数过渡在 150ms 以内）' : median <= 300 ? '适中' : '舒缓'
  const easeText = easings.size === 0 ? '' : `，缓动多用 ${[...easings].slice(0, 3).join(' / ')}`
  return {
    value: `过渡节奏${pace}，中位时长约 ${String(Math.round(median))}ms${easeText}。`,
    confidence: 'medium',
    source: [source],
  }
}

function siteName(pages: readonly DesignPageInput[]): BrandDesignValue<string> | undefined {
  for (const page of pages) {
    const name = metaContent(page.html, 'og:site_name')
    if (name === undefined || name.trim() === '') continue
    return {
      value: name.trim(),
      confidence: 'high',
      source: [{ origin: 'site', url: page.url, locator: 'og:site_name', quote: name }],
    }
  }
  return undefined
}
