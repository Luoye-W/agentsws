/**
 * WP120（69）：**角色定位（persona）**——两层、六段、可覆盖。
 *
 * 这个文件是 persona 的唯一真源：怎么取语言、怎么叠公司层覆盖、怎么拼成进系统提示的
 * 那几段、以及「这段 persona 写全了没有」的校验。三个运行时与右栏面板都只从这里取。
 *
 * **纯函数**：不碰存储、不碰时钟、不碰随机（与 `route.ts` 同一条规矩）。
 * 覆盖从哪儿读由调用方给（服务端一份、模拟层一份），这里只负责叠。
 */
import type {
  PersonaOverride,
  PersonaSectionId,
  PersonaSectionOverrides,
  PersonaSubject,
  PersonaText,
  PersonaView,
  Position,
  PromptSection,
  RoleDefinition,
} from '@agentsws/contracts'
import { builtinContentTable, readContentTable } from '@agentsws/core'
import HOUSE_RULES_FILE from './house-rules.content.json' with { type: 'json' }

/** persona 用哪种语言（界面语言）。 */
export type PersonaLang = 'zh' | 'en'

/**
 * 一段 persona 在某种语言下的正文。
 *
 * 纯字符串的老写法：不管要哪种语言都回它（那是"只有一份"的意思，不是"中文的"）。
 * `{ zh, en }`：要哪份给哪份；**要的那份是空的就回落另一份**——空白的 persona 比
 * 语言不对糟得多（前者让 Agent 退回"我是谁都不知道"，后者至少还知道自己是谁）。
 */
export function personaTextIn(persona: PersonaText | undefined, lang: PersonaLang): string {
  if (persona === undefined) return ''
  if (typeof persona === 'string') return persona.trim()
  const want = (lang === 'zh' ? persona.zh : persona.en) ?? ''
  if (want.trim() !== '') return want.trim()
  const other = (lang === 'zh' ? persona.en : persona.zh) ?? ''
  return other.trim()
}

/** 这段 persona 是不是"一个字都没有"（两份都空也算空）。 */
export function personaIsEmpty(persona: PersonaText | undefined): boolean {
  return personaTextIn(persona, 'zh') === '' && personaTextIn(persona, 'en') === ''
}

/* ── 69 §2：固定骨架的校验 ──────────────────────────────────────────────── */

/**
 * 六段骨架的小标题。**正文里逐字出现**这六个词就算写了那一段——不做自然语言判断，
 * 因为那种判断会在半年后悄悄变松。写 persona 的人照着抄这六个小标题，机器照着查。
 *
 * 顺序就是读的顺序：先知道自己是谁，才谈得上负责什么；「不负责什么」紧跟在
 * 「负责什么」后面，是因为这两段要对着读才看得出边界在哪。
 */
export const PERSONA_SECTIONS_ZH = [
  '你是谁',
  '你负责',
  '你不负责',
  '怎么做',
  '口气',
  '必须出卡',
] as const

/** 英文那份的六个小标题（与中文一一对应）。 */
export const PERSONA_SECTIONS_EN = [
  'Who you are',
  'You handle',
  'Not yours',
  'How you work',
  'Tone',
  'Always ask',
] as const

/**
 * 69 §2：一段 persona 的字数上限。**短是刻意的**——长了模型读不进去，
 * 而 persona 的作用恰恰是"进了系统提示之后还被记住"。
 *
 * 派工单写的是「每段 ≤ 200 字」。那是**正文**的目标，机器上限要留出六个小标题本身
 * （约 30 字）的开销，所以中文原先卡 260。
 *
 * 决策 1392（Luoye 10-21 放宽）：中文 260 → **320**。依据：「SEO 与 GEO」（docs/109 §4.3）
 * 的原稿六段约 294 字，压到 260 要删掉「讲清一件事」「关注词排名」这类本来就该说的事；
 * 放宽 60 字够原稿进、也还留着"短"的约束（上限仍远小于英文 950）。
 *
 * WP226（69 §1.1）：**只卡中文**。英文那份现在由 `scripts/gen-persona-en.mjs` 从中文翻出来，
 * 长短跟着中文走——再卡一遍英文，只会逼着翻译去删一件中文里写了的事。`en` 这一格留着
 * （契约只加不删），`checkPersona` 不再读它。
 */
export const MAX_PERSONA_CHARS = { zh: 320, en: 950 } as const

/**
 * 英文正文里不许出现的字：汉字，以及全角标点（`（` `：` `，` `「` …）。
 *
 * 全角标点也算：docs/91 §3.3 那 14 条混中文的英文 persona，露馅的除了汉字还有一对全角括号。
 * `→` 与弯引号是英文里也用的符号，不在里面。
 */
