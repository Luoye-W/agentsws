/**
 * 把抓到的令牌写成正文（71 §3）。
 *
 * **只根据抓到 / 读到的证据写。** 没证据的节写「未找到，请补充」，**不编**。
 * 这一条不是一句提示词里的客套话，它在代码里有形状：证据不够的小节
 * {@link sectionEvidence} 直接判空，**根本不进提示词**——模型看不见那一节，
 * 也就没机会替它编一段听起来很像品牌手册的话。
 *
 * 模型那一口是注入的（{@link DesignComposeModel}），所以测试里跑的是替身，
 * 一个字节都不出这台机器。**接不上模型时不空手**：退回一段按令牌直述的文字
 * （{@link factualProse}）。它读起来干，但每一句都对得上一个真实的值——
 * 这正是这一节该有的下限。
 *
 * ## 钱
 *
 * 一次成文**只发一次模型请求**（八节一起写，不是一节一个），封顶
 * `DEFAULT_BRAND_DESIGN_CAP_CREDITS = 1`。开跑前报预估，撞顶就停，
 * 停下来的时候**已经写好的照样交**（与 WP121 同一条）。
 */
import {
  type BrandDesignProfile,
  CREDITS_PER_VISION_CALL,
  DEFAULT_BRAND_DESIGN_CAP_CREDITS,
  DESIGN_MD_SECTIONS,
  type DesignMdSection,
} from '@agentsws/contracts'
import { type DesignProse, fontsOf, paletteOf, serializeDesignMd, tokensOf } from './serialize.js'

/** 模型那一口。返回整段 Markdown（里面是 `## 小节名` 分节）。 */
export type DesignComposeModel = (request: {
  prompt: string
  /** 便宜档就够：这一步是把一张表写成人话，不是推理。 */
  tier: 'cheap'
  purpose: 'brand_design_compose'
}) => Promise<{ text: string; credits?: number }>

/** 看图那一口（图片风格那一节要它）。**现在通常不接**，见下。 */
export type DesignVisionModel = (request: {
  /** 页面截图或手册某一页的图。 */
  image: Uint8Array
  prompt: string
  purpose: 'brand_design_vision'
}) => Promise<{ text: string; credits?: number }>

/** 一次成文请求按多少积分算（只发一次，所以这就是这一步的全部成本）。 */
export const CREDITS_PER_COMPOSE = 0.3

export interface ComposeDesignInput {
  profile: BrandDesignProfile
  model?: DesignComposeModel
  /** 看截图的那一口。不给就不看图，`imagery` 那一节如实写「未找到」。 */
  vision?: DesignVisionModel
  /** 给视觉模型看的图（页面截图 / 手册页）。 */
  images?: readonly Uint8Array[]
  capCredits?: number
}

export interface ComposeDesignResult {
  prose: DesignProse
  /**
   * 成文用的那一份档案：**看图那一步可能补了 `imagery`**（视觉口回的话
   * 也是证据）。调用方落库要用这一份，不要用它递进来的原档——否则文件里
   * 写着图片风格、色板里却没有那一格，两边的真源就分叉了。
   */
  profile: BrandDesignProfile
  /** 整份文件（front matter + 正文）。 */
  markdown: string
  budget: { estimated_credits: number; cap_credits: number; spent_credits: number }
  /** 撞上封顶停下来的。界面上要说一句「写到这儿就停了」。 */
  stopped_for_budget: boolean
  /** 证据不够、如实留白的那几节。 */
  missing: DesignMdSection[]
  /** 模型那一步没成的时候那一句人话（退回直述文本了）。 */
  fallback_reason?: string
}

/** 开跑前给用户看的那个数。 */
export function estimateComposeCredits(input: {
  profile: BrandDesignProfile
  images?: readonly unknown[]
}): number {
  const sections = DESIGN_MD_SECTIONS.filter((s) => sectionEvidence(input.profile, s) !== undefined)
  if (sections.length === 0) return 0
  const vision = (input.images?.length ?? 0) * CREDITS_PER_VISION_CALL
  return Math.round((CREDITS_PER_COMPOSE + vision) * 100) / 100
}

/**
 * 这一节有没有证据可写。
 *
 * 回一段"事实摘要"（进提示词的那一段），没证据回 `undefined`。
 * **这个函数就是"不编"那条纪律的执行处。**
 */
