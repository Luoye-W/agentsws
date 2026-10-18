/**
 * WP411（客户真机 10-18 #10 #11 #13）：Reddit 巡查与起草的**质量闸**——纯函数，服务进程与模拟世界共用一份。
 *
 * | 函数 | 干什么 |
 * |---|---|
 * | {@link keywordHit} / {@link keywordNoise} | 外部关键词结果入库前的本地整词匹配（大小写、词边界、品牌名变体） |
 * | {@link dedupeByFullname} | 同一条（Reddit 全名）只留一份（收件箱 / 自家版块都读到时） |
 * | {@link externalReplyGate} | 外部帖要不要起草：个人主页、竞品版、没提到我们的都不起草 |
 * | {@link ungroundedSentences} / {@link stripUngrounded} | 草稿里没依据的技术细节（规格、故障原因、计划…）认出来、换成「我去确认一下」 |
 * | {@link contradictionHints} | 草稿和品牌号在这串里已经说过的话对不上（对方说过 A，草稿说「不清楚 A」） |
 * | {@link personaViolations} / {@link personaHint} | 人设：个人口吻里冒出「we / the team / DM us」；从品牌号历史发言里猜口吻 |
 * | {@link coveringTimeWindow} | 回补时间窗 → 搜索要用的最小时间档（day / week / month / year / all） |
 *
 * 全是本地比对：不调模型、不联网、不计费。通用写法，不认哪个品牌。
 */

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
const LATIN = /^[\p{Script=Latin}\d\s.'’&_+-]+$/u
const EDGE_L = '(?:^|[^\\p{L}\\p{N}])'
const EDGE_R = '(?=$|[^\\p{L}\\p{N}])'

/** 一个词 → 拉丁字母 / 数字段（段与段之间的空格、连字符、点、下划线可有可无）。 */
function chunks(term: string): string[] {
  return term.toLowerCase().match(/\p{L}+|\d+/gu) ?? []
}
const bodyOf = (term: string): string | undefined => {
  const c = chunks(term)
  return c.length === 0 ? undefined : c.map(esc).join('[\\s\\-_.]?')
}
/** 写法上算不算同一个词（大小写、空格、连字符都不算不同）。 */
export const sameTerm = (a: string, b: string): boolean =>
  chunks(a).join('') !== '' && chunks(a).join('') === chunks(b).join('')

export interface KeywordMatchContext {
  /** 品牌名与写法变体（品牌名、档案里的品牌词）。 */
  brand_names?: readonly string[]
  /** 型号写法（标签词）：品牌名直接连着型号（`IVRAAir3`）也算品牌名出现。 */
  models?: readonly string[]
}

/** 整词正则：拉丁字母按词边界；中文等按包含。认不出回 `undefined`。 */
export function phrasePattern(term: string, glue: readonly string[] = []): RegExp | undefined {
  const k = term.trim()
  if (k === '') return undefined
  if (!LATIN.test(k)) return new RegExp(esc(k.toLowerCase()), 'u')
  const body = bodyOf(k)
  if (body === undefined) return undefined
  const g = glue.map(bodyOf).filter((x): x is string => x !== undefined)
  const tail = g.length === 0 ? '' : `(?:[\\s\\-_]?(?:${g.join('|')}))?`
  return new RegExp(`${EDGE_L}${body}${tail}${EDGE_R}`, 'u')
}

/** 标题 + 正文 + 所在帖子的标题（评论没提关键词、但帖子标题提了也算这一串在说它）。 */
export function matchText(item: { title?: string; text: string; post_title?: string }): string {
  return [item.title ?? '', item.text, item.post_title ?? ''].join('\n').toLowerCase()
}

/**
 * 这段话里**整词**出现了这个关键词没有。关键词就是品牌名（或它的写法变体）时，品牌名的每种写法都认，
 * 品牌名直接连着型号也认；短语关键词要整串连续出现（`AI glasses` 不认 `glasses` 单独出现）。
 */
export function keywordHit(text: string, keyword: string, ctx: KeywordMatchContext = {}): boolean {
  const t = text.toLowerCase()
  const brands = (ctx.brand_names ?? []).filter((b) => b.trim() !== '')
  const forms = brands.some((b) => sameTerm(b, keyword)) ? [keyword, ...brands] : [keyword]
  const glue = forms.length > 1 ? (ctx.models ?? []) : []
  return forms.some((f) => phrasePattern(f, glue)?.test(t) === true)
}

/** 品牌（品牌名任一写法，或型号）在这段话里整词出现了没有。 */
export function mentionsBrand(text: string, ctx: KeywordMatchContext): boolean {
  const t = text.toLowerCase()
  const brands = (ctx.brand_names ?? []).filter((b) => b.trim() !== '')
  return (
    brands.some((b) => phrasePattern(b, ctx.models ?? [])?.test(t) === true) ||
    (ctx.models ?? []).some((m) => phrasePattern(m)?.test(t) === true)
  )
}

/** 外部关键词那一条留不留：没整词出现就是数据渠道的宽松匹配撞上的噪音（不入库、不判、不计）。 */
export function keywordNoise(
  item: { title?: string; text: string; post_title?: string },
  keyword: string,
  ctx: KeywordMatchContext = {},
): { keep: true } | { keep: false; why: string } {
  return keywordHit(matchText(item), keyword, ctx)
    ? { keep: true }
    : { keep: false, why: `没有整词出现「${keyword}」` }
}

/** 同一条（全名）只留第一份；后面的进 `dupes`。 */
export function dedupeByFullname<T extends { fullname: string }>(
  items: readonly T[],
): { kept: T[]; dupes: T[] } {
  const seen = new Set<string>()
  const kept: T[] = []
  const dupes: T[] = []
  for (const it of items) {
    const k = it.fullname.toLowerCase()
    if (seen.has(k)) dupes.push(it)
    else {
      seen.add(k)
      kept.push(it)
    }
  }
  return { kept, dupes }
}

/* ── 外部帖要不要起草 ───────────────────────────────────────────────── */

/** 别人的个人主页（`r/u_xxx`）。 */
export const isProfileSub = (sub: string | undefined): boolean =>
  /^u_/iu.test((sub ?? '').replace(/^\/?r\//iu, ''))

const squash = (s: string): string => chunks(s).join('')

/** 这个版是不是某个竞品自己的版（版名就是竞品名，或竞品名开头 + 短尾巴，如 `EvenRealities` / `xrealofficial`）。 */
export function competitorSubOf(
  sub: string | undefined,
  competitors: readonly string[],
): string | undefined {
  const s = squash((sub ?? '').replace(/^\/?r\//iu, ''))
  if (s === '') return undefined
  for (const c of competitors) {
    const k = squash(c)
    if (k.length < 3) continue
    if (s === k || (s.startsWith(k) && s.length - k.length <= 8)) return c
  }
  return undefined
}

export interface ExternalGateContext extends KeywordMatchContext {
  /** 竞品名（档案里的）。 */
  competitors?: readonly string[]
}

/**
 * 外部（自家版块以外）的一条，品牌号该不该去回：个人主页不回；竞品自己的版不回；
 * 帖子 / 评论 / 所在帖子标题里**没整词提到我们**（品牌名任一写法、型号）的不回——只说品类的问题不自动起草。
 */
export function externalReplyGate(
  item: { subreddit?: string; title?: string; text: string; post_title?: string },
  ctx: ExternalGateContext,
): { ok: true } | { ok: false; why: string } {
  if (isProfileSub(item.subreddit)) return { ok: false, why: '别人的个人主页帖，品牌号不去回' }
  const rival = competitorSubOf(item.subreddit, ctx.competitors ?? [])
  if (rival !== undefined)
    return { ok: false, why: `r/${item.subreddit} 是竞品（${rival}）自己的版，不去回` }
  if (!mentionsBrand(matchText(item), ctx))
    return { ok: false, why: '外部帖没提到我们（只说品类），不自动起草' }
  return { ok: true }
}

/* ── 草稿的依据 ─────────────────────────────────────────────────────── */

/** 拆句（英文按 .!? 与换行，中文按。！？）。 */
export function splitSentences(text: string): string[] {
  return (text.match(/[^.!?。！？\n]+[.!?。！？]*/gu) ?? [])
    .map((s) => s.trim())
    .filter((s) => s !== '')
}

/**
 * 「具体说法」的记号：规格数字、故障原因、修法、兼容 / 连接方式、型号定位、计划与进度、召回 / 保修这类。
 * 一句里有这些、而依据（知识卡、品牌号已发的话、对方原话）里找不到同一个记号 → 这句没依据。
 */
const CLAIM_MARKERS: readonly RegExp[] = [
  /\d+(?:\.\d+)?\s?(?:mah|wh|w|v|g|kg|mm|cm|inch(?:es)?|hz|nits?|fps|gb|tb|hours?|hrs?|minutes?|mins?|days?|%|°)(?![\p{L}])/giu,
  /[$€£¥]\s?\d[\d,.]*/gu,
  /\bknown (?:issue|bug|problem|quirk)\b/giu,
  /\b(?:bug|glitch|firmware|ota|patch|hotfix|workaround|indexing|formatting)\b/giu,
  /\b(?:software|firmware|app) update\b/giu,
  /\bcompatib\w*\b/giu,
  /\b(?:wireless|wired|bluetooth|wi-?fi|usb-?c|tethered)\b/giu,
  /\b(?:battery life|refresh rate|field of view|fov|resolution|chipset|processor)\b/giu,
  /\b(?:replacement|successor|upgrade) (?:for|to|of)\b/giu,
  /\b(?:discontinued|recall(?:ed|s)?|warranty)\b/giu,
  /\b(?:we|i)(?:'re| are| am)? (?:working on|preparing|planning|putting together)\b/giu,
  /\b(?:coming soon|roadmap|next (?:version|release|update)|later this (?:week|month|year))\b/giu,
  /\b(?:display|system|interface) language\b/giu,
  /(?:固件|升级|兼容|无线|蓝牙|续航|召回|保修|已知问题|正在做|下个版本)/gu,
]

const norm = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[\s\-_]+/gu, ' ')
    .trim()

/** 草稿里没依据的那几句（原样回，去重）。 */
export function ungroundedSentences(draft: string, grounding: readonly string[]): string[] {
  const base = norm(grounding.join('\n'))
  const out: string[] = []
  for (const s of splitSentences(draft)) {
    const marks = CLAIM_MARKERS.flatMap((re) => [...s.matchAll(new RegExp(re.source, re.flags))])
    if (marks.some((m) => !base.includes(norm(m[0]))) && !out.includes(s)) out.push(s)
  }
  return out
}

const hasCjk = (s: string): boolean => /[㐀-鿿]/u.test(s)

/** 把没依据的那几句去掉，换成一句「我去确认一下」（语言照草稿；只补一次）。 */
export function stripUngrounded(draft: string, bad: readonly string[]): string {
  if (bad.length === 0) return draft
  let out = draft
  for (const s of bad) out = out.split(s).join('')
  out = out
    .replace(/[ \t]{2,}/gu, ' ')
    .replace(/\n{3,}/gu, '\n\n')
    .trim()
  const check = hasCjk(draft)
    ? '这个我去确认一下再回你。'
    : 'Let me double-check that and get back to you.'
  return out === '' ? check : `${out}\n\n${check}`
}

/* ── 和品牌号已说过的话对不对得上 ──────────────────────────────────── */

/** 「说不清 / 不知道 / 是谣言」这类回避或否认的说法。 */
const HEDGE =
  /\b(?:can(?:no|')?t|won'?t|unable to) (?:speak|comment|confirm)\b|\bnot (?:aware|sure) (?:of|about)\b|\b(?:don'?t|do not) know (?:about|of|anything)\b|\bno (?:official )?(?:info|information|news)\b|\b(?:just )?(?:a )?rumou?rs?\b|\bunconfirmed\b|\b(?:is not|isn'?t|not) true\b|\bhaven'?t heard\b|\bno (?:such )?recalls?\b|\bnever (?:been )?recalled\b|(?:不清楚|不了解|没听说|不是真的|谣言|无法评论)/iu

const STOP = new Set(
  'that this with have from they their there about which would could should these those what when your will just been were some more than into only also very much like make made know sure here thanks thank really'.split(
    ' ',
  ),
)
/** 一句里的实词（≥ 4 个字母，去掉常见词尾；中文按两字一段）。 */
function contentWords(s: string): Set<string> {
  const out = new Set<string>()
  for (const w of s.toLowerCase().match(/\p{L}[\p{L}\d]+/gu) ?? []) {
    if (/^[\p{Script=Han}]+$/u.test(w)) {
      for (let i = 0; i + 2 <= w.length; i += 1) out.add(w.slice(i, i + 2))
      continue
    }
    if (w.length < 4 || STOP.has(w)) continue
    out.add(w.replace(/(?:ing|ed|es|s)$/u, ''))
  }
  return out
}

/**
 * 草稿里回避 / 否认的那句，和品牌号之前**正面说过**的某句讲的是同一件事（有共同的实词）→ 对不上。
 * 回对上的那几对（品牌号原话那一句 + 草稿那一句）。
 */
export function contradictionHints(
  draft: string,
  priors: readonly { text: string; at?: string }[],
): { prior: string; sentence: string; at?: string }[] {
  const out: { prior: string; sentence: string; at?: string }[] = []
  for (const s of splitSentences(draft)) {
    if (!HEDGE.test(s)) continue
    const mine = contentWords(s)
    for (const p of priors)
      for (const ps of splitSentences(p.text)) {
        if (HEDGE.test(ps)) continue
        const shared = [...contentWords(ps)].filter((w) => mine.has(w))
        if (shared.length === 0) continue
        out.push({ prior: ps, sentence: s, ...(p.at === undefined ? {} : { at: p.at }) })
        break
      }
  }
  return out
}

/* ── 人设（品牌号怎么说话）───────────────────────────────────────────── */

export type PersonaStance = 'personal' | 'team'

const WE = /\b(?:we|we're|we've|we'll|we'd|us|our|ours)\b|\bthe team\b|\bdm us\b|我们团队|我们会/giu
const I_WORDS = /\b(?:i|i'm|i've|i'll|i'd|me|my|mine)\b/giu

/** 草稿和人设对不上的说法（个人口吻里冒出「we / the team / DM us」；团队口吻里冒出「我以前在这儿工作」）。 */
export function personaViolations(draft: string, stance: PersonaStance): string[] {
  if (stance === 'personal')
    return [...new Set([...draft.matchAll(WE)].map((m) => m[0].toLowerCase()))]
  const m = draft.match(/\bI (?:used to|previously) work(?:ed)?\b[^.!?\n]*/iu)
  return m === null ? [] : [m[0]]
}

/**
 * 从品牌号自己发过的话里猜口吻：第一人称单数明显多 / 有「我以前在…工作」这种自我介绍 → 个人；
 * 「we / our team」多 → 团队。猜不出就不给。`evidence` 是拿来当理由的原话（最多两句）。
 */
export function personaHint(texts: readonly string[]): {
  stance?: PersonaStance
  intro?: string
  evidence: string[]
} {
  let mine = 0
  let ours = 0
  let intro: string | undefined
  const evidence: string[] = []
  for (const t of texts) {
    mine += [...t.matchAll(I_WORDS)].length
    ours += [...t.matchAll(WE)].length
    const m =
      t.match(
        /\bI (?:used to |previously |currently )?(?:work|worked) (?:at|for|with)\b[^.!?\n]*/iu,
      ) ?? t.match(/\bI'?m (?:from|with|on) (?:the )?[^.!?\n]*\bteam\b[^.!?\n]*/iu)
    if (m !== null && intro === undefined) {
      intro = m[0].trim().slice(0, 160)
      evidence.push(intro)
    }
  }
  const stance: PersonaStance | undefined =
    intro !== undefined && !/\bteam\b/iu.test(intro)
      ? 'personal'
      : mine > 0 && mine >= ours * 1.5
        ? 'personal'
        : ours > mine
          ? 'team'
          : undefined
  if (evidence.length < 2) {
    const want = new RegExp((stance === 'team' ? WE : I_WORDS).source, 'iu')
    const pick = texts.find((t) => want.test(t) && !evidence.includes(t))
    if (pick !== undefined)
      evidence.push(splitSentences(pick)[0]?.slice(0, 160) ?? pick.slice(0, 160))
  }
  return {
    ...(stance === undefined ? {} : { stance }),
    ...(intro === undefined ? {} : { intro }),
    evidence,
  }
}

/* ── 回补时间窗 ─────────────────────────────────────────────────────── */

export type SearchTimeWindow = 'day' | 'week' | 'month' | 'year' | 'all'

/** 要覆盖到 `sinceMs` 的最小搜索时间档（Reddit 搜索的 `t`）。 */
export function coveringTimeWindow(sinceMs: number, nowMs: number): SearchTimeWindow {
  const span = nowMs - sinceMs
  const day = 86_400_000
  return span <= day
    ? 'day'
    : span <= 7 * day
      ? 'week'
      : span <= 31 * day
        ? 'month'
        : span <= 365 * day
          ? 'year'
          : 'all'
}