const CHINESE_IN_TEXT = /[\p{Script=Han}\u3000-\u303F\uFF01-\uFF60]/u

/** 这段文字里有没有汉字或全角标点（英文那份不许有）。 */
export function hasChineseText(text: string): boolean {
  return CHINESE_IN_TEXT.test(text)
}

/** 第一处汉字前后几个字（报错时指给人看在哪儿）。 */
function chineseSnippet(text: string): string {
  const at = text.search(CHINESE_IN_TEXT)
  return at < 0 ? '' : text.slice(Math.max(0, at - 12), at + 12).replace(/\s+/g, ' ')
}

/** 中文那份：六段都在、没超长。 */
function checkZhPersona(text: string): string | undefined {
  if (text.length > MAX_PERSONA_CHARS.zh)
    return `persona（zh）${text.length} 字，超过 ${MAX_PERSONA_CHARS.zh} 字上限`
  const missing = PERSONA_SECTIONS_ZH.filter((h) => !text.includes(h))
  return missing.length > 0
    ? `persona（zh）少了这几段：${missing.join(' / ')}（69 §2 的固定骨架）`
    : undefined
}

/** 英文那份：只查「没有汉字」（WP226：不卡字数，见 `MAX_PERSONA_CHARS`）。 */
function checkEnPersona(text: string): string | undefined {
  return hasChineseText(text)
    ? `persona（en）里混着中文：「${chineseSnippet(text)}」（英文那份不许有汉字与全角标点，69 §1.1）`
    : undefined
}

/**
 * 一段 persona 写全了没有。回 `undefined` = 没问题，回一句中文 = 哪儿不对。
 *
 * 1. **不是空的**（`gen-ontology --check` 把空判成失败，69 §2 最后一句）；
 * 2. **中文那份**：六段都在（尤其是防串岗的「你不负责」）、不超过 320 字（决策 1392）；
 * 3. **英文那份**（填了才查）：不许混汉字。WP226 起英文由脚本从中文生成，不再卡字数；
 *    它的「六段小标题都在」由生成脚本自己查（`checkGeneratedPersonaEn`）。
 *
 * 老的纯字符串写法（"只有一份"）：有汉字就按中文那份查，否则按英文那份查。
 */
export function checkPersona(persona: PersonaText | undefined): string | undefined {
  if (personaIsEmpty(persona)) return 'persona 是空的（69 §2：全部职责与岗位都要写，不许留空）'
  if (typeof persona === 'string') {
    const text = persona.trim()
    return hasChineseText(text) ? checkZhPersona(text) : checkEnPersona(text)
  }
  const zh = (persona?.zh ?? '').trim()
  if (zh !== '') {
    const bad = checkZhPersona(zh)
    if (bad !== undefined) return bad
  }
  const en = (persona?.en ?? '').trim()
  return en === '' ? undefined : checkEnPersona(en)
}

/**
 * 生成出来的那一份英文合不合格（`scripts/gen-persona-en.mjs` 写盘前、`--check` 与单测都用它）。
 *
 * 比 `checkPersona` 的英文那一刀多查两样：**不为空**、**六个英文小标题都在**——
 * 后者是给机器读的（串岗测试按 `Not yours` 找那一段），翻译把小标题意译掉就红在这里。
 */
export function checkGeneratedPersonaEn(en: string): string | undefined {
  const text = en.trim()
  if (text === '') return '英文是空的'
  const bad = checkEnPersona(text)
  if (bad !== undefined) return bad
  const missing = PERSONA_SECTIONS_EN.filter((h) => !text.includes(h))
  return missing.length > 0 ? `英文少了这几段小标题：${missing.join(' / ')}` : undefined
}

/* ── 69 §4：公司层覆盖 ──────────────────────────────────────────────────── */

/** 两个 subject 是不是同一个。 */
export function sameSubject(a: PersonaSubject, b: PersonaSubject): boolean {
  return a.kind === b.kind && a.id === b.id
}

/** 覆盖表的查表键（`position:web-ops` / `role:kol.youtube`）。 */
export function personaKey(subject: PersonaSubject): string {
  return `${subject.kind}:${subject.id}`
}

/**
 * 包里的原文 + 公司层覆盖 → 现在生效的那一份。
 *
 * WP226（69 §4.1）：**公司只改中文**。英文跟着中文走：
 * - 覆盖后的中文与包里的一样（或者覆盖只给了英文）→ 英文用包里那份（生成的）；
 * - 覆盖后的中文变了、覆盖里又没有英文 → 英文那一格**留空**（= 还没翻译）。
 *   取英文时 `personaTextIn` 回落中文，面板据 `personaUntranslated` 标「未翻译」。
 *
 * 不再"另一边从原文补齐"：那样拼出来的是两份不同来历的文字——中文是公司刚改的，
 * 英文还是包里说的那一套，英文界面上看着通顺，其实说的不是同一件事。
 * 老的覆盖里两边都填了的（WP226 之前存下的），照原样认。
 */