export function sectionEvidence(
  profile: BrandDesignProfile,
  section: DesignMdSection,
): string | undefined {
  const colors = profile.colors ?? {}
  const typography = profile.typography ?? {}
  switch (section) {
    case 'Overview': {
      const bits: string[] = []
      if (profile.name !== undefined) bits.push(`品牌名：${profile.name.value}`)
      if (profile.description !== undefined) bits.push(`一句话：${profile.description.value}`)
      if (profile.voice !== undefined) bits.push(`语气样例：${profile.voice.value}`)
      if (profile.imagery !== undefined) bits.push(`图片风格：${profile.imagery.value}`)
      return bits.length === 0 ? undefined : bits.join('\n')
    }
    case 'Colors': {
      const entries = Object.entries(colors)
      if (entries.length === 0) return undefined
      return entries
        .map(([k, v]) => `${k} = ${v.value}（出处：${locatorText(v.source[0])}）`)
        .join('\n')
    }
    case 'Typography': {
      const entries = Object.entries(typography)
      if (entries.length === 0) return undefined
      return entries
        .map(([k, v]) => {
          const t = v.value
          const parts = [
            t.fontFamily,
            t.fontSize,
            t.fontWeight === undefined ? undefined : `weight ${String(t.fontWeight)}`,
          ]
          return `${k}：${parts.filter((x) => x !== undefined).join(' / ')}`
        })
        .join('\n')
    }
    case 'Layout': {
      const spacing = profile.spacing ?? {}
      const entries = Object.entries(spacing)
      return entries.length === 0
        ? undefined
        : `间距阶梯：${entries.map(([k, v]) => `${k}=${String(v.value)}`).join('、')}`
    }
    case 'Elevation & Depth': {
      const shadows = profile.shadows ?? {}
      const entries = Object.entries(shadows)
      return entries.length === 0
        ? undefined
        : `阴影：${entries.map(([k, v]) => `${k}=${v.value}`).join('；')}`
    }
    case 'Shapes': {
      const rounded = profile.rounded ?? {}
      const entries = Object.entries(rounded)
      return entries.length === 0
        ? undefined
        : `圆角：${entries.map(([k, v]) => `${k}=${v.value}`).join('、')}`
    }
    case 'Components': {
      const components = profile.components ?? {}
      const entries = Object.entries(components)
      if (entries.length === 0) return undefined
      return entries
        .map(
          ([name, props]) =>
            `${name}：${Object.entries(props)
              .map(([k, v]) => `${k}=${v.value}`)
              .join('，')}`,
        )
        .join('\n')
    }
    case "Do's and Don'ts": {
      // 这一节**只在别的节有内容时才写**：它是从别的节推出来的守则，
      // 自己没有独立的证据。一份什么都没抓到的档案不该凭空得到一串"不许"。
      const hasAny = Object.keys(colors).length > 0 || Object.keys(typography).length > 0
      if (!hasAny) return undefined
      const palette = paletteOf(profile)
      const fonts = fontsOf(profile)
      return `色板共 ${String(palette.length)} 色：${palette.join('、')}\n字体表：${fonts.length === 0 ? '（没抓到）' : fonts.join('、')}`
    }
    default:
      return undefined
  }
}

function locatorText(
  source: { url?: string; locator?: string; page?: number } | undefined,
): string {
  if (source === undefined) return '未知'
  if (source.page !== undefined) return `手册第 ${String(source.page)} 页`
  return [source.url, source.locator].filter((x) => x !== undefined).join(' 的 ')
}

/* ── 提示词 ───────────────────────────────────────────────────────── */

const RULES = [
  '你在给一个品牌写 DESIGN.md 的正文。读者是这个品牌的运营者（不是设计师），以及以后要照着它出图、出页面的 AI。',
  '**只能写下面「证据」里有的东西。** 证据里没有的一个字都不许加：不要编品牌故事，不要猜行业，不要写"现代简约"这类放之四海皆准的形容。',
  '每一节 3–6 句，说清楚这个值**什么场合用**、**什么场合不用**。颜色那一节要给每个色一个人能记住的叫法（比如"墨黑""砖红"）并跟上色值。',
  '用中文，说人话，不要项目符号以外的排版花样，不要写标题以外的 Markdown 语法。',
  "Do's and Don'ts 那一节写 4–6 条，每条一行，以「要」或「不要」开头。",
  '按给定的小节标题原样输出（`## Colors` 这种英文标题不要翻译），没给你的小节不要自己加。',
]

export function composePrompt(
  profile: BrandDesignProfile,
  sections: readonly DesignMdSection[],
): string {
  const blocks = sections.map((s) => `### ${s}\n${sectionEvidence(profile, s) ?? ''}`)
  return [
    RULES.join('\n'),
    '',
    '── 证据 ──',
    blocks.join('\n\n'),
    '',
    `── 要写的小节（按这个顺序、用这些标题）──\n${sections.map((s) => `## ${s}`).join('\n')}`,
  ].join('\n')
}

/* ── 入口 ─────────────────────────────────────────────────────────── */

/**
 * 写一遍。
 *
 * 封顶撞上就不发请求，直接退回直述文本——**已经有的照样交**。
 */
