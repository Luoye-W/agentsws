/**
 * Shopify 主题设置 → 令牌（WP122b 交付 ⑥，71 §9 第 2 条，`BrandDesignOrigin` 的
 * `'theme'` 档）。
 *
 * 店主在 Shopify 后台挑的主色与字体**就是**他的品牌规范在店上的那一层——
 * 比我们从 CSS 里量出来的更"是规范"，所以来路标 `theme`（优先级排在 site
 * 之上、上传手册之下；`merge.ts` 的 `PRIORITY` 表里已留好位）。
 *
 * 读的是主题的 `config/settings_data.json`（经 `shopify_admin.get_theme_asset`）。
 * 各主题的设置键没有硬性标准，这里认两类：
 *
 * - **配色**：Dawn 11+ 的 `color_schemes`（scheme-1…N，各带 `background` /
 *   `text` / `button`…），退回平铺的键名含 `color` 的 HEX 值；
 * - **字体**：`type_header_font` / `type_base_font`（font handle，如
 *   `assistant_n4`），handle 的类型后缀剥掉再还原成可读的名字。
 *
 * 只认拿得准的键，认不出的忽略——宁缺毋编（71 §3 第 3 条对每个来路都成立）。
 */
import type { BrandDesignProfile, BrandDesignSource } from '@agentsws/contracts'
import { isNeutral, normalizeColor, parseColor } from './color.js'

export interface ThemeDesignResult {
  profile: BrandDesignProfile
  /** 哪几格是主题设置贡献的（字段路径，进 `BrandDesignFileIntake.contributed` 的同款）。 */
  contributed: string[]
}

const HEXISH = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i

const themeSource = (key: string): BrandDesignSource => ({
  origin: 'theme',
  locator: `theme:${key}`,
})

/** Shopify font handle → 字体名：`assistant_n4` → `Assistant`，`open_sans_n7` → `Open Sans`。 */
export function fontHandleToName(handle: string): string {
  const base = handle.replace(/_[hn]\d+$/i, '').trim()
  if (base === '') return ''
  return base
    .split(/[_\s-]+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** 拆 Dawn 的一个配色方案：background / text / button… → surface / on-surface / primary…。 */
function schemeTokens(scheme: Record<string, unknown>): Record<string, string> {
  const settings = isRecord(scheme.settings) ? scheme.settings : scheme
  const out: Record<string, string> = {}
  const MAPPING: [RegExp, string][] = [
    [/^background(_solid|_gradient_)?[0-9]*$/i, 'surface'],
    [/^text(_[0-9]+)?$/i, 'on-surface'],
    [/^button(_outline|_label)?$/i, 'primary'],
    [/secondary_button/i, 'secondary'],
  ]
  for (const [key, value] of Object.entries(settings)) {
    if (typeof value !== 'string' || !HEXISH.test(value)) continue
    const role = MAPPING.find(([re]) => re.test(key))?.[1]
    if (role !== undefined && out[role] === undefined) out[role] = value
  }
  return out
}

/** 平铺路径：键名里带角色词的认角色，剩下的色按出现顺序补位。 */
function flatColors(current: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {}
  const leftover: string[] = []
  for (const [key, value] of Object.entries(current)) {
    if (!/color/i.test(key)) continue
    const candidates = Array.isArray(value) ? value : [value]
    const hex = candidates
      .filter((c): c is string => typeof c === 'string' && HEXISH.test(c))
      .map((c) => normalizeColor(c))
      .find((c) => c !== undefined)
    if (hex === undefined) continue
    let role: string | undefined
    if (/primary/i.test(key)) role = 'primary'
    else if (/secondary/i.test(key)) role = 'secondary'
    else if (/tertiary|accent/i.test(key)) role = 'tertiary'
    else if (/background/i.test(key)) role = 'surface'
    else if (/text|foreground/i.test(key)) role = 'on-surface'
    if (role !== undefined) {
      if (out[role] === undefined) out[role] = hex
    } else {
      leftover.push(hex)
    }
  }
  const roles = ['primary', 'secondary', 'tertiary']
  for (const role of roles) {
    const hex = leftover.shift()
    if (hex === undefined) break
    if (out[role] === undefined) out[role] = hex
  }
  return out
}

/** 主题的 `color_schemes`：Dawn 11+ 是对象（`scheme-1`…），有的主题是数组——都收。 */
function schemeList(raw: unknown): Record<string, unknown>[] {
  if (Array.isArray(raw)) return raw.filter(isRecord)
  if (isRecord(raw)) return Object.values(raw).filter(isRecord)
  return []
}

/**
 * 从主题设置里读令牌。读不到的颜色 / 字体整格不出现，**不猜**。
 */
export function extractThemeDesign(settings: unknown): ThemeDesignResult {
  const profile: BrandDesignProfile = {}
  const contributed: string[] = []
  const current = isRecord(settings)
    ? isRecord(settings.current)
      ? settings.current
      : settings
    : {}
  if (!isRecord(current)) return { profile, contributed }

  // ── 配色 ────────────────────────────────────────────────────────
  const colors: Record<
    string,
    { value: string; confidence: 'medium'; source: BrandDesignSource[] }
  > = {}
  const schemes = schemeList(current.color_schemes)
  if (schemes.length > 0) {
    // scheme-1（数组第一项 / 对象第一个键）是主方案：它的 background / text /
    // button 就是主色三件套
    const scheme = schemes.find((s) => Object.keys(schemeTokens(s)).length > 0)
    if (scheme !== undefined) {
      const tokens = schemeTokens(scheme)
      for (const [role, hex] of Object.entries(tokens)) {
        const rgb = parseColor(hex)
        if (rgb !== undefined && isNeutral(rgb) && (role === 'primary' || role === 'secondary'))
          continue
        colors[role] = { value: hex, confidence: 'medium', source: [themeSource('color_schemes')] }
      }
    }
  }
  if (Object.keys(colors).length === 0) {
    for (const [role, hex] of Object.entries(flatColors(current))) {
      colors[role] = { value: hex, confidence: 'medium', source: [themeSource('colors')] }
    }
  }
  if (Object.keys(colors).length > 0) {
    profile.colors = colors
    contributed.push(...Object.keys(colors).map((k) => `colors.${k}`))
  }

  // ── 字体 ────────────────────────────────────────────────────────
  const typography: NonNullable<BrandDesignProfile['typography']> = {}
  const header = current.type_header_font
  if (typeof header === 'string' && header !== '') {
    const name = fontHandleToName(header)
    if (name !== '') {
      typography.h1 = {
        value: { fontFamily: name },
        confidence: 'medium',
        source: [themeSource('type_header_font')],
      }
    }
  }
  const base = current.type_base_font
  if (typeof base === 'string' && base !== '') {
    const name = fontHandleToName(base)
    if (name !== '') {
      typography['body-md'] = {
        value: { fontFamily: name },
        confidence: 'medium',
        source: [themeSource('type_base_font')],
      }
    }
  }
  if (Object.keys(typography).length > 0) {
    profile.typography = typography
    contributed.push(...Object.keys(typography).map((k) => `typography.${k}`))
  }

  return { profile, contributed }
}