export function applyPersonaOverride(
  packaged: PersonaText | undefined,
  override: PersonaText | undefined,
): PersonaText | undefined {
  if (override === undefined) return packaged
  if (packaged === undefined) return override
  /*
   * 这里读的是**原始格子**（`rawIn`），不是 `personaTextIn`。
   *
   * `personaTextIn` 那一层带回落（英文空了就给中文），在别处正是要的行为——
   * 宁可语言不对也别给一段空白。但在这儿用它，就会把中文抄进英文那一格，
   * 于是"还没翻译"这件事再也看不出来。
   */
  const zh = rawIn(override, 'zh') || personaTextIn(packaged, 'zh')
  const en =
    rawIn(override, 'en') || (zh === personaTextIn(packaged, 'zh') ? rawIn(packaged, 'en') : '')
  return { zh, en }
}

/** 某一格的原文（**不回落**另一份）。 */
function rawIn(persona: PersonaText, lang: PersonaLang): string {
  if (typeof persona === 'string') return persona.trim()
  return ((lang === 'zh' ? persona.zh : persona.en) ?? '').trim()
}

/**
 * WP226：这一份有中文、却还没有对应的英文（公司改了中文之后、或者包里生成的英文过期了）。
 *
 * 英文界面据此显示中文原文 + 一个「未翻译」标记（69 §4.1）。老的纯字符串写法是
 * "只有一份"，不算没翻译。
 */
export function personaUntranslated(persona: PersonaText | undefined): boolean {
  if (persona === undefined || typeof persona === 'string') return false
  return rawIn(persona, 'zh') !== '' && rawIn(persona, 'en') === ''
}

/** 面板要的那一份（现在生效的 + 包里的原文 + 改没改过）。 */
export function personaView(input: {
  subject: PersonaSubject
  name: { zh: string; en: string }
  packaged: PersonaText
  override?: PersonaOverride | undefined
}): PersonaView {
  const effective = applyPersonaSectionOverride(input.packaged, input.override) ?? input.packaged
  const overridden =
    input.override !== undefined &&
    (personaTextIn(effective, 'zh') !== personaTextIn(input.packaged, 'zh') ||
      personaTextIn(effective, 'en') !== personaTextIn(input.packaged, 'en'))
  return {
    subject: input.subject,
    name: input.name,
    effective,
    packaged: input.packaged,
    overridden,
    ...(personaUntranslated(effective) ? { untranslated: true } : {}),
    ...(input.override?.sections === undefined
      ? {}
      : { overridden_sections: overriddenPersonaSections(input.override.sections) }),
    ...(input.override?.updated_at === undefined ? {} : { updated_at: input.override.updated_at }),
    ...(input.override?.updated_by === undefined ? {} : { updated_by: input.override.updated_by }),
  }
}

/* ── WP404（docs/107 §4）：按段覆盖 ─────────────────────────────────────── */

/** 六段的稳定 id，与 `PERSONA_SECTIONS_ZH` / `PERSONA_SECTIONS_EN` 一一对应（段名就是天然的 id）。 */
export const PERSONA_SECTION_IDS: readonly PersonaSectionId[] = [
  'who',
  'handles',
  'not_yours',
  'how',
  'tone',
  'always_ask',
]

/** 拆开的一段：小标题、它后面那个冒号（照原样，中文全角 / 英文半角）、正文。 */
export interface PersonaSectionPart {
  id: PersonaSectionId
  heading: string
  sep: string
  body: string
}

/** 拆开的一份 persona：六段之前的那几行（通常没有）+ 六段。 */
export interface SplitPersona {
  preamble: string
  sections: PersonaSectionPart[]
}

/**
 * 把一份 persona 拆成六段。只认 69 §2 的固定骨架：六个小标题**各占一行开头、各出现一次、按顺序**，
 * 后面跟一个冒号（`：` 或 `:`）。拆不开（用户自己写成一整段、少了段、顺序乱了）→ `undefined`，
 * 调用方照旧按整段处理。拆开再拼回去与原文逐字节相同（`joinPersonaSections`）。
 */