export async function composeDesignProse(input: ComposeDesignInput): Promise<ComposeDesignResult> {
  const cap = input.capCredits ?? DEFAULT_BRAND_DESIGN_CAP_CREDITS
  let missing = DESIGN_MD_SECTIONS.filter((s) => !sectionEvidence(input.profile, s))
  const estimated = estimateComposeCredits({
    profile: input.profile,
    ...(input.images === undefined ? {} : { images: input.images }),
  })

  let spent = 0
  let stopped = false
  let fallbackReason: string | undefined
  let prose: DesignProse = {}

  // ① 看图那一步（有口子才跑，且**先跑**——它的结果要进成文的证据，
  // 甚至能凭空造出一节证据：只有图、没有 CSS 的站也能有 imagery 那一节）
  let profile = input.profile
  if (input.vision !== undefined && input.images !== undefined && input.images.length > 0) {
    const notes: string[] = []
    for (const image of input.images) {
      if (spent + CREDITS_PER_VISION_CALL + CREDITS_PER_COMPOSE > cap) {
        stopped = true
        break
      }
      try {
        const res = await input.vision({
          image,
          prompt: '这张截图里的图片风格：摄影还是插画、色调、构图。两句话，只说你看得见的。',
          purpose: 'brand_design_vision',
        })
        notes.push(res.text.trim())
        spent = round(spent + (res.credits ?? CREDITS_PER_VISION_CALL))
      } catch {
        // 看不了就不看。这一节会如实留白。
        break
      }
    }
    if (notes.length > 0)
      profile = {
        ...profile,
        imagery: {
          value: notes.join(' '),
          confidence: 'low',
          source: [{ origin: 'site', locator: 'model:vision' }],
        },
      }
  }

  // 看完图再算一遍小节：imagery 可能刚成为 Overview 那一节的新证据
  const sections = DESIGN_MD_SECTIONS.filter((s) => sectionEvidence(profile, s) !== undefined)
  missing = DESIGN_MD_SECTIONS.filter((s) => !sections.includes(s))

  if (sections.length === 0) {
    return {
      prose,
      profile,
      markdown: serializeDesignMd(profile, prose),
      budget: { estimated_credits: estimated, cap_credits: cap, spent_credits: spent },
      stopped_for_budget: false,
      missing,
    }
  }

  // ② 成文
  if (input.model === undefined) {
    fallbackReason = '这一轮没接上模型，正文按抓到的令牌直述。'
    prose = factualProse(profile, sections)
  } else if (spent + CREDITS_PER_COMPOSE > cap) {
    stopped = true
    fallbackReason = '积分到封顶了，正文按抓到的令牌直述。'
    prose = factualProse(profile, sections)
  } else {
    try {
      const res = await input.model({
        prompt: composePrompt(profile, sections),
        tier: 'cheap',
        purpose: 'brand_design_compose',
      })
      spent = round(spent + (res.credits ?? CREDITS_PER_COMPOSE))
      prose = splitProse(res.text, sections)
      if (Object.keys(prose).length === 0) {
        fallbackReason = '模型回的那段读不出小节，正文按抓到的令牌直述。'
        prose = factualProse(profile, sections)
      }
    } catch (err) {
      fallbackReason = `模型没回（${err instanceof Error ? err.message : '未知原因'}），正文按抓到的令牌直述。`
      prose = factualProse(profile, sections)
    }
  }

  return {
    prose,
    profile,
    markdown: serializeDesignMd(profile, prose),
    budget: { estimated_credits: estimated, cap_credits: cap, spent_credits: spent },
    stopped_for_budget: stopped,
    missing,
    ...(fallbackReason === undefined ? {} : { fallback_reason: fallbackReason }),
  }
}

function round(n: number): number {
  return Math.round(n * 100) / 100
}

/** 模型回的一整段 → 按小节切开。认不出来的标题丢掉，不硬塞。 */
export function splitProse(text: string, sections: readonly DesignMdSection[]): DesignProse {
  const out: DesignProse = {}
  const known = new Map(sections.map((s) => [s.toLowerCase(), s]))
  let current: DesignMdSection | undefined
  let buffer: string[] = []
  const flush = (): void => {
    if (current === undefined) return
    const body = buffer.join('\n').trim()
    if (body !== '') out[current] = body
    buffer = []
  }
  for (const line of text.split(/\r?\n/)) {
    const h = /^#{1,3}\s+(.+?)\s*$/.exec(line)
    if (h?.[1] !== undefined) {
      flush()
      current = known.get(h[1].toLowerCase())
      continue
    }
    if (current !== undefined) buffer.push(line)
  }
  flush()
  return out
}

/**
 * 接不上模型时的正文：**直述**。
 *
 * 读起来干，但每一句都对得上一个真实的值，且不会有一个字是编的。
 * 这是这一节的下限，不是它的目标。
 */
export function factualProse(
  profile: BrandDesignProfile,
  sections: readonly DesignMdSection[],
): DesignProse {
  const out: DesignProse = {}
  for (const s of sections) {
    const evidence = sectionEvidence(profile, s)
    if (evidence === undefined) continue
    out[s] = `以下是从这个品牌的官网与上传文件里读到的原值（尚未成文，可直接改）：\n\n${evidence
      .split('\n')
      .map((line) => `- ${line}`)
      .join('\n')}`
  }
  const tokens = tokensOf(profile)
  void tokens
  return out
}
