/**
 * 建站这一侧怎么用那份 `DESIGN.md`（71 §5，WP122）。
 *
 * 两件事，不多：
 *
 * 1. **出页面 / 出邮件模板时把令牌注进提示词**（{@link siteDesignPrompt}）。
 * 2. **把令牌翻成主题变量**（{@link themeDesignVariables}），WP89 的主题沙箱
 *    预览直接吃这一份——预览里的颜色与规范里的颜色是同一个来源，
 *    而不是"设计规范说一套、沙箱里又调一套"。
 *
 * 这里**不拼那段提示词**：它由 `brandDesignContext()`（`@agentsws/brand-design`）
 * 算好递进来。四个岗位共用一个拼法，各拼各的的话，过两周社媒出的图与建站
 * 出的页就不是一套颜色了——而那种问题事后没人查得出是哪一行提示词的差别。
 */
import type { BrandDesignContext, DesignTokens } from '@agentsws/contracts'

/**
 * 出页面 / 出邮件模板时，贴在提示词后面的那一段。
 *
 * 没有规范就回空串——建站这件事不该因为没有品牌规范就停下来。
 */
export function siteDesignPrompt(design?: BrandDesignContext): string {
  if (design?.present !== true) return ''
  return design.prompt
}

/**
 * 令牌 → 主题里那几个 CSS 变量。
 *
 * 变量名按 Shopify 主题设置里最常见的那套写（`--color-primary` 这类），
 * 但**不替任何一个主题起名字**：我们出的是一张 `name → value` 的表，
 * 主题那一侧认哪几个是主题的事。认不出来的那几行主题会直接忽略，
 * 这比我们猜一个它可能用的名字安全。
 */
export function themeDesignVariables(tokens: DesignTokens): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(tokens.colors ?? {})) out[`--color-${name}`] = value
  for (const [name, value] of Object.entries(tokens.rounded ?? {})) out[`--radius-${name}`] = value
  for (const [name, value] of Object.entries(tokens.spacing ?? {}))
    out[`--space-${name}`] = typeof value === 'number' ? String(value) : value
  for (const [name, value] of Object.entries(tokens.shadows ?? {})) out[`--shadow-${name}`] = value
  const families = new Set<string>()
  for (const [name, type] of Object.entries(tokens.typography ?? {})) {
    if (type.fontSize !== undefined) out[`--font-size-${name}`] = type.fontSize
    if (type.fontFamily !== undefined) families.add(type.fontFamily)
  }
  // 字体族只出两个位：标题与正文。一个主题的字体设置通常也只有这两格，
  // 十几个字号令牌各带一份字体族会把那张表撑成噪声。
  const [heading, body] = [...families]
  if (heading !== undefined) out['--font-heading'] = heading
  if (body !== undefined) out['--font-body'] = body
  return out
}