export function splitPersonaSections(text: string, lang: PersonaLang): SplitPersona | undefined {
  const headings = lang === 'zh' ? PERSONA_SECTIONS_ZH : PERSONA_SECTIONS_EN
  const starts: { at: number; sep: string }[] = []
  let from = 0
  for (const h of headings) {
    let at = -1
    let sep = ''
    for (let i = text.indexOf(h, from); i >= 0; i = text.indexOf(h, i + 1)) {
      const lineStart = i === 0 || text[i - 1] === '\n'
      const next = text[i + h.length]
      if (lineStart && (next === '：' || next === ':')) {
        at = i
        sep = next
        break
      }
    }
    if (at < 0) return undefined
    starts.push({ at, sep })
    from = at + h.length + 1
  }
  const first = starts[0]
  if (first === undefined) return undefined
  const sections: PersonaSectionPart[] = []
  for (const [i, h] of headings.entries()) {
    const cur = starts[i]
    const id = PERSONA_SECTION_IDS[i]
    if (cur === undefined || id === undefined) return undefined
    const bodyStart = cur.at + h.length + cur.sep.length
    const next = starts[i + 1]
    // 下一段的小标题前面那个换行不属于这一段
    const bodyEnd = next === undefined ? text.length : next.at - 1
    sections.push({ id, heading: h, sep: cur.sep, body: text.slice(bodyStart, bodyEnd) })
  }
  return { preamble: text.slice(0, first.at), sections }
}

/** `splitPersonaSections` 的反过程（逐字节）。 */
export function joinPersonaSections(split: SplitPersona): string {
  return split.preamble + split.sections.map((s) => `${s.heading}${s.sep}${s.body}`).join('\n')
}

/**
 * 用户交上来的整段改写 → 按语言、按段的改写（只记和包里那一份不一样的段）。
 *
 * 拆不开、或者拆开再拼回去和交上来的不是同一串字（多了段外的话、段落顺序乱了）→ `undefined`：
 * 这种改写没法按段存，调用方照旧整段替换（行为与改造前一样）。老的纯字符串写法也不按段存。
 */
export function personaSectionDiff(
  packaged: PersonaText | undefined,
  text: PersonaText,
): PersonaSectionOverrides | undefined {
  if (packaged === undefined || typeof packaged === 'string' || typeof text === 'string')
    return undefined
  const out: PersonaSectionOverrides = {}
  for (const lang of ['zh', 'en'] as const) {
    const mine = rawIn(text, lang)
    if (mine === '') continue
    const base = splitPersonaSections(rawIn(packaged, lang), lang)
    const split = splitPersonaSections(mine, lang)
    if (base === undefined || split === undefined) return undefined
    if (joinPersonaSections(split) !== mine || split.preamble !== base.preamble) return undefined
    const changed: Partial<Record<PersonaSectionId, string>> = {}
    for (const [i, part] of split.sections.entries()) {
      const was = base.sections[i]
      if (was === undefined) return undefined
      if (part.body !== was.body || part.sep !== was.sep) changed[part.id] = part.body
    }
    if (Object.keys(changed).length > 0) out[lang] = changed
  }
  return out
}

/** 一种语言：包里那一份逐段换上改写（拆不开就回 `undefined`）。 */
function withSections(
  base: string,
  lang: PersonaLang,
  changed: Partial<Record<PersonaSectionId, string>> | undefined,
): string | undefined {
  const split = splitPersonaSections(base, lang)
  if (split === undefined) return undefined
  return joinPersonaSections({
    preamble: split.preamble,
    sections: split.sections.map((s) =>
      changed?.[s.id] === undefined ? s : { ...s, body: changed[s.id] ?? s.body },
    ),
  })
}

/**
 * WP404：包里的原文 + 按段的改写 → 现在生效的那一份。
 *
 * - **中文**：包里的中文逐段换上改写过的段；没改的段跟着包里走（包里出了新版，那几段自然是新的）。
 * - **英文**（与 WP226「公司只改中文」同一条规矩）：改写里给了英文 → 包里的英文逐段换上改过的那几段；
 *   没给英文、中文却改了 → 英文那一格**留空**（= 未翻译，取英文时回落中文）；中文也没改 → 包里的英文。
 * - 包里那一份拆不开（外部自建的职责写成一整段）→ 回落整段替换（`applyPersonaOverride(packaged, text)`）。
 */
export function applyPersonaSectionOverride(
  packaged: PersonaText | undefined,
  override: { text: PersonaText; sections?: PersonaSectionOverrides | undefined } | undefined,
): PersonaText | undefined {
  if (override === undefined) return packaged
  if (override.sections === undefined || packaged === undefined || typeof packaged === 'string')
    return applyPersonaOverride(packaged, override.text)
  const zhBase = rawIn(packaged, 'zh')
  const zh = withSections(zhBase, 'zh', override.sections.zh)
  if (zh === undefined) return applyPersonaOverride(packaged, override.text)
  const zhChanged = Object.keys(override.sections.zh ?? {}).length > 0
  const enGiven = rawIn(override.text, 'en')
  const enBase = rawIn(packaged, 'en')
  // 与 `applyPersonaOverride` 同一个判法：给了英文就用（按段叠到包里的英文上）；没给英文时，
  // 中文一段都没改 → 包里的英文，改了 → 留空（未翻译）
  const en =
    enGiven !== ''
      ? (withSections(enBase, 'en', override.sections.en) ?? enGiven)
      : zhChanged
        ? ''
        : enBase
  return { zh, en }
}

