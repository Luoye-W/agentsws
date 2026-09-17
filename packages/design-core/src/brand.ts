/**
 * 58 §2 `brand.ts`：品牌系统**只从公司层技能取，不在这里编**。
 *
 * 与 `social-core` 的 `voice.ts` 逐字同一条纪律（24 技能分层）：
 * "这个品牌用什么颜色、什么字、什么版式、忌讳什么"属于**公司层技能**，
 * 由人写、由学习回路沉淀。一个共享包不该替某家公司决定它长什么样。
 *
 * 所以这个文件里没有一个色值、没有一个字体名，也不该有。它只做三件很窄的事：
 *
 * 1. {@link parseBrandSystem}：把一张技能卡读成结构（读不出来就说读不出来）；
 * 2. {@link resolveBrandSystem}：挑该用哪一张（按用途细化 → 公司那张 → 没有）；
 * 3. {@link brandSystemMissingCard}：一张都没有时出「先设品牌系统」卡
 *    （58 §3 四张卡里的第四张）——**不是一段默认样式**。
 *
 * 第 3 条是这个文件的重点。没有品牌系统时编一套"看起来还行"的配色，
 * 后果是这个品牌所有的图都按我们编的那套出，而没有人同意过。
 */

import { DESIGN_CAPS, type DesignDuty } from '@agentsws/contracts'

/** 公司层技能里那张品牌系统卡（`packages/skills` 那一侧的投影）。 */
export interface BrandSystemCard {
  /** 技能名（`brand-system` / `brand-system-amazon`）。 */
  name: string
  /** 这张卡管到哪儿：整个公司，还是某一条设计职责。 */
  scope: 'org' | 'duty'
  duty?: DesignDuty
  /** 卡正文（人写的 Markdown，原样引用）。 */
  body: string
  updated_at?: string
}

/**
 * 从卡正文里读出来的品牌系统。
 *
 * 四样都是**可选**的：一张只写了配色的卡照样是一张有用的卡，
 * 硬要求四样齐全等于逼人一次写完，然后他一样都不写。
 */
export interface BrandSystem {
  name: string
  scope: 'org' | 'duty'
  duty?: DesignDuty
  /** 色（十六进制或人写的名字，原样）。 */
  colors: readonly string[]
  /** 字（字体名，原样）。 */
  fonts: readonly string[]
  /** 版式与风格的那一段（原样引用，一个字不改写）。 */
  layout?: string
  /** **忌讳**：不许出现的东西。guardrail 拿它去查提示词，所以它是一串词。 */
  forbidden: readonly string[]
  updated_at?: string
}

/** 卡正文里认的那四个小标题。中英各一，写哪个都行。 */
const SECTIONS: readonly { key: 'colors' | 'fonts' | 'layout' | 'forbidden'; terms: string[] }[] = [
  { key: 'colors', terms: ['色', '颜色', '配色', 'color', 'colours', 'colors', 'palette'] },
  { key: 'fonts', terms: ['字', '字体', 'font', 'fonts', 'typography'] },
  { key: 'layout', terms: ['版式', '排版', 'layout', 'grid'] },
  { key: 'forbidden', terms: ['禁忌', '不许', '禁用', 'forbidden', 'avoid', 'never'] },
]

const HEADING = /^\s{0,3}#{1,6}\s*(.+?)\s*$/
/** `- #FF5722` / `* Inter` / `1. …`，把列表符号剥掉。 */
const BULLET = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/

function sectionKeyOf(heading: string): 'colors' | 'fonts' | 'layout' | 'forbidden' | undefined {
  const lower = heading.toLowerCase()
  for (const section of SECTIONS)
    if (section.terms.some((t) => lower.includes(t.toLowerCase()))) return section.key
  return undefined
}

/**
 * 一张卡 → 结构。
 *
 * 按小标题分段，段里的列表项就是那一格的内容；`layout` 那一段不拆列表，
 * **整段原样留着**——版式是一段话，拆成词就没意义了。
 *
 * 认不出任何一段时回的是"四格都空 + 正文照旧在 `layout` 里"，
 * 而不是抛错：人写了一段散文也是一张卡，只是我们读不出结构，
 * 那就把它整段喂给模型，别假装它不存在。
 */
