/**
 * 库内的档案 ⇄ 一份真正的 `DESIGN.md`（71 §3）。
 *
 * **写出去的那份文件里没有我们的私货。** 出处、把握度、冲突那一层是给界面看的，
 * 落到文件上的是规范定义的裸令牌——因为这份文件的全部价值在于**别的工具也能读**：
 * 用户把它拖进 Stitch / Claude Code / Cursor，那些工具不认识我们的 `source` 字段。
 *
 * 反过来也要成立：用户从别处粘一份 `DESIGN.md` 进来，我们得读得回去
 * （{@link parseDesignMd}）。那一份没有出处，所以每一格的出处记成"用户粘的"、
 * 把握度记 `high`——**这是对的**：人手工贴进来的东西比我们从 CSS 里猜的硬。
 *
 * 小节的名字与顺序按规范（`DESIGN_MD_SECTIONS`）。抓不到的那几节**不省略了事**，
 * 而是写一句「未找到，请补充」并把节名记进 front matter 的 `omitted`——
 * 规范的 linter 认这个，用户也能一眼看见哪儿还缺。
 */
import {
  type BrandDesignProfile,
  type BrandDesignSource,
  type BrandDesignValue,
  DESIGN_MD_SECTIONS,
  DESIGN_MD_SPEC_VERSION,
  type DesignMdSection,
  type DesignOmittedSection,
  type DesignTokens,
  type DesignTypography,
} from '@agentsws/contracts'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

/** 抓不到的那一节写这句。**不编**（71 §3 第 3 条）。 */
export const NOT_FOUND_ZH = '未找到，请补充。'

/** 正文：小节名 → 那一节的散文。 */
export type DesignProse = Partial<Record<DesignMdSection, string>>

/* ── 档案 → 裸令牌 ────────────────────────────────────────────────── */

function bare<T>(v: BrandDesignValue<T> | undefined): T | undefined {
  return v?.value
}

function bareRecord<T>(
  rec: Record<string, BrandDesignValue<T>> | undefined,
): Record<string, T> | undefined {
  if (rec === undefined) return undefined
  const out: Record<string, T> = {}
  for (const [k, v] of Object.entries(rec)) out[k] = v.value
  return Object.keys(out).length === 0 ? undefined : out
}

/** 把带出处的档案压成规范的那份令牌。 */
export function tokensOf(profile: BrandDesignProfile): DesignTokens {
  const tokens: DesignTokens = { version: DESIGN_MD_SPEC_VERSION }
  const name = bare(profile.name)
  if (name !== undefined) tokens.name = name
  const description = bare(profile.description)
  if (description !== undefined) tokens.description = description

  const colors = bareRecord(profile.colors)
  if (colors !== undefined) tokens.colors = colors
  const typography = bareRecord(profile.typography)
  if (typography !== undefined) tokens.typography = typography
  const rounded = bareRecord(profile.rounded)
  if (rounded !== undefined) tokens.rounded = rounded
  const spacing = bareRecord(profile.spacing)
  if (spacing !== undefined) tokens.spacing = spacing
  const shadows = bareRecord(profile.shadows)
  if (shadows !== undefined) tokens.shadows = shadows

  if (profile.components !== undefined) {
    const components: Record<string, Record<string, string>> = {}
    for (const [name_, props] of Object.entries(profile.components)) {
      const bucket = bareRecord(props)
      if (bucket !== undefined) components[name_] = bucket
    }
    if (Object.keys(components).length > 0) tokens.components = components
  }
  return tokens
}

/** 哪几节是空的（要写进 `omitted`）。 */
function omittedOf(tokens: DesignTokens, prose: DesignProse): DesignOmittedSection[] {
  const out: DesignOmittedSection[] = []
  const missing = (section: string, has: boolean, reason: string): void => {
    if (!has) out.push({ section, reason })
  }
  missing('colors', tokens.colors !== undefined, '这一轮没抽到颜色')
  missing('typography', tokens.typography !== undefined, '这一轮没抽到字体')
  missing('spacing', tokens.spacing !== undefined, '这一轮没抽到间距阶梯')
  missing('rounded', tokens.rounded !== undefined, '这一轮没抽到圆角')
  missing('components', tokens.components !== undefined, '这一轮没抽到组件样式')
  void prose
  return out
}

/* ── 序列化 ───────────────────────────────────────────────────────── */

/**
 * 写出一份 `DESIGN.md`。
 *
 * 八节**全都写出来**（在场的按规范的顺序），没内容的写「未找到，请补充」。
 * 为什么不干脆省掉：一份缺了三节的文件，用户看不出是"这个品牌没有这一项"
 * 还是"我们没抓到"。把话写出来，这两件事就分开了。
 */
export function serializeDesignMd(profile: BrandDesignProfile, prose: DesignProse = {}): string {
  const tokens = tokensOf(profile)
  const omitted = omittedOf(tokens, prose)
  if (omitted.length > 0) tokens.omitted = omitted

  const front = stringifyYaml(tokens, { lineWidth: 0 }).trimEnd()
  const parts = [`---\n${front}\n---`]
  const title = tokens.name
  if (title !== undefined) parts.push(`# ${title}`)
  for (const section of DESIGN_MD_SECTIONS) {
    const body = prose[section]?.trim()
    parts.push(`## ${section}\n\n${body === undefined || body === '' ? NOT_FOUND_ZH : body}`)
  }
  return `${parts.join('\n\n')}\n`
}