/**
 * 一份 persona 摊成「段」（id / 小标题 / 正文），形状与技能的段合并（`planContentMerge`，`@agentsws/skills`）
 * 要的一样——persona 的官方更新（WP406）直接复用那一套按段三方合并，不另写一份。拆不开 → 空数组。
 */
export function personaMergeSections(
  persona: PersonaText | undefined,
  lang: PersonaLang,
): { id: PersonaSectionId; heading: string; body: string }[] {
  if (persona === undefined) return []
  const split = splitPersonaSections(personaTextIn(persona, lang), lang)
  return split === undefined
    ? []
    : split.sections.map((s) => ({ id: s.id, heading: s.heading, body: s.body }))
}

/** 按段改写摊成段合并要的「上层改动」（整段替换那一种）。 */
export function personaSectionEdits(
  sections: PersonaSectionOverrides | undefined,
  lang: PersonaLang,
  owner: { tier: string; owner: string },
): {
  tier: string
  owner: string
  source: 'layer'
  op: 'replace'
  section_id: string
  body: string
}[] {
  const changed = sections?.[lang] ?? {}
  return PERSONA_SECTION_IDS.filter((id) => changed[id] !== undefined).map((id) => ({
    ...owner,
    source: 'layer',
    op: 'replace',
    section_id: id,
    body: changed[id] ?? '',
  }))
}

/** 按段改写里改了哪几段（中文那份；面板标「改过」用）。 */
export function overriddenPersonaSections(
  sections: PersonaSectionOverrides | undefined,
): PersonaSectionId[] {
  const zh = sections?.zh ?? {}
  return PERSONA_SECTION_IDS.filter((id) => zh[id] !== undefined)
}

/* ── 69 §3：装配成系统提示的那几段 ───────────────────────────────────────── */

/**
 * 品牌上下文的四个槽位（WP121 的品牌档案供，取不到就不写那一句）。
 *
 * **一格都不许编**：`brand_name` 没有就整句不写，而不是写"你们公司"。
 * 模型读到一句编出来的品牌定位，会把它当事实用进开发信里。
 */
export interface PersonaBrandContext {
  /** 品牌名（这次运行所在的那个品牌）。 */
  brand_name?: string
  /**
   * WP251（决策 119）：公司全称（这个品牌挂的那家公司）。另起一行「公司：」；
   * 与品牌名一样（个人用户常把两格填成同一个名字）就不重复写。
   */
  company_name?: string
  /** 一句话定位。 */
  one_liner?: string
  /** 目标市场（ISO 国家码，最多写前几个）。 */
  markets?: string[]
  /** 站上的原话，给语气参考（最多两条）。 */
  tone_samples?: string[]
  /**
   * WP122 的扩展点：品牌设计规范里的「视觉气质」一句。
   *
   * 留这一格而不是让 WP122 自己去改 `renderBrandContext`：品牌上下文是**一段**，
   * 多一句就多一个槽位，槽位的规矩（取不到就不写）对每一格都一样。
   * WP122 只要把这一格填上，这一段自然多一行，别处一行都不用改。
   */
  visual_tone?: string
  /** WP248（决策 83）：客服邮箱（品牌档案里写着的那一个；没写就整行不出）。 */
  support_email?: string
  /** WP248（决策 83）：这个品牌卖货的币种（ISO 4217；品牌档案里写过才有，不替人补默认值）。 */
  currency?: string
  /*
   * WP346（决策 872）：品牌档案第二版那几格——红人、广告、内容、巡查的建议都先读它们。
   * 还是「AI 建议」（人没核过）的那几格列在 `unconfirmed` 里，那一行后面注一句「AI 归纳，待人核」。
   */
  category?: string
  subcategory?: string
  positioning?: string
  price_band?: string
  audience?: { buyers: string; payer?: string; concerns?: string[] }
  keywords?: { brand: string[]; category: string[]; scenario: string[] }
  /** 竞品名（理由不进提示词：太长，模型要的是「跟谁比」）。 */
  competitors?: string[]
  unconfirmed?: string[]
}

/** WP251：公司全称与品牌名是不是同一个（大小写、空白不算）。没有品牌名 = 不一样。 */
function sameName(a: string, b: string | undefined): boolean {
  if (b === undefined || b === '') return false
  const norm = (v: string): string => v.normalize('NFKC').toLowerCase().replace(/\s+/g, '')
  return norm(a) === norm(b)
}

