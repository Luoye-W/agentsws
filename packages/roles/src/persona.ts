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
 * 派工单写的是「每段 ≤ 200 字」。那是**正文**的目标，机器上限要留出两样开销：
 * 六个小标题本身（约 30 字），以及英文——实测同一段话的英文字符数是中文的 3.5 倍
 * （中文一个字顶英文三四个字母），一个数卡不住两种语言，卡了只会逼着英文那份
 * 写得比中文少说一件事。所以两种语言各一个上限，目标仍是 200 字的中文正文。
 */
export const MAX_PERSONA_CHARS = { zh: 260, en: 950 } as const

/**
 * 一段 persona 写全了没有。回 `undefined` = 没问题，回一句中文 = 哪儿不对。
 *
 * 查三样，一样都不能少：
 * 1. **不是空的**（`gen-ontology --check` 把空判成失败，69 §2 最后一句）；
 * 2. **六段都在**——尤其是「你不负责」那一段，它是防串岗的那一条；
 * 3. **没超长**。
 */
export function checkPersona(persona: PersonaText | undefined): string | undefined {
  if (personaIsEmpty(persona)) return 'persona 是空的（69 §2：全部职责与岗位都要写，不许留空）'
  for (const lang of ['zh', 'en'] as const) {
    const text = personaTextIn(persona, lang)
    if (text === '') continue
    const cap = MAX_PERSONA_CHARS[lang]
    if (text.length > cap) return `persona（${lang}）${text.length} 字，超过 ${cap} 字上限`
    const heads = lang === 'zh' ? PERSONA_SECTIONS_ZH : PERSONA_SECTIONS_EN
    const missing = heads.filter((h) => !text.includes(h))
    if (missing.length > 0)
      return `persona（${lang}）少了这几段：${missing.join(' / ')}（69 §2 的固定骨架）`
  }
  return undefined
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
 * 覆盖里空着的那一边**回落原文**：公司只改了中文那份时，英文界面仍该拿到包里的英文，
 * 而不是一段空白（69 §4「包里的原文保留可还原」的另一半——它也随时可用）。
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
   * 宁可语言不对也别给一段空白。但在这儿用它，公司只改了中文的那一次就会把
   * 中文抄进英文那一格，包里原本写好的英文从此再也回不来了。
   */
  const zh = rawIn(override, 'zh') || personaTextIn(packaged, 'zh')
  const en = rawIn(override, 'en') || personaTextIn(packaged, 'en')
  return { zh, en }
}

/** 某一格的原文（**不回落**另一份）。 */
function rawIn(persona: PersonaText, lang: PersonaLang): string {
  if (typeof persona === 'string') return persona.trim()
  return ((lang === 'zh' ? persona.zh : persona.en) ?? '').trim()
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