export function parseBrandSystem(card: BrandSystemCard): BrandSystem {
  const buckets: Record<'colors' | 'fonts' | 'layout' | 'forbidden', string[]> = {
    colors: [],
    fonts: [],
    layout: [],
    forbidden: [],
  }
  let current: 'colors' | 'fonts' | 'layout' | 'forbidden' | undefined
  let sawSection = false
  const loose: string[] = []
  for (const line of card.body.split(/\r?\n/)) {
    const heading = HEADING.exec(line)
    if (heading !== null) {
      current = sectionKeyOf(heading[1] ?? '')
      if (current !== undefined) sawSection = true
      continue
    }
    if (line.trim() === '') continue
    if (current === undefined) {
      loose.push(line.trim())
      continue
    }
    const bullet = BULLET.exec(line)
    buckets[current].push((bullet?.[1] ?? line).trim())
  }
  const layout = [...buckets.layout, ...(sawSection ? [] : loose)].join('\n').trim()
  return {
    name: card.name,
    scope: card.scope,
    ...(card.duty === undefined ? {} : { duty: card.duty }),
    colors: buckets.colors,
    fonts: buckets.fonts,
    ...(layout === '' ? {} : { layout }),
    // 禁忌拿去查提示词，所以剥掉行内的说明（`竞品 logo —— 法务说过`→`竞品 logo`）
    forbidden: buckets.forbidden.map((t) => t.split(/[———:：(（]/)[0]?.trim() ?? t).filter(Boolean),
    ...(card.updated_at === undefined ? {} : { updated_at: card.updated_at }),
  }
}

/** 挑一张的结论。`system` 为 `undefined` = 这家公司还没设过品牌系统。 */
export interface ResolvedBrandSystem {
  system?: BrandSystem
  /** 一句人话：用的是哪一张、为什么。界面与提示词都读它。 */
  note: string
}

/**
 * 挑一张。这条职责单独写过的那张优先；没有就用公司那张；一张都没有就说没有。
 *
 * **不合并两张**（同 `voice.ts` 的 `resolveVoice`）：把公司配色与 Amazon 专用
 * 配色拼起来听着合理，实际上是我们编了第三份没人写过的品牌系统。
 */
export function resolveBrandSystem(
  cards: readonly BrandSystemCard[],
  duty: DesignDuty,
): ResolvedBrandSystem {
  const scoped = cards.find((c) => c.scope === 'duty' && c.duty === duty)
  if (scoped !== undefined)
    return {
      system: parseBrandSystem(scoped),
      note: `用的是这条职责单独写的那张品牌系统（${scoped.name}）。`,
    }
  const org = cards.find((c) => c.scope === 'org')
  if (org !== undefined)
    return {
      system: parseBrandSystem(org),
      note: `用的是公司层那张品牌系统（${org.name}）。`,
    }
  return { note: MISSING_NOTE }
}

/** 一张都没有时那句话。**全仓唯一一份**（卡面、提示词说明、模拟断言读同一个字符串）。 */
export const MISSING_NOTE =
  '这个品牌还没设过品牌系统（色 / 字 / 版式 / 禁忌）。没有它，出来的图每一张都是另一种风格——' +
  '同一个品牌的十张图放在一起会像十个牌子。先花十分钟写一张，后面每一张图都吃得到。'

/**
 * 58 §3 的第四张卡：**缺品牌系统卡**。
 *
 * 出的是一张卡而不是一段默认样式。卡上只有一件事要人做：去写那张技能卡。
 * `blocking: false` 是故意的——没有品牌系统照样出得了 brief 与规格
 * （58 §1：没有图片模型时也是"只出 brief 与规格"），只是出图这一步会
 * 每张都换个风格，卡上把这件事说清楚。
 */
export interface BrandSystemMissingCard {
  kind: 'brand_system_missing'
  title_zh: string
  title_en: string
  body_zh: string
  /** 去哪儿写（公司层技能的名字与目录约定，24 §3）。 */
  skill_name: string
  skill_tier: 'company'
  blocking: false
}

export function brandSystemMissingCard(): BrandSystemMissingCard {
  return {
    kind: 'brand_system_missing',
    title_zh: '先设品牌系统',
    title_en: 'Set up the brand system first',
    body_zh: MISSING_NOTE,
    skill_name: 'brand-system',
    skill_tier: 'company',
    blocking: false,
  }
}

/**
 * 品牌系统 → 喂给模型的那一段。
 *
 * `layout` **原样引用**，一个字不改写（同 `voicePrompt`）。没有系统的时候
 * 回的是"没有"那句话，而不是一段我们编的默认风格。
 */
export function brandPrompt(resolved: ResolvedBrandSystem): string {
  const s = resolved.system
  if (s === undefined) return `【品牌系统】${resolved.note}`
  const lines = [`【品牌系统｜${s.name}${s.updated_at === undefined ? '' : ` · ${s.updated_at}`}】`]
  if (s.colors.length > 0) lines.push(`色：${s.colors.join('、')}`)
  if (s.fonts.length > 0) lines.push(`字：${s.fonts.join('、')}`)
  if (s.layout !== undefined) lines.push(`版式：${s.layout}`)
  if (s.forbidden.length > 0) lines.push(`【不许出现】${s.forbidden.join('、')}`)
  return lines.join('\n')
}

/** 58 §6 的三个默认额度，从契约转出来一份（调用方不必同时 import 两个包）。 */
export { DESIGN_CAPS }