/** 市场那一行最多列几个（再多就是一串没人读的国家码）。 */
const MAX_MARKETS = 5
/** 口吻样例最多列几条。 */
const MAX_TONE_SAMPLES = 2

/**
 * 品牌上下文 → 一段人话。**一格都没有就回空串**（调用方据此不出这一节）。
 *
 * 每一格一行，取不到的行整行不出现——这是 69 §5「别编」的落点。
 */
export function renderBrandContext(
  brand: PersonaBrandContext | undefined,
  lang: PersonaLang = 'zh',
): string {
  if (brand === undefined) return ''
  const zh = lang === 'zh'
  const lines: string[] = []
  const name = brand.brand_name?.trim()
  if (name) lines.push(zh ? `品牌：${name}` : `Brand: ${name}`)
  const company = brand.company_name?.trim()
  if (company && !sameName(company, name))
    lines.push(zh ? `公司：${company}` : `Company: ${company}`)
  const one = brand.one_liner?.trim()
  if (one) lines.push(zh ? `一句话定位：${one}` : `Positioning: ${one}`)
  const markets = (brand.markets ?? []).filter((m) => m.trim() !== '').slice(0, MAX_MARKETS)
  if (markets.length > 0)
    lines.push(zh ? `主要市场：${markets.join('、')}` : `Main markets: ${markets.join(', ')}`)
  const currency = brand.currency?.trim()
  if (currency) lines.push(zh ? `币种：${currency}` : `Currency: ${currency}`)
  const email = brand.support_email?.trim()
  if (email) lines.push(zh ? `客服邮箱：${email}` : `Support email: ${email}`)
  // WP346：第二版那几格（AI 归纳、人没核过的注一句）
  const note = (key: string): string =>
    brand.unconfirmed?.includes(key) === true
      ? zh
        ? '（AI 归纳，待人核）'
        : ' (AI draft, unconfirmed)'
      : ''
  const cat = [brand.category?.trim(), brand.subcategory?.trim()].filter((x) => x).join(' / ')
  if (cat)
    lines.push(zh ? `品类：${cat}${note('category')}` : `Category: ${cat}${note('category')}`)
  const pos = brand.positioning?.trim()
  if (pos)
    lines.push(
      zh
        ? `品牌定位：${pos}${note('positioning')}`
        : `Brand positioning: ${pos}${note('positioning')}`,
    )
  const band = brand.price_band?.trim()
  if (band)
    lines.push(
      zh ? `价格带：${band}${note('price_band')}` : `Price band: ${band}${note('price_band')}`,
    )
  const who = brand.audience
  if (who !== undefined && who.buyers.trim() !== '') {
    const parts = [
      who.buyers.trim(),
      ...(who.payer?.trim()
        ? [zh ? `付钱的人：${who.payer.trim()}` : `Payer: ${who.payer.trim()}`]
        : []),
      ...((who.concerns ?? []).length > 0
        ? [
            zh
              ? `顾虑：${(who.concerns ?? []).join('、')}`
              : `Concerns: ${(who.concerns ?? []).join('; ')}`,
          ]
        : []),
    ]
    lines.push(
      zh
        ? `目标人群：${parts.join('；')}${note('audience')}`
        : `Audience: ${parts.join('; ')}${note('audience')}`,
    )
  }
  const kw = brand.keywords
  if (kw !== undefined) {
    const groups = [
      [zh ? '品牌词' : 'brand', kw.brand],
      [zh ? '品类词' : 'category', kw.category],
      [zh ? '场景词' : 'scenario', kw.scenario],
    ] as const
    const text = groups
      .filter(([, list]) => list.length > 0)
      .map(([label, list]) => `${label} ${list.slice(0, 8).join(zh ? '、' : ', ')}`)
      .join(zh ? '；' : '; ')
    if (text)
      lines.push(zh ? `关键词：${text}${note('keywords')}` : `Keywords: ${text}${note('keywords')}`)
  }
  const rivals = (brand.competitors ?? []).filter((c) => c.trim() !== '').slice(0, 8)
  if (rivals.length > 0)
    lines.push(
      zh
        ? `主要竞品：${rivals.join('、')}${note('competitors')}`
        : `Main competitors: ${rivals.join(', ')}${note('competitors')}`,
    )
  const visual = brand.visual_tone?.trim()
  if (visual) lines.push(zh ? `视觉气质：${visual}` : `Visual character: ${visual}`)
  const tone = (brand.tone_samples ?? []).filter((t) => t.trim() !== '').slice(0, MAX_TONE_SAMPLES)
  if (tone.length > 0) {
    lines.push(zh ? '品牌自己的原话（语气参考，别照抄）：' : 'The brand’s own words (tone only):')
    for (const t of tone) lines.push(`- ${t.trim()}`)
  }
  return lines.join('\n')
}