/* ── 反序列化 ─────────────────────────────────────────────────────── */

export interface ParsedDesignMd {
  tokens: DesignTokens
  prose: DesignProse
  /** 规范不认识的小节（`## Iconography` 这种）。**保留，不报错。** */
  extraSections: { heading: string; body: string }[]
  /** 读不动的地方那一句人话。文件整个坏掉时才有。 */
  failure?: string
}

/**
 * 读回来。
 *
 * **坏掉的 front matter 不让整份文件报废**：YAML 解析不了就当"没有令牌"，
 * 正文照读。用户粘进来的东西十有八九是从别处复制的，前面多一个空行、少一个
 * 引号都很常见，而正文那几段散文本身就有价值。
 */
export function parseDesignMd(markdown: string): ParsedDesignMd {
  let rest = markdown.replace(/^﻿/, '')
  let tokens: DesignTokens = {}
  let failure: string | undefined

  const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(rest)
  if (fm?.[1] !== undefined) {
    rest = rest.slice(fm[0].length)
    try {
      const parsed: unknown = parseYaml(fm[1])
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed))
        tokens = parsed as DesignTokens
      else failure = '文件开头那段 YAML 不是一组键值对，这一份的令牌没读出来。'
    } catch (err) {
      failure = `文件开头那段 YAML 读不动（${err instanceof Error ? err.message.split('\n')[0] : '格式不对'}），只读了正文。`
    }
  }

  const prose: DesignProse = {}
  const extraSections: { heading: string; body: string }[] = []
  const known = new Set<string>(DESIGN_MD_SECTIONS)
  const lines = rest.split(/\r?\n/)
  let current: string | undefined
  let buffer: string[] = []
  const flush = (): void => {
    if (current === undefined) return
    const body = buffer.join('\n').trim()
    if (known.has(current)) prose[current as DesignMdSection] = body
    else extraSections.push({ heading: current, body })
    buffer = []
  }
  for (const line of lines) {
    const h2 = /^##\s+(.+?)\s*$/.exec(line)
    if (h2?.[1] !== undefined) {
      flush()
      current = h2[1]
      continue
    }
    if (current !== undefined) buffer.push(line)
  }
  flush()

  return { tokens, prose, extraSections, ...(failure === undefined ? {} : { failure }) }
}

/**
 * 粘进来的一份 → 库内档案。
 *
 * 每一格记成 `manual` + `high` + `edited`。最后那一格是关键：**用户粘的东西
 * 在重抓时整格不动**。他刚刚亲手贴了一份规范进来，我们下一轮抓取就把它覆盖回
 * 从 CSS 里猜的值——这种事发生一次，这个输入框就废了（与 70 §3.4 同一条）。
 */
export function profileFromTokens(
  tokens: DesignTokens,
  source: BrandDesignSource = { origin: 'manual', locator: 'paste' },
): BrandDesignProfile {
  const wrap = <T>(value: T): BrandDesignValue<T> => ({
    value,
    confidence: 'high',
    source: [source],
    edited: source.origin === 'manual',
  })
  const wrapRecord = <T>(
    rec: Record<string, T> | undefined,
  ): Record<string, BrandDesignValue<T>> | undefined => {
    if (rec === undefined) return undefined
    const out: Record<string, BrandDesignValue<T>> = {}
    for (const [k, v] of Object.entries(rec)) out[k] = wrap(v)
    return out
  }

  const profile: BrandDesignProfile = {}
  if (tokens.name !== undefined) profile.name = wrap(tokens.name)
  if (tokens.description !== undefined) profile.description = wrap(tokens.description)
  const colors = wrapRecord(tokens.colors)
  if (colors !== undefined) profile.colors = colors
  const typography = wrapRecord<DesignTypography>(tokens.typography)
  if (typography !== undefined) profile.typography = typography
  const rounded = wrapRecord(tokens.rounded)
  if (rounded !== undefined) profile.rounded = rounded
  const spacing = wrapRecord<string | number>(tokens.spacing)
  if (spacing !== undefined) profile.spacing = spacing
  const shadows = wrapRecord(tokens.shadows)
  if (shadows !== undefined) profile.shadows = shadows
  if (tokens.components !== undefined) {
    const components: Record<string, Record<string, BrandDesignValue<string>>> = {}
    for (const [name, props] of Object.entries(tokens.components)) {
      const bucket = wrapRecord(props)
      if (bucket !== undefined) components[name] = bucket
    }
    if (Object.keys(components).length > 0) profile.components = components
  }
  return profile
}

/** 色板（自检与提示注入拿它比对）。 */
export function paletteOf(profile: BrandDesignProfile): string[] {
  return Object.values(profile.colors ?? {}).map((v) => v.value)
}

/** 字体表。 */
export function fontsOf(profile: BrandDesignProfile): string[] {
  const out: string[] = []
  for (const v of Object.values(profile.typography ?? {})) {
    const family = v.value.fontFamily
    if (family !== undefined && !out.includes(family)) out.push(family)
  }
  return out
}
