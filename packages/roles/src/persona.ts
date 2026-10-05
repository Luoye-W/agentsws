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
  PersonaSubject,
  PersonaText,
  PersonaView,
  Position,
  PromptSection,
  RoleDefinition,
} from '@agentsws/contracts'

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
 * （约 30 字）的开销，所以中文卡 260。
 *
 * WP226（69 §1.1）：**只卡中文**。英文那份现在由 `scripts/gen-persona-en.mjs` 从中文翻出来，
 * 长短跟着中文走——再卡一遍英文，只会逼着翻译去删一件中文里写了的事。`en` 这一格留着
 * （契约只加不删），`checkPersona` 不再读它。
 */
export const MAX_PERSONA_CHARS = { zh: 260, en: 950 } as const

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
 * 2. **中文那份**：六段都在（尤其是防串岗的「你不负责」）、不超过 260 字；
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
  const effective = applyPersonaOverride(input.packaged, input.override?.text) ?? input.packaged
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
    ...(input.override?.updated_at === undefined ? {} : { updated_at: input.override.updated_at }),
    ...(input.override?.updated_by === undefined ? {} : { updated_by: input.override.updated_by }),
  }
}

/* ── 69 §3：装配成系统提示的那几段 ───────────────────────────────────────── */

/**
 * 品牌上下文的四个槽位（WP121 的品牌档案供，取不到就不写那一句）。
 *
 * **一格都不许编**：`brand_name` 没有就整句不写，而不是写"你们公司"。
 * 模型读到一句编出来的品牌定位，会把它当事实用进开发信里。
 */
export interface PersonaBrandContext {
  /** 品牌名。 */
  brand_name?: string
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
  const one = brand.one_liner?.trim()
  if (one) lines.push(zh ? `一句话定位：${one}` : `Positioning: ${one}`)
  const markets = (brand.markets ?? []).filter((m) => m.trim() !== '').slice(0, MAX_MARKETS)
  if (markets.length > 0)
    lines.push(zh ? `主要市场：${markets.join('、')}` : `Main markets: ${markets.join(', ')}`)
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

export const HOUSE_RULES: Readonly<Record<PersonaLang, string>> = {
  zh: '对用户说话时不提工具名、函数名、内部 id，用人话说做了什么（说「查了规矩与政策库」，不说 search_policies）。',
  en: 'When talking to the user, never mention tool names, function names or internal ids — say in plain words what you did (“checked the policy library”, not search_policies).',
}

/** 公共段那一节（每条职责、每个运行时都带同一份）。 */
export function houseRulesSection(lang: PersonaLang = 'zh'): PromptSection {
  return {
    id: 'house',
    name: lang === 'zh' ? '说话规矩' : 'house rules',
    order: HOUSE_RULES_ORDER,
    text: HOUSE_RULES[lang],
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
 */
export const REPLY_LANGUAGE_ORDER = 22

export const REPLY_LANGUAGE_RULE: Readonly<Record<PersonaLang, string>> = {
  zh:
    '你对用户说的每一句话都用中文：边做边说的过程话（比如"我先查一下……"）、给用户的回复、' +
    '摘要和卡片，哪怕来信、资料、工具结果是英文。只有要发出去的那份稿子（起草工具里的正文和主题，' +
    '给客户、红人、媒体、平台上的人）用对方来信的语言：对方写英文就写英文；没有来信可对照时' +
    '（主动开发信、发帖），用目标市场的语言。',
  en:
    'Everything you say to the user is in English: progress notes while you work ("let me check…"), ' +
    'replies to the user, summaries and cards, even when the message, the material or tool results ' +
    'are in another language. Only the text going out (the body and subject in the drafting tool, to ' +
    'customers, creators, press, people on a platform) follows the language of the message you are ' +
    'answering: if they wrote in German, write in German; with no message to match (cold outreach, ' +
    'posts), use the language of the target market.',
}

/** 回复语言那一节（每条职责、每个运行时都带同一份；`lang` = 界面语言）。 */
export function replyLanguageSection(lang: PersonaLang = 'zh'): PromptSection {
  return {
    id: 'reply_language',
    name: lang === 'zh' ? '回复语言' : 'reply language',
    order: REPLY_LANGUAGE_ORDER,
    text: REPLY_LANGUAGE_RULE[lang],
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