/** persona 三节在系统提示里的次序（69 §3：品牌 → 岗位 → 职责 → 技能 → 工具）。 */
export const PERSONA_ORDER = { brand: 5, position: 10, role: 20 } as const

/**
 * WP153（09-26 真账号冒烟）：**所有职责的提示词公共段**——紧跟在职责那一节后面（25），技能（40）前面。
 *
 * 冒烟里真模型回的是「我用 `search_policies` 查了三轮」：工具名是给模型看的，给人看的是做了什么。
 * 这一句管的是模型自己别说；万一还是说了，服务端有一道兜底（`humanizeToolNames`，同一张人话表）。
 */
export const HOUSE_RULES_ORDER = 25

/**
 * WP404（docs/107 §3）：规矩原文外置成数据（`house-rules.content.json`，每条带 id），这里只管拼。
 * 几条按顺序用换行接起来；现在只有一条，所以和外置前逐字节相同。
 *
 * WP407（决策 1179）：「回复语言」「下一步建议」两句全职责公共规矩也并进这张表——每行多一格可选的
 * `section`，说它进哪一节：不写 / `house` = 说话规矩（25），`reply_language` = 回复语言（22），
 * `next_step` = 下一步建议（27）。三节的位置、标题、正文与并表前逐字节相同（测试钉住），只是文字的真源
 * 换成了数据，能随官方岗位更新改、能按品牌覆盖。
 */
const HOUSE_RULES_TABLE = builtinContentTable<HouseRuleRow>(HOUSE_RULES_FILE)

/** 公共规矩表里一行能进的那几节（WP407，决策 1179）。 */
export const HOUSE_RULE_SECTIONS = ['house', 'reply_language', 'next_step'] as const
export type HouseRuleSection = (typeof HOUSE_RULE_SECTIONS)[number]

interface HouseRuleRow {
  id: string
  zh: string
  en: string
  /** 不写 = `house`。 */
  section?: HouseRuleSection
}

const isHouseRuleRow = (r: unknown): r is HouseRuleRow =>
  typeof (r as HouseRuleRow).zh === 'string' &&
  typeof (r as HouseRuleRow).en === 'string' &&
  ((r as HouseRuleRow).section === undefined ||
    (HOUSE_RULE_SECTIONS as readonly unknown[]).includes((r as HouseRuleRow).section))

const sectionOf = (r: HouseRuleRow): HouseRuleSection => r.section ?? 'house'

/**
 * 某一节的正文（按品牌可覆盖：`readContentTable`；没登记覆盖源就是随软件带的那一份）。
 * 覆盖来的表里**这一节一行都没有**（例如一份只写了说话规矩的老表），这一节照旧用随软件带的那几行——
 * 公共规矩不能因为覆盖表缺行就从提示词里整节消失。
 */
function houseRulesText(
  lang: PersonaLang,
  brand?: string,
  section: HouseRuleSection = 'house',
): string {
  const rows = readContentTable(HOUSE_RULES_TABLE, { brand, accepts: isHouseRuleRow }).filter(
    (r) => sectionOf(r) === section,
  )
  const use =
    rows.length > 0 ? rows : HOUSE_RULES_TABLE.rows.filter((r) => sectionOf(r) === section)
  return use.map((r) => r[lang]).join('\n')
}

export const HOUSE_RULES: Readonly<Record<PersonaLang, string>> = {
  zh: houseRulesText('zh'),
  en: houseRulesText('en'),
}

/** 公共段那一节（每条职责、每个运行时都带同一份）。 */
export function houseRulesSection(lang: PersonaLang = 'zh', brand?: string): PromptSection {
  return {
    id: 'house',
    name: lang === 'zh' ? '说话规矩' : 'house rules',
    order: HOUSE_RULES_ORDER,
    text: houseRulesText(lang, brand),
  }
}

/**
 * WP226（69 §3.3）：**回复语言**——紧跟在职责那一节后面（22），公共段（25）前面。
 *
 * 系统提示里的 persona 一律是中文那份（只有中文是手写的真源，英文是翻出来的）；
 * 模型读中文说明、照这一句用对方的语言回，比送一份机翻英文更稳。这一句本身按**界面语言**
 * 二选一：它说的"对内用哪种语言"就是界面语言，所以中文界面送中文那句、英文界面送英文那句。
 *
 * 三个运行时拿到的是同一份字节：stub / direct 走 `assemblePrompt`，dsh 写进唯一那个
 * `complete` 段（69 §3 那张表）。
 *
 * WP232（10-05 真模型实测）：草稿跟来信语言写对了，可**过程中对用户说的话**也跟着成了英文
 * （「I'll pull the playbook…」）。旧句子先讲「对方写英文就回英文」、最后才半句「对内用中文」，
 * 而且「说明」没点到"边做边说的那几句"。改成**先说对内**、点名过程话，再把"跟来信语言"
 * 收窄到「要发出去的那份稿子（起草工具的正文与主题）」；起草工具的参数描述里另有同一句
 * （`@agentsws/stand-ins` 的 `DRAFT_BODY_DESCRIPTION`）。
 *
 * WP407（决策 1179）：原文挪进公共规矩表（`section: reply_language` 那一行），这里只管拼。
 */
export const REPLY_LANGUAGE_ORDER = 22

export const REPLY_LANGUAGE_RULE: Readonly<Record<PersonaLang, string>> = {
  zh: houseRulesText('zh', undefined, 'reply_language'),
  en: houseRulesText('en', undefined, 'reply_language'),
}

/** 回复语言那一节（每条职责、每个运行时都带同一份；`lang` = 界面语言）。 */
export function replyLanguageSection(lang: PersonaLang = 'zh', brand?: string): PromptSection {
  return {
    id: 'reply_language',
    name: lang === 'zh' ? '回复语言' : 'reply language',
    order: REPLY_LANGUAGE_ORDER,
    text: houseRulesText(lang, brand, 'reply_language'),
  }
}

/**
 * WP264（决策 179）：**下一步建议**那一节（27，紧跟公共段）——交代末尾有明确下一步就单独一行
 * `<next>…</next>`。原文是契约里的 `NEXT_SUGGESTION_RULE`（只有中文）；WP407（决策 1179）起真源是
 * 公共规矩表 `section: next_step` 那一行（补了英文），契约那个常量留着不删，测试钉住两边逐字节相同。
 */
export const NEXT_SUGGESTION_ORDER = 27

export function nextSuggestionSection(lang: PersonaLang = 'zh', brand?: string): PromptSection {
  return {
    id: 'next_step',
    name: lang === 'zh' ? '下一步建议' : 'next step',
    order: NEXT_SUGGESTION_ORDER,
    text: houseRulesText(lang, brand, 'next_step'),
  }
}

export interface PersonaSectionsInput {
  lang?: PersonaLang
  /** 这次运行落在哪个岗位上（反查不出来就没有这一节，54 §3「不猜一个」）。 */
  position?: { id: string; name: string; persona: PersonaText | undefined } | undefined
  /** 这次运行落在哪条职责上。 */
  role: { id: string; name?: string | undefined; persona: PersonaText | undefined }
  /** 品牌上下文（WP121 的品牌档案；没有就不出这一节）。 */
  brand?: PersonaBrandContext | undefined
}

/**
 * 装配 persona 的那几节（69 §3）。空的那一节**不出现**——
 * `assemblePrompt` 会把每一节渲染成 `## <id> <name>` 加正文，出一个空节等于在
 * 系统提示里放一个空标题，模型只会被它带偏。
 */
export function personaSections(input: PersonaSectionsInput): PromptSection[] {
  const lang = input.lang ?? 'zh'
  const out: PromptSection[] = []
  const brand = renderBrandContext(input.brand, lang)
  if (brand !== '')
    out.push({
      id: 'brand',
      name: lang === 'zh' ? '品牌' : 'brand',
      order: PERSONA_ORDER.brand,
      text: brand,
    })
  if (input.position !== undefined) {
    const text = personaTextIn(input.position.persona, lang)
    if (text !== '')
      out.push({
        id: 'position',
        name: input.position.name,
        order: PERSONA_ORDER.position,
        text,
      })
  }
  const roleText = personaTextIn(input.role.persona, lang)
  if (roleText !== '')
    out.push({
      id: 'role',
      name: input.role.name ?? input.role.id,
      order: PERSONA_ORDER.role,
      text: roleText,
    })
  return out
}

/* ── 校验整包 ──────────────────────────────────────────────────────────── */

/** 一条「这份 persona 不合格」的报告（`gen-ontology --check` 与单测共用）。 */
export interface PersonaProblem {
  subject: PersonaSubject
  message: string
}

/** 全部职责与全部岗位的 persona 体检（69 §2：一条都不许空）。 */
export function checkAllPersonas(input: {
  roles: readonly Pick<RoleDefinition, 'id' | 'persona'>[]
  positions: readonly Pick<Position, 'id' | 'persona'>[]
}): PersonaProblem[] {
  const out: PersonaProblem[] = []
  for (const p of input.positions) {
    const bad = checkPersona(p.persona)
    if (bad !== undefined) out.push({ subject: { kind: 'position', id: p.id }, message: bad })
  }
  for (const r of input.roles) {
    const bad = checkPersona(r.persona)
    if (bad !== undefined) out.push({ subject: { kind: 'role', id: r.id }, message: bad })
  }
  return out
}
